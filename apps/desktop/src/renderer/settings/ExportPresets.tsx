import { useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Tooltip } from '@base-ui/react/tooltip';
import { Check, ChevronDown } from 'lucide-react';
import { AppIcon } from '../components/AppIcon';
import { AppMenuPositioner } from '../components/PopupPositioner';
import type { AppSettingsPatch } from '../../shared/app-settings';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AppDialog } from '../components/AppDialog';
import { AppInput } from '../components/AppInput';
import { Button } from '../components/ui/button';
import { setAppSettings, useAppSettingsLoaded, useAppSettingsStore } from './appSettingsStore';
import { type CompDims, type ExportSettings } from '../../shared/exportSettings';
import {
  applyExportPreset, defaultExportPreset, exportPresetLibrary, exportPresetNameKey, exportPresetValues,
  sameExportPresetValues, validateExportPresetValues, EXPORT_PRESET_NAME_LIMIT,
  DEFAULT_EXPORT_PRESET_ID, type ExportPreset, type ExportPresetValues,
} from '../../shared/export-presets';

const EMPTY_PRESETS: ExportPreset[] = [];
function usePresetPreferences() {
  const export_presets = useAppSettingsStore(s => s.settings.export_presets ?? EMPTY_PRESETS);
  const default_export_preset_id = useAppSettingsStore(s => s.settings.default_export_preset_id ?? DEFAULT_EXPORT_PRESET_ID);
  return { export_presets, default_export_preset_id };
}

export const exportPresetLabel = (p: ExportPreset, t: TFunction): string =>
  p.id.startsWith('builtin:') ? t(`export_presets.builtin_${p.name}`) : p.name;

/** Keep the actual name intact; reveal it only when its rendered label is clipped. */
function PresetNameTooltip({ text, side = 'bottom', children }: {
  text: string; side?: 'bottom' | 'right'; children: (labelRef: RefObject<HTMLSpanElement | null>) => ReactElement;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  return <Tooltip.Root onOpenChange={(open, event) => {
    const label = labelRef.current;
    if (open && (!label || label.scrollWidth <= label.clientWidth)) event.cancel();
  }}>
    <Tooltip.Trigger aria-describedby={tooltipId} render={children(labelRef)} />
    <Tooltip.Portal>
      <Tooltip.Positioner side={side} align="start" sideOffset={4} className="app-popup-positioner">
        <Tooltip.Popup id={tooltipId} role="tooltip" className="export-preset-name-tooltip">{text}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}

function NameDialog({ initialName = '', excludeId, onSave, onClose }: {
  initialName?: string; excludeId?: string | undefined; onSave: (name: string) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const prefs = usePresetPreferences();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const countId = useId();
  const duplicate = exportPresetLibrary(prefs).some(p => p.id !== excludeId
    && exportPresetNameKey(exportPresetLabel(p, t)) === exportPresetNameKey(name));
  async function save() {
    if (pending.current || !name.trim() || duplicate) return;
    pending.current = true; setBusy(true); setError('');
    try { await onSave(name.trim()); onClose(); }
    catch { setError(t('export_presets.save_failed')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <AppDialog title={t('export_presets.name')} onClose={busy ? undefined : onClose} panelClassName="settings-panel export-preset-name">
    <form className="settings-body settings-card" onSubmit={e => { e.preventDefault(); void save(); }}>
      <AppInput ariaLabel={t('export_presets.name')} aria-describedby={countId} value={name} onValueChange={setName} maxLength={EXPORT_PRESET_NAME_LIMIT} autoFocus disabled={busy} />
      <p id={countId} className="export-preset-name-count">{name.length}/{EXPORT_PRESET_NAME_LIMIT}</p>
      {duplicate && <p role="alert" className="settings-warn">{t('export_presets.duplicate_name')}</p>}
      {error && <p role="alert" className="settings-warn">{error}</p>}
      <div className="export-preset-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('export_dialog.cancel')}</Button>
        <Button type="submit" disabled={busy || duplicate || !name.trim()}>{t('export_presets.save')}</Button>
      </div>
    </form>
  </AppDialog>;
}

/** One menu mixes mutually exclusive recipe choices with explicit commands below. */
function PresetMenu({ library, active, caption, modified, defaultId, disabled, dialogOpen, onChoose, children }: {
  library: readonly ExportPreset[]; active: ExportPreset | undefined | null; caption: string; defaultId: string;
  modified: boolean; disabled: boolean; dialogOpen: boolean; onChoose: (p: ExportPreset) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <Menu.Root>
    <PresetNameTooltip text={caption}>{labelRef =>
      <Menu.Trigger className="app-select export-preset-trigger" aria-label={t('export_presets.preset')} disabled={disabled}>
        <span ref={labelRef} className="export-preset-label">{caption}</span>
        {modified && <span className="export-preset-modified">{t('export_presets.modified_badge')}</span>}
        <AppIcon icon={ChevronDown} size="caption" aria-hidden />
      </Menu.Trigger>
    }</PresetNameTooltip>
    <Menu.Portal><AppMenuPositioner align="start" sideOffset={4} className="app-popup-positioner">
      <Menu.Popup className="app-menu-list export-preset-menu" finalFocus={!dialogOpen}>
        <div className="export-preset-options">
          <Menu.RadioGroup value={active?.id ?? ''}>
            {[true, false].map(builtin => <Menu.Group key={String(builtin)}>
              <Menu.GroupLabel className="menu-heading">{t(builtin ? 'export_presets.builtins' : 'export_presets.personal')}</Menu.GroupLabel>
              {library.filter(p => p.id.startsWith('builtin:') === builtin).map(p => <PresetNameTooltip key={p.id} text={exportPresetLabel(p, t)} side="right">{labelRef => <Menu.RadioItem
                value={p.id} label={exportPresetLabel(p, t)} closeOnClick className="app-menu-item" onClick={() => onChoose(p)}>
                <span className="app-menu-item-check" aria-hidden><Menu.RadioItemIndicator><AppIcon icon={Check} size="body" /></Menu.RadioItemIndicator></span>
                <span ref={labelRef} className="app-menu-item-label">{exportPresetLabel(p, t)}</span>
                {p.id === defaultId && <span className="export-preset-default">{t('export_presets.default_badge')}</span>}
              </Menu.RadioItem>}</PresetNameTooltip>)}
              {!builtin && !library.some(p => !p.id.startsWith('builtin:')) && <div className="export-preset-empty">{t('export_presets.empty_short')}</div>}
            </Menu.Group>)}
          </Menu.RadioGroup>
        </div>
        <Menu.Separator className="menu-separator" />
        {children}
      </Menu.Popup>
    </AppMenuPositioner></Menu.Portal>
  </Menu.Root>;
}

function useLibraryActions(onCreated: (p: ExportPreset) => void) {
  const { t } = useTranslation();
  const [naming, setNaming] = useState<{ kind: 'rename'; preset: ExportPreset } | { kind: 'create'; values: ExportPresetValues } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function write(patch: AppSettingsPatch): Promise<boolean> {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    try { await setAppSettings(patch); return true; }
    catch { setError(t('export_presets.save_failed')); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return {
    busy, error, write, naming,
    rename: (preset: ExportPreset) => setNaming({ kind: 'rename', preset }),
    create: (values: ExportPresetValues) => setNaming({ kind: 'create', values: structuredClone(values) }),
    dialog: naming && <NameDialog initialName={naming.kind === 'rename' ? naming.preset.name : ''}
      excludeId={naming.kind === 'rename' ? naming.preset.id : undefined} onClose={() => setNaming(null)} onSave={async name => {
        if (naming.kind === 'rename') await setAppSettings({ export_preset_change: { kind: 'update', id: naming.preset.id, name } });
        else {
          const preset: ExportPreset = { id: crypto.randomUUID(), name, version: 1, values: naming.values };
          await setAppSettings({ export_preset_change: { kind: 'create', preset } });
          onCreated(preset);
        }
        setError('');
      }} />,
  };
}

function LibraryCommands({ active, defaultId, actions }: {
  active: ExportPreset | undefined | null; defaultId: string;
  actions: ReturnType<typeof useLibraryActions>;
}) {
  const { t } = useTranslation();
  if (!active) return null;
  const personal = !active.id.startsWith('builtin:');
  return <>
    <Menu.Group>
      {personal && <Menu.Item className="app-menu-item" onClick={() => actions.rename(active)}>{t('export_presets.rename')}</Menu.Item>}
      <Menu.Item className="app-menu-item" disabled={active.id === defaultId}
        onClick={() => void actions.write({ default_export_preset_id: active.id })}>
        {t(active.id === defaultId ? 'export_presets.is_default' : 'export_presets.set_default')}
      </Menu.Item>
    </Menu.Group>
    {personal && <>
      <Menu.Separator className="menu-separator" />
      <Menu.Item className="app-menu-item export-preset-delete"
        onClick={() => void actions.write({ export_preset_change: { kind: 'delete', id: active.id } })}>{t('export_presets.delete')}</Menu.Item>
    </>}
  </>;
}

export function ExportPresetControl({ settings, comp, onApply }: {
  settings: ExportSettings; comp: CompDims; onApply: (s: ExportSettings) => void;
}) {
  const { t } = useTranslation();
  const prefs = usePresetPreferences();
  const loaded = useAppSettingsLoaded();
  const library = exportPresetLibrary(prefs);
  const [source, setSource] = useState<{ id: string; values: ExportPresetValues } | null>(() => {
    const p = [...library].reverse().find(p => sameExportPresetValues(exportPresetValues(settings), exportPresetValues(applyExportPreset(p, comp, settings))));
    return p ? { id: p.id, values: exportPresetValues(settings) } : null;
  });
  const actions = useLibraryActions(p => setSource({ id: p.id, values: p.values }));
  const active = source && library.find(p => p.id === source.id);
  const modified = !!active && !!source && !sameExportPresetValues(exportPresetValues(settings), source.values);
  const caption = active ? exportPresetLabel(active, t) : t('export_presets.custom');
  let valid = true;
  try { validateExportPresetValues(exportPresetValues(settings)); } catch { valid = false; }
  return <div className="export-preset-control">
      <PresetMenu library={library} active={active} caption={caption} modified={modified} defaultId={defaultExportPreset(prefs).id}
        disabled={!loaded || actions.busy} dialogOpen={actions.naming !== null} onChoose={p => {
          const next = applyExportPreset(p, comp, settings);
          setSource({ id: p.id, values: exportPresetValues(next) }); onApply(next);
        }}>
        <Menu.Item className="app-menu-item" disabled={!valid} onClick={() => actions.create(exportPresetValues(settings))}>{t('export_presets.save_as')}</Menu.Item>
        {modified && source && <Menu.Item className="app-menu-item" onClick={() => onApply({ ...settings, ...structuredClone(source.values) })}>{t('export_presets.restore')}</Menu.Item>}
        {active && !active.id.startsWith('builtin:') && modified && <Menu.Item className="app-menu-item" disabled={!valid} onClick={async () => {
          const values = exportPresetValues(settings);
          if (await actions.write({ export_preset_change: { kind: 'update', id: active.id, values } })) setSource({ id: active.id, values });
        }}>{t('export_presets.update')}</Menu.Item>}
        <LibraryCommands active={active} defaultId={defaultExportPreset(prefs).id} actions={actions} />
      </PresetMenu>
    {actions.error && <p role="alert" className="settings-warn">{actions.error}</p>}
    {actions.dialog}
  </div>;
}
