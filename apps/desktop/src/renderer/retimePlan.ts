// Shared pure planning seam. The actor and inspector must adapt their current
// snapshot into this input and call the SAME planner; committing a saved UI
// plan is forbidden. No project mutation, link expansion or neighbour movement.
import { TimeMappingError, type ContentTiming, type ExactTime, type RetimeTarget, type TimeMappingErrorCode } from '../shared/timeMapping';
import { timeUsAtFrame } from './eval';
import { type Grid, isCanonicalOnGrid, snapDownOnGrid } from './grid';
import {
  UNIT_RATE, ZERO_TIME, addTime, compareTime, contentRateAt,
  divideTime, exactTime, multiplyTime, readContentTiming, readExactTime,
  retimeTiming, roundTime, subtractTime,
} from './timeMapping';

/** Include ALL placed clips (also disabled/locked/unselected ones), and every
 * composition reference, so occupancy and ancestor checks see the full graph.
 * Unsupported content has timing=null. `locked` folds the clip and track lock. */
export interface RetimeClip {
  readonly id: string;
  readonly composition_id: string;
  readonly track_id: string;
  readonly overlap_class: 'audio' | 'visual';
  readonly t_start_us: number;
  readonly t_end_us: number;
  readonly grid: Grid;
  readonly timing: ContentTiming | null;
  readonly locked: boolean;
  readonly composition_ref?: string;
}

export interface RetimeTransition {
  readonly id: string;
  readonly from_layer: string;
  readonly to_layer: string;
  readonly duration_us: number;
  readonly extended_us: number;
}

export interface RetimeEdit {
  readonly layer_id: string;
  readonly t_start_us: number;
  readonly t_end_us: number;
  readonly duration_us: number;
  readonly timing: ContentTiming;
  readonly animation_scale: ExactTime;
  /** Exact requested duration before endpoint snapping. */
  readonly requested_duration: ExactTime;
  readonly requested_rate: ExactTime;
  readonly actual_rate: ExactTime;
  readonly rate_delta: ExactTime;
}

export type RetimeConflict =
  | { readonly kind: 'EmptyTargets' }
  | { readonly kind: 'LayerMissing' | 'Locked' | 'UnsupportedContent'; readonly layer_id: string }
  | { readonly kind: 'NestedTargets'; readonly ancestor_id: string; readonly descendant_id: string }
  | { readonly kind: 'InvalidSnapshot'; readonly layer_id: string }
  | { readonly kind: 'InvalidTarget' }
  | { readonly kind: 'Numeric'; readonly reason: TimeMappingErrorCode }
  | { readonly kind: 'DurationTooShort'; readonly layer_id: string; readonly requested_duration: ExactTime }
  | { readonly kind: 'Transition'; readonly transition_id: string }
  | { readonly kind: 'Collision'; readonly layer_id: string; readonly blocking_layer_id: string;
      readonly requested_duration: ExactTime; readonly maximum_duration_us: number | null;
      readonly minimum_rate: ExactTime | null };

export type RetimePlan =
  | { readonly ok: true; readonly edits: readonly RetimeEdit[] }
  | { readonly ok: false; readonly conflict: RetimeConflict };

export interface RetimePlanInput {
  readonly clips: readonly RetimeClip[];
  readonly transitions: readonly RetimeTransition[];
  readonly layer_ids: readonly string[];
  readonly target: RetimeTarget;
}

const refused = (conflict: RetimeConflict): RetimePlan => ({ ok: false, conflict });

function validateTarget(target: RetimeTarget): void {
  if (!target || typeof target !== 'object') throw new TimeMappingError('InvalidRange');
  if (target.kind === 'Rate') {
    if (compareTime(readExactTime(target.value), ZERO_TIME) <= 0) throw new TimeMappingError('NonPositiveRate');
  } else if (target.kind === 'Duration') {
    if (compareTime(exactTime(target.duration_us), ZERO_TIME) <= 0) throw new TimeMappingError('InvalidRange');
  } else {
    throw new TimeMappingError('InvalidRange');
  }
}

function validPlacement(clip: RetimeClip): boolean {
  return Number.isSafeInteger(clip.t_start_us) && clip.t_start_us >= 0
    && Number.isSafeInteger(clip.t_end_us) && clip.t_end_us > clip.t_start_us
    && Number.isInteger(clip.grid.num) && clip.grid.num > 0 && clip.grid.num <= 0xffff_ffff
    && Number.isInteger(clip.grid.den) && clip.grid.den > 0 && clip.grid.den <= 0xffff_ffff
    && isCanonicalOnGrid(clip.t_start_us, clip.grid) && isCanonicalOnGrid(clip.t_end_us, clip.grid);
}

function descendantOf(ancestor: RetimeClip, child: RetimeClip, clips: readonly RetimeClip[]): boolean {
  const pending = ancestor.composition_ref ? [ancestor.composition_ref] : [];
  const visited = new Set<string>();
  while (pending.length) {
    const composition = pending.pop()!;
    if (composition === child.composition_id) return true;
    if (visited.has(composition)) continue;
    visited.add(composition);
    for (const clip of clips) {
      if (clip.composition_id === composition && clip.composition_ref) pending.push(clip.composition_ref);
    }
  }
  return false;
}

function makeEdit(clip: RetimeClip, target: RetimeTarget): RetimeEdit {
  const timing = readContentTiming(clip.timing);
  const contentSpan = subtractTime(timing.content_out, timing.content_in);
  const requestedDuration = target.kind === 'Rate' ? divideTime(contentSpan, target.value) : exactTime(target.duration_us);
  const requestedRate = target.kind === 'Rate' ? target.value : divideTime(contentSpan, requestedDuration);
  // A duration is not itself a canonical lattice point. Snap the ABSOLUTE end,
  // retaining the exact desired endpoint until the shared integer round step.
  const idealEnd = addTime(exactTime(clip.t_start_us), requestedDuration);
  const endFrame = roundTime(multiplyTime(idealEnd, exactTime(clip.grid.num, 1_000_000 * clip.grid.den)));
  const endUs = timeUsAtFrame(endFrame, clip.grid.num, clip.grid.den);
  const duration = exactTime(endUs - clip.t_start_us);
  // Let the caller return a useful DurationTooShort result, without inventing
  // a one-frame duration that changes the user's requested operation.
  if (duration.num <= 0) return {
    layer_id: clip.id, t_start_us: clip.t_start_us, t_end_us: endUs, duration_us: duration.num,
    timing, animation_scale: UNIT_RATE, requested_duration: requestedDuration,
    requested_rate: requestedRate, actual_rate: contentRateAt(timing, ZERO_TIME), rate_delta: ZERO_TIME,
  };
  exactTime(endUs); // Decoder/grid APIs return numbers; check the wire range.
  const next = retimeTiming(timing, duration);
  const actualRate = contentRateAt(next, ZERO_TIME);
  return {
    layer_id: clip.id, t_start_us: clip.t_start_us, t_end_us: endUs, duration_us: duration.num,
    timing: next, animation_scale: divideTime(duration, exactTime(clip.t_end_us - clip.t_start_us)),
    requested_duration: requestedDuration, requested_rate: requestedRate,
    actual_rate: actualRate, rate_delta: subtractTime(actualRate, requestedRate),
  };
}

/** A complete final-state plan or ONE refusal, never a partial edit list. Main
 * must run normal project validation too (source bounds, capabilities, locks),
 * then atomically commit from the SAME snapshot it passed here. */
export function planRetime(input: RetimePlanInput): RetimePlan {
  try {
    return computePlan(input);
  } catch (error) {
    if (error instanceof TimeMappingError) return refused({ kind: 'Numeric', reason: error.code });
    throw error;
  }
}

function computePlan({ clips, transitions, layer_ids: ids, target }: RetimePlanInput): RetimePlan {
  if (!ids.length) return refused({ kind: 'EmptyTargets' });
  // Sort IDs for deterministic plans/refusals, independent of UI selection order.
  const targets = [...new Set(ids)].sort();
  const byId = new Map<string, RetimeClip>();
  for (const clip of clips) {
    if (byId.has(clip.id)) return refused({ kind: 'InvalidSnapshot', layer_id: clip.id });
    byId.set(clip.id, clip);
  }
  try { validateTarget(target); }
  catch (error) {
    if (error instanceof TimeMappingError) return refused({ kind: 'InvalidTarget' });
    throw error;
  }
  const selected: RetimeClip[] = [];
  for (const id of targets) {
    const clip = byId.get(id);
    if (!clip) return refused({ kind: 'LayerMissing', layer_id: id });
    if (clip.locked) return refused({ kind: 'Locked', layer_id: id });
    if (!clip.timing) return refused({ kind: 'UnsupportedContent', layer_id: id });
    if (!validPlacement(clip)) return refused({ kind: 'InvalidSnapshot', layer_id: id });
    selected.push(clip);
  }
  for (const a of selected) for (const b of selected) {
    if (a.id !== b.id && descendantOf(a, b, clips)) return refused({ kind: 'NestedTargets', ancestor_id: a.id, descendant_id: b.id });
  }
  const edits: RetimeEdit[] = [];
  for (const clip of selected) {
    const edit = makeEdit(clip, target);
    if (edit.duration_us <= 0) return refused({ kind: 'DurationTooShort', layer_id: clip.id, requested_duration: edit.requested_duration });
    edits.push(edit);
  }
  const editsById = new Map(edits.map((edit) => [edit.layer_id, edit]));
  const final = new Map(clips.map((clip) => [clip.id, { ...clip, t_end_us: editsById.get(clip.id)?.t_end_us ?? clip.t_end_us }]));
  const authorized = new Set<string>();
  const pair = (a: string, b: string) => JSON.stringify([a, b].sort());
  // Check before ordinary occupancy; a transition has a stricter equation and
  // a useful refusal identity. Its participants' starts and its duration stay.
  for (const tr of transitions) {
    if (!editsById.has(tr.from_layer) && !editsById.has(tr.to_layer)) continue;
    const from = final.get(tr.from_layer);
    const to = final.get(tr.to_layer);
    if (!from || !to || from.id === to.id || from.composition_id !== to.composition_id
      || from.track_id !== to.track_id || from.overlap_class !== 'visual' || to.overlap_class !== 'visual'
      || tr.duration_us <= 0 || tr.extended_us < 0 || tr.extended_us > tr.duration_us
      || tr.duration_us > from.t_end_us - from.t_start_us || tr.duration_us > to.t_end_us - to.t_start_us
      || Math.max(0, Math.min(from.t_end_us, to.t_end_us) - Math.max(from.t_start_us, to.t_start_us)) !== tr.duration_us) return refused({ kind: 'Transition', transition_id: tr.id });
    authorized.add(pair(from.id, to.id));
  }
  for (const clip of selected) {
    const edit = editsById.get(clip.id)!;
    for (const blocker of [...final.values()].sort((a, b) => a.t_start_us - b.t_start_us || a.id.localeCompare(b.id))) {
      if (blocker.id === clip.id || blocker.composition_id !== clip.composition_id || blocker.track_id !== clip.track_id
        || blocker.overlap_class !== clip.overlap_class || authorized.has(pair(clip.id, blocker.id))) continue;
      if (edit.t_start_us >= blocker.t_end_us || edit.t_end_us <= blocker.t_start_us) continue;
      const maximum = snapDownOnGrid(blocker.t_start_us, clip.grid) - clip.t_start_us;
      return refused({
        kind: 'Collision', layer_id: clip.id, blocking_layer_id: blocker.id,
        requested_duration: edit.requested_duration, maximum_duration_us: maximum > 0 ? maximum : null,
        minimum_rate: maximum > 0 ? divideTime(subtractTime(edit.timing.content_out, edit.timing.content_in), exactTime(maximum)) : null,
      });
    }
  }
  return { ok: true, edits };
}
