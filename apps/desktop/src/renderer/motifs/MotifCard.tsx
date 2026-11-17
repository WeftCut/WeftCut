import { AppMenuPositioner } from "../components/PopupPositioner";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOutputIcon } from 'lucide-react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Button } from '@/components/ui/button';
import { getMotifCover } from '../ipc';
import { formatTimecode } from '../frames';
import { MenuItem, contextMenuFinalFocus } from '../menu/Menu';
import { useCloseOnAnchorMove, useCursorAnchor } from '../timeline/contextMenuAnchor';
import { AppIcon } from "@/components/AppIcon";
import { canSaveToLibrary, libraryTake, projectRowBadge, rowHost, rowName, type MotifRow } from './motifRows';

/** What a card's actions do; each is offered only where it applies
 *  (`motifRows.ts`). */
export interface MotifCardActions {
  onSelect: () => void;
  onExport: () => void;
  /** Library: an installed Motif's versions. */
  onHistory: () => void;
  /** Library: an installed Motif to the trash. */
  onDelete: () => void;
  /** Project: take the library's version (update, or restore a broken copy). */
  onTakeLibrary: () => void;
  /** Project: save it to the library. */
  onSave: () => void;
  /** Project: remove it from the project's table. */
  onRemove: () => void;
}

export function MotifCard({ row, selected, fpsNum, fpsDen, ...actions }: MotifCardActions & {
  row: MotifRow; selected: boolean; fpsNum: number; fpsDen: number;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useCloseOnAnchorMove(menu ? card.current : null, closeMenu);
  const badge = row.group === 'project' ? projectRowBadge(row) : row.status;
  const take = row.group === 'project' ? libraryTake(row) : null;
  const unavailable = row.group === 'project' && row.status !== 'ok';
  return (
    <div ref={card} className={`motif-card${selected ? ' motif-card-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}
      onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      onKeyDown={e => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left + 12, y: rect.top + 12 });
      }}>
      <button type="button" className="motif-card-select" title={row.id} aria-pressed={selected} onClick={actions.onSelect}>
        {row.motif
          ? <MotifCover key={`${rowHost(row)}:${row.motif.content_hash}`} host={rowHost(row)} contentHash={row.motif.content_hash ?? ''} />
          : <div className="motif-preview-host motif-card-unavailable" style={{ maxWidth: "calc(240 * var(--ui-px))" }}>
            <span className="settings-error">{row.group === 'project' ? row.diagnostic : null}</span>
          </div>}
        <span className="motif-card-title">
          <span className="motif-card-name">{rowName(row)}</span>
          {badge && <span className={`motif-card-status status-${badge}`}>{t(`motif_picker.status.${badge}`)}</span>}
        </span>
      </button>
      <div className="motif-card-footer">
        <span className="motif-card-meta">
          {row.motif
            ? `${row.motif.size[0]}×${row.motif.size[1]} · ${formatTimecode(Math.round(row.motif.default_duration_s * 1_000_000), fpsNum, fpsDen)}`
            : row.id}
          {row.group === 'library' && row.in_project ? ` · ${t('motif_picker.in_project')}` : ''}
        </span>
        {take && (
          <Button variant="ghost" size="xs" title={t(`motif_picker.${take}_hint`)} onClick={actions.onTakeLibrary}>
            {t(`motif_picker.${take}_button`)}
          </Button>
        )}
        {row.motif && (
          <Button variant="ghost" size="icon-xs" title={t('motif_picker.export_button')}
            aria-label={t('motif_picker.export_button')} onClick={actions.onExport}>
            <AppIcon icon={FolderOutputIcon} size="title" aria-hidden />
          </Button>
        )}
      </div>
      {menu && <MotifCardMenu row={row} {...menu} onClose={closeMenu} {...actions} />}
    </div>
  );
}

function MotifCardMenu({ row, x, y, onClose, onExport, onHistory, onDelete, onTakeLibrary, onSave, onRemove }: Omit<MotifCardActions, 'onSelect'> & {
  row: MotifRow; x: number; y: number; onClose: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const take = row.group === 'project' ? libraryTake(row) : null;
  return <MenuPrimitive.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <MenuPrimitive.Portal>
      <AppMenuPositioner anchor={anchor} side="bottom" align="start" sideOffset={0} className="app-popup-positioner">
        <MenuPrimitive.Popup className="app-menu-list" finalFocus={contextMenuFinalFocus} aria-label={rowName(row)}>
          {take && <MenuItem label={t(`motif_picker.${take}_button`)} onSelect={onTakeLibrary} />}
          {row.group === 'project' && canSaveToLibrary(row) &&
            <MenuItem label={t('motif_picker.save_button')} onSelect={onSave} />}
          {row.motif && <MenuItem label={t('motif_picker.export_button')} onSelect={onExport} />}
          {row.group === 'library' && row.status === 'installed' &&
            <MenuItem label={t('motif_picker.history_button')} onSelect={onHistory} />}
          {row.group === 'library' && row.status === 'installed' &&
            <MenuItem label={t('motif_picker.delete_button')} onSelect={onDelete} />}
          {row.group === 'project' &&
            <MenuItem label={t('motif_picker.remove_button')} onSelect={onRemove} />}
        </MenuPrimitive.Popup>
      </AppMenuPositioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root>;
}

/** Only visible cards request covers. Main owns capture, deduplication and disk
 * persistence; this module owns visibility and the lifetime of its image URL. */
function MotifCover({ host: motifHost, contentHash }: { host: string; contentHash: string }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: host.current?.closest('.motif-picker-list') ?? null, rootMargin: '100px' });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let imageUrl: string | undefined;
    void getMotifCover(motifHost, contentHash).then(blob => {
      if (cancelled) return;
      imageUrl = URL.createObjectURL(blob);
      setUrl(imageUrl);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [visible, motifHost, contentHash]);
  return <div ref={host} className="motif-preview-host" style={{ maxWidth: "calc(240 * var(--ui-px))" }}>
    {url && <img src={url} alt={`preview-${motifHost}`} />}
    {!url && !error && <span className="motif-preview-loading" role="status" aria-label={t('motif_picker.preview_loading')} />}
    {error && <span className="settings-status">{t('motif_picker.cover_unavailable')}</span>}
  </div>;
}
