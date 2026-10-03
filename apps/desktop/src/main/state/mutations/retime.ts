import type { Animated, Layer, Project } from '../model';
import type { FrameInterpolation, RetimeTarget, TimingFields } from '../../../shared/timeMapping';
import { TimeMappingError } from '../../../shared/timeMapping';
import { planRetime, type RetimeClip } from '../../../renderer/retimePlan';
import { addTime, exactTime, multiplyTime, ZERO_TIME } from '../../../renderer/timeMapping';
import { keyTimeExact, layerContentTiming, splitExact, writeKeyTime, writeLayerTiming } from '../../../renderer/layerTiming';
import { gridForLayerKind, layerOverlapClass } from '../snap';
import { eachLayer } from '../model';
import { applyDurationAutofit, requireLayer, checkLayerEditable } from './helpers';
import { forEachAnimatedF64, forEachAnimatedRgba } from './animated';
import { CommandFailure } from '../errors';
import { validate } from '../validate';

export function canRetime(p: Project, layer: Layer): boolean {
  const pa = layer.params;
  if (pa.kind === 'ImageOverlay') {
    const media = p.media_pool[pa.media];
    return (media?.metadata.video?.nb_frames ?? 0) > 1 || (media?.metadata.duration_us ?? 0) > 0;
  }
  return ['VideoClip', 'Audio', 'Motif', 'CompositionRef'].includes(pa.kind);
}

export function applyRetimeLayers(p: Project, ids: readonly string[], target: RetimeTarget) {
  try {
    const clips: RetimeClip[] = [];
    for (const { layer, track, composition: comp } of eachLayer(p)) {
      clips.push({ id: layer.id, composition_id: comp.id, track_id: track.id,
        t_start_us: layer.t_start_us, t_end_us: layer.t_end_us,
        grid: gridForLayerKind(layer.params.kind, comp.fps), overlap_class: layerOverlapClass(layer.params),
        timing: canRetime(p, layer) ? layerContentTiming(layer) : null,
        locked: layer.locked || track.locked,
        ...(layer.params.kind === 'CompositionRef' ? { composition_ref: layer.params.composition } : {}),
      });
    }
    const plan = planRetime({ clips, transitions: Object.values(p.compositions).flatMap(c => c.transitions), layer_ids: ids, target });
    if (!plan.ok) throw new CommandFailure({ error: 'RetimeRejected', reason: { ...plan.conflict } });
    for (const edit of plan.edits) {
      const { layer } = requireLayer(p, edit.layer_id);
      const scale = <T>(track: Animated<T>) => {
        if (track.mode === 'Keyframed') for (const key of track.value) writeKeyTime(key, multiplyTime(keyTimeExact(key), edit.animation_scale));
      };
      forEachAnimatedF64(layer.params, scale);
      forEachAnimatedRgba(layer.params, scale);
      for (const effect of layer.effects) for (const track of Object.values(effect.params)) scale(track);
      if ('fade_in_us' in layer.params) {
        const pa = layer.params;
        const a = splitExact(multiplyTime(addTime(exactTime(pa.fade_in_us), pa.fade_phase?.in ?? ZERO_TIME), edit.animation_scale));
        const b = splitExact(multiplyTime(addTime(exactTime(pa.fade_out_us), pa.fade_phase?.out ?? ZERO_TIME), edit.animation_scale));
        pa.fade_in_us = a.whole; pa.fade_out_us = b.whole;
        if (a.fraction.num || b.fraction.num) pa.fade_phase = { in: a.fraction, out: b.fraction };
        else delete pa.fade_phase;
      }
      writeLayerTiming(layer, edit.timing);
      layer.t_end_us = edit.t_end_us;
    }
    for (const c of Object.values(p.compositions)) applyDurationAutofit(c);
    validate(p);
    return { layers: plan.edits };
  } catch (e) {
    if (e instanceof TimeMappingError) throw new CommandFailure({ error: 'RetimeRejected', reason: { kind: 'Numeric', reason: e.code } });
    throw e;
  }
}

export function applyPreservePitch(p: Project, ids: readonly string[], preserve: boolean): void {
  if (!ids.length || typeof preserve !== 'boolean') throw new CommandFailure({ error: 'InvalidArgument', field: 'preserve_pitch', detail: 'Select audio or Group clips and a boolean pitch policy' });
  for (const id of new Set(ids)) {
    const { layer } = checkLayerEditable(p, id);
    if (layer.params.kind !== 'Audio' && layer.params.kind !== 'CompositionRef') throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: `Clip ${id} has no independent audio timing policy` });
    layer.params.preserve_pitch = preserve;
  }
}

export function interpolationCapabilities(p: Project, ids: readonly string[], purpose: 'Preview' | 'Export') {
  return { purpose, layers: ids.map(id => {
    const { layer } = requireLayer(p, id);
    const visual = layer.params.kind !== 'Audio' && canRetime(p, layer);
    return { layer_id: id, modes: ['FrameSampling', 'FrameBlending', 'OpticalFlow'].map(kind => ({ kind,
      available: visual && kind === 'FrameSampling', reason: !visual ? 'NoTemporalVisualContent' : kind === 'FrameSampling' ? null : 'NotImplemented' })) };
  }) };
}
export function applyFrameInterpolation(p: Project, ids: readonly string[], interpolation: FrameInterpolation) {
  if (!ids.length || interpolation?.kind !== 'FrameSampling') throw new CommandFailure({ error: 'InvalidArgument', field: 'interpolation', detail: 'Only FrameSampling is available in this build' });
  for (const id of new Set(ids)) {
    const { layer } = requireLayer(p, id);
    if (layer.params.kind === 'Audio' || !canRetime(p, layer)) throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: `Clip ${id} has no temporal visual content` });
    (layer.params as TimingFields).frame_interpolation = { kind: 'FrameSampling' };
  }
  return { layer_ids: [...new Set(ids)], interpolation };
}
