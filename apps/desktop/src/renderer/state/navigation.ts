import { lastFrameAnchorUs } from "../frames";
import { openComposition, useCompositionAnchorStore } from "./compositionAnchorStore";
import { transportSeek } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
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

/// Clamp a target playhead time to [0, lastFrameAnchorUs] against the OPEN
/// composition — the same rule App.tsx's seekTo applies (Q5 of the
/// frame-anchor spec). The playhead lives on the open timeline's axis.
export function clampSeekUs(tUs: number): number {
  const comp = currentOpenComposition();
  const fpsNum = comp?.fps_num ?? 30;
  const fpsDen = comp?.fps_den ?? 1;
  const upper = lastFrameAnchorUs(comp?.duration_us ?? 0, fpsNum, fpsDen);
  return Math.max(0, Math.min(tUs, upper));
}

/// Optimistic playheadStore write first: with no preview mounted there is
/// no engine emit, yet the playhead UI must still move (mirrors App.tsx
/// seekTo). Play state is untouched — seek-while-playing keeps playing
/// (NLE norm). `clampedUs` must already be clamped — callers go through
/// `seekToClamped` or `jumpToTimeUs`, both of which clamp exactly once.
function seekExact(clampedUs: number): void {
  setPlayheadTimeUs(clampedUs);
  transportSeek(clampedUs);
}

/// Clamped seek through the module-level transport.
export function seekToClamped(tUs: number): void {
  seekExact(clampSeekUs(tUs));
}

export function jumpToTimeUs(tUs: number): void {
  const clamped = clampSeekUs(tUs);
  seekExact(clamped);
  scrollToTimeFn?.(clamped);
}

/// Canonical edit points of the OPEN composition: every layer boundary on
/// every track, plus 0. All tracks participate — navigation is timeline
/// geometry, not audibility, and there is no track targeting to scope it.
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
  const current = playheadTimeUs();
  let best: number | null = null;
  for (const p of editPointsUs()) {
    if (p >= current) break;
    best = p;
  }
  if (best !== null) seekToClamped(best);
}

export function seekToNextEdit(): void {
  const current = playheadTimeUs();
  for (const p of editPointsUs()) {
    if (p > current) {
      seekToClamped(p);
      return;
    }
  }
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
  jumpToTimeUs(layer.t_start_us);
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

/// Reveal + scroll a Track, selecting nothing and seeking nowhere. Returns
/// false when the Track is gone from the live summary, or when no reveal
/// handle is mounted (nothing observable would happen).
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
