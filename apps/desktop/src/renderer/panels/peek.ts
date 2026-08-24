// Pure peek-list logic: which hidden-track layers sit near the playhead
// (`buildPeekItems`), what category a layer falls into (`peekCategory`),
// and how the items split into the At-playhead stack vs the Nearby list
// under the AB-mode filter (`splitPeekSections`).
// Kept separate from presentation so it is unit-testable without a DOM.

import type { LayerSummary, TrackSummary } from "../ipc";
import { trackDisplayName } from "../lib/trackName";

/// One row in the peek list. Carries enough state to render the row +
/// drive selection / reveal on click.
export interface PeekItem {
  layer: LayerSummary;
  trackId: string;
  /// The name the track's own header shows (`lib/trackName.ts`), already
  /// resolved — one lane has one name everywhere.
  trackLabel: string;
  trackKind: string;
  /// Position of the layer's track in the *full* project track array —
  /// `Project.tracks` is ordered bottom-of-z-stack first, so a larger index
  /// composites on top. This is the z source for the At-playhead stack.
  trackIndex: number;
  /// Microseconds from playhead to the *layer's nearest edge* —
  /// negative when the layer ended in the past, positive when it
  /// starts in the future, zero when it spans the playhead.
  offsetUs: number;
  /// True when `playhead ∈ [t_start, t_end]` — gets the LIVE badge.
  spansPlayhead: boolean;
}

/// `t` is injected rather than imported so this module stays DOM- and
/// i18n-instance-free; the label it resolves has to be built here because the
/// item order breaks its ties on the track name.
export function buildPeekItems(
  tracks: TrackSummary[],
  currentTimeUs: number,
  deltaUs: number,
  t: (key: string, values: Record<string, unknown>) => string,
): PeekItem[] {
  const lo = currentTimeUs - deltaUs;
  const hi = currentTimeUs + deltaUs;
  const items: PeekItem[] = [];
  for (const [trackIndex, track] of tracks.entries()) {
    if (track.role !== null) continue;
    for (const layer of track.layers) {
      if (layer.t_end_us <= lo || layer.t_start_us >= hi) continue;
      const spans =
        layer.t_start_us <= currentTimeUs && layer.t_end_us >= currentTimeUs;
      const offset = spans
        ? 0
        : layer.t_start_us > currentTimeUs
          ? layer.t_start_us - currentTimeUs
          : layer.t_end_us - currentTimeUs;
      items.push({
        layer,
        trackId: track.id,
        trackLabel: trackDisplayName(track, tracks, t),
        trackKind: track.kind,
        trackIndex,
        offsetUs: offset,
        spansPlayhead: spans,
      });
    }
  }
  // Order: spanning items first (LIVE bubble), then chronologically by
  // t_start. Equal t_start ties break by track label (stable enough).
  items.sort((a, b) => {
    if (a.spansPlayhead !== b.spansPlayhead) {
      return a.spansPlayhead ? -1 : 1;
    }
    if (a.layer.t_start_us !== b.layer.t_start_us) {
      return a.layer.t_start_us - b.layer.t_start_us;
    }
    return a.trackLabel.localeCompare(b.trackLabel);
  });
  return items;
}

/// The ±Δ window values the Panel offers, roughly doubling across the clamp
/// the settings store enforces (`DELTA_WINDOW_MIN_US`…`DELTA_WINDOW_MAX_US`,
/// [1 s, 5 min]). A preset list rather than a free field on purpose: the
/// window is an observation radius, and no edit decision distinguishes ±11 s
/// from ±10 s — the choice worth offering is the order of magnitude.
export const PEEK_WINDOW_PRESETS_US: readonly number[] = [
  1_000_000,
  2_000_000,
  5_000_000,
  10_000_000,
  30_000_000,
  60_000_000,
  120_000_000,
  300_000_000,
];

/// The window as a compact duration ("10s", "2min"), never a timecode. A
/// timecode answers "where in the composition", and this value is a radius
/// the user picks — `00:00:10:00` spends eight characters saying what three
/// do, in a column that has none to spare. Whole minutes read in minutes;
/// everything else in seconds, so an out-of-band value (MCP, a hand-edited
/// app_settings.json) still prints something honest.
export function formatPeekWindow(
  us: number,
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  const seconds = Math.round(us / 1_000_000);
  if (seconds >= 60 && seconds % 60 === 0) {
    return t("peek.window_minutes", { value: seconds / 60 });
  }
  return t("peek.window_seconds", { value: seconds });
}

/// Peek filter buckets. Coarser than `layerOverlapClass` (which is
/// visual-vs-audio) because the user wants Text layers split out from
/// picture for fast scanning.
export type PeekCategory = "video" | "audio" | "text";

/// Order of the filter chips.
export const PEEK_CATEGORY_ORDER: PeekCategory[] = ["video", "audio", "text"];

export function peekCategory(layerKind: string): PeekCategory {
  if (layerKind === "Audio") return "audio";
  if (layerKind === "Text") return "text";
  // VideoClip | ImageOverlay | Color | Motif
  return "video";
}

/// The panel's two sections (ADR 0044): the boundary is the playhead,
/// not the category.
export interface PeekSections {
  /// Exactly the window items spanning the playhead — the stack being
  /// composited right now. Visual kinds merged into one list ordered
  /// top-of-stack first (descending track index, the layer-panel
  /// convention); audio rows sink to the tail because audio mixes by
  /// role and z is meaningless for it.
  atPlayhead: PeekItem[];
  /// The visual prefix of `atPlayhead` — the same items, ending where the
  /// audio tail begins. This is the reorderable z-stack: consumers take it
  /// as-is instead of re-deriving kinds.
  atPlayheadVisual: PeekItem[];
  /// Everything else in the window, in `buildPeekItems`' proximity
  /// order, untouched.
  nearby: PeekItem[];
}

/// Split already-sorted peek items into the At-playhead / Nearby sections,
/// honoring the active filter — the checked categories filter both sections.
///
/// **An empty set means no filter at all**, not "keep nothing". That is what
/// lets the chips be plain checkboxes with no mutually-exclusive All among
/// them: clearing the selection IS the unfiltered view, so every subset of the
/// categories — the empty one included — is reachable and none is stranded.
///
/// Each at-playhead visual row necessarily sits on a distinct track
/// (same-class layers on one track cannot overlap in time), so the
/// descending-index sort is total for the rows it orders. Spanning audio
/// keeps its input order at the tail.
export function splitPeekSections(
  items: PeekItem[],
  filter: ReadonlySet<PeekCategory>,
): PeekSections {
  const visual: PeekItem[] = [];
  const audio: PeekItem[] = [];
  const nearby: PeekItem[] = [];
  for (const item of items) {
    if (
      filter.size > 0 &&
      !filter.has(peekCategory(item.layer.params.kind))
    ) {
      continue;
    }
    if (!item.spansPlayhead) {
      nearby.push(item);
    } else if (peekCategory(item.layer.params.kind) === "audio") {
      audio.push(item);
    } else {
      visual.push(item);
    }
  }
  visual.sort((a, b) => b.trackIndex - a.trackIndex);
  return {
    atPlayhead: [...visual, ...audio],
    atPlayheadVisual: visual,
    nearby,
  };
}

/// The anchored restack a drop means: the op's own addressing (ADR 0044
/// decision 3) — a layer, not an index, because an index drifts between the
/// gesture's read and the op's apply.
export interface RestackTarget {
  anchorId: string;
  position: "above" | "below";
}

/// Map a drop gap in the At-playhead visual stack to its anchored restack
/// (ADR 0044 decision 5), or report a no-op as null.
///
/// `visibleRows` is exactly what the user sees: the filtered visual rows,
/// top-of-stack first — so a neighbour hidden by a category chip can never
/// become an anchor, and layers the filter hides keep their relative order.
/// `gap` is the insertion slot in [0..rows.length] (the row would land before
/// `visibleRows[gap]`); `fromIndex` is the dragged row's index at gesture
/// start. Rules:
///  - a gap above a visible row inserts DIRECTLY ABOVE that row
///    (anchor = the row below the gap, position = 'above');
///  - the section-bottom gap inserts DIRECTLY BELOW the last visible row;
///  - the dragged row's own gap and its following gap are no-ops (the same
///    pair usePointerReorder's isNoopGap suppresses — restated here so the
///    mapping is total on its own).
export function restackTargetForGap(
  visibleRows: readonly PeekItem[],
  fromIndex: number,
  gap: number,
): RestackTarget | null {
  if (visibleRows.length === 0 || gap < 0 || gap > visibleRows.length) {
    return null;
  }
  if (gap === fromIndex || gap === fromIndex + 1) return null;
  const below = visibleRows[gap];
  if (below !== undefined) {
    return { anchorId: below.layer.id, position: "above" };
  }
  // gap === visibleRows.length: the section's bottom.
  const last = visibleRows[visibleRows.length - 1]!;
  return { anchorId: last.layer.id, position: "below" };
}

/// The row context menu's four ordering actions, each resolved to its
/// anchored restack or null for "disabled" — the menu never offers a no-op.
export interface RestackMenuTargets {
  bringForward: RestackTarget | null;
  sendBackward: RestackTarget | null;
  bringToFront: RestackTarget | null;
  sendToBack: RestackTarget | null;
}

/// Map a row of the visible At-playhead visual stack to its four
/// context-menu actions (ADR 0044 decision 4). Front/back are not op
/// variants: they derive as above-the-top / below-the-bottom of the visible
/// non-reserved stack, so the op surface stays above/below and the menu can
/// never compose a move under the reserved skeleton.
///
/// `visibleRows` is exactly what the user sees — the filtered visual rows,
/// top-of-stack first (the same contract as `restackTargetForGap`, so a
/// neighbour hidden by a category chip can never become an anchor);
/// `index` is the row's position in it. The top row's forward/front and the
/// bottom row's backward/back are the extremes' no-ops; a single-row stack
/// disables all four.
export function restackMenuTargets(
  visibleRows: readonly PeekItem[],
  index: number,
): RestackMenuTargets {
  const row = visibleRows[index];
  if (row === undefined) {
    return {
      bringForward: null,
      sendBackward: null,
      bringToFront: null,
      sendToBack: null,
    };
  }
  const above = visibleRows[index - 1];
  const below = visibleRows[index + 1];
  const top = visibleRows[0]!;
  const bottom = visibleRows[visibleRows.length - 1]!;
  return {
    bringForward:
      above === undefined
        ? null
        : { anchorId: above.layer.id, position: "above" },
    sendBackward:
      below === undefined
        ? null
        : { anchorId: below.layer.id, position: "below" },
    bringToFront:
      above === undefined ? null : { anchorId: top.layer.id, position: "above" },
    sendToBack:
      below === undefined
        ? null
        : { anchorId: bottom.layer.id, position: "below" },
  };
}
