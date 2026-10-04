import { useMediaById, useProjectStore } from '../state/projectStore';
import { useEffect, useRef, useState } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { retimeLayers, setPreservePitch, type LayerSummary } from '../ipc';
import { useSelectedLayerIds } from '../state/selectionStore';
import { AppInput } from '../components/AppInput';
import { AppTimecodeField } from '../components/AppTimecodeField';
import { formatAudioTime, parseAudioTime, useAudioUnits } from '../state/audioUnitsStore';
import { Button } from '@/components/ui/button';
import { Field } from './Field';
import { exactTime } from '../timeMapping';
import { layerRateNumber, layerContentTiming } from '../layerTiming';
import { refusalText } from '../errors/tryMutate';
import type { RetimeTarget } from '../../shared/timeMapping';

import { planRetime, type RetimeClip } from '../retimePlan';
import { gridForLayerKind } from '../grid';

export function RetimeFields({ layer, disabled, onMutated, fpsNum, fpsDen }: {
  layer: LayerSummary; disabled: boolean; onMutated: () => void | Promise<void>;
  fpsNum: number; fpsDen: number;
}) {
  const { t } = useTranslation();
  const summary = useProjectStore(s => s.summary);
  const selected = useSelectedLayerIds();
  const media = useMediaById(layer.params.kind === 'ImageOverlay' ? layer.params.media_id : null);
  const animatedImage = (media?.duration_us ?? 0) > 0;
  const supported = ['VideoClip', 'Audio', 'Motif', 'CompositionRef', 'ImageOverlay'].includes(layer.params.kind) && (layer.params.kind !== 'ImageOverlay' || animatedImage);
  const rate = layerRateNumber(layer.params);
  const duration = (layer.t_end_us - layer.t_start_us) / 1e6;
  const audioUnits = useAudioUnits();
  const units = layer.params.kind === 'Audio' ? audioUnits : 'frames';
  const formatDuration = (us: number) => formatAudioTime(us, units, fpsNum, fpsDen);
  const durationEdited = useRef(false);
  const [durationReset, setDurationReset] = useState(0);
  const [applyToSelection, setApplyToSelection] = useState(false);
  useEffect(() => setApplyToSelection(false), [layer.id, selected]);
  const [rateInput, setRateInput] = useState(rate);
  const [rateOpen, setRateOpen] = useState(false);
  const [rateText, setRateText] = useState(String(rate));
  const rateCancelled = useRef(false);
  const [durationInput, setDurationInput] = useState(() => formatDuration(duration * 1e6));
  const [editing, setEditing] = useState<'Rate' | 'Duration' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRateInput(rate);
    setRateOpen(false);
    setDurationInput(formatDuration(duration * 1e6));
    durationEdited.current = false;
    setEditing(null);
    setError(null);
    // The formatter depends only on the unit and frame rate below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, layer.t_start_us, rate, duration, units, fpsNum, fpsDen]);
  if (!supported) return null;
  const ids = applyToSelection && selected.has(layer.id) ? [...selected] : [layer.id];
  const preview = (target: RetimeTarget) => {
    if (!summary) return null;
    const clips: RetimeClip[] = Object.values(summary.compositions).flatMap(c => c.tracks.flatMap(track => track.layers.map(l => ({
      id: l.id, composition_id: c.id, track_id: track.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us,
      grid: gridForLayerKind(l.params.kind, { num: c.fps_num, den: c.fps_den }), overlap_class: l.params.kind === 'Audio' ? 'audio' as const : 'visual' as const,
      timing: ['VideoClip', 'Audio', 'Motif', 'CompositionRef'].includes(l.params.kind) || (l.params.kind === 'ImageOverlay' && summary.media.some(m => m.id === ('media_id' in l.params ? l.params.media_id : null) && (m.duration_us ?? 0) > 0)) ? layerContentTiming(l) : null,
      locked: l.locked || track.locked, ...(l.params.kind === 'CompositionRef' ? { composition_ref: l.params.composition_id } : {}),
    }))));
    return planRetime({ clips, transitions: Object.values(summary.compositions).flatMap(c => c.transitions), layer_ids: ids, target });
  };
  const targetFor = (kind: 'Rate' | 'Duration', value: number): RetimeTarget | null => {
    const units = Math.round(value * 1e6);
    if (!Number.isSafeInteger(units) || units <= 0) return null;
    return kind === 'Rate' ? { kind, value: exactTime(units, 1e6) } : { kind, duration_us: units };
  };
  const durationUs = parseAudioTime(durationInput, units, fpsNum, fpsDen);
  const draftTarget = editing ? targetFor(editing, editing === 'Rate' ? rateInput : (durationUs ?? 0) / 1e6) : null;
  const draft = draftTarget ? preview(draftTarget) : null;
  const previewError = editing && !draftTarget ? t('retime.conflicts.InvalidTarget')
    : draft && !draft.ok ? t('retime.conflicts.' + draft.conflict.kind) : null;
  const selectedLayers = summary ? Object.values(summary.compositions).flatMap(c => c.tracks.flatMap(track => track.layers)).filter(l => ids.includes(l.id)) : [];
  const mixed = selectedLayers.some(l => layerRateNumber(l.params) !== rate || (l.t_end_us - l.t_start_us) / 1e6 !== duration);
  const commit = (kind: 'Rate' | 'Duration', value: number) => {
    const target = targetFor(kind, value);
    if (target) void apply(target);
    else setError(t('retime.conflicts.InvalidTarget'));
  };
  const resetInputs = () => {
    durationEdited.current = false;
    setRateInput(rate);
    setDurationInput(formatDuration(duration * 1e6));
    setDurationReset(n => n + 1);
    setEditing(null);
  };
  const commitDuration = (us: number | null) => {
    // Merely focusing a field (or cancelling with Escape) must not retime it.
    if (!durationEdited.current) return;
    durationEdited.current = false;
    if (!mixed && us !== null && formatDuration(us) === formatDuration(duration * 1e6)) {
      setEditing(null);
      return;
    }
    if (us === null || us <= 0) {
      setError(t('retime.conflicts.InvalidTarget'));
      resetInputs();
      return;
    }
    commit('Duration', us / 1e6);
  };
  const apply = async (target: RetimeTarget) => {
    if (disabled || busy) return;
    const plan = preview(target);
    if (plan && !plan.ok) { setError(t('retime.conflicts.' + plan.conflict.kind)); resetInputs(); return; }
    setBusy(true); setError(null);
    try {
      await retimeLayers(ids, target);
      setEditing(null);
      await onMutated();
    }
    catch (e) { setError(refusalText(e)); resetInputs(); }
    finally { setBusy(false); }
  };
  const cancelDuration = () => {
    durationEdited.current = false;
    setEditing(null);
    setError(null);
    setDurationInput(formatDuration(duration * 1e6));
  };
  const finishRate = () => {
    if (rateCancelled.current) return;
    setRateOpen(false);
    const value = Number(rateText);
    if (!mixed && value === rate) { setEditing(null); return; }
    commit('Rate', value);
  };
  return <>
    {selected.has(layer.id) && selected.size > 1 && <label className="prop-hint">
      <input type="checkbox" checked={applyToSelection} disabled={disabled || busy} onChange={e => setApplyToSelection(e.target.checked)} /> {t('retime.apply_selection', { count: selected.size })}
    </label>}
    <div className="prop-retime-row">
      <Field as="div" label={t('retime.title')} hint={t('retime.hint')}>
        {units === 'frames' ? <AppTimecodeField
          key={durationReset} valueUs={duration * 1e6} fpsNum={fpsNum} fpsDen={fpsDen}
          ariaLabel={t('retime.duration')} disabled={disabled || busy} invalid={editing === 'Duration' && !!previewError}
          onValueChange={us => {
            durationEdited.current = true;
            setError(null); setEditing('Duration'); setDurationInput(formatDuration(us));
          }}
          onCommit={commitDuration} onCancel={cancelDuration}
        /> : <AppInput value={durationInput} mono ariaLabel={t('retime.duration')}
          disabled={disabled || busy} invalid={editing === 'Duration' && !!previewError} onCancel={cancelDuration}
          onValueChange={value => {
            durationEdited.current = true;
            setError(null); setEditing('Duration'); setDurationInput(value);
          }}
          onBlur={() => commitDuration(durationUs)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />}
        <div className="prop-retime-multiplier" title={t('retime.rate')}>
          {rateOpen ? <>
            <AppInput value={rateText} mono autoFocus inputMode="decimal" ariaLabel={t('retime.rate')}
              disabled={disabled || busy} invalid={editing === 'Rate' && !!previewError}
              onFocus={event => event.currentTarget.select()}
              onValueChange={value => { setRateText(value); setRateInput(Number(value)); setEditing('Rate'); setError(null); }}
              onBlur={finishRate}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
              onCancel={() => {
                rateCancelled.current = true;
                setRateOpen(false); setRateInput(rate); setEditing(null); setError(null);
              }} />
            <span className="prop-retime-multiplier-suffix" aria-hidden="true">×</span>
          </> : <Button size="xs" variant="ghost" className="prop-retime-rate-readout"
            aria-label={t('retime.rate')} disabled={disabled || busy}
            onClick={() => {
              rateCancelled.current = false;
              setRateText(String(rate)); setRateInput(rate); setError(null); setRateOpen(true);
            }}>
            {rate.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 8 })}×
          </Button>}
        </div>
        <Button size="icon-xs" variant="ghost" aria-label={t('retime.reset')} title={t('retime.reset')}
          disabled={disabled || busy}
          onClick={() => void apply({ kind: 'Rate', value: { num: 1, den: 1 } })}>
          <RotateCcwIcon size={12} aria-hidden="true" />
        </Button>
      </Field>
    </div>
    {layer.params.kind === 'Audio' || layer.params.kind === 'CompositionRef' ? <label className="prop-hint">
      <input type="checkbox" checked={layer.params.preserve_pitch !== false} disabled={disabled || busy}
        onChange={e => { setBusy(true); void setPreservePitch(ids, e.target.checked).then(onMutated).catch(e => setError(refusalText(e))).finally(() => setBusy(false)); }} /> {t('retime.pitch')}
    </label> : null}
    {mixed && <p className="prop-hint">{t('retime.mixed')}</p>}
    {(error || previewError) && <p role="alert" className="prop-hint">{error || previewError}</p>}
  </>;
}
