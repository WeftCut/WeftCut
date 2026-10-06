import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AppNumberField } from '../components/AppNumberField';
import { AppSelect } from '../components/AppSelect';
import { readResourcePolicy, resolveResourcePolicy, type ResourcePolicyPatch, type ResourceStatus } from '../../shared/resource-policy';
import type { AppSettings, AppSettingsPatch } from '../../shared/app-settings';

export function ResourceControls({ settings, disabled, save }: {
  settings: AppSettings; disabled: boolean; save(patch: AppSettingsPatch): Promise<AppSettings | null>;
}) {
  const { t } = useTranslation();
  const policy = readResourcePolicy(settings.resource_policy);
  const allocation = settings.resource_allocation ?? resolveResourcePolicy(policy);
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [failed, setFailed] = useState<ResourcePolicyPatch | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void window.api?.resources?.status().then(s => { if (alive) setStatus(s); }).catch(() => {}); };
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const commit = async (patch: ResourcePolicyPatch) => {
    const rev = ++revision.current;
    const after = await save({ resource_policy: patch });
    if (rev === revision.current) setFailed(after ? null : patch);
  };
  return <>
    <ResourceNumber label={t('resources.memory')} hint={t('resources.memory_hint')} value={allocation.memory_mib / 1024}
      min={1} max={256} disabled={disabled} save={value => commit({ memory_mib: Math.round(value * 1024) })} />
    <div className="settings-control-row">
      <div className="settings-performance-copy"><span className="settings-toggle-label">{t('resources.processing')}</span>
        <p className="settings-toggle-hint">{t('resources.processing_hint')}</p></div>
      <AppSelect className="settings-select settings-performance-processing" ariaLabel={t('resources.processing')} disabled={disabled} value={policy.processing}
        onValueChange={value => void commit({ processing: value as 'low' | 'balanced' | 'high' })}
        options={(['low', 'balanced', 'high'] as const).map(value => ({ value, label: t('resources.' + value) }))} />
    </div>
    <ResourceNumber label={t('resources.disk')} hint={t('resources.disk_hint')} value={policy.disk_cache_mib / 1024}
      min={.25} max={1024} disabled={disabled} save={value => commit({ disk_cache_mib: Math.round(value * 1024) })} />
    <label className="settings-control-row"><div className="settings-performance-copy">
      <span className="settings-toggle-label">{t('resources.background')}</span>
      <p className="settings-toggle-hint">{t('resources.background_hint')}</p></div>
      <input type="checkbox" checked={policy.background_playback} disabled={disabled}
        onChange={e => void commit({ background_playback: e.target.checked })} />
    </label>
    {failed && <div className="settings-performance-actions"><span role="alert">{t('performance.save_failed')}</span>
      <Button variant="secondary" onClick={() => void commit(failed)}>{t('performance.retry_save')}</Button></div>}
    {status && <p className="settings-toggle-hint" role="status">{t(status.pressure === 'constrained' ? 'resources.constrained' : 'resources.normal')}
      {status.memory_mib !== null && <>{' '}{t('resources.usage', { used: (status.memory_mib / 1024).toFixed(1) })}</>}
      {status.waiting > 0 && <>{' '}{t('resources.waiting', { count: status.waiting })}</>}</p>}
  </>;
}
function ResourceNumber({ label, hint, value, min, max, disabled, save }: {
  label: string; hint: string; value: number; min: number; max: number; disabled: boolean; save(value: number): Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <div className="settings-control-row settings-performance-row">
    <div className="settings-performance-copy"><span className="settings-toggle-label">{label}</span><p className="settings-toggle-hint">{hint}</p></div>
    <div className="settings-performance-value"><AppNumberField value={draft} min={min} max={max} step={.25}
      ariaLabel={label} disabled={disabled} className="settings-input" format={{ maximumFractionDigits: 2 }}
      onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
      onValueChange={setDraft} onCommit={v => { if (v !== value) void save(v); }} />
      <span className="settings-slider-unit">GiB</span></div>
  </div>;
}
