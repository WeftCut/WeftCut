import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  addTransition,
  dropShotMarkers,
  linksCreate,
  linksDissolve,
  linksRename,
  groupsRename,
  moveLayer,
  removeTransition,
  separateAudioToNewTrack,
  setLayersEnabled,
  splitLayerLinked,
  updateLayer,
  updateLayerParamTrack,
  updateLayerParamTracks,
  updateParamTracksMulti,
  updateTransition,
  type AnimTrack,
  type LinkSummary,
  type KeybindingsMap,
  type LayerSummary,
  type MediaSummary,
  type TrackSummary,
  type TransitionDirection,
  type TransitionSummary,
} from "../ipc";
import { mediaReadiness, type ProxyState } from "../panels/mediaReadiness";
import { findPanelLayer } from "../panels/panelLayer";
import { scaleFanOutFor } from "../keyframe/descriptors";
import { fanOutEntries } from "../keyframe/fanOut";
import { formatTimecode, snapFrameRound } from "../frames";
import {
  useDisplayMode,
  useFollowPlayheadEnabled,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "../settings/appSettingsStore";
import { useShortcuts, type OverrideMap } from "../shortcuts/useShortcuts";
import { ACTION_DEFS } from "../shortcuts/defs";
import { useCommandProvider } from "../commands/registry";
import {
  NUDGE_MS,
  NUDGE_SAMPLE,
  nudgedStartUs,
  resyncStartUs,
  slippableAudioLayers,
  type SlipLayer,
} from "./audioSlip";
import { deriveAudioSyncOffsets, setAudioSyncOffsets } from "./audioSyncOffsetStore";
import {
  canToggleLinkSelection,
  enclosingLink,
  linkFanoutActive,
  linkToggleState,
} from "./linkEligibility";
import {
  canDeselectAll,
  canSelectAll,
  deselectAll,
  selectAllLayers,
} from "./selectionCommands";
import { requestPrebake } from "../render/motifs/prebakeBus";
import {
  DEFAULT_TRACK_HEIGHT,
  HEADER_COL_PX,
  computeTimelineExtent,
  indexLinks,
  indexLinkTabs,
  playheadFrameShadowPx,
  trackKeyframeProperties,
  visualOrderedTracks,
  type MeasuredTrackRow,
} from "./geometry";
import {
  marqueeHitClips,
  marqueeHitKeyframes,
  resolveMarqueeSelection,
  type MeasuredSubLaneRow,
} from "./marquee";
import type { MarqueeBox, MarqueeKind } from "./marqueeStore";
import { DropStrip, DropStripHeader } from "./DropStrip";
import { MarkerLane, MarkerLaneHeader } from "./MarkerLane";
import { registerTimelineSurface } from "./timelineSurfaces";
import { TimelineRuler } from "./TimelineRuler";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import type { MediaDragPayload, MediaDropPlan } from "./mediaDrag";
import {
  KeyframeLane,
  KeyframeLaneHeaders,
  type RegisterSubLaneEl,
} from "./KeyframeLane";
import {
  useAnchorPath,
  useFocusedCompositionId,
} from "../state/compositionAnchorStore";
import { handCaretToEditor } from "../menu/Menu";
import { LayerContextMenu } from "./LayerContextMenu";
import { ForeignDragGhost } from "./ForeignDragGhost";
import { MarqueeOverlay } from "./MarqueeOverlay";
import { beginGroupRename, beginLayerRename, beginLinkRename } from "./renameStore";
import {
  MarqueeAnchorContext,
  beginMarquee,
  type MarqueeAnchor,
} from "./hooks/useMarqueeAnchor";
import { useTimelineView } from "./hooks/useTimelineView";
import { useFollowPlayhead } from "./hooks/useFollowPlayhead";
import { useWheelScroll } from "./hooks/useWheelScroll";
import { useHeightDrag } from "./hooks/useHeightDrag";
import { useLayerDrag } from "./hooks/useLayerDrag";
import { LayerDragTrimMonitor } from "./LayerDragTrimMonitor";
import { useIsLayerDragging } from "./layerDragStore";
import { snapTimeToTimelineBoundary } from "./snapping";
import {
  localClockUsOf,
  localPlayheadIn,
  playheadClockUs,
  rootUsOf,
  seekLocalUs,
  subscribeLocalPlayhead,
  useAnchorFrame,
} from "../state/playheadProjection";
import type { AnchorFrame } from "../render/timeProjection";
import {
  useRangeInUs,
  useRangeOutUs,
  useRangeReveal,
} from "../state/rangeStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import {
  registerScrollToTime,
  revealTrackInPlace,
} from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { addGroupLayerIn, addTrackIn } from "../ipc/compositionScoped";
import {
  clearLayerSelection,
  clearTransitionSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  setLayerSelection,
  setTransitionSelection,
  toggleLayerSelection,
  usePrimaryLayerId,
  useSelectedLayerIds,
  useSelectedTransitionId,
} from "../state/selectionStore";
import {
  clearKeyframeSelection,
  getSelectedKeyframes,
  setKeyframeSelection,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import {
  KeyframeBatchContext,
  batchParamTrackEntries,
  removeKeys,
  type KeyframeBatchCommit,
  type ParamTrackEntry,
} from "./keyframeBatch";
import { resolveAccelerator } from "../shortcuts/match";
import { subSelectionDeleteYields } from "./subSelectionDelete";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import { logMutationFailure } from "../errors/tryMutate";
import {
  CUT_CLICK_TOLERANCE_PX,
  defaultTransitionDurationUs,
  findCutNear,
  type TrackTransitionChip,
  type TransitionCut,
  type TransitionKindName,
  type TransitionResizeArgs,
  type TransitionUpdateArgs,
} from "./transitions";
import { TransitionChipMenu } from "./TransitionChipMenu";

interface TimelineProps {
  /// The composition this timeline renders — its Panel's own instance, never
  /// the focused one (ADR 0053). `null` is the unbound row the Dock builds
  /// before the first summary names a root, and reads as the root.
  compositionId: string | null;
  tracks: TrackSummary[];
  /// `docs/features.md#links`. Empty array when no links exist.
  links: LinkSummary[];
  /// Transitions between same-track adjacent visual layers, rendered as
  /// chips over the incoming layer's head. Optional — older snapshots and
  /// test fixtures omit the field; absent means empty.
  transitions?: TransitionSummary[];
  durationUs: number;
  /// (`docs/data-model.md`): when set, this hidden track is
  /// included in the AB-mode ordered list at its natural accretion
  /// slot. Cleared by the App when the user selects a layer on a
  /// different track, presses Esc, or the Playhead Panel dispatches a new
  /// reveal.
  revealedTrackId?: string | null;
  /// User-overridden keybindings, threaded through from App for the
  /// timeline-scoped `toggleLinkSelected` action. Missing entries fall back
  /// to `ACTION_DEFS` defaults.
  keybindings: KeybindingsMap;
  /// Composition fps for frame-grid snapping of seek / drag / scrub
  /// targets. UI snaps eagerly so the ghost matches the actor's
  /// commit-side snap; actor remains the authoritative enforcement.
  fpsNum: number;
  fpsDen: number;
  /// True while the Blade tool is armed (`toolStore.ts`; `C` selects it).
  /// Layer clicks then split at the click point instead of selecting, and
  /// the cursor turns into a razor. Exit by selecting the Selection tool
  /// (`V`) or pressing Esc (handled here).
  bladeMode: boolean;
  /// Snapshot of the current media pool — used by `onMediaDrop` to
  /// validate readiness before lowering the drop to `addMediaLayer`.
  media: MediaSummary[];
  /// Media that are still copying into the workspace. Cards in this set
  /// are not interactive in the pool; the drop handler rejects them as
  /// defence in depth (e.g. status flipping mid-drag, future non-drag
  /// drop pathways).
  importing: ReadonlySet<string>;
  /// Per-video proxy lifecycle from `media:job_*`. Same defence-in-depth
  /// role at the drop site as `importing`.
  proxyState: ReadonlyMap<string, ProxyState>;
  /// Media ids whose original can be used as a session preview bridge while
  /// optimization is still running.
  previewDecodable: ReadonlySet<string>;
  visible?: boolean;
  onExitBlade: () => void;
  /// Park the film at this ROOT moment. A Panel scrubs on its own clock, so it
  /// projects up before calling (`state/playheadProjection.ts`); a composition
  /// with no root time never reaches here at all.
  onSeek: (tUs: number) => void;
  onMutated: () => Promise<void>;
}


const EMPTY_TRANSITIONS: TransitionSummary[] = [];

/// How far off the panel surface one level of nesting moves the timeline's empty
/// space, and how many levels are worth showing. Capped because the tint has to
/// stay quieter than the clips drawn on it — past three steps it starts reading
/// as a selected region rather than as a place.
const GROUP_TINT_STEP_PCT = 6;
const MAX_GROUP_TINT_STEPS = 3;

export function Timeline({
  compositionId,
  tracks,
  links,
  transitions = EMPTY_TRANSITIONS,
  durationUs,
  revealedTrackId,
  keybindings,
  fpsNum,
  fpsDen,
  bladeMode,
  media,
  importing,
  proxyState,
  previewDecodable,
  visible = true,
  onExitBlade,
  onSeek,
  onMutated,
}: TimelineProps) {
  // Right-click context-menu state. `null` when closed; otherwise
  // anchors the menu at the cursor and stores the target layer id.
  // `cut` is non-null when the click landed within the tolerance band of a
  // hard cut between same-track adjacent visual layers — the menu then
  // offers the "Add transition" section.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
    layerEnabled: boolean;
    /// `Alt` held on the right-click — the menu's Enable/Disable row escapes
    /// the link fan-out, as the click's selection did.
    escapeLink: boolean;
    cut: TransitionCut | null;
  } | null>(null);
  // Transition-chip context-menu state — the chip counterpart of
  // `contextMenu`, holding the full TransitionSummary so the menu can render
  // current kind/direction/duration checkmarks without a re-lookup.
  const [chipMenu, setChipMenu] = useState<{
    x: number;
    y: number;
    transition: TransitionSummary;
  } | null>(null);
  const primaryLayerId = usePrimaryLayerId();
  const selectedLayerIds = useSelectedLayerIds();
  const selectedTransitionId = useSelectedTransitionId();
  const [bladePreview, setBladePreview] = useState<{
    layerId: string;
    atUs: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const {
    pxPerSec,
    trackHeights,
    setTrackHeights,
    trackHeightsRef,
    expandedTracks,
    toggleExpanded,
    viewportWidthPx,
    zoomBySteps,
  } = useTimelineView({ compositionId, rootRef, tracks, durationUs });

  // Publish this Panel's surface so a clip drag that wanders out of it can name
  // the composition it wandered into (`timelineSurfaces.ts`). Only while on
  // screen: a tab behind another still holds a rect, and one that overlapped a
  // visible neighbour would make an ordinary in-Panel drag look like a crossing.
  useEffect(() => {
    const el = rootRef.current;
    if (compositionId === null || !visible || el === null) return;
    return registerTimelineSurface(compositionId, el);
  }, [compositionId, visible]);

  // The unmodified wheel's axis. Separate from `useTimelineView`'s listener on
  // the same node because the two gestures are separate concerns and neither
  // reads the other's state; they stay disjoint by keying on modifiers
  // (Ctrl/Alt zoom, bare/Shift scroll), not on listener order.
  useWheelScroll(rootRef);

  // Horizontal scroll-to-time for palette jumps.
  // pxPerSec is React state; the registered closure reads it through a ref
  // so registration happens once per mount.
  const pxPerSecForScrollRef = useRef(pxPerSec);
  useLayoutEffect(() => {
    pxPerSecForScrollRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(
    () =>
      registerScrollToTime((tUs) => {
        const root = rootRef.current;
        if (!root) return;
        // ROOT time in: the caller parks the film, and this Panel scrolls to
        // wherever that moment sits on its own axis.
        const x =
          (localClockUsOf(compositionId, tUs) / 1_000_000) *
          pxPerSecForScrollRef.current;
        const viewport = root.clientWidth - HEADER_COL_PX;
        // Center the target time in the lane area (the first HEADER_COL_PX
        // of the viewport is the sticky track-header column).
        root.scrollLeft = Math.max(0, x - viewport / 2);
        // Publish now rather than waiting for the scroll event's rAF, so the
        // ruler's tick window lands with the jump instead of one frame later.
        setTimelineScrollLeftPx(compositionId, root.scrollLeft);
      }),
    [compositionId],
  );

  // Publish horizontal scroll for the ruler's tick window. Deliberately NOT
  // React state here: this component is the whole timeline tree, and a
  // per-wheel-event re-render of it is the regression the memory ratchet
  // guards (see state/timelineScrollStore.ts). rAF-coalesced so a scroll
  // burst collapses to one store write per frame.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const publish = () => {
      raf = 0;
      setTimelineScrollLeftPx(compositionId, root.scrollLeft);
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(publish);
    };
    // Seed: a remount (dock panel switch) starts at scrollLeft 0 without
    // firing a scroll event.
    setTimelineScrollLeftPx(compositionId, root.scrollLeft);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      root.removeEventListener("scroll", onScroll);
    };
  }, [compositionId]);

  // Cursor-anchored zoom re-writes `scrollLeft` in a layout effect inside
  // `useTimelineView`, which is registered BEFORE this one — so by the time this
  // runs the re-anchored offset is final, and publishing it here (rather than
  // waiting for the scroll event's rAF) is what keeps the ruler's window from
  // painting the pre-zoom region for one frame.
  useLayoutEffect(() => {
    if (rootRef.current) {
      setTimelineScrollLeftPx(compositionId, rootRef.current.scrollLeft);
    }
  }, [compositionId, pxPerSec]);

  const { totalSec, widthPx } = computeTimelineExtent({
    durationUs,
    pxPerSec,
    viewportWidthPx,
  });

  // Page the view to keep the playhead visible (app-level pref, default on).
  // Also gated on `visible`, like the playhead line itself: a timeline behind
  // another dock tab has nothing to keep in view.
  const followEnabled = useFollowPlayheadEnabled();
  // Resolved once here and handed to every per-frame reader below: resolving an
  // anchor frame walks the summary, which is exactly what must not happen once
  // per composition frame, once per open Panel.
  const anchorFrame = useAnchorFrame(compositionId);
  const { setScrubbing: setFollowScrubbing } = useFollowPlayhead({
    compositionId,
    anchorFrame,
    rootRef,
    pxPerSec,
    viewportWidthPx,
    contentWidthPx: widthPx,
    enabled: followEnabled && visible,
  });

  const linkByLayerId = useMemo(() => indexLinks(links), [links]);

  // The derived A/V sync offset (R2-D7). Published to a store rather than threaded as
  // a prop so only the badged clip re-renders; `setAudioSyncOffsets` no-ops when the
  // map is unchanged, so an unrelated project update costs nothing.
  useLayoutEffect(() => {
    setAudioSyncOffsets(
      deriveAudioSyncOffsets(
        tracks.flatMap((t) => t.layers),
        links,
      ),
    );
  }, [tracks, links]);

  // A/B-roll display mode comes from the app-level settings store
  // (`docs/data-model.md`). The store hydrates on app mount via
  // `wireAppSettingsStream`. Atomic selector — never include the rest of
  // the settings struct in a single selector (feedback_zustand_composite_
  // selector).
  const displayMode = useDisplayMode();
  const tailSnapEnabled = useTailSnapEnabled();
  const tailSnapStrengthPx = useTailSnapStrengthPx();

  const orderedTracks = useMemo(() => {
    const all = visualOrderedTracks(tracks);
    if (displayMode === "AllTracks") return all;
    // A/B Roll filter: keep role-stamped tracks. Inline-reveal lets one
    // additional hidden track survive the filter at its natural
    // accretion slot — the visualOrderedTracks output already has the
    // slot computed, so we just need to keep that row alongside the
    // role-stamped ones.
    return all.filter(
      ({ track }) =>
        track.role !== null || track.id === (revealedTrackId ?? null),
    );
  }, [tracks, displayMode, revealedTrackId]);

  const visibleSnapTracks = useMemo(
    () => orderedTracks.map(({ track }) => track),
    [orderedTracks],
  );
  // Each link's anchor member and what it draws there. Built from the RENDERED
  // lanes, so the hidden-member count follows the display filter and the
  // inline reveal with no rule of its own.
  const linkTabByLayerId = useMemo(
    () => indexLinkTabs(links, visibleSnapTracks, tracks),
    [links, visibleSnapTracks, tracks],
  );
  const mediaDropSnap = useMemo(
    () => ({
      visibleTracks: visibleSnapTracks,
      links,
      linkByLayerId,
      enabled: tailSnapEnabled,
      strengthPx: tailSnapStrengthPx,
    }),
    [
      linkByLayerId,
      links,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  /// Map a click event on a layer chip to the resulting selection set.
  /// `docs/features.md#links`: plain click on a linked layer selects the
  /// whole link; `Alt+click` selects only the clicked layer (escape
  /// path), and so does every click while the link override is on
  /// (`linkFanoutActive`); `Shift+click` TOGGLES the clicked layer (with its
  /// whole link if any) in and out of the current selection.
  ///
  /// Returns whether the clicked layer is selected afterwards — `false` only
  /// for a Shift+click that removed it. `LayerBlock` needs that answer because
  /// it seeds a drag from the same pointerdown, and a clip the user just
  /// deselected must not be the one that moves.
  const selectFromClick = useCallback(
    (
      layerId: string,
      e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
    ): boolean => {
      const gid = linkByLayerId.get(layerId);
      const memberSet = (): Set<string> => {
        if (!gid || !linkFanoutActive(e)) return new Set([layerId]);
        const g = links.find((x) => x.id === gid);
        return new Set(g?.layer_ids ?? [layerId]);
      };
      const members = memberSet();
      if (e.shiftKey) return toggleLayerSelection(layerId, members);
      setLayerSelection(layerId, members);
      return true;
    },
    [linkByLayerId, links],
  );

  /// Handler for the link toggle (`ACTION_DEFS.toggleLinkSelected` owns the
  /// key and the why). It reads state via refs to avoid the stale-closure trap
  /// of multi-key chord dispatch.
  const selectedLayerIdsRef = useRef(selectedLayerIds);
  const linkByLayerIdRef = useRef(linkByLayerId);
  const linksRef = useRef(links);
  const onMutatedRef = useRef(onMutated);
  useLayoutEffect(() => {
    selectedLayerIdsRef.current = selectedLayerIds;
    linkByLayerIdRef.current = linkByLayerId;
    linksRef.current = links;
    onMutatedRef.current = onMutated;
  }, [selectedLayerIds, linkByLayerId, links, onMutated]);

  const shortcutOverrides = useMemo<OverrideMap>(
    () => keybindings as OverrideMap,
    [keybindings],
  );
  // Every handler below is named so the search-palette command provider can
  // reference the exact same function objects the shortcut dispatcher uses.

  /// Select All over the RENDERED tracks, not the project's (`selectAllLayers`
  /// carries the why). `visibleSnapTracks` is already the display-filtered,
  /// reveal-aware list the lanes are drawn from, so the selection this builds is
  /// exactly what the user can see. Closes over the latest render rather than a
  /// ref: `useShortcuts` re-reads its handler map every render, and the rendered
  /// track list is a prop-derived memo, so there is no chord-dispatch staleness
  /// to dodge here. Deselect All takes no input at all, so the module function
  /// IS the handler.
  const handleSelectAll = useCallback(
    () => selectAllLayers(visibleSnapTracks),
    [visibleSnapTracks],
  );

  /// One key, two directions (`linkEligibility.ts` decides which): a selection
  /// inside one link dissolves that link; two or more unlinked layers become
  /// one. A mixed selection is a no-op here, the same silence the strip's
  /// disabled button shows.
  const handleToggleLinkSelected = useCallback(async () => {
    const sel = selectedLayerIdsRef.current;
    const currentLinks = linksRef.current;
    try {
      const enclosing = enclosingLink(sel, currentLinks);
      if (enclosing) {
        await linksDissolve(enclosing.id);
      } else if (linkToggleState(sel, currentLinks) === "link") {
        await linksCreate(Array.from(sel), null, false);
      } else {
        return;
      }
      await onMutatedRef.current();
    } catch (err) {
      logMutationFailure(err, "Link / Unlink layers");
    }
  }, []);

  // ── Sub-frame audio slip (ADR 0038) ────────────────────────────────────────
  // Why keys are the authoring surface at all: see the ADR 0038 note on
  // `ACTION_DEFS.nudgeAudioSampleBack`.
  //
  // `escapeLink: true` on every one of them: the whole point is to move the audio
  // WITHOUT its video partner. That is also what creates the implicit sync offset
  // R2-D7 surfaces as the clip badge — there is no field to write.
  const layersByIdRef = useRef(new Map<string, LayerSummary>());
  const trackOfLayerRef = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const byId = new Map<string, LayerSummary>();
    const trackOf = new Map<string, string>();
    for (const t of tracks) {
      for (const l of t.layers) {
        byId.set(l.id, l);
        trackOf.set(l.id, t.id);
      }
    }
    layersByIdRef.current = byId;
    trackOfLayerRef.current = trackOf;
  }, [tracks]);

  /// Move every selected audio layer to `nextStart(layer)`, or skip it when that
  /// resolves to null / no movement. One `move_layer` per layer, then one refresh.
  const slipSelectedAudio = useCallback(
    async (nextStart: (l: SlipLayer, members: SlipLayer[]) => number | null) => {
      const byId = layersByIdRef.current;
      const targets = slippableAudioLayers(selectedLayerIdsRef.current, [...byId.values()]);
      if (targets.length === 0) return;
      let moved = false;
      for (const audio of targets) {
        const gid = linkByLayerIdRef.current.get(audio.id);
        const members = gid
          ? (linksRef.current.find((g) => g.id === gid)?.layer_ids ?? [])
              .map((id) => byId.get(id))
              .filter((l): l is LayerSummary => l !== undefined)
          : [];
        const next = nextStart(audio, members);
        if (next === null || next === audio.t_start_us) continue;
        const trackId = trackOfLayerRef.current.get(audio.id);
        if (trackId === undefined) continue;
        try {
          await moveLayer(audio.id, trackId, next, true);
          moved = true;
        } catch (err) {
          logMutationFailure(err, "Slip audio");
        }
      }
      if (moved) await onMutatedRef.current();
    },
    [],
  );

  const nudgeAudio = useCallback(
    (steps: number) => () => void slipSelectedAudio((l) => nudgedStartUs(l, steps)),
    [slipSelectedAudio],
  );
  const handleNudgeAudioSampleBack = useMemo(() => nudgeAudio(-NUDGE_SAMPLE), [nudgeAudio]);
  const handleNudgeAudioSampleForward = useMemo(() => nudgeAudio(NUDGE_SAMPLE), [nudgeAudio]);
  const handleNudgeAudioMsBack = useMemo(() => nudgeAudio(-NUDGE_MS), [nudgeAudio]);
  const handleNudgeAudioMsForward = useMemo(() => nudgeAudio(NUDGE_MS), [nudgeAudio]);
  const handleResyncAudioToVideo = useCallback(
    () => void slipSelectedAudio((l, members) => resyncStartUs(l, members)),
    [slipSelectedAudio],
  );

  // ── Keyboard zoom, anchored on the playhead ────────────────────────────────
  // Read at press time rather than subscribed: the playhead moves once per
  // composition frame and this component is the whole timeline tree, so a
  // subscription here would re-render all of it during playback (the regression
  // `state/timelineScrollStore.ts` guards). A one-off read is also the only
  // correct one — the anchor is where the playhead is when the key goes down.
  // Projected: the anchor is a position on THIS Panel's axis, so it is the
  // moment as this composition reads it, not as the film does.
  const handleZoomTimelineIn = useCallback(
    () => zoomBySteps(1, playheadClockUs(compositionId)),
    [compositionId, zoomBySteps],
  );
  const handleZoomTimelineOut = useCallback(
    () => zoomBySteps(-1, playheadClockUs(compositionId)),
    [compositionId, zoomBySteps],
  );

  // `useShortcuts` binds one `window` listener per instance, so N mounted
  // timeline Panels are N listeners that all pass the same
  // `scope: "timeline"` test — the region name is a kind, and every timeline
  // Panel is that kind. Unscoped, the handlers below would each run once per
  // open Panel: both timelines would zoom, and `toggleLinkSelected` would fire
  // twice and undo itself. Only the Panel holding the keyboard answers, which
  // is what ADR 0041's `scope` means once a kind instantiates (ADR 0053).
  //
  // `disabled` is read at dispatch time, so this gate costs a re-render per
  // focus change — a user gesture — and nothing per keystroke.
  const focusedCompositionId = useFocusedCompositionId();
  const rootCompositionId = useProjectStore((s) => s.summary?.root_id ?? null);
  // The unbound row the Dock builds before a summary names a root shows the
  // root, the same reading `compositionOrRoot` gives it.
  const isFocusedTimeline =
    (compositionId ?? rootCompositionId) ===
    (focusedCompositionId ?? rootCompositionId);

  useShortcuts({
    disabled: !isFocusedTimeline,
    overrides: shortcutOverrides,
    handlers: {
      selectAll: handleSelectAll,
      deselectAll,
      toggleLinkSelected: handleToggleLinkSelected,
      nudgeAudioSampleBack: handleNudgeAudioSampleBack,
      nudgeAudioSampleForward: handleNudgeAudioSampleForward,
      nudgeAudioMsBack: handleNudgeAudioMsBack,
      nudgeAudioMsForward: handleNudgeAudioMsForward,
      resyncAudioToVideo: handleResyncAudioToVideo,
      zoomTimelineIn: handleZoomTimelineIn,
      zoomTimelineOut: handleZoomTimelineOut,
    },
  });

  // Gated on the same predicate as the shortcuts above, for the ADR 0053 reason
  // stated there and one more that is specific to the registry: these ten ids
  // are one namespace, so two open timeline Panels hand `listCommands()` the
  // same ten twice. It keeps whichever Panel mounted FIRST, which is not
  // necessarily the one holding the keyboard — so ungated, the palette's
  // Select All and Ctrl+A would act on DIFFERENT timelines, and every lookup
  // would log the collision (25 of them per Quick Actions strip render).
  useCommandProvider(() => [
    // Timeline's provider rather than App's catalogue, which is also why neither
    // appears in the Edit menu: a menu-bar row backed by this provider would
    // vanish whenever the Timeline Panel is closed
    // (`menu/contextMenuCommands.test.ts` states the rule). The keyboard is the
    // primary surface for both — and it is timeline-scoped anyway — with the
    // palette carrying discoverability.
    {
      id: "selectAll",
      actionId: "selectAll",
      labelKey: ACTION_DEFS.selectAll.labelKey,
      enabled: canSelectAll,
      run: handleSelectAll,
    },
    {
      id: "deselectAll",
      actionId: "deselectAll",
      labelKey: ACTION_DEFS.deselectAll.labelKey,
      enabled: canDeselectAll,
      run: deselectAll,
    },
    {
      id: "toggleLinkSelected",
      actionId: "toggleLinkSelected",
      labelKey: ACTION_DEFS.toggleLinkSelected.labelKey,
      // Live store reads, not this render's `selectedLayerIds`: the predicate
      // is evaluated inside `listCommands()` by whichever surface is drawing
      // the row (the Quick Actions strip, the palette, a context menu), and a
      // value captured when Timeline last rendered would freeze. Same rule
      // `appCommands.ts` states for `clearRange`.
      enabled: canToggleLinkSelection,
      run: handleToggleLinkSelected,
    },
    {
      id: "nudgeAudioSampleBack",
      actionId: "nudgeAudioSampleBack",
      labelKey: ACTION_DEFS.nudgeAudioSampleBack.labelKey,
      run: handleNudgeAudioSampleBack,
    },
    {
      id: "nudgeAudioSampleForward",
      actionId: "nudgeAudioSampleForward",
      labelKey: ACTION_DEFS.nudgeAudioSampleForward.labelKey,
      run: handleNudgeAudioSampleForward,
    },
    {
      id: "nudgeAudioMsBack",
      actionId: "nudgeAudioMsBack",
      labelKey: ACTION_DEFS.nudgeAudioMsBack.labelKey,
      run: handleNudgeAudioMsBack,
    },
    {
      id: "nudgeAudioMsForward",
      actionId: "nudgeAudioMsForward",
      labelKey: ACTION_DEFS.nudgeAudioMsForward.labelKey,
      run: handleNudgeAudioMsForward,
    },
    {
      id: "resyncAudioToVideo",
      actionId: "resyncAudioToVideo",
      labelKey: ACTION_DEFS.resyncAudioToVideo.labelKey,
      run: handleResyncAudioToVideo,
    },
    {
      id: "zoomTimelineIn",
      actionId: "zoomTimelineIn",
      labelKey: ACTION_DEFS.zoomTimelineIn.labelKey,
      run: handleZoomTimelineIn,
    },
    {
      id: "zoomTimelineOut",
      actionId: "zoomTimelineOut",
      labelKey: ACTION_DEFS.zoomTimelineOut.labelKey,
      run: handleZoomTimelineOut,
    },
  ], { enabled: isFocusedTimeline });

  // Live lane-element registry. The drag hit-test measures these nodes rather
  // than recomputing row offsets from track heights — a row's on-screen extent
  // includes chrome that arithmetic misses (see `trackIdAtClientY`).
  const laneElsRef = useRef(new Map<string, HTMLElement>());
  const registerLaneEl = useCallback((trackId: string, el: HTMLElement | null) => {
    if (el) laneElsRef.current.set(trackId, el);
    else laneElsRef.current.delete(trackId);
  }, []);
  // The keyframe half of the registry above, one entry per rendered sub-lane
  // row. Held apart because these rows are not lanes and nothing but the
  // marquee reads them; the key is `(trackId, paramKey)` because one row draws
  // one property across every layer on its track.
  const subLaneElsRef = useRef(
    new Map<
      string,
      { trackId: string; paramKey: string; expanded: boolean; el: HTMLElement }
    >(),
  );
  const registerSubLaneEl = useCallback<RegisterSubLaneEl>(
    (trackId, paramKey, expanded, el) => {
      const key = `${trackId}|${paramKey}`;
      if (el) subLaneElsRef.current.set(key, { trackId, paramKey, expanded, el });
      else subLaneElsRef.current.delete(key);
    },
    [],
  );
  // The drop strip's row, measured by the same hit-test. Held apart from the
  // registry above because that registry maps TRACK ids to lanes and the strip is
  // not a track — no consumer of it should have to know about a row that is not
  // one (see `useLayerDrag`'s `dropStripEl`).
  const dropStripElRef = useRef<HTMLDivElement | null>(null);

  const { heightDrag, beginHeightDrag } = useHeightDrag({
    trackHeightsRef,
    setTrackHeights,
  });

  // A spawned lane carries no role, so the A/B Roll filter above would hide the clip
  // that just landed on it. Route it through the existing inline-reveal (R.7)
  // rather than a second visibility rule. Held as state because the reveal
  // registry validates against `projectStore`, which refreshes on its own
  // `project:changed` subscription and can still be one fetch behind the commit.
  const [spawnRevealTrackId, setSpawnRevealTrackId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const trackId = spawnRevealTrackId;
    if (trackId === null) return;
    const attempt = () => {
      if (!revealTrackInPlace(trackId)) return false;
      setSpawnRevealTrackId(null);
      return true;
    };
    if (attempt()) return;
    return useProjectStore.subscribe(() => void attempt());
  }, [spawnRevealTrackId]);
  // Both spawn paths — a media-pool drop and an existing-clip raise — end here,
  // so the visibility rule has one home.
  const revealSpawnedTrack = useCallback(
    (trackId: string) => {
      if (displayMode !== "AllTracks") setSpawnRevealTrackId(trackId);
    },
    [displayMode],
  );

  // The gesture itself lives in `layerDragStore`, not here: one `useState` on
  // this root would re-render every lane, sub-lane and chip per pointermove.
  // This root subscribes to the one bit it draws.
  const isLayerDragging = useIsLayerDragging(compositionId);
  const { setDrag, pendingPlacements, pendingLayerById, dragLayerById } =
    useLayerDrag({
      compositionId,
      tracks,
      links,
      linkByLayerId,
      orderedTracks,
      laneEls: laneElsRef,
      dropStripEl: dropStripElRef,
      pxPerSec,
      fpsNum,
      fpsDen,
      tailSnapEnabled,
      tailSnapStrengthPx,
      onLaneSpawned: revealSpawnedTrack,
      onMutated,
    });

  // -------- Media drop, seek, render --------

  // Every commit here names THIS Panel's composition, so the clip lands in the
  // timeline it was released on. Nothing focuses that timeline: the drop is a
  // local act, and stealing the keyboard would take the inspector and — while
  // the preview follows focus — the picture along with it (ADR 0053 decision 4).
  const onMediaDrop = useCallback(
    async (
      // null = the drop strip: no lane exists yet, so one is created first.
      track: TrackSummary | null,
      payload: MediaDragPayload,
      plan: MediaDropPlan,
    ) => {
      // No kind gate: tracks are kind-agnostic, so any media kind drops on any
      // track and nothing is auto-routed elsewhere. Overlap is the main-process
      // state layer's rule (`main/state/validate.ts`), pre-checked for the ghost
      // by the placement policy.
      //
      // A composition drop takes the same route with no readiness gate: what it
      // places is already in the project, so there is no import to wait for and
      // nothing to be missing. The one thing it can be refused for — containing
      // itself — the drop target has already greyed out.
      if (payload.source === "composition") {
        try {
          const trackId =
            track !== null ? track.id : await addTrackIn(compositionId);
          await addGroupLayerIn({
            compositionId,
            sourceCompositionId: payload.compositionId,
            trackId,
            tStartUs: plan.rawStartUs,
          });
          if (track === null) revealSpawnedTrack(trackId);
          await onMutated();
        } catch (err) {
          logMutationFailure(err, "Group drop");
        }
        return;
      }
      const m = media.find((mm) => mm.id === payload.mediaId);
      if (!m) {
        console.warn(
          `media drop rejected: ${payload.mediaId} not found in current summary`,
        );
        return;
      }
      const readiness = mediaReadiness(m, importing, proxyState, {
        previewDecodable: previewDecodable.has(m.id),
      });
      if (!readiness.ready) {
        console.warn(
          `media drop rejected: ${payload.mediaId} is ${readiness.reason}`,
        );
        return;
      }
      try {
        // Spawn-then-place is TWO commits, matching what the layer-adding
        // commands already do when their reverse scan finds no free lane
        // (`main/state/actor.ts`, add_color_layer): the track add gets its own
        // op_id, then the layer add gets a second one.
        //
        // Deliberately unlike raising an EXISTING clip, which is one entry via
        // `move_layers_to_new_track`. There, undo has to give a pruned SOURCE
        // lane back, so two entries would let one undo leave the clip stranded on
        // a lane that no longer belongs to it. A fresh import empties nothing, so
        // the first undo removes the layer and the second removes the lane —
        // each step reversing exactly what it did.
        const trackId = track !== null ? track.id : await addTrackIn(compositionId);
        await addMediaLayer(trackId, payload.mediaId, plan.rawStartUs);
        if (track === null) revealSpawnedTrack(trackId);
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Media drop");
      }
    },
    [
      compositionId,
      importing,
      media,
      onMutated,
      previewDecodable,
      proxyState,
      revealSpawnedTrack,
    ],
  );

  // Context-menu open handler. Captures cursor position + target layer;
  // triggered by LayerBlock's onContextMenu (right-click). Also hit-tests
  // the click against the cuts on the layer's track: within
  // CUT_CLICK_TOLERANCE_PX of a seam between same-track adjacent visual
  // layers both long enough for the default duration (the kernel's
  // eligibility), the menu grows the "Add transition" section. A locked track
  // offers no cuts — the add would refuse TrackLocked, and prevention beats a
  // status-bar refusal (#18).
  const onContextMenu = useCallback(
    (
      e: React.MouseEvent,
      layerId: string,
      layerKind: string,
      layerEnabled: boolean,
    ) => {
      // Right-click SELECTS, the way it does in Premiere, Resolve and FCP —
      // and the way `onLayerPointerDown` deliberately does not (it takes
      // `e.button === 0` only, because a right-press must not arm a drag).
      // The menu's registry rows act on the selection, so without this a
      // "Delete" chosen from one clip's menu could delete a different one.
      //
      // Only when the clip is OUTSIDE the current selection: right-clicking
      // inside a multi-selection keeps it, so "select four clips, right-click
      // one, Delete" behaves the way it reads. Modifier semantics are the
      // click path's (`selectFromClick`): plain takes the whole link,
      // `Alt` escapes it, `Shift` toggles — and the guard below is what keeps
      // the toggle one-directional here, since a right-click on an
      // already-selected clip never reaches it. A right-click that DESELECTED
      // its own target and then opened a menu acting on the selection would be
      // the worst reading of this gesture.
      if (!selectedLayerIds.has(layerId)) selectFromClick(layerId, e);
      let cut: TransitionCut | null = null;
      const canvas = canvasRef.current;
      const track = tracks.find((candidate) =>
        candidate.layers.some((l) => l.id === layerId),
      );
      if (canvas && track && !track.locked && pxPerSec > 0) {
        const rect = canvas.getBoundingClientRect();
        const xUs = ((e.clientX - rect.left) / pxPerSec) * 1_000_000;
        const toleranceUs = (CUT_CLICK_TOLERANCE_PX / pxPerSec) * 1_000_000;
        cut = findCutNear(
          track.layers,
          xUs,
          toleranceUs,
          defaultTransitionDurationUs(fpsNum, fpsDen),
        );
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        layerId,
        layerKind,
        layerEnabled,
        escapeLink: e.altKey,
        cut,
      });
    },
    [tracks, pxPerSec, fpsNum, fpsDen, selectedLayerIds, selectFromClick],
  );

  // Create a transition at a cut (context-menu action). Default duration is
  // the hardcoded 1 s snapped DOWN to whole comp frames; no placement arg, so
  // the add takes the overlap default (the incoming layer moves left,
  // ADR 0048). The refusals the eligibility gate cannot prevent (participants
  // sharing a link, a moved sibling crossing t = 0) surface through the
  // status bar / log (errors/formatCommandError.ts owns the copy). NO silent
  // clamping.
  const onAddTransition = useCallback(
    async (
      cut: TransitionCut,
      kind: TransitionKindName,
      direction?: TransitionDirection,
    ) => {
      setContextMenu(null);
      try {
        await addTransition({
          fromLayerId: cut.fromLayerId,
          toLayerId: cut.toLayerId,
          durationUs: defaultTransitionDurationUs(fpsNum, fpsDen),
          kind,
          ...(direction !== undefined ? { direction } : {}),
        });
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Add transition");
      }
    },
    [fpsNum, fpsDen, onMutated],
  );

  // Chip context menu (right-click on a transition chip). The chip has
  // already selected itself; the menu's update commits ride the same
  // `updateTransition` wrapper as the inspector, and delete matches the
  // Delete-key path below (remove + clear selection).
  const onChipContextMenu = useCallback(
    (e: React.MouseEvent, chip: TrackTransitionChip) => {
      setChipMenu({ x: e.clientX, y: e.clientY, transition: chip.transition });
    },
    [],
  );

  const onChipMenuUpdate = useCallback(
    async (args: TransitionUpdateArgs) => {
      setChipMenu(null);
      try {
        await updateTransition(args);
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Update transition");
      }
    },
    [onMutated],
  );

  // Chip edge-drag commit (spec D6): the chip assembled the exact
  // (durationUs, extendedUs) pair for the dragged edge; this only lowers the
  // ONE pointerup patch. A backend refusal (e.g. B's move landing on an
  // occupied span) surfaces through the status log, never a silent clamp.
  const onChipResize = useCallback(
    async (args: TransitionResizeArgs) => {
      try {
        await updateTransition(args);
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Resize transition");
      }
    },
    [onMutated],
  );

  const onChipMenuDelete = useCallback(
    async (transitionId: string) => {
      setChipMenu(null);
      try {
        await removeTransition(transitionId);
        clearTransitionSelection();
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Remove transition");
      }
    },
    [onMutated],
  );

  // Delete/Backspace removes the selected transition chip. Capture phase +
  // stopImmediatePropagation preempts the app-level delete-selected-layer
  // shortcut (same pattern as the keyframe Delete below); armed only while a
  // chip is selected, and never while typing in a field or while another panel
  // owns the keyboard (`subSelectionDeleteYields`).
  useEffect(() => {
    if (selectedTransitionId === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (subSelectionDeleteYields(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void (async () => {
        try {
          await removeTransition(selectedTransitionId);
          clearTransitionSelection();
          await onMutatedRef.current();
        } catch (err) {
          logMutationFailure(err, "Remove transition");
        }
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedTransitionId]);

  const onCommitLabel = useCallback(
    async (layerId: string, label: string) => {
      try {
        await updateLayer(layerId, { label });
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Rename layer");
      }
    },
    [onMutated],
  );

  const onCommitLinkLabel = useCallback(
    async (linkId: string, label: string | null) => {
      try {
        await linksRename(linkId, label);
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Rename link");
      }
    },
    [onMutated],
  );

  /// A Group's COMPOSITION name, from the clip's inline editor. Blank clears it
  /// back to the derived `Group N`, which is a Group's ordinary unnamed state.
  const onCommitGroupLabel = useCallback(
    async (compositionId: string, label: string | null) => {
      try {
        await groupsRename(compositionId, label);
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Rename group");
      }
    },
    [onMutated],
  );

  const onCommitParamTrack = useCallback(
    async (layerId: string, paramKey: string, track: AnimTrack<number>) => {
      try {
        // Every timeline keyframe edit (value field, diamond drag, interp
        // menu, curve editor, navigator) funnels through here. A scale write
        // on a LINKED layer fans out to both axes in one batch — otherwise
        // the result-based invariant would read the single-axis write as
        // divergence and silently unlink the layer.
        const layer = findPanelLayer(tracks, layerId);
        const fanOut = scaleFanOutFor(paramKey, layer?.params ?? null);
        if (fanOut) {
          await updateLayerParamTracks(layerId, fanOutEntries(fanOut, track));
        } else {
          await updateLayerParamTrack(layerId, paramKey, track);
        }
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Edit keyframes");
      }
    },
    [onMutated, tracks],
  );

  // Every MULTI-key keyframe operation's commit: `keyframeBatch.ts` folds the
  // selection into one entry per (layerId, paramKey), and the whole set goes as
  // `updateParamTracksMulti` rather than the per-layer batch — a swept selection
  // spans layers and N layers must still cost ONE undo entry.
  //
  // The scale fan-out is `onCommitParamTrack`'s, repeated here for its reason:
  // the main-side twin invariant reads a lone `scale_x` write as divergence and
  // silently unlinks the layer.
  const commitKeyframeBatch = useCallback<KeyframeBatchCommit>(
    (edit) => {
      const entries = batchParamTrackEntries({
        selected: getSelectedKeyframes(),
        tracks,
        edit,
      }).flatMap<ParamTrackEntry>(([layerId, paramKey, next]) => {
        const layer = findPanelLayer(tracks, layerId);
        const fanOut = scaleFanOutFor(paramKey, layer?.params ?? null);
        if (fanOut === null) return [[layerId, paramKey, next]];
        return fanOutEntries(fanOut, next).map(([key, track]) => [layerId, key, track]);
      });
      if (entries.length === 0) return;
      void (async () => {
        try {
          await updateParamTracksMulti(entries);
          await onMutated();
        } catch (e) {
          logMutationFailure(e, "Edit keyframes");
        }
      })();
    },
    [onMutated, tracks],
  );

  // Delete/Backspace removes the selected KEYFRAMES. Capture phase +
  // stopImmediatePropagation preempts the app-level delete-selected-layer
  // shortcut (same shape as the transition chip's handler above); winning that
  // race is the sub-selection model, and bypassing the dispatcher is why the
  // stand-down rules come back in through `subSelectionDeleteYields`.
  //
  // LANDMINE: this handler belongs to the Timeline and must not move back down
  // to `KeyframeLane` or `LayerBlock`. A per-track or per-layer handler was
  // correct only while a selection could not span layers; a marquee arms
  // several at once, and whichever registered first would stop the event dead
  // having deleted its own subset — several ops, several undo entries, and
  // which subset survives decided by mount order.
  const keyframeSelectionSize = useKeyframeSelectionStore((s) => s.selected.size);
  const deleteSelectedKeyframes = useEffectEvent(() => {
    commitKeyframeBatch(removeKeys);
    clearKeyframeSelection();
  });
  useEffect(() => {
    if (keyframeSelectionSize === 0) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (subSelectionDeleteYields(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      deleteSelectedKeyframes();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keyframeSelectionSize]);

  const onRename = useCallback((layerId: string) => {
    setContextMenu(null);
    // The menu would otherwise take the caret back as it unmounts, and the
    // editor commits on blur — see `contextMenuFinalFocus`.
    handCaretToEditor();
    beginLayerRename(layerId);
  }, []);

  const onRenameLink = useCallback((linkId: string) => {
    setContextMenu(null);
    handCaretToEditor();
    beginLinkRename(linkId);
  }, []);

  /// The Group clip's OTHER rename: the composition's name rather than this
  /// clip's label. Resolved from the live snapshot because the menu carries only
  /// the layer's id and kind, and the target is the composition behind it.
  const onRenameGroup = useCallback(
    (layerId: string) => {
      setContextMenu(null);
      for (const track of tracks) {
        for (const layer of track.layers) {
          if (layer.id !== layerId) continue;
          if (layer.params.kind !== "CompositionRef") return;
          handCaretToEditor();
          beginGroupRename(layer.params.composition_id);
          return;
        }
      }
    },
    [tracks],
  );

  /// The menu hands over the resolved set — the link's members, or the clicked
  /// layer alone when escaped — and `set_layers_enabled` records it as ONE
  /// history row (`docs/features.md#links`).
  const onToggleEnabled = useCallback(
    async (layerIds: string[], enabled: boolean) => {
      setContextMenu(null);
      try {
        await setLayersEnabled(layerIds, enabled);
        await onMutated();
      } catch (e) {
        logMutationFailure(e, "Toggle layer");
      }
    },
    [onMutated],
  );

  // Close the context menus when the timeline scrolls under them — the
  // popups are anchored to fixed cursor coordinates, so they would float
  // detached over moving content. Outside-click and Escape closing belong
  // to Base UI.
  useEffect(() => {
    if (!contextMenu && !chipMenu) return;
    const onScroll = () => {
      setContextMenu(null);
      setChipMenu(null);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [contextMenu, chipMenu]);

  const onSeparateAudio = useCallback(
    async (layerId: string) => {
      setContextMenu(null);
      try {
        await separateAudioToNewTrack(layerId);
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Separate audio");
      }
    },
    [onMutated],
  );

  const onPrebakeNow = useCallback((layerId: string) => {
    setContextMenu(null);
    requestPrebake(layerId);
  }, []);

  /// Shot detection is an inline whole-source scan with no progress surface, so
  /// the menu closes immediately and the markers appear when it lands — the
  /// same shape as the media pool's "Analyze shots", and warm after it (both
  /// read one VSHOT-cached report). `onMutated` is what makes the new markers
  /// visible: the write goes through the actor, not this component's state.
  const onMarkShotCuts = useCallback(
    async (layerId: string) => {
      setContextMenu(null);
      try {
        await dropShotMarkers(layerId);
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Mark shot cuts");
      }
    },
    [onMutated],
  );

  /// A scrub reads px on THIS Panel's axis, so the time it produces is this
  /// composition's and is reverse-projected into the one moment before it
  /// leaves. A composition with no root time has nothing to project into: its
  /// Panel parks on an axis of its own and the film stays where it is.
  const seekFromClientX = useCallback(
    (clientX: number) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const rawUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      const localUs = snapFrameRound(rawUs, fpsNum, fpsDen);
      const rootUs = rootUsOf(compositionId, localUs);
      if (rootUs === null) {
        seekLocalUs(compositionId, localUs);
        return;
      }
      onSeek(rootUs);
    },
    [compositionId, onSeek, pxPerSec, fpsNum, fpsDen],
  );

  const bladeCutTimeFromClientX = useCallback(
    (layer: LayerSummary, clientX: number): number | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const rawUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      const frameUs = snapFrameRound(rawUs, fpsNum, fpsDen);
      const atUs = snapTimeToTimelineBoundary({
        timeUs: frameUs,
        layerId: layer.id,
        // Escaped under the link override: the split then cuts this layer
        // alone, so its siblings' edges are snap targets again.
        escapeLink: !linkFanoutActive(),
        visibleTracks: visibleSnapTracks,
        links,
        linkByLayerId,
        // Event-time read: the playhead is a snap TARGET here, so the value
        // at the moment of the mouse event is the correct one — no reactive
        // subscription needed. Projected, because it is offered alongside layer
        // boundaries on this Panel's own axis.
        currentTimeUs: playheadClockUs(compositionId),
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: tailSnapEnabled,
        strengthPx: tailSnapStrengthPx,
        isValidSnap: (boundaryUs) =>
          boundaryUs > layer.t_start_us && boundaryUs < layer.t_end_us,
      });
      return atUs > layer.t_start_us && atUs < layer.t_end_us ? atUs : null;
    },
    [
      compositionId,
      fpsNum,
      fpsDen,
      linkByLayerId,
      links,
      pxPerSec,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  const updateBladePreview = useCallback(
    (layer: LayerSummary | null, clientX?: number) => {
      if (!bladeMode || !layer || clientX === undefined) {
        setBladePreview(null);
        return;
      }
      const atUs = bladeCutTimeFromClientX(layer, clientX);
      setBladePreview(atUs === null ? null : { layerId: layer.id, atUs });
    },
    [bladeCutTimeFromClientX, bladeMode],
  );

  useEffect(() => {
    if (!bladeMode) setBladePreview(null);
  }, [bladeMode]);

  // Blade-tool click handler: convert clientX → frame-snapped composition
  // timestamp and ask the actor to split the layer at that point. Reject
  // only when the snapped point lands exactly on a layer edge — the
  // actor would refuse that anyway, and a frame-precise editor needs
  // frame-precise cuts. After a split the user stays in blade mode
  // (NLE convention); press `C` or `Esc` to exit.
  const splitFromClientX = useCallback(
    async (layer: LayerSummary, clientX: number) => {
      const atUs = bladeCutTimeFromClientX(layer, clientX);
      if (atUs === null) return;
      setBladePreview(null);
      try {
        // Link-aware, as `splitAtPlayhead` sends it; escaped only under the
        // link override.
        await splitLayerLinked(layer.id, atUs, !linkFanoutActive());
        await onMutated();
      } catch (err) {
        logMutationFailure(err, "Blade split");
      }
    },
    [bladeCutTimeFromClientX, onMutated],
  );

  // Esc exits blade mode. Bound at the window level so it fires regardless
  // of focus, and attached only while blade mode is on.
  const onExitBladeEvent = useEffectEvent(onExitBlade);
  useEffect(() => {
    if (!bladeMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExitBladeEvent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bladeMode]);

  // Ruler-only seek: the time ruler is the SOLE surface that moves the
  // playhead. Begins a drag-scrub from the ruler's pointerdown. Decoupled
  // from selection — seeking never clears the selected clip.
  const beginRulerScrub = useCallback(
    (clientX: number) => {
      // Hold the view still for the length of the drag: the user is aiming at a
      // point they can see, and a follow-page mid-gesture would move the target
      // out from under the pointer (see `useFollowPlayhead`).
      setFollowScrubbing(true);
      seekFromClientX(clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        setFollowScrubbing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX, setFollowScrubbing],
  );

  // The primary at pointerdown, which `resolveMarqueeSelection` needs on every
  // move to keep a surviving primary. It lives on this side of the gesture's
  // seam together with the rest of the snapshot: the SHAPE of a selection is
  // what `useMarqueeAnchor` deliberately does not know, so it holds only the
  // opaque restore thunk `takeMarqueeSnapshot` hands back.
  const marqueeSnapshotPrimaryRef = useRef<string | null>(null);
  const takeMarqueeSnapshot = useCallback((): (() => void) => {
    const snapshot = currentSelection();
    const keyframes = getSelectedKeyframes();
    const primary = primaryLayerIdOf(snapshot);
    marqueeSnapshotPrimaryRef.current = primary;
    return () => {
      // The timeline's own kinds only. A pool selection the box displaced is
      // not put back — the marquee never reached into the pool to begin with.
      if (snapshot.kind === "transition") {
        setTransitionSelection(snapshot.id);
      } else {
        setLayerSelection(primary, layerIdsOf(snapshot));
      }
      // A non-empty clip box clears the keyframe selection below, so a cancel
      // that left it cleared would not be a cancel.
      setKeyframeSelection(keyframes);
    };
  }, []);

  /// The rendered lanes' vertical bands, in the BOX's coordinate space.
  /// `getBoundingClientRect` answers in client coordinates while the box is
  /// canvas-relative (`marqueeStore.ts`), hence the subtraction. x needs no
  /// such conversion: `marqueeHitClips` derives a chip's x from `t_start_us ×
  /// pxPerSec`, which is canvas-relative already — x = 0 IS the canvas's left
  /// edge, at t = 0.
  ///
  /// Walks `orderedTracks` rather than the registry, so only rendered lanes
  /// count and the A/B Roll display filter is honoured structurally. Measured
  /// per pointer event and cached nowhere, which is also what absorbs a
  /// mid-gesture project mutation (an MCP agent commit, an undo) on the next
  /// move — there is no cache, so do not add a generation guard.
  const measureMarqueeRows = useCallback((): MeasuredTrackRow[] => {
    const canvas = canvasRef.current;
    if (canvas === null) return [];
    const canvasTop = canvas.getBoundingClientRect().top;
    const rows: MeasuredTrackRow[] = [];
    for (const { track } of orderedTracks) {
      const el = laneElsRef.current.get(track.id);
      if (el === undefined) continue;
      const rect = el.getBoundingClientRect();
      rows.push({
        trackId: track.id,
        top: rect.top - canvasTop,
        bottom: rect.bottom - canvasTop,
      });
    }
    return rows;
  }, [orderedTracks]);

  /// The rendered sub-lane rows, in the box's coordinate space — the keyframe
  /// twin of `measureMarqueeRows`, converted and re-measured per event for the
  /// same reasons. Sorted top-to-bottom so the hit order reads down the screen
  /// instead of following the registry's mount order.
  const measureMarqueeSubLaneRows = useCallback((): MeasuredSubLaneRow[] => {
    const canvas = canvasRef.current;
    if (canvas === null) return [];
    const canvasTop = canvas.getBoundingClientRect().top;
    const rows: MeasuredSubLaneRow[] = [];
    for (const entry of subLaneElsRef.current.values()) {
      const rect = entry.el.getBoundingClientRect();
      rows.push({
        trackId: entry.trackId,
        paramKey: entry.paramKey,
        expanded: entry.expanded,
        top: rect.top - canvasTop,
        bottom: rect.bottom - canvasTop,
      });
    }
    rows.sort((a, b) => a.top - b.top);
    return rows;
  }, []);

  const onMarqueeBox = useCallback(
    (box: MarqueeBox, kind: MarqueeKind) => {
      if (kind === "keyframe") {
        // Selection and nothing else: no seek, no focus move. Those stay on the
        // single-click path (`KeyframeLane`'s `selectKeyframe` +
        // `setKeyframeFocus` + `transportSeek` triple). The layer selection is
        // left standing too — the sub-selection model already gives keyframes
        // Delete priority, so a clip selection is not a conflict in this
        // direction the way it is in the other.
        setKeyframeSelection(
          marqueeHitKeyframes({
            box,
            rows: measureMarqueeSubLaneRows(),
            tracks,
            pxPerSec,
          }),
        );
        return;
      }
      const { ids, primary } = resolveMarqueeSelection({
        snapshotPrimary: marqueeSnapshotPrimaryRef.current,
        hit: marqueeHitClips({
          box,
          rows: measureMarqueeRows(),
          tracks,
          pxPerSec,
        }),
        linkByLayerId,
        links,
        mode: "replace",
        linkFanout: linkFanoutActive(),
      });
      setLayerSelection(primary, ids);
      // So the Delete that follows reaches the clips just swept: whenever a
      // keyframe is selected, the keyframe Delete handler above answers first
      // and stops the event dead, and a stale selection there would eat this
      // one's. The chip's own pointerdown clears it for the same reason.
      if (ids.length > 0) clearKeyframeSelection();
    },
    [
      linkByLayerId,
      links,
      measureMarqueeRows,
      measureMarqueeSubLaneRows,
      pxPerSec,
      tracks,
    ],
  );

  /// A press that never became a box — the timeline's background click, and the
  /// only path that clears a selection from the background. Per kind, because
  /// the two populations' blank space is not the same blank space: blank
  /// sub-lane space drops keyframes and leaves the clip selection, so the
  /// Attribute panel stays on the clip being inspected. That is a strict
  /// narrowing — the state it leaves was already reachable by selecting a
  /// keyframe and then clicking a lane.
  const onMarqueeBackgroundClick = useCallback((kind: MarqueeKind) => {
    if (kind === "keyframe") {
      clearKeyframeSelection();
      return;
    }
    clearLayerSelection();
  }, []);

  // How deep THIS Panel's composition sits, and the background that says so.
  // Read here rather than in a child because the tint belongs to the timeline's
  // own empty space — the band below the last lane included, which is part of
  // this scroll container.
  const depth = useAnchorPath(compositionId).length;
  const insideGroup = depth > 0;
  const tintPct = GROUP_TINT_STEP_PCT * Math.min(depth, MAX_GROUP_TINT_STEPS);
  const groupDepthTint = `color-mix(in srgb, var(--card) ${100 - tintPct}%, var(--foreground))`;

  // Memoized: the provider hands this to every anchor surface, so a fresh
  // object would re-render all four on every Timeline render.
  const marqueeAnchor = useMemo<MarqueeAnchor>(
    () => ({
      canvasRef,
      scrollRootRef: rootRef,
      onBox: onMarqueeBox,
      takeSnapshot: takeMarqueeSnapshot,
      onBackgroundClick: onMarqueeBackgroundClick,
    }),
    [onMarqueeBackgroundClick, onMarqueeBox, takeMarqueeSnapshot],
  );

  return (
    <MarqueeAnchorContext.Provider value={marqueeAnchor}>
    <KeyframeBatchContext.Provider value={commitKeyframeBatch}>
    <div
      ref={rootRef}
      className={`scrollbar-hidden relative min-h-0 w-full flex-1 overflow-auto ${
        insideGroup ? "" : "bg-card"
      } ${isLayerDragging ? "cursor-grabbing select-none" : ""} ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "timeline-root-blade" : ""}`}
      // One step off the panel surface for every depth below the root, capped so
      // a deep nest cannot walk the background into the foreground. Resolve tints
      // a compound clip's timeline the same way, and it is the one signal that
      // reads without leaving the timeline: the tab says which composition this
      // is, the tint says how deep it sits, and neither can be scrolled past.
      style={insideGroup ? { backgroundColor: groupDepthTint } : undefined}
    >
      {/* Renders nothing. A leaf so the trim preview's per-frame seek stays a
          leaf subscription — read here, it would re-render every lane. */}
      <LayerDragTrimMonitor
        compositionId={compositionId}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
      />
      {/* `min-h-full` so the lanes' container fills the panel even on a short
          project: the leftover band below the last track then belongs to the
          scrolling body, which makes it a `clip` anchor — click it to clear,
          or start a box there and drag up over the tracks. Owned by the root
          instead, that band reached no anchor at all and was dead space. The
          playhead and the header column's divider run the panel's full height
          as a result, which is what they do in every other NLE. */}
      <div className="flex min-h-full min-w-max">
        {/* sticky header column */}
        <div className="sticky left-0 z-10 flex-none border-r border-border bg-card" style={{ width: HEADER_COL_PX }}>
          <div
            data-testid="timeline-ruler-corner"
            className="sticky top-0 z-[1] h-5 border-b border-border-soft bg-card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          /> {/* ruler corner */}
          {/* The two columns paint the same rows in the same order; a row
              present in one and missing from the other slides every header
              beneath it out of line with its lane. The next two are the paired
              halves of the marker lane and the drop strip.

              Both halves of the marker lane read `markers_visible` themselves,
              so the row cannot vanish from one column and stay in the other.
              The header names the row; it is not a spacer like the drop
              strip's, but it is exactly as tall. */}
          <MarkerLaneHeader />
          <DropStripHeader />
          {orderedTracks.map(({ track }) => (
            <Fragment key={track.id}>
              <TrackHeader
                compositionId={compositionId}
                track={track}
                height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
                isRevealed={track.id === (revealedTrackId ?? null)}
                isExpanded={expandedTracks.has(track.id)}
                hasKeyframes={trackKeyframeProperties(track).length > 0}
                onToggleExpand={() => toggleExpanded(track.id)}
                onMutated={onMutated}
              />
              {expandedTracks.has(track.id) && (
                <KeyframeLaneHeaders
                  track={track}
                  compositionId={compositionId}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  visible={visible}
                  onCommitParamTrack={onCommitParamTrack}
                />
              )}
            </Fragment>
          ))}
        </div>
        {/* scrolling body. The marquee anchors HERE and not on the root: the
            root spans the sticky header column, so a box could start from the
            header's blank space. This column excludes it structurally, with no
            HEADER_COL_PX coordinate test. Timeline provides the anchor context,
            so it cannot consume its own provider — hence `beginMarquee`. */}
        <div
          className="relative grow"
          onPointerDown={(e) => beginMarquee(marqueeAnchor, "clip", e)}
        >
          <TimelineRuler
            compositionId={compositionId}
            pxPerSec={pxPerSec}
            totalSec={totalSec}
            widthPx={widthPx}
            viewportWidthPx={viewportWidthPx}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            onScrub={beginRulerScrub}
          />
          {/* Above the drop strip because markers belong to the RULER family —
              they measure time — while the strip belongs to the track family. */}
          <MarkerLane
            compositionId={compositionId}
            pxPerSec={pxPerSec}
            widthPx={widthPx}
            viewportWidthPx={viewportWidthPx}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
          <div
            ref={canvasRef}
            data-testid="timeline-canvas"
            className="relative min-w-full"
            style={{ width: widthPx }}
          >
            <DropStrip
              elRef={dropStripElRef}
              compositionId={compositionId}
              pxPerSec={pxPerSec}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
              mediaDropSnap={mediaDropSnap}
              pendingPlacements={pendingPlacements}
              pendingLayerById={pendingLayerById}
              onMediaDrop={onMediaDrop}
            />
            {orderedTracks.length === 0 && <EmptyHint mode={displayMode} />}
            {/*
              Data model: `tracks[0]` is the bottom of the z-stack, `tracks[last]`
              is the top (see `docs/data-model.md`). `visualOrderedTracks`
              reverses that, so the tail of the array is the TOP row here — it
              splits role-stamped lanes from role-less ones, it does NOT bucket
              by kind. The role-less section is the one at the top, which is
              where the strip above spawns into.
            */}
            {orderedTracks.map(({ track }) => (
              <Fragment key={track.id}>
              <TrackLane
                track={track}
                compositionId={compositionId}
                registerLaneEl={registerLaneEl}
                pxPerSec={pxPerSec}
                height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
                isExpanded={expandedTracks.has(track.id)}
                selectedLayerId={primaryLayerId}
                selectedLayerIds={selectedLayerIds}
                transitions={transitions}
                selectedTransitionId={selectedTransitionId}
                linkByLayerId={linkByLayerId}
                linkTabByLayerId={linkTabByLayerId}
                pendingPlacements={pendingPlacements}
                pendingLayerById={pendingLayerById}
                dragLayerById={dragLayerById}
                bladeMode={bladeMode}
                onBladeSplit={splitFromClientX}
                onBladePreview={updateBladePreview}
                onSelectFromClick={selectFromClick}
                onDragStart={(state) => setDrag(state)}
                onContextMenu={onContextMenu}
                onChipContextMenu={onChipContextMenu}
                onChipResize={(args) => void onChipResize(args)}
                onCommitLabel={onCommitLabel}
                onCommitLinkLabel={onCommitLinkLabel}
                onCommitGroupLabel={onCommitGroupLabel}
                onCommitParamTrack={onCommitParamTrack}
                onMediaDrop={onMediaDrop}
                isRevealed={track.id === (revealedTrackId ?? null)}
                isResizing={heightDrag !== null}
                onHeightDragStart={beginHeightDrag(track.id)}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                mediaDropSnap={mediaDropSnap}
              />
              {expandedTracks.has(track.id) && (
                <KeyframeLane
                  track={track}
                  pxPerSec={pxPerSec}
                  registerSubLaneEl={registerSubLaneEl}
                  onCommitParamTrack={onCommitParamTrack}
                />
              )}
              </Fragment>
            ))}
            {bladePreview && (
              <BladeCutPreview
                x={(bladePreview.atUs / 1_000_000) * pxPerSec}
                label={formatTimecode(bladePreview.atUs, fpsNum, fpsDen)}
                width={widthPx}
              />
            )}
            <OutOfRangeDim pxPerSec={pxPerSec} />
            {/* Draws only while a clip from ANOTHER Panel is over this one.
                A leaf, so following the pointer costs this Panel one render
                and nothing below it. */}
            <ForeignDragGhost
              compositionId={compositionId}
              tracks={tracks}
              orderedTracks={orderedTracks}
              laneEls={laneElsRef}
              dropStripEl={dropStripElRef}
              canvasRef={canvasRef}
              pxPerSec={pxPerSec}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
              snapTracks={visibleSnapTracks}
              links={links}
              linkByLayerId={linkByLayerId}
              tailSnapEnabled={tailSnapEnabled}
              tailSnapStrengthPx={tailSnapStrengthPx}
            />
            <MarqueeOverlay />
          </div>
          <TimelinePlayhead
            compositionId={compositionId}
            anchorFrame={anchorFrame}
            pxPerSec={pxPerSec}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            visible={visible}
          />
        </div>
      </div>
    </div>
    {contextMenu && (
      <LayerContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        layerId={contextMenu.layerId}
        layerKind={contextMenu.layerKind}
        layerEnabled={contextMenu.layerEnabled}
        linkId={linkByLayerId.get(contextMenu.layerId) ?? null}
        linkMemberIds={
          links.find((l) => l.id === linkByLayerId.get(contextMenu.layerId))
            ?.layer_ids ?? [contextMenu.layerId]
        }
        escapeLink={contextMenu.escapeLink}
        transitionCut={contextMenu.cut}
        onClose={() => setContextMenu(null)}
        onRename={onRename}
        onRenameLink={onRenameLink}
        onRenameGroup={onRenameGroup}
        onToggleEnabled={onToggleEnabled}
        onSeparateAudio={onSeparateAudio}
        onPrebakeNow={onPrebakeNow}
        onMarkShotCuts={(id) => void onMarkShotCuts(id)}
        onAddTransition={(cut, kind, direction) =>
          void onAddTransition(cut, kind, direction)
        }
      />
    )}
    {chipMenu && (
      <TransitionChipMenu
        x={chipMenu.x}
        y={chipMenu.y}
        transition={chipMenu.transition}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
        onClose={() => setChipMenu(null)}
        onUpdate={(args) => void onChipMenuUpdate(args)}
        onDelete={(id) => void onChipMenuDelete(id)}
      />
    )}
    </KeyframeBatchContext.Provider>
    </MarqueeAnchorContext.Provider>
  );
}

/**
 * Washes out everything outside the marked in/out span — but only for a beat
 * after the range changes, then fades away. The standing record of the range
 * lives elsewhere — see `RangeCap` in TimelineRuler.tsx for the permanent-mark
 * vs transient-wash split.
 *
 * `z-[4]` clears every LayerBlock (max `z-[3]`) while staying under the blade
 * preview (`z-[5]`) and the playhead, which must never read as out-of-range.
 * The node stays mounted at zero opacity so the fade is a CSS transition
 * rather than a pop; `pointer-events-none` keeps it inert either way.
 */
function OutOfRangeDim({ pxPerSec }: { pxPerSec: number }) {
  const inUs = useRangeInUs();
  const outUs = useRangeOutUs();
  const revealed = useRangeReveal();
  if (inUs === null && outUs === null) return null;
  // An unmarked side means "to the edge", matching `resolveMarkedRange`: one
  // point alone is a complete instruction, not half a range — so that side
  // simply renders no wash.
  const inPx = inUs !== null ? (inUs / 1_000_000) * pxPerSec : 0;
  const outPx = outUs !== null ? (outUs / 1_000_000) * pxPerSec : 0;
  return (
    <div
      data-testid="timeline-out-of-range"
      data-revealed={revealed ? "true" : "false"}
      className={`pointer-events-none absolute inset-0 z-[4] transition-opacity duration-300 ${
        revealed ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden="true"
    >
      {inUs !== null && inPx > 0 && (
        <div
          className="absolute inset-y-0 left-0 bg-background/65"
          style={{ width: inPx }}
        />
      )}
      {/* Anchored `right-0` rather than sized `widthPx - outPx`: the canvas
          carries `min-w-full`, so on a project shorter than the viewport it is
          WIDER than `widthPx` and a computed width would stop short of its real
          right edge, leaving an undimmed strip past the end of the project. */}
      {outUs !== null && (
        <div
          className="absolute inset-y-0 right-0 bg-background/65"
          style={{ left: outPx }}
        />
      )}
    </div>
  );
}

/// The playhead line, updated at frame rate via a TRANSIENT playhead-store
/// subscription (tier 2, see playheadStore.ts): the engine emits once per
/// composition frame during playback, and routing that through React state
/// re-renders the whole Timeline per frame.
/// Here the subscription mutates `style.left` on the ref'd node directly —
/// zero React commits while playing.
///
/// PROJECTED (ADR 0053 decision 2): what is drawn is THIS composition's reading
/// of the one moment. A moment its placement does not reach draws nothing — a
/// Group that is off screen has no position, and a line clamped to the nearest
/// edge would claim the film is somewhere it is not.
///
/// `anchorFrame` arrives already resolved because resolving one walks the
/// summary, and this callback runs once per composition frame per open Panel.
///
/// The one-frame-wide shadow (child node) makes the display convention
/// visible at frame-level zoom: the playhead shows the frame to its RIGHT
/// (half-open intervals — see docs/data-model.md, boundary semantics). Same
/// transient subscription, same zero-commit rule.
function TimelinePlayhead({
  compositionId,
  anchorFrame,
  pxPerSec,
  fpsNum,
  fpsDen,
  visible,
}: {
  compositionId: string | null;
  anchorFrame: AnchorFrame | null;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const apply = (tUs: number | null) => {
      if (ref.current) ref.current.style.display = tUs === null ? "none" : "block";
      if (tUs === null) return;
      const leftPx = (tUs / 1_000_000) * pxPerSec;
      if (ref.current) ref.current.style.left = `${leftPx}px`;
      if (shadowRef.current) {
        const shadow = playheadFrameShadowPx(tUs, fpsNum, fpsDen, pxPerSec);
        if (shadow) {
          shadowRef.current.style.display = "block";
          // Offset relative to the playhead root, which sits at `tUs`.
          shadowRef.current.style.left = `${shadow.leftPx - leftPx}px`;
          shadowRef.current.style.width = `${shadow.widthPx}px`;
        } else {
          shadowRef.current.style.display = "none";
        }
      }
    };
    return subscribeLocalPlayhead(compositionId, anchorFrame, apply);
  }, [anchorFrame, compositionId, pxPerSec, fpsNum, fpsDen, visible]);
  // The frame is already in hand, so the first paint costs no second walk.
  const firstPaintUs = localPlayheadIn(compositionId, anchorFrame);
  return (
    <div
      ref={ref}
      data-testid="timeline-playhead"
      className="pointer-events-none absolute bottom-0 top-0 z-[4] w-0.5 rounded-[1px] bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
      style={{
        left: ((firstPaintUs ?? 0) / 1_000_000) * pxPerSec,
        display: firstPaintUs === null ? "none" : undefined,
      }}
    >
      <div
        ref={shadowRef}
        data-testid="timeline-playhead-frame-shadow"
        className="pointer-events-none absolute bottom-0 top-0 bg-red-500/10"
        style={{ display: "none" }}
      />
      <div
        data-testid="timeline-playhead-head"
        className="sticky top-0 h-4 w-0"
      >
        <div
          data-testid="timeline-playhead-line-cap"
          className="absolute -left-1.5 top-0 h-0.5 w-3.5 bg-card"
        />
        <div
          data-testid="timeline-playhead-head-shape"
          className="absolute -left-1.5 top-0.5 h-3.5 w-3.5 bg-gradient-to-b from-[#fb7185] via-red-500 to-red-700 [clip-path:polygon(0_0,100%_0,100%_45%,50%_100%,0_45%)] [filter:drop-shadow(0_1px_1.5px_rgba(0,0,0,0.6))]"
        />
      </div>
    </div>
  );
}

function BladeCutPreview({
  x,
  label,
  width,
}: {
  x: number;
  label: string;
  width: number;
}) {
  const labelX = Math.min(Math.max(x, 44), Math.max(44, width - 44));
  return (
    <>
      <div
        data-testid="timeline-blade-preview"
        className="pointer-events-none absolute bottom-0 top-0 z-[5]"
        style={{ left: x }}
        aria-hidden="true"
      >
        <div className="absolute bottom-0 top-0 w-px -translate-x-1/2 bg-amber-300 shadow-[0_0_0_0.5px_rgba(0,0,0,0.65),0_0_8px_rgba(251,191,36,0.55)]" />
        <div className="absolute -left-1.5 top-0 h-3 w-3 bg-amber-300 shadow-[0_1px_2px_rgba(0,0,0,0.55)] [clip-path:polygon(50%_100%,0_0,100%_0)]" />
      </div>
      <div
        className="pointer-events-none absolute top-1 z-[6] -translate-x-1/2 whitespace-nowrap rounded-sm border border-amber-200/50 bg-black/80 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-amber-100 shadow-[0_1px_5px_rgba(0,0,0,0.45)]"
        style={{ left: labelX }}
        aria-hidden="true"
      >
        {label}
      </div>
    </>
  );
}



function EmptyHint({ mode }: { mode?: "AbRoll" | "AllTracks" }) {
  const { t } = useTranslation();
  // Rendered when the user is in A/B Roll but no track carries a role
  // stamp; the user switches to All Tracks manually.
  //
  // The hint names the KEY, not the Quick Actions button: the strip is a Panel
  // the user can close or drag away, whereas the binding is always live. Read
  // through the bindings context so a remap can't make this text lie.
  const binding = useEffectiveBindings("toggleDisplayMode");
  const accelerator = binding ? resolveAccelerator(binding) : "";
  const message =
    mode === "AbRoll"
      ? t("timeline.empty_ab_roll", {
          key: accelerator,
          defaultValue:
            "No A/B-roll content here. Drop a clip on A roll or B roll, or press {{key}} to switch to All Tracks.",
        })
      : t("timeline.empty_placeholder");
  return <div className="p-6 text-center text-xs text-muted-foreground">{message}</div>;
}
