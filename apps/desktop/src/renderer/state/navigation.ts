import { displayedFrameStartUs, lastFrameAnchorUs } from "../frames";
import type { MarkerSummary } from "../ipc";
import { openComposition, useCompositionAnchorStore } from "./compositionAnchorStore";
import { transportSeek } from "./playbackStore";
import {
  focusedPlayheadUs,
  focusedRootUs,
  previewLocalUs,
} from "./playheadProjection";
import { setPlayheadTimeUs } from "./playheadStore";
import { currentOpenComposition, useProjectStore } from "./projectStore";
import { setLayerSelection } from "./selectionStore";

/// Imperative navigation verbs for callers outside the React ref chain
/// (search palette, future agent-driven UI). Handles that need component
/// internals — App's R.7 reveal-track state, Timeline's scroll container,
/// MediaPool's list DOM — are registered on mount, playbackStore-style;
/// every verb is a safe no-op for whatever isn't mounted.

/// `layerId: null` means "reveal + scroll the track, select nothing". History
/// rows for `add_track` / `add_caption_track` carry a Track ref and nothing
/// else, and `selectionStore` has no track-selection concept — so revealing
/// without selecting is the honest outcome, not a degraded one. App's
/// `revealTrack` skips its `selectLayerWithLink` for null, leaving whatever
/// was selected alone rather than clearing it.
type RevealTrackFn = (trackId: string, layerId: string | null) => void;
type RevealCollapseFn = () => void;
type ScrollToTimeFn = (tUs: number) => void;
type RevealMediaFn = (mediaId: string) => void;
type OpenMediaPoolPanelFn = () => void;

let revealTrackFn: RevealTrackFn | null = null;
let revealCollapseFn: RevealCollapseFn | null = null;
let scrollToTimeFn: ScrollToTimeFn | null = null;
let revealMediaFn: RevealMediaFn | null = null;
let openMediaPoolPanelFn: OpenMediaPoolPanelFn | null = null;
let pendingRevealMediaId: string | null = null;

// Identity-guarded unregister (releaseTransport pattern): a stale cleanup
// from an old mount can't tear down a newer registration.
export function registerRevealTrack(fn: RevealTrackFn): () => void {
  revealTrackFn = fn;
  return () => {
    if (revealTrackFn === fn) revealTrackFn = null;
  };
}

/// The inverse of `revealTrack`: drop the inline reveal. The composition scope
/// store calls this on every switch — a revealed lane belongs to the timeline
/// being left.
export function registerRevealCollapse(fn: RevealCollapseFn): () => void {
  revealCollapseFn = fn;
  return () => {
    if (revealCollapseFn === fn) revealCollapseFn = null;
  };
}

export function collapseReveal(): void {
  revealCollapseFn?.();
}

export function registerScrollToTime(fn: ScrollToTimeFn): () => void {
  scrollToTimeFn = fn;
  return () => {
    if (scrollToTimeFn === fn) scrollToTimeFn = null;
  };
}

export function registerRevealMedia(fn: RevealMediaFn): () => void {
  revealMediaFn = fn;
  if (pendingRevealMediaId !== null) {
    const mediaId = pendingRevealMediaId;
    pendingRevealMediaId = null;
    fn(mediaId);
  }
  return () => {
    if (revealMediaFn === fn) revealMediaFn = null;
  };
}

/**
 * Register the app-owned Dock Workspace action used by navigation surfaces.
 * The callback is intentionally Media-specific so Dockview and Panel ids do
 * not leak into search/navigation code.
 */
export function registerOpenMediaPoolPanel(
  fn: OpenMediaPoolPanelFn,
): () => void {
  openMediaPoolPanelFn = fn;
  if (pendingRevealMediaId !== null) fn();
  return () => {
    if (openMediaPoolPanelFn === fn) openMediaPoolPanelFn = null;
  };
}

/// Clamp a target playhead time to [0, lastFrameAnchorUs] against the ROOT
/// composition (Q5 of the frame-anchor spec). The ROOT and not the focused
/// timeline: the playhead is one moment in root time (ADR 0053 decision 2), so
/// the film's own length is the only bound that means anything — clamping to a
/// Group's would refuse moments of the film that lie outside it.
export function clampSeekUs(tUs: number): number {
  const summary = useProjectStore.getState().summary;
  const root = summary ? summary.compositions[summary.root_id] : undefined;
  const fpsNum = root?.fps_num ?? 30;
  const fpsDen = root?.fps_den ?? 1;
  const upper = lastFrameAnchorUs(root?.duration_us ?? 0, fpsNum, fpsDen);
  return Math.max(0, Math.min(tUs, upper));
}

/// Optimistic playheadStore write first: with no preview mounted there is
/// no engine emit, yet the playhead UI must still move (mirrors App.tsx
/// seekTo). Play state is untouched — seek-while-playing keeps playing
/// (NLE norm). `clampedUs` must already be clamped — callers go through
/// `seekToClamped` or `jumpToTimeUs`, both of which clamp exactly once.
///
/// ROOT time into the store, the PREVIEW'S clock into the transport: the engine
/// draws one composition and reads one number, and only the store's number is
/// the film's (`playheadProjection.ts`).
function seekExact(clampedUs: number): void {
  setPlayheadTimeUs(clampedUs);
  transportSeek(previewLocalUs(clampedUs));
}

/// Clamped seek through the module-level transport. `tUs` is ROOT time — a
/// caller holding a composition's own clock projects first
/// (`state/playheadProjection.ts`).
export function seekToClamped(tUs: number): void {
  seekExact(clampSeekUs(tUs));
}

/// ROOT time, and it scrolls the timeline it lands in to match.
export function jumpToTimeUs(tUs: number): void {
  const clamped = clampSeekUs(tUs);
  seekExact(clamped);
  scrollToTimeFn?.(clamped);
}

/// Canonical edit points of the FOCUSED composition, on that composition's own
/// clock: every layer boundary on every track, plus 0. All tracks participate —
/// navigation is timeline geometry, not audibility, and there is no track
/// targeting to scope it.
///
/// Local, because a cut is a fact about the timeline being edited: stepping
/// through a Group's cuts means ITS boundaries, not the root's. The projection
/// happens at the two callers, which is also where the answer has to become a
/// root-time seek again.
function editPointsUs(): number[] {
  const comp = currentOpenComposition();
  const points = new Set<number>([0]);
  for (const track of comp?.tracks ?? []) {
    for (const layer of track.layers) {
      points.add(layer.t_start_us);
      points.add(layer.t_end_us);
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

/// Park the playhead on the nearest edit point before/after it
/// (Premiere-style ↑/↓). Parking ON a cut displays the incoming clip's first
/// frame — the half-open convention; one ← from there shows the outgoing
/// clip's last frame. A boundary at the exclusive composition end clamps to
/// the last frame anchor like every other seek, so "next" at the tail is a
/// safe no-op rather than a black frame.
export function seekToPrevEdit(): void {
  const current = focusedPlayheadUs();
  let best: number | null = null;
  for (const p of editPointsUs()) {
    if (p >= current) break;
    best = p;
  }
  if (best !== null) seekToClamped(focusedRootUs(best));
}

export function seekToNextEdit(): void {
  const current = focusedPlayheadUs();
  for (const p of editPointsUs()) {
    if (p > current) {
      seekToClamped(focusedRootUs(p));
      return;
    }
  }
}

/// One reading of the FOCUSED composition, on its own clock, for both verbs
/// below.
interface MarkerWalk {
  /// The marks that can be landed on, in `t_us` order.
  markers: MarkerSummary[];
  /// Start of the frame the playhead is displaying — what each mark's own
  /// frame is compared against.
  frameUs: number;
  fpsNum: number;
  fpsDen: number;
}

/// Local for `editPointsUs`' reason — a mark is a fact about the timeline being
/// edited, so standing in a Group walks ITS marks. Null when no composition is
/// open.
///
/// HIBERNATING marks are dropped: the anchor has left its clip's source window,
/// so the mark names no moment of this timeline to land on. Every other marker
/// surface drops them for the same reason (`timeline/rulerModel.ts`, the search
/// index, the Group badge).
///
/// Nothing is sorted. `t_us` order is a stored invariant (`sortMarkers`,
/// main/state/validate.ts) that `markerStartingInFrame` and the actor's
/// insertion scan already rely on, and a defensive re-sort here would only hide
/// a break in it.
function markerWalk(): MarkerWalk | null {
  const comp = currentOpenComposition();
  if (comp === null) return null;
  return {
    markers: comp.markers.filter((m) => !m.hibernating),
    frameUs: displayedFrameStartUs(focusedPlayheadUs(), comp.fps_num, comp.fps_den),
    fpsNum: comp.fps_num,
    fpsDen: comp.fps_den,
  };
}

/// Park the playhead on the nearest mark starting after / before the frame it
/// is displaying. Local in, ROOT out, the way the edit-point pair above travels.
///
/// Where a mark BEGINS and never where it merely reaches: a region spanning the
/// playhead is not a mark to be walked to — `markerStartingInFrame`'s rule for
/// `M`, said about a neighbouring frame instead of the current one. A region is
/// therefore reached at its start, its end being nothing to land on.
///
/// The comparison is by FRAME and not by microsecond, so a mark sharing the
/// displayed frame counts as behind you in both directions — otherwise a mark
/// whose `t_us` sits a hair past a playhead parked in its own frame would be
/// walked "forward" onto the frame already on screen.
///
/// NO WRAP, in either direction. A walk that cycles turns the far end into a
/// silent jump back to the near one and loses the place being walked from; the
/// dead key at the end of the list IS the signal that the list has an end.
export function seekToNextMarker(): void {
  const walk = markerWalk();
  if (walk === null) return;
  for (const m of walk.markers) {
    if (displayedFrameStartUs(m.t_us, walk.fpsNum, walk.fpsDen) > walk.frameUs) {
      seekToClamped(focusedRootUs(m.t_us));
      return;
    }
  }
}

export function seekToPrevMarker(): void {
  const walk = markerWalk();
  if (walk === null) return;
  let best: MarkerSummary | null = null;
  for (const m of walk.markers) {
    if (displayedFrameStartUs(m.t_us, walk.fpsNum, walk.fpsDen) >= walk.frameUs) break;
    best = m;
  }
  if (best !== null) seekToClamped(focusedRootUs(best.t_us));
}

/// Replace the global selection from an imperative navigation surface. Every
/// requested Layer and the primary must exist in the live Project index; a
/// stale request fails atomically without disturbing the current selection.
export function selectLayers(
  layerIds: Iterable<string>,
  primaryLayerId?: string | null,
): boolean {
  const requested = Array.from(new Set(layerIds));
  const { layerById } = useProjectStore.getState();
  if (requested.some((id) => !layerById.has(id))) return false;
  if (requested.length === 0) {
    if (primaryLayerId !== undefined && primaryLayerId !== null) return false;
    setLayerSelection(null, []);
    return true;
  }

  const primary = primaryLayerId ?? requested[0] ?? null;
  if (primary === null || !requested.includes(primary)) return false;
  setLayerSelection(primary, requested);
  return true;
}

export function selectLayer(layerId: string): boolean {
  return selectLayers([layerId], layerId);
}

/// Open the composition `layerId` lives in, when it is not the open one. The
/// index spans every composition, so a search hit inside a Group resolves; the
/// selection it is about to receive only means something on that Group's
/// timeline, hence the switch comes first. False when the layer is unknown.
function openCompositionOfLayer(layerId: string): boolean {
  const compositionId = useProjectStore.getState().compositionIdByLayerId.get(layerId);
  if (compositionId === undefined) return false;
  if (useCompositionAnchorStore.getState().focusedId === compositionId) return true;
  return openComposition(compositionId, null);
}

/// Select + seek + scroll to a layer, opening its composition first when it
/// sits inside a Group. Validates against the live index — the caller may hold
/// a stale search entry (index rebuilds are debounced). Returns false (and
/// changes nothing) when the layer is gone.
export function jumpToLayer(layerId: string): boolean {
  const { layerById, trackIdByLayerId } = useProjectStore.getState();
  const layer = layerById.get(layerId);
  if (!layer) return false;
  const trackId = trackIdByLayerId.get(layerId);
  if (!openCompositionOfLayer(layerId)) return false;
  if (!selectLayer(layerId)) return false;
  if (trackId && revealTrackFn) {
    // App's revealTrack both reveals a hidden track (R.7) and selects the
    // layer; revealing an already-visible track is harmless.
    revealTrackFn(trackId, layerId);
  }
  // The layer's start is on ITS composition's clock, and the composition it
  // sits in is open by now — so the moment to park the film on is that start
  // projected up through the anchor the open just gave it.
  jumpToTimeUs(focusedRootUs(layer.t_start_us));
  return true;
}

/// Select + reveal a Layer WITHOUT moving the playhead — the non-seeking half
/// of `jumpToLayer`.
///
/// This exists for the History Panel and is deliberately NOT `jumpToLayer`:
/// the playhead is the user's observation point, and a history jump changes
/// what is ON the timeline, not which frame is being looked at. Holding it
/// still is what makes "same frame, before and after" comparison possible —
/// the whole basis for deciding whether a step should be reverted
/// (spec decision 8).
///
/// Goes through App's `revealTrack` when mounted, so the selection is
/// link-aware exactly as a timeline click is; falls back to a plain
/// selection when nothing has registered. Returns false for a Layer that
/// isn't in the live index.
export function revealLayerWithoutSeek(layerId: string): boolean {
  const { layerById, trackIdByLayerId } = useProjectStore.getState();
  if (!layerById.has(layerId)) return false;
  if (!openCompositionOfLayer(layerId)) return false;
  const trackId = trackIdByLayerId.get(layerId);
  if (trackId !== undefined && revealTrackFn) {
    revealTrackFn(trackId, layerId);
    return true;
  }
  return selectLayer(layerId);
}

/// Reveal a Track where it already is, without navigating to it: no
/// composition switch, no selection, no seek. A reveal is keyed by track id,
/// which names its composition project-wide, so a Panel showing that
/// composition picks it up whether or not it holds the keyboard.
///
/// This is the half a Panel asks for about its OWN rows — a lane that spawned
/// under a drop, which the A/B Roll filter would otherwise hide. Taking the
/// keyboard for that would make a drop into a background timeline a
/// navigation, and a drop is a destination (ADR 0053 decision 4).
export function revealTrackInPlace(trackId: string): boolean {
  if (!useProjectStore.getState().compositionIdByTrackId.has(trackId)) return false;
  if (!revealTrackFn) return false;
  revealTrackFn(trackId, null);
  return true;
}

/// Reveal + scroll a Track, selecting nothing and seeking nowhere, ENTERING its
/// composition first — the jump from somewhere else (the History Panel, a
/// search hit), where the whole point is to be taken there. Returns false when
/// the Track is gone from the live summary, or when no reveal handle is mounted
/// (nothing observable would happen).
export function revealTrackWithoutSelection(trackId: string): boolean {
  const compositionId = useProjectStore.getState().compositionIdByTrackId.get(trackId);
  if (compositionId === undefined) return false;
  if (!revealTrackFn) return false;
  if (
    useCompositionAnchorStore.getState().focusedId !== compositionId &&
    !openComposition(compositionId, null)
  ) {
    return false;
  }
  revealTrackFn(trackId, null);
  return true;
}

/// Focus or reopen the singleton Media Pool Panel and flash the item. The
/// pending id survives a closed Panel's destroy/recreate boundary.
export function revealInMediaPool(mediaId: string): boolean {
  if (!useProjectStore.getState().mediaById.has(mediaId)) return false;
  pendingRevealMediaId = mediaId;
  openMediaPoolPanelFn?.();
  if (revealMediaFn) {
    pendingRevealMediaId = null;
    revealMediaFn(mediaId);
  }
  return true;
}
