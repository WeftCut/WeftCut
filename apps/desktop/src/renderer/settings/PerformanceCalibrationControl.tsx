import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { CalibrationRecommendation, CalibrationSnapshot } from '../../shared/playback-calibration';
import { transportPause } from '../state/playbackStore';

export function PerformanceCalibrationControl({ disabled, accepted, onRunning, onApply, onError }: {
  disabled: boolean;
  accepted?: CalibrationRecommendation | null;
  onRunning: (running: boolean) => void;
  onApply: (recommendation: CalibrationRecommendation) => Promise<boolean>;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<CalibrationSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await window.api.performanceCalibration.status();
        if (alive) { setSnapshot(next); onRunning(next.running); }
      } catch (error) { if (alive) onError(String(error)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 500);
    return () => { alive = false; clearInterval(timer); };
  }, [onError, onRunning]);
  const run = async (cancel: boolean) => {
    setPending(true); onError('');
    try {
      if (!cancel) transportPause();
      const next = await window.api.performanceCalibration[cancel ? 'cancel' : 'start']();
      setSnapshot(next); onRunning(next.running);
    } catch (error) { onError(String(error)); }
    finally { setPending(false); }
  };
  const report = snapshot?.report;
  const recommendation = report?.state === 'complete' && !snapshot?.running ? report.recommendation : null;
  const applied = !!accepted && JSON.stringify(accepted) === JSON.stringify(recommendation);
  const progress = report?.cells.filter(cell => cell.status !== 'not-run').length ?? 0;
  const status = snapshot?.running ? t('performance.test_progress', { count: progress })
    : report?.state === 'cancelled' ? t('performance.test_cancelled')
    : report?.state === 'error' || (report?.state === 'complete' && !recommendation) ? t('performance.test_failed')
    : recommendation ? t(recommendation.conservative ? 'performance.test_conservative' : 'performance.test_complete',
      { count: recommendation.maximum.preview_gpu_sessions }) : '';
  return <div className="settings-performance-calibration">
    <p className="settings-toggle-hint">{t('performance.test_hint')}</p>
    <div className="settings-control-row">
      <Button variant="secondary" disabled={pending || (!snapshot?.running && (disabled || !snapshot?.available))}
        onClick={() => void run(!!snapshot?.running)}>
        {t(snapshot?.running ? 'performance.test_cancel' : 'performance.test_start')}
      </Button>
      {recommendation && <Button variant="secondary" disabled={disabled || pending || applied}
        onClick={async () => { setPending(true); try { await onApply(recommendation); } finally { setPending(false); } }}>
        {t(applied ? 'performance.test_applied' : 'performance.test_apply')}
      </Button>}
    </div>
    <p className="settings-toggle-hint" role="status">{status || (snapshot && !snapshot.available
      ? t(snapshot.unavailableReason === 'platform' ? 'performance.test_windows' : 'performance.test_missing') : '')}</p>
  </div>;
}
