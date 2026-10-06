import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon } from 'lucide-react';
import { PerformanceCalibrationControl } from './PerformanceCalibrationControl';
import type { AppSettings, AppSettingsPatch } from '../../shared/app-settings';
import { MIB } from '../../shared/performance-settings';
import type { PerformanceResourceInfo } from '../../shared/performance-budgets';
import { setAppSettings, useAppSettingsStore } from './appSettingsStore';
import { cacheBudget } from '../render/cacheBudget';
import { ResourceControls } from './ResourceControls';

type Save = (patch: AppSettingsPatch) => Promise<AppSettings | null>;

export function PerformanceSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const appSettings = useAppSettingsStore(s => s.settings);
  const loaded = useAppSettingsStore(s => s.loaded);
  const profile = appSettings.performance_test_profile;
  const compatible = appSettings.performance_test_compatible;
  const [resources, setResources] = useState<PerformanceResourceInfo | null>(null);
  const [cacheUsage, setCacheUsage] = useState(() => cacheBudget.snapshot());
  const [resourceFailed, setResourceFailed] = useState(false);
  const [pending, setPending] = useState(0);
  const [testing, setTesting] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [testExpanded, setTestExpanded] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const advancedId = useId();
  const testId = useId();
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (alive) setCacheUsage(cacheBudget.snapshot());
      try {
        const info = await window.api.performanceResources.info();
        if (alive) { setResources(info); setResourceFailed(false); }
      } catch { if (alive) setResourceFailed(true); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  // Queue writes without disabling or blurring an input while typing. Main
  // merges each partial intent against disk, including other windows' edits.
  const commit: Save = patch => {
    setPending(n => n + 1); onError('');
    const task = queue.current.then(() => setAppSettings(patch));
    queue.current = task.catch(() => {});
    return task.then(after => { onError(''); return after; }, error => { onError(String(error)); return null; })
      .finally(() => setPending(n => n - 1));
  };
  const gpu = resources?.gpu_buffers;
  return <>
    <section className="settings-section">
      <h3>{t('performance.hardware_heading')}</h3>
      <dl className="settings-performance-allocation">
        <div><dt>{t('performance.hardware_ram')}</dt><dd>{resources && !resourceFailed
          ? `${(resources.total_memory_mib / 1024).toFixed(1)} GiB` : t('performance.unknown')}</dd></div>
        <div><dt>{t('performance.hardware_gpu')}</dt><dd>{resources?.gpu?.name ?? t('performance.unknown')}</dd></div>
        <div><dt>{t('performance.hardware_vram')}</dt><dd>{resources?.gpu
          ? resources.gpu.dedicatedMemoryMib > 512 ? `${(resources.gpu.dedicatedMemoryMib / 1024).toFixed(1)} GiB`
            : t('performance.shared_gpu_memory') : t('performance.unknown')}</dd></div>
      </dl>
    </section>
    <section className="settings-section">
      <h3>{t('performance.budgets_heading')}</h3>
      <ResourceControls settings={appSettings} disabled={!loaded} save={commit} />
      <div className="settings-performance-actions">
        <Button variant="secondary" disabled={!loaded || pending > 0}
          onClick={() => void commit({ resource_policy: null, performance_action: 'restore_defaults' })}>{t('performance.restore_defaults')}</Button>
      </div>
    </section>
    <section className="settings-section">
      <Button variant="ghost" className="settings-performance-disclosure" aria-expanded={advanced}
        aria-controls={advancedId} onClick={() => setAdvanced(open => !open)}>
        <ChevronDownIcon size={14} aria-hidden="true" />{t('performance.details_heading')}
      </Button>
      <div id={advancedId} hidden={!advanced}>
        <p className="settings-toggle-hint" data-testid="performance-cache-usage">{t('performance.cache_usage', {
          used: (cacheUsage.total / MIB).toFixed(1), limit: (cacheUsage.limit / MIB).toFixed(1),
        })}</p>
        {resourceFailed ? <p className="settings-toggle-hint" role="status">{t('performance.resources_unavailable')}</p>
          : null}
        {!resourceFailed && gpu && <p className="settings-toggle-hint" data-testid="performance-gpu-usage">{t('performance.budget_gpu_usage', {
          used: (gpu.used_bytes / MIB).toFixed(1), limit: (gpu.limit_bytes / MIB).toFixed(0),
        })}</p>}
        <p className="settings-toggle-hint">{t('performance.activation')}</p>
      </div>
    </section>
    <section className="settings-section">
      <Button variant="ghost" className="settings-performance-disclosure" aria-expanded={testExpanded || testing}
        aria-controls={testId} disabled={testing} onClick={() => setTestExpanded(open => !open)}>
        <ChevronDownIcon size={14} aria-hidden="true" />{t('performance.test_heading')}
      </Button>
      <div id={testId} hidden={!testExpanded && !testing}>
        <p className="settings-toggle-hint">{t('performance.test_scope')}</p>
        <PerformanceCalibrationControl disabled={!loaded || pending > 0} accepted={compatible ? profile?.calibration ?? null : null}
          onRunning={setTesting} onError={onError}
          onApply={async recommendation => !!await commit({ performance_test_recommendation: recommendation })} />
        {profile && <>
          <p className="settings-toggle-hint" data-testid="performance-test-record">{t(profile.calibration.conservative
            ? 'performance.test_record_conservative' : 'performance.test_record', {
            date: new Date(profile.saved_at).toLocaleString(), version: profile.app_version || '—',
            count: profile.calibration.maximum.preview_gpu_sessions,
          })}</p>
          <p className="settings-toggle-hint">{t('performance.test_record_budgets', {
            cache: profile.budgets.cache_mib, gpu: profile.budgets.gpu_buffer_mib,
          })}</p>
          {!compatible && <p className="settings-toggle-hint">{t('performance.test_stale')}</p>}
          <div className="settings-performance-actions">
            <Button variant="secondary" disabled={!loaded || pending > 0 || testing || !compatible}
              onClick={() => void commit({ performance_action: 'restore_tested' })}>{t('performance.restore_tested')}</Button>
            <Button variant="ghost" disabled={!loaded || pending > 0 || testing}
              onClick={() => void commit({ performance_action: 'clear_test' })}>{t('performance.clear_test')}</Button>
          </div>
        </>}
      </div>
    </section>
  </>;
}
