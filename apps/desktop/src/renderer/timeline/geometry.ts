import { DEFAULT_TIMELINE_PX_PER_SEC } from "../../shared/view-state";
import type {
  LinkSummary,
  LayerParamsView,
  LayerSummary,
  TrackSummary,
} from "../ipc";
import { displayedFrameStartUs, inclusiveOutBoundaryUs } from "../frames";
import {
  animatableParams,
  readParamTrack,
  readScaleLinked,
  type ParamDescriptor,
} from "../keyframe/descriptors";

// Zoom + height bounds. DEFAULT_PX_PER_SEC is the fallback for a timeline
// `view.json` remembers nothing about — the persisted document's own default,
// re-exported so the timeline reads one name for it.
// The lower bound is computed dynamically as `viewport / totalSec` so
// the zoom wheel can always zoom out far enough to fit the entire timeline
// in view, regardless of how long it is. `MIN_PX_PER_SEC_FLOOR` is a
// tiny absolute floor that keeps the math sane in pathological cases
// (zero-width viewport, zero-duration project).
export const DEFAULT_PX_PER_SEC = DEFAULT_TIMELINE_PX_PER_SEC;
export const MIN_PX_PER_SEC_FLOOR = 0.05;
// 2000 px/s exceeds the waveform's stored finest LOD (1000 peaks/s): past
// ~1500 px/s the envelope stretches instead of gaining detail — accepted;
// the filmstrip (the ceiling's driver) keeps densifying to lod 0.
export const MAX_PX_PER_SEC = 2000;
// Empty/short projects still need enough temporal context to feel like an
// editing surface instead of a five-second strip.
export const MIN_TIMELINE_SECONDS = 10;
// Keep the composition tail away from the viewport edge. The proportional
// part makes the post-roll useful on wide workspaces; the floor keeps it
// usable in narrow panes and before the first viewport measurement lands.
export const TIMELINE_END_PADDING_VIEWPORT_RATIO = 0.35;
export const MIN_TIMELINE_END_PADDING_PX = 240;
// Taller default row so combined V+A rows fit a thumbnail strip (top half)
// + waveform strip (bottom half); single-class tracks still fit comfortably.
export const DEFAULT_TRACK_HEIGHT = 56;
export const MIN_TRACK_HEIGHT = 24;
export const MAX_TRACK_HEIGHT = 200;

export const LAYER_PREVIEW_MIN_PX = 16;
export const LAYER_LABEL_MIN_PX = 48;
export const LAYER_FULL_LABEL_MIN_PX = 120;

/// Width of the sticky track-header column.
export const HEADER_COL_PX = 160;

/// Height of the drop strip above the topmost lane (ADR 0042). Its space is
/// reserved in flow permanently, not conditionally on a drag — a row that
/// appeared mid-gesture would reflow the timeline under the pointer. Thin
/// enough to read as a seam rather than a lane the user is meant to manage.
export const DROP_STRIP_HEIGHT_PX = 14;

/// Height of the marker lane under the ruler, expanded: a glyph plus the label
/// beside it, which is the whole reason the lane exists — a mark whose name is
/// only reachable by hovering is a mark nobody reads.
///
/// Reserved in flow permanently for the same reason the drop strip's row is,
/// and the trap is sharper here: `markers_visible` governs what the lane PAINTS,
/// never whether the lane exists, and `M` force-enables that flag. A lane bound
/// to it would reflow the timeline under the pointer on every press.
export const MARKER_LANE_HEIGHT_PX = 20;

/// Height of the marker lane collapsed: glyphs, no text. Deliberately the drop
/// strip's height — a collapsed lane is a seam, not a lane to manage, and the
/// two seams above the tracks should not be two different thicknesses.
///
/// Collapse is a USER-initiated toggle, so unlike the visibility flag its
/// reflow is asked for.
export const MARKER_LANE_COLLAPSED_HEIGHT_PX = DROP_STRIP_HEIGHT_PX;

export function computeTimelineExtent({
  durationUs,
  pxPerSec,
  viewportWidthPx,
}: {
  durationUs: number;
  pxPerSec: number;
  viewportWidthPx: number;
}): { widthPx: number; totalSec: number } {
  const contentSec = Math.max(durationUs / 1_000_000, MIN_TIMELINE_SECONDS);
  const contentWidthPx = contentSec * pxPerSec;
  const safeViewportWidthPx = Math.max(0, viewportWidthPx);
  const endPaddingPx = Math.max(
    MIN_TIMELINE_END_PADDING_PX,
    safeViewportWidthPx * TIMELINE_END_PADDING_VIEWPORT_RATIO,
  );
  const widthPx = Math.max(contentWidthPx, safeViewportWidthPx) + endPaddingPx;
  return { widthPx, totalSec: widthPx / pxPerSec };
}

export interface VisualTrack {
  track: TrackSummary;
  /// True when this is the first lane of its section — the renderer adds a
  /// divider line above it. Sections are role-stamped vs role-less, not kind
  /// buckets, so there is exactly one boundary (see `visualOrderedTracks`).
  isRoleSectionStart: boolean;
}

/// Layer-overlap class. Visual-class layers (VideoClip, ImageOverlay, Color,
/// Motif, Text, CompositionRef) can't overlap each other on a track; Audio
/// can't overlap Audio. Visual + Audio CAN coexist at the same time — that's
/// the AE-style "combined row" trigger.
export type LayerOverlapClass = "visual" | "audio";

/// The rule itself, keyed on nothing but the kind: everything that is not Audio
/// is visual. Stated that way rather than as an allowlist of visual kinds, so a
/// Group — a composition placed as one layer, which may hold audio INSIDE it and
/// still composites as a picture — falls on the visual side by construction
/// (ADR 0052 §4).
///
/// Split out from `layerOverlapClass` for the one caller that has no layer to
/// hand it: a Panel previewing a drop from ANOTHER composition holds no summary
/// for the clips being carried, only their kinds (`layerDragStore.ts`).
export function overlapClassForKind(
  kind: LayerParamsView["kind"],
): LayerOverlapClass {
  return kind === "Audio" ? "audio" : "visual";
}

export function layerOverlapClass(layer: LayerSummary): LayerOverlapClass {
  return overlapClassForKind(layer.params.kind);
}

/// The two source-window affordances a media-bearing clip can carry at its
/// right edge, as fractions of the clip's own width.
///
/// `overhangFromFraction` is where the source runs out: the clip is windowed
/// `[src_in, src_out)` 1:1 onto `[t_start, t_end)`, so content stops at
/// `(sourceDuration − src_in) / (src_out − src_in)` of the way across. Non-null
/// only when the window actually overhangs. `hasUnusedTail` is the opposite
/// case — the source runs longer than the window, so the out edge can still be
/// dragged out.
///
/// Both exist for Groups in particular (ADR 0052 §6: overhang is tolerated in
/// state and clamped at the gesture, because deleting a layer INSIDE a Group
/// shrinks its composition and must not be refused on account of a parent's
/// window). Written kind-agnostically because the arithmetic is the source
/// window's, not the Group's: a media clip whose file was replaced by a shorter
/// one is the same picture.
export interface SourceWindowTail {
  overhangFromFraction: number | null;
  hasUnusedTail: boolean;
}

export function sourceWindowTail({
  srcInUs,
  srcOutUs,
  sourceDurationUs,
}: {
  srcInUs: number;
  srcOutUs: number;
  /// The source's own length, or null when it is unknown (an unprobed media, a
  /// composition the summary has not delivered). Unknown draws NEITHER
  /// affordance: a guessed hatch would claim the clip renders nothing.
  sourceDurationUs: number | null;
}): SourceWindowTail {
  const span = srcOutUs - srcInUs;
  if (sourceDurationUs === null || span <= 0) {
    return { overhangFromFraction: null, hasUnusedTail: false };
  }
  if (srcOutUs <= sourceDurationUs) {
    return { overhangFromFraction: null, hasUnusedTail: srcOutUs < sourceDurationUs };
  }
  // Clamped at 0 for a window that starts past the end already — the whole clip
  // is then hatched, which is what "nothing renders here" looks like.
  const fraction = Math.max(0, (sourceDurationUs - srcInUs) / span);
  return { overhangFromFraction: fraction, hasUnusedTail: false };
}

/// Which header controls a track shows, derived from its content. The header
/// carries the eye (lock is unconditional, unmodeled here); mute/solo live on
/// audio roles (Mixer panel). A pure-audio lane hides the eye — `muted` is its
/// single audio on/off, so the whole-track `enabled` toggle would be redundant;
/// visual-only and empty tracks keep it. `hasAudio` is retained because a
/// pure-audio lane (`hasAudio && !showEye`) drives the audio-lane music glyph.
/// See ADR 0023.
export interface TrackHeaderControls {
  showEye: boolean;
  hasAudio: boolean;
}

export function trackHeaderControls(track: TrackSummary): TrackHeaderControls {
  const hasAudio = track.layers.some((l) => layerOverlapClass(l) === "audio");
  const hasVisual = track.layers.some((l) => layerOverlapClass(l) === "visual");
  return {
    showEye: hasVisual || !hasAudio,
    hasAudio,
  };
}

/// Vertical slice the layer occupies within its track row:
///   - "full"   — uses the entire row height (default; no opposite-
///                class layer overlaps in time)
///   - "top"    — uses the top half (Visual layer paired with an
///                Audio layer at the same time slot)
///   - "bottom" — uses the bottom half (Audio layer paired with a
///                Visual layer at the same time slot)
export type LayerSlice = "full" | "top" | "bottom";

export function computeLayerSlices(
  layers: readonly LayerSummary[],
): Map<string, LayerSlice> {
  // Walk all (visual, audio) pairs; any overlap in time flips both
  // sides to half-height. O(V × A) per track, which is fine because a
  // typical track has at most a handful of layers.
  const slices = new Map<string, LayerSlice>();
  const visual = layers.filter((l) => layerOverlapClass(l) === "visual");
  const audio = layers.filter((l) => layerOverlapClass(l) === "audio");
  for (const v of visual) {
    for (const a of audio) {
      if (v.t_end_us > a.t_start_us && a.t_end_us > v.t_start_us) {
        slices.set(v.id, "top");
        slices.set(a.id, "bottom");
      }
    }
  }
  // Layers that didn't get a half-slot stay full-height.
  for (const l of layers) {
    if (!slices.has(l.id)) slices.set(l.id, "full");
  }
  return slices;
}

/// A chip's vertical band inside its lane, in lane-local px. The chip renderer,
/// the media-drop ghost, and the marquee's vertical hit-test all read this, so
/// the padding and the midline gap have exactly one definition and what is drawn
/// cannot drift from what is selectable.
///
/// The outer padding keeps the chip off the row edges. The 1 px the bottom slice
/// cedes at the midline is load-bearing rather than decoration: it visually
/// separates V from A in the combined-row case so the user sees the two are
/// hit-test independent. The 8 px floors keep a chip off zero height on a lane
/// squeezed to `MIN_TRACK_HEIGHT` or a height that never went through that clamp.
export function layerSliceRect(
  laneHeight: number,
  slice: LayerSlice,
): { top: number; height: number } {
  const ROW_PADDING = 4;
  const interiorTop = ROW_PADDING;
  const interiorHeight = Math.max(8, laneHeight - 2 * ROW_PADDING);
  const halfHeight = Math.max(8, Math.floor((interiorHeight - 1) / 2));
  if (slice === "full") return { top: interiorTop, height: interiorHeight };
  if (slice === "top") return { top: interiorTop, height: halfHeight };
  return {
    top: interiorTop + halfHeight + 1,
    height: interiorHeight - halfHeight - 1,
  };
}

// Track rendering order is a simple reverse of the data-model. Convention
// (idx 0 = bottom of z-stack, last = top) maps directly to "last index renders
// at the top of the screen", matching the editor convention that the
// top-of-z-stack composites visually on top. See `docs/data-model.md`.
//
// Placement APPENDS a lane it had to create, so the role-less "additional"
// region is the TAIL of the data array and therefore the HEAD of the visual
// order — auto-created lanes accrete downward from the top of the screen, which
// is why the drop strip that spawns them sits above the first row (ADR 0042).
//
//   data-model (bottom → top of z-stack)        visual (top → bottom of screen)
//   ┌─────────────────────────────────┐         ┌─────────────────────────────┐
//   │ idx 0 — A roll                  │         │ additional (newest)         │
//   │ idx 1 — A's separated audio     │   ⇄     │ additional / transient      │
//   │ idx 2 — B roll                  │ reverse │ B's separated audio (if any)│
//   │ idx 3 — B's separated audio     │         │ B roll                      │
//   │ idx 4 — additional / transient  │         │ A's separated audio (if any)│
//   │ idx 5 — additional (newest)     │         │ A roll                      │
//   └─────────────────────────────────┘         └─────────────────────────────┘
//
// One role-section divider separates the two sections: it lands on the first
// role-stamped row, i.e. under the "additional" region at the top.
export function visualOrderedTracks(tracks: TrackSummary[]): VisualTrack[] {
  const reversed = tracks.slice().reverse();
  const out: VisualTrack[] = [];
  let prevSection: "role" | "extra" | null = null;
  for (const track of reversed) {
    // Role-stamped tracks (the reserved A/B skeleton + their separated
    // audio derivatives if any) form one section; everything else
    // (transient imports, spawned additional tracks) forms the section
    // above them. The boundary between them gets a divider.
    const section: "role" | "extra" = track.role !== null ? "role" : "extra";
    const isRoleSectionStart = prevSection !== null && section !== prevSection;
    out.push({ track, isRoleSectionStart });
    prevSection = section;
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/// One track lane's MEASURED vertical extent, in client coordinates
/// (`getBoundingClientRect`). Feeds `trackIdAtClientY`.
export interface MeasuredTrackRow {
  trackId: string;
  top: number;
  bottom: number;
}

/// Which track a pointer at `clientY` is over, from measured lane rects.
///
/// LANDMINE: never answer this from an arithmetic y-offset table built out of
/// track heights. A row carries chrome the table cannot see — an expanded
/// track's keyframe sub-lanes sit BETWEEN its lane and the next one — so the
/// table drifts a full row or more per expanded track above the pointer, and
/// the drag hit-test then reports a foreign track. That is not a cosmetic
/// error: `useLayerDrag` treats a track change as edit intent, so a stale
/// table turns a plain click into a committed cross-track move. The DOM
/// already computed this layout; measure it.
///
/// Band rule: a row owns `[its own top, the next row's top)`. That hands the
/// sub-lane strip under an expanded track to the track that owns it, instead
/// of leaving a hole that would snap a mid-drag ghost back to its origin. The
/// last row owns only its own height. Above the first row or below the last
/// returns null — the caller keeps the layer on its origin track.
export function trackIdAtClientY(
  rows: readonly MeasuredTrackRow[],
  clientY: number,
): string | null {
  // Sorted so the band rule never depends on registration order.
  const sorted = rows.slice().sort((a, b) => a.top - b.top);
  for (const [i, row] of sorted.entries()) {
    if (clientY < row.top) return null;
    const next = sorted[i + 1];
    const bandEndY = next ? next.top : row.bottom;
    if (clientY < bandEndY) return row.trackId;
  }
  return null;
}

// Below this on-screen frame width the shadow reads as line jitter, not an
// area — hide it and let the playhead line stand alone.
const PLAYHEAD_FRAME_SHADOW_MIN_PX = 5;

/// One-frame-wide playhead shadow (Avid's position bar; Resolve's "Playhead
/// Shadow"): spans the DISPLAYED frame, from its start to its exclusive end,
/// making "the playhead shows the frame to its right" visible at frame-level
/// zoom. Exact grid boundaries per frame — a nominal `pxPerSec / fps` width
/// would drift at fractional rates (see `approxFrameDurUs`). Returns null
/// when the frame is too narrow on screen or inputs are degenerate.
export function playheadFrameShadowPx(
  tUs: number,
  fpsNum: number,
  fpsDen: number,
  pxPerSec: number,
): { leftPx: number; widthPx: number } | null {
  if (fpsNum <= 0 || fpsDen <= 0 || pxPerSec <= 0) return null;
  const startUs = displayedFrameStartUs(tUs, fpsNum, fpsDen);
  const endUs = inclusiveOutBoundaryUs(tUs, fpsNum, fpsDen);
  const widthPx = ((endUs - startUs) / 1_000_000) * pxPerSec;
  if (widthPx < PLAYHEAD_FRAME_SHADOW_MIN_PX) return null;
  return { leftPx: (startUs / 1_000_000) * pxPerSec, widthPx };
}

/// `docs/features.md#links`. Stable, deterministic hue per link id so all
/// members share an accent color across renders. Skips the yellow/green
/// band that conflicts with the selection highlight (ring token) on LayerBlock.
export function linkHue(linkId: string): number {
  let h = 0;
  for (let i = 0; i < linkId.length; i++) {
    h = (h * 31 + linkId.charCodeAt(i)) >>> 0;
  }
  const raw = h % 300;
  return raw < 60 ? raw : raw + 60;
}

/// Build the layer-id → link-id lookup used by every render path that
/// asks "what link is this in?". Built by a flat walk over each link's
/// `layer_ids`: `links` is small in practice (a handful), so nothing
/// incremental is worth keeping.
export function indexLinks(links: LinkSummary[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const g of links) {
    for (const lid of g.layer_ids) {
      idx.set(lid, g.id);
    }
  }
  return idx;
}

/// A member of a link whose lane is not rendered — the reveal target the
/// hidden-member badge cycles through.
export interface HiddenLinkMember {
  layerId: string;
  trackId: string;
}

/// What a link draws at its one on-clip anchor: the label tab and the count of
/// members the display filter hides. `LayerBlock` receives it only on the
/// anchor member; every other member gets null.
export interface LinkTab {
  linkId: string;
  label: string | null;
  /// In link order, so "reveal the first hidden member" is stable across
  /// re-renders. Empty in All Tracks display by construction.
  hidden: HiddenLinkMember[];
}

/// The anchor member of every link — keyed by that member's layer id — for the
/// lanes actually rendered.
///
/// One anchor per link, its TOP-MOST rendered member: lowest visual row, and
/// inside a combined row the visual half over the audio half, then the earlier
/// clip. A labelled link is named once rather than once per member, and the
/// badge that counts filtered-out members sits where the eye lands first.
///
/// `visibleTracks` is the rendered lane list in visual order (top row first),
/// so the A/B Roll filter is honoured structurally: a member whose lane is not
/// in it is `hidden`, and revealing that lane moves the member out of the
/// count with no second copy of the filter here. `allTracks` only resolves a
/// hidden member's lane for the reveal. A link with no rendered member has no
/// anchor and draws nothing.
export function indexLinkTabs(
  links: readonly LinkSummary[],
  visibleTracks: readonly TrackSummary[],
  allTracks: readonly TrackSummary[],
): Map<string, LinkTab> {
  const visibleTrackIds = new Set(visibleTracks.map((track) => track.id));
  const trackIdByLayerId = new Map<string, string>();
  for (const track of allTracks) {
    for (const layer of track.layers) trackIdByLayerId.set(layer.id, track.id);
  }
  // Rank of every rendered layer: row first, visual half before audio half,
  // then start time. Lower ranks anchor.
  const rank = new Map<string, [number, number, number]>();
  visibleTracks.forEach((track, row) => {
    for (const layer of track.layers) {
      rank.set(layer.id, [
        row,
        layerOverlapClass(layer) === "visual" ? 0 : 1,
        layer.t_start_us,
      ]);
    }
  });
  const before = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

  const out = new Map<string, LinkTab>();
  for (const link of links) {
    let anchorId: string | null = null;
    let anchorRank: [number, number, number] | null = null;
    const hidden: HiddenLinkMember[] = [];
    for (const layerId of link.layer_ids) {
      const r = rank.get(layerId);
      if (r !== undefined) {
        if (anchorRank === null || before(r, anchorRank)) {
          anchorId = layerId;
          anchorRank = r;
        }
        continue;
      }
      const trackId = trackIdByLayerId.get(layerId);
      // A member with no lane at all is not hidden, it is gone — a stale link
      // the next summary prunes.
      if (trackId !== undefined && !visibleTrackIds.has(trackId)) {
        hidden.push({ layerId, trackId });
      }
    }
    if (anchorId === null) continue;
    out.set(anchorId, { linkId: link.id, label: link.label, hidden });
  }
  return out;
}

/// Map a layer-local keyframe time (µs) to an x offset (px) within a clip
/// chip of `clipDurationUs` rendered `clipWidthPx` wide. Clamps out-of-range
/// keyframes (kept in data after trims) to the clip bounds.
export function keyframeXWithinClip(
  kfTUs: number,
  clipDurationUs: number,
  clipWidthPx: number,
): number {
  if (clipDurationUs <= 0) return 0;
  const u = clamp(kfTUs / clipDurationUs, 0, 1);
  return u * clipWidthPx;
}

/// Absolute x (px) of a keyframe on the timeline ruler: the clip start plus
/// the layer-local keyframe time, scaled by zoom. Used by the expanded
/// sub-lanes (which span the whole track, not one clip).
export function keyframeAbsoluteX(
  layerTStartUs: number,
  kfTUs: number,
  pxPerSec: number,
): number {
  return ((layerTStartUs + kfTUs) / 1_000_000) * pxPerSec;
}

/// The keyframed-property union across a track's layers, in descriptor order
/// — one entry per property that at least one layer animates (Keyframed).
/// Drives the expanded sub-lane rows.
export function trackKeyframeProperties(track: TrackSummary): ParamDescriptor[] {
  const out: ParamDescriptor[] = [];
  // Stable, de-duped, descriptor-ordered: walk each layer's animatable params;
  // include a param the first time any layer has it Keyframed. Per-layer
  // link-aware: a LINKED layer's param list carries the composite Scale and no
  // scale_y at all, so its keyed twin tracks surface as ONE lane — while an
  // unlinked neighbour on the same track still contributes scale_x/scale_y.
  const seen = new Set<string>();
  for (const layer of track.layers) {
    for (const desc of animatableParams(layer.kind, readScaleLinked(layer.params))) {
      if (seen.has(desc.paramKey)) continue;
      const t = readParamTrack(layer.params, desc.paramKey);
      if (t && t.mode === "Keyframed") {
        seen.add(desc.paramKey);
      }
    }
  }
  // Emit in the stable order defined by ORDER below (not first-seen order).
  // The descriptor (label "Scale" vs "Scale X", fan-out or not) comes from the
  // first layer actually KEYED on the param, so a mixed track labels the lane
  // after the layer whose diamonds it shows; first-defining is the fallback.
  const ORDER = ["x", "y", "scale_x", "scale_y", "rotation_deg", "anchor_x", "anchor_y", "opacity", "gain_db", "pan"];
  for (const key of ORDER) {
    if (!seen.has(key)) continue;
    let picked: ParamDescriptor | null = null;
    for (const layer of track.layers) {
      const d = animatableParams(layer.kind, readScaleLinked(layer.params)).find((x) => x.paramKey === key);
      if (!d) continue;
      picked ??= d;
      const t = readParamTrack(layer.params, key);
      if (t && t.mode === "Keyframed") { picked = d; break; }
    }
    if (picked) out.push(picked);
  }
  return out;
}

/// Nearest diamond id within `radiusPx` of `pointerX`, else null.
export function keyframeHitTest(
  diamonds: readonly { id: string; x: number }[],
  pointerX: number,
  radiusPx: number,
): string | null {
  let best: { id: string; d: number } | null = null;
  for (const dia of diamonds) {
    const d = Math.abs(dia.x - pointerX);
    if (d <= radiusPx && (best === null || d < best.d)) best = { id: dia.id, d };
  }
  return best?.id ?? null;
}

/// `mm:ss` for second-grain steps, `mm:ss.cs` (centiseconds) for
/// sub-second steps so the user sees a meaningful precision delta as
/// they zoom in. Rounding is done in integer milliseconds to keep
/// floating-point accumulation out of the label.
export function formatRulerLabel(seconds: number, majorSec: number): string {
  const sec = Math.max(0, seconds);
  const ms = Math.round(sec * 1000);
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const ssStr = String(ss).padStart(2, "0");
  if (majorSec < 1) {
    const cs = Math.round((ms % 1000) / 10);
    return `${mm}:${ssStr}.${String(cs).padStart(2, "0")}`;
  }
  return `${mm}:${ssStr}`;
}
