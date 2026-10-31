import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect } from '../components/AppSelect';
import { setPlaybackResolution, usePlaybackResolution } from '../settings/appSettingsStore';
import type { PlaybackResolution } from '../../shared/app-settings';

const MODES: PlaybackResolution[] = ['full', 'half', 'quarter'];

/** One persisted preview-only setting shared with Settings and Quick Actions.
 * Export routing, project dimensions and output settings are never modified. */
export function PreviewQualityControl() {
  const { t } = useTranslation();
  const resolution = usePlaybackResolution();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const change = async (value: string) => {
    if (!MODES.includes(value as PlaybackResolution) || value === resolution || inFlight.current) return;
    inFlight.current = true; setPending(true); setError('');
    try { await setPlaybackResolution(value as PlaybackResolution); }
    catch { setError(t('preview.quality_error')); }
    finally { inFlight.current = false; setPending(false); }
  };
  return (
    <div className="preview-quality-control" title={t('preview.quality_hint')}>
      <AppSelect value={resolution} onValueChange={value => { void change(value); }}
        disabled={pending} ariaLabel={t('preview.quality_label')} className="preview-quality-select"
        popupClassName="preview-select-popup"
        options={MODES.map(value => ({ value, label: t(`preview.quality_${value}`) }))} />
      {error && <span className="preview-quality-error" role="alert">{error}</span>}
    </div>
  );
}
