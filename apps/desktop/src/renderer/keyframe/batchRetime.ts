// The arithmetic behind the two GROUP gestures on a keyframe selection: a
// shared translate (drag, nudge) and a time-scale about an anchor (Alt-drag).
// Both answer with the `updateParamTracksMulti` entries for the whole
// selection, so one gesture stays one undo entry however many layers and params
// it spans.
//
// Pure: measured pointer travel and committed tracks in, next tracks out. No
// React, no store, no IPC — `useKeyframeDrag` measures, this decides, and
// `KeyframeBatch.commitEntries` writes. The grouping itself is not repeated
// here; `selectionGroups` (timeline/keyframeBatch.ts) is the one place a
// selection meets the project's tracks.
import { snapFrameRound, timeUsAtFrame } from "../frames";
import type { Keyframe, TrackSummary } from "../ipc";
import type { TrackValue } from "./edits";
import type { SelectedKeyframe } from "./selectionStore";
import {
  selectionGroups,
  type KeyframedTrack,
  type ParamTrackEntry,
} from "../timeline/keyframeBatch";

/// A composition's frame rate as the snap primitives take it.
export interface Grid {
  num: number;
  den: number;
}

/// One group of the selection with the geometry a retime needs. Keyframe times
/// are LAYER-LOCAL and a selection spans layers, so `tStartUs` is what lets one
/// gesture meet every group on the composition's clock; `durationUs` is that
/// group's own `[0, duration]` wall.
export interface RetimeGroup {
  layerId: string;
  paramKey: string;
  track: KeyframedTrack;
  kfIds: readonly string[];
  tStartUs: number;
  durationUs: number;
}

export interface TranslateResult {
  entries: ParamTrackEntry[];
  /// The delta actually used — snapped to the grid, then clamped to the
  /// tightest wall. Surfaced so a caller can tell a no-op from a move.
  appliedDeltaUs: number;
}

export interface ScaleResult {
  entries: ParamTrackEntry[];
  /// The factor actually used, after the one-frame floor and the walls.
  appliedK: number;
}

const NO_TRANSLATION: TranslateResult = { entries: [], appliedDeltaUs: 0 };
const NO_SCALE: ScaleResult = { entries: [], appliedK: 1 };

/// The selection's groups with their layer geometry attached — what both
/// gestures and the nudge handler start from.
export function retimeGroupsOf(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
}): RetimeGroup[] {
  return selectionGroups(args).map((g) => ({
    layerId: g.layerId,
    paramKey: g.paramKey,
    track: g.track,
    kfIds: g.kfIds,
    tStartUs: g.layer.t_start_us,
    durationUs: g.layer.t_end_us - g.layer.t_start_us,
  }));
}

/// The selected keys of one group, in track order. A selected id the track no
/// longer carries contributes nothing.
function selectedKeys(group: RetimeGroup): Keyframe<TrackValue>[] {
  const want = new Set(group.kfIds);
  return group.track.value.filter((k) => want.has(k.id));
}

/// Every selected key's time on the COMPOSITION clock, ascending.
function selectedTimesUs(groups: readonly RetimeGroup[]): number[] {
  const times: number[] = [];
  for (const g of groups) for (const k of selectedKeys(g)) times.push(g.tStartUs + k.t_us);
  return times.sort((a, b) => a - b);
}

/// The selection's extent on the composition clock, plus how many DISTINCT
/// times it spans. Alt time-scale needs all three: the end keys are its only
/// grab handles, the opposite end is the anchor, and a selection with fewer
/// than two distinct times has no span to scale — the caller falls back to a
/// plain translate. `null` when nothing is selected.
export function selectionExtent(
  groups: readonly RetimeGroup[],
): { firstUs: number; lastUs: number; distinct: number } | null {
  const times = selectedTimesUs(groups);
  if (times.length === 0) return null;
  return {
    firstUs: times[0]!,
    lastUs: times[times.length - 1]!,
    distinct: new Set(times).size,
  };
}

/// Rewrite one group with the moved keys LAST. The array order IS the collision
/// policy: main sorts stably and keeps the last of a tied time, so a moved key
/// landing on a stationary key's frame replaces it while a stationary key it
/// merely passes survives. Never sort here — sorting would hand the tie to
/// whichever key the comparator happened to reach first.
function reorderMoved(
  group: RetimeGroup,
  nextTimeUs: (tUs: number) => number,
): ParamTrackEntry {
  const moving = new Set(group.kfIds);
  const kept = group.track.value.filter((k) => !moving.has(k.id));
  const moved = group.track.value
    .filter((k) => moving.has(k.id))
    .map((k) => ({ ...k, t_us: nextTimeUs(k.t_us) }));
  return [group.layerId, group.paramKey, { ...group.track, value: [...kept, ...moved] }];
}

/// Move every selected key by ONE shared delta.
///
/// The delta is snapped once, before the clamp, and never per key: a whole
/// number of frames leaves every key the frame offset it already had, which is
/// what makes a group drag move the shape rather than deform it. The walls are
/// then the tightest `[0, duration]` interval across ALL groups, so the group
/// stops where its most constrained member stops. The actor's write-time snap
/// settles the last microsecond at fractional rates, where two canonical frame
/// times do not sum to a third.
export function translateSelection(
  groups: readonly RetimeGroup[],
  deltaUs: number,
  grid: Grid,
): TranslateResult {
  let lo = -Infinity;
  let hi = Infinity;
  let any = false;
  for (const group of groups) {
    const keys = selectedKeys(group);
    if (keys.length === 0) continue;
    any = true;
    let min = Infinity;
    let max = -Infinity;
    for (const k of keys) {
      if (k.t_us < min) min = k.t_us;
      if (k.t_us > max) max = k.t_us;
    }
    lo = Math.max(lo, -min);
    hi = Math.min(hi, group.durationUs - max);
  }
  // No walls to obey, or a key already outside its layer has crossed them:
  // nothing can move without breaking one, so nothing does.
  if (!any || lo > hi) return NO_TRANSLATION;
  const applied = Math.min(hi, Math.max(lo, snapFrameRound(deltaUs, grid.num, grid.den)));
  if (applied === 0) return NO_TRANSLATION;
  const entries = groups
    .filter((g) => selectedKeys(g).length > 0)
    .map((g) => reorderMoved(g, (tUs) => tUs + applied));
  return { entries, appliedDeltaUs: applied };
}

/// Scale the selection's span about `anchorCompUs` — the opposite end key of an
/// Alt-drag, on the composition clock.
///
/// Snapping happens AFTER the multiply, per key: a scale is not a translation,
/// so there is no single delta a pre-snap could round. Two bounds hold the
/// result together — a floor that keeps adjacent selected keys at least one
/// frame apart, so a shrink can neither merge nor flip them, and the same
/// `[0, duration]` walls the translate obeys, expressed on `k`.
export function scaleSelection(
  groups: readonly RetimeGroup[],
  anchorCompUs: number,
  k: number,
  grid: Grid,
): ScaleResult {
  const times = selectedTimesUs(groups);
  if (new Set(times).size < 2) return NO_SCALE;

  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  const kMin = minGap === Infinity ? 0 : timeUsAtFrame(1, grid.num, grid.den) / minGap;

  let kMax = Infinity;
  for (const group of groups) {
    const anchorLocal = anchorCompUs - group.tStartUs;
    for (const key of selectedKeys(group)) {
      // `t' = anchorLocal + (t − anchorLocal)·k` against that group's two walls.
      // A key ON the anchor is fixed by any `k` and constrains nothing.
      const d = key.t_us - anchorLocal;
      if (d > 0) kMax = Math.min(kMax, (group.durationUs - anchorLocal) / d);
      else if (d < 0) kMax = Math.min(kMax, -anchorLocal / d);
    }
  }
  // A selection whose keys already sit on a wall can push `kMax` under the
  // no-merge floor. The floor wins: an out-of-range key is retained and
  // recoverable, two keys merged onto one frame are not.
  const applied = Math.min(Math.max(k, kMin), Math.max(kMin, kMax));
  if (applied === 1) return NO_SCALE;

  const entries = groups
    .filter((g) => selectedKeys(g).length > 0)
    .map((g) => {
      const anchorLocal = anchorCompUs - g.tStartUs;
      return reorderMoved(g, (tUs) =>
        snapFrameRound(anchorLocal + (tUs - anchorLocal) * applied, grid.num, grid.den),
      );
    });
  return { entries, appliedK: applied };
}
