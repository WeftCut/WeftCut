import { useMediaById, useProjectStore } from '../state/projectStore';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { retimeLayers, setPreservePitch, type LayerSummary } from '../ipc';
import { useSelectedLayerIds } from '../state/selectionStore';
import { AppNumberField } from '../components/AppNumberField';
import { Button } from '@/components/ui/button';
import { Field } from './Field';
import { exactTime } from '../timeMapping';
import { layerRateNumber, layerContentTiming } from '../layerTiming';
import { refusalText } from '../errors/tryMutate';
import type { RetimeTarget } from '../../shared/timeMapping';

import { planRetime, type RetimeClip } from '../retimePlan';
import { gridForLayerKind } from '../grid';

export function RetimeFields({ layer, disabled, onMutated }: {
  layer: LayerSummary; disabled: boolean; onMutated: () => void;
}) {
  const { t } = useTranslation();
  const summary = useProjectStore(s => s.summary);
  const selected = useSelectedLayerIds();
  const media = useMediaById(layer.params.kind === 'ImageOverlay' ? layer.params.media_id : null);
  const animatedImage = (media?.duration_us ?? 0) > 0;
  const supported = ['VideoClip', 'Audio', 'Motif', 'CompositionRef', 'ImageOverlay'].includes(layer.params.kind) && (layer.params.kind !== 'ImageOverlay' || animatedImage);
  const rate = layerRateNumber(layer.params);
  const duration = (layer.t_end_us - layer.t_start_us) / 1e6;
  const [applyToSelection, setApplyToSelection] = useState(false);
  useEffect(() => setApplyToSelection(false), [layer.id, selected]);
  const [rateInput, setRateInput] = useState(rate);
  const [durationInput, setDurationInput] = useState(duration);
  const [editing, setEditing] = useState<'Rate' | 'Duration' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRateInput(rate); setDurationInput(duration); setEditing(null); setError(null); }, [layer.id, rate, duration]);
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
  const draftTarget = editing ? targetFor(editing, editing === 'Rate' ? rateInput : durationInput) : null;
  const draft = draftTarget ? preview(draftTarget) : null;
  const actual = draft?.ok ? draft.edits.find(e => e.layer_id === layer.id) : null;
  const previewError = draft && !draft.ok ? t('retime.conflicts.' + draft.conflict.kind) : null;
  const selectedLayers = summary ? Object.values(summary.compositions).flatMap(c => c.tracks.flatMap(track => track.layers)).filter(l => ids.includes(l.id)) : [];
  const mixed = selectedLayers.some(l => layerRateNumber(l.params) !== rate || (l.t_end_us - l.t_start_us) / 1e6 !== duration);
  const commit = (kind: 'Rate' | 'Duration', value: number) => {
    const target = targetFor(kind, value);
    if (target) void apply(target);
    else setError(t('retime.conflicts.InvalidTarget'));
  };
  const apply = async (target: RetimeTarget) => {
    const plan = preview(target);
    if (plan && !plan.ok) { setError(t('retime.conflicts.' + plan.conflict.kind)); setRateInput(rate); setDurationInput(duration); return; }
    setBusy(true); setError(null);
    try { await retimeLayers(ids, target); onMutated(); }
    catch (e) { setError(refusalText(e)); setRateInput(rate); setDurationInput(duration); }
    finally { setBusy(false); }
  };
  return <>
    {selected.has(layer.id) && selected.size > 1 && <label className="prop-hint">
      <input type="checkbox" checked={applyToSelection} disabled={disabled || busy} onChange={e => setApplyToSelection(e.target.checked)} /> {t('retime.apply_selection', { count: selected.size })}
    </label>}
    <Field label={t('retime.rate')} hint={t('retime.hint', { count: ids.length })}>
      <AppNumberField value={rateInput} min={0.000001} step={0.05} disabled={disabled || busy}
        ariaLabel={t('retime.rate')} onValueChange={v => { setEditing('Rate'); setRateInput(v); }}
        onCommit={v => commit('Rate', v)} />
    </Field>
    <Field label={t('retime.duration')}>
      <AppNumberField value={durationInput} min={0.000001} step={0.1} disabled={disabled || busy}
        ariaLabel={t('retime.duration')} onValueChange={v => { setEditing('Duration'); setDurationInput(v); }}
        onCommit={v => commit('Duration', v)} />
    </Field>
    <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void apply({ kind: 'Rate', value: { num: 1, den: 1 } })}>{t('retime.reset')}</Button>
    {layer.params.kind === 'Audio' || layer.params.kind === 'CompositionRef' ? <label className="prop-hint">
      <input type="checkbox" checked={layer.params.preserve_pitch !== false} disabled={disabled || busy}
        onChange={e => { setBusy(true); void setPreservePitch(ids, e.target.checked).then(onMutated).catch(e => setError(refusalText(e))).finally(() => setBusy(false)); }} /> {t('retime.pitch')}
    </label> : null}
    {layer.params.kind !== 'Audio' && <Field label={t('retime.sampling')} hint={t('retime.sampling_hint')}><span className="prop-hint">{t('retime.sampling')}</span></Field>}
    <p className="prop-hint">{t('retime.preview', { rate: Number((actual ? actual.actual_rate.num / actual.actual_rate.den : rate).toPrecision(8)), duration: actual ? actual.duration_us / 1e6 : duration })}</p>
    {mixed && <p className="prop-hint">{t('retime.mixed')}</p>}
    {(error || previewError) && <p role="alert" className="prop-hint">{error || previewError}</p>}
  </>;
}
