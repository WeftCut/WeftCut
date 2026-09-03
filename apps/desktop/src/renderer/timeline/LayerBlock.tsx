import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioWaveform,
  Film,
  Flag,
  Group as GroupIcon,
  Image as ImageIcon,
  Link2,
  Palette,
  Sparkles,
  Type,
} from "lucide-react";
import { TEXT_NAME_MAX, textSnippet } from "../../shared/textSnippet";
import { adjacentFrameBoundaryUs, formatTimecode } from "../frames";
import { groupDisplayName, layerDisplayName } from "../lib/layerName";
import { AppInput } from "../components/AppInput";
import {
  HEADER_COL_PX,
  LAYER_FULL_LABEL_MIN_PX,
  LAYER_LABEL_MIN_PX,
  linkHue,
  keyframeHitTest,
  keyframeXWithinClip,
  layerSliceRect,
  sourceWindowTail,
  type LayerSlice,
  type LinkTab as LinkTabInfo,
} from "./geometry";
import { TimelineVisualPreview } from "./TimelineVisualPreview";
import { useLayerBakePhase } from "./motifBakeStatusStore";
import { useGroupMarkerCount } from "./groupMarkerCount";
import { formatSyncOffset } from "./audioSlip";
import { useAudioSyncOffset } from "./audioSyncOffsetStore";
import type { AnimTrack, Extrapolate, Keyframe, LayerSummary } from "../ipc";
import {
  useEditingGroupId,
  useEditingLayerId,
  useEditingLinkId,
  beginLayerRename,
  endRename,
} from "./renameStore";
import { useLinkOverride } from "../state/linkOverrideStore";
import { openComposition } from "../state/compositionAnchorStore";
import { revealTrackWithoutSelection } from "../state/navigation";
import {
  useCompositionDurationUs,
  useGroupOrdinals,
} from "../state/projectStore";
import { currentSelection, layerIdsOf } from "../state/selectionStore";
import { useFocusedParamFor } from "../keyframe/focusStore";
import { readParamTrack } from "../keyframe/descriptors";
import {
  EXTRAP_GLYPH_GAP_PX,
  extrapolateClass,
  extrapolateGlyph,
  extrapolateLabelKey,
  interpGlyphClass,
} from "../keyframe/curve";
import { useNumberTrackPreview } from "../keyframe/easingPreviewStore";
import { retimeKeyframe } from "../keyframe/edits";
import { EasingMenu } from "./EasingMenu";
import { useKeyframeBatchCommit } from "./keyframeBatch";
import { transportSeek } from "../state/playbackStore";
import {
  selectKeyframe,
  clearKeyframeSelection,
  keyframeKey,
  useIsKeyframeSelected,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import { timelineLayerTheme } from "./layerTheme";
import { placementRefuses, previewTrackId } from "./placement";
import { useLayerDragFor, type DragKind, type DragSeed } from "./layerDragStore";

export interface PendingLayerPlacement {
  layerId: string;
  /// For a duplicate that has not landed in refreshed project state yet, use
  /// this source layer's content to render the pending clone.
  sourceLayerId?: string;
  trackId: string;
  tStartUs: number;
  tEndUs: number;
}

const LAYER_ICON_PROPS = {
  size: 10,
  strokeWidth: 2,
  "aria-hidden": true,
} as const;

/// Small status dot on a Motif layer block. Hidden when idle (selector
/// returns null).
function MotifBakeDot({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const phase = useLayerBakePhase(layerId);
  if (!phase) return null;
  const label =
    phase === "warming"
      ? t("timeline.bake_dot_warming", { defaultValue: "Warming…" })
      : phase === "baking"
        ? t("timeline.bake_dot_baking", { defaultValue: "Pre-baking…" })
        : phase === "ready"
          ? t("timeline.bake_dot_ready", { defaultValue: "Pre-baked" })
          : t("timeline.bake_dot_error", { defaultValue: "Pre-bake failed" });
  return <span className={`motif-bake-dot is-${phase}`} title={label} aria-label={label} />;
}

/// The derived A/V sync-offset badge on a slipped audio clip (ADR 0038 / R2-D7).
/// Renders nothing when the offset is zero or the layer has no visual partner —
/// which is the normal case, so the badge's presence IS the signal that something was
/// deliberately slipped. Discoverability is the whole job here: the offset lives
/// implicitly in each member's own `t_start_us`, with no field to inspect.
function AudioSyncBadge({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const offset = useAudioSyncOffset(layerId);
  const text = formatSyncOffset(offset);
  if (text === null) return null;
  const label = t("timeline.audio_slipped", { offset: text });
  return (
    <span
      data-testid="audio-sync-offset-badge"
      className="pointer-events-none absolute bottom-1 right-1 z-[4] rounded bg-sky-600/90 px-1 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm"
      title={label}
      aria-label={label}
    >
      {text}
    </span>
  );
}

/// The `⚑N` badge on a Group clip: how many marks are reachable inside the
/// composition it shows, nesting included (`groupMarkerCount.ts`). From the
/// parent timeline a Group is opaque, so without this there is nothing to tell
/// the user whether going in is worth it.
///
/// Nothing at zero. Most Groups hold no marks, so a `⚑0` on every Group clip in
/// the project would be noise sitting exactly where the signal has to be.
///
/// Activating it opens that composition's Panel — the same `openComposition`
/// the clip's double-click and its `Open group` row run, because "go and look"
/// gets one route, not a second one that could drift.
function GroupMarkerBadge({
  compositionId,
  layerId,
}: {
  compositionId: string;
  layerId: string;
}) {
  const { t } = useTranslation();
  const count = useGroupMarkerCount(compositionId);
  if (count === 0) return null;
  const label = t("timeline.group_marker_count", { count });
  return (
    <button
      type="button"
      data-testid="group-marker-count-badge"
      className="absolute bottom-1 right-1 z-[4] flex cursor-pointer items-center gap-0.5 rounded bg-black/45 px-1 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm hover:bg-black/65"
      title={label}
      aria-label={label}
      // The badge sits inside the block, whose pointerdown selects and arms a
      // drag: without these a press meant for the badge becomes both. The
      // context menu is deliberately left to bubble — a right-click anywhere on
      // a clip, badge included, should reach that clip's menu.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openComposition(compositionId, layerId);
      }}
    >
      <Flag size={9} strokeWidth={2.5} aria-hidden="true" />
      {count}
    </button>
  );
}

/// A link's chrome above its anchor member's top-left corner: the label tab
/// when the link is named (or being named), and the `+N` badge when the display
/// filter hides members. Both share one anchor so a labelled link with hidden
/// members reads `label · +N`. Badge click reveals the first hidden member's
/// lane and nothing else — revealing is not selecting, and because the reveal is
/// single-lane the member revealed leaves the count, so a second click reaches
/// the next one.
///
/// Every pointer event stops here: the tab sits inside the block, whose
/// pointerdown selects and arms a drag, and a click meant for the badge must
/// not become either.
function LinkTab({
  tab,
  hue,
  accentAlpha,
  clipWidthPx,
  hiddenCount,
  isEditing,
  onCommitLabel,
}: {
  tab: LinkTabInfo;
  hue: number;
  /// The block's accent alpha — 0.4 under the link override, else 1.
  accentAlpha: number;
  clipWidthPx: number;
  /// The count to draw — the tab's own while idle, the drag's while this
  /// member is the drag anchor.
  hiddenCount: number;
  isEditing: boolean;
  onCommitLabel: (linkId: string, label: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isEditing) {
      setDraft(tab.label ?? "");
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  }, [isEditing, tab.label]);
  const showTab = tab.label !== null || isEditing;
  if (!showTab && hiddenCount === 0) return null;

  const commit = () => {
    const next = draft.trim() || null;
    if (next !== tab.label) onCommitLabel(tab.linkId, next);
    endRename();
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const badgeTitle = t("timeline.link_hidden_members", { count: hiddenCount });

  return (
    <div
      data-testid="link-tab-anchor"
      className="absolute left-0 bottom-full z-[4] flex max-w-full items-stretch gap-1 rounded-t px-1 py-0.5 text-[10px] font-semibold leading-none text-white"
      style={{
        maxWidth: clipWidthPx,
        backgroundColor: `hsl(${hue} 75% 45% / ${accentAlpha})`,
      }}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {isEditing ? (
        <AppInput
          ref={inputRef}
          className="z-[2]"
          style={{ width: "8rem", maxWidth: "100%", height: "1rem", fontSize: 10 }}
          value={draft}
          ariaLabel={t("timeline.link_label")}
          onValueChange={setDraft}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              endRename();
            }
          }}
        />
      ) : tab.label !== null ? (
        <span
          data-testid="link-tab"
          className="overflow-hidden text-ellipsis whitespace-nowrap"
          title={tab.label}
        >
          {tab.label}
        </span>
      ) : null}
      {showTab && hiddenCount > 0 && !isEditing && (
        <span aria-hidden="true" className="opacity-70">
          ·
        </span>
      )}
      {hiddenCount > 0 && !isEditing && (
        <button
          type="button"
          data-testid="link-hidden-badge"
          className="shrink-0 cursor-pointer rounded-sm bg-black/30 px-1 hover:bg-black/50"
          title={badgeTitle}
          aria-label={badgeTitle}
          onClick={(e) => {
            e.stopPropagation();
            const first = tab.hidden[0];
            if (first) revealTrackWithoutSelection(first.trackId);
          }}
        >
          +{hiddenCount}
        </button>
      )}
    </div>
  );
}

/// The stored composition name of a Group clip, or null for every other kind —
/// the primitive the rename editor seeds from and compares against.
function groupLabel(layer: LayerSummary): string | null {
  return layer.params.kind === "CompositionRef"
    ? layer.params.composition_label
    : null;
}

function shortLayerLabel(label: string): string {
  const clean = label.trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 12)}...`;
}

function LayerKindIcon({ kind }: { kind: LayerSummary["params"]["kind"] }) {
  switch (kind) {
    case "VideoClip":
      return <Film {...LAYER_ICON_PROPS} />;
    case "Audio":
      return <AudioWaveform {...LAYER_ICON_PROPS} />;
    case "ImageOverlay":
      return <ImageIcon {...LAYER_ICON_PROPS} />;
    case "Text":
      return <Type {...LAYER_ICON_PROPS} />;
    case "Motif":
      return <Sparkles {...LAYER_ICON_PROPS} />;
    case "Color":
      return <Palette {...LAYER_ICON_PROPS} />;
    // The one glyph that names a container rather than a medium — the same
    // `Group` lucide gives the strip's Group button, so the button and the clip
    // it makes carry one mark.
    case "CompositionRef":
      return <GroupIcon {...LAYER_ICON_PROPS} />;
  }
}

export function LayerBlock({
  layer,
  trackId,
  trackKind,
  trackLocked,
  isTrackExpanded,
  pxPerSec,
  laneHeight,
  slice,
  isPrimary,
  isSelected,
  linkId,
  linkTab,
  pendingPlacement,
  previewOnly = false,
  bladeMode,
  onBladeSplit,
  onBladePreview,
  onSelectFromClick,
  onDragStart,
  onContextMenu,
  onCommitLabel,
  onCommitLinkLabel,
  onCommitGroupLabel,
  onCommitParamTrack,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  trackId: string;
  trackKind: string;
  /// Track-level lock — blocks move/trim/blade on every layer in the
  /// lane, same affordance as the per-layer lock.
  trackLocked: boolean;
  /// True when this track's keyframe sub-lanes are expanded — collapsed
  /// in-clip diamonds are hidden (the sub-lanes render them instead).
  isTrackExpanded: boolean;
  pxPerSec: number;
  laneHeight: number;
  /// Vertical slot. "full" = entire row; "top" = top half (visual
  /// layer paired with audio); "bottom" = bottom half (audio paired
  /// with visual). Determines the rendered height + top offset.
  slice: LayerSlice;
  /// Primary selection (drives the Attribute panel). One layer at a time.
  isPrimary: boolean;
  /// Member of the current selection set (highlight only).
  isSelected: boolean;
  /// `docs/features.md#links` — null when unlinked.
  linkId: string | null;
  /// Non-null only on the link's anchor member (`indexLinkTabs`): the label
  /// tab and hidden-member badge draw there and nowhere else.
  linkTab: LinkTabInfo | null;
  pendingPlacement: PendingLayerPlacement | null;
  /// Non-interactive in-flight clone rendered for an Alt+drag duplicate.
  previewOnly?: boolean;
  /// Blade-tool mode: pointerdown splits at the click point instead
  /// of selecting/dragging. Cursor is set by the `timeline-root-blade`
  /// class (styles.css) via the `timeline-layer` hook class below.
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onBladePreview: (layer: LayerSummary | null, clientX?: number) => void;
  /// Applies the click's selection semantics and answers whether THIS layer is
  /// selected afterwards — `false` only for an additive click that removed it.
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => boolean;
  onDragStart: (state: DragSeed) => void;
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
  /// Persist an inline-rename edit. `label` may be empty (clears the custom
  /// label → block falls back to the kind name). Wired by Timeline to
  /// `updateLayer({label}) + onMutated`, matching the drag-commit pattern.
  onCommitLabel: (layerId: string, label: string) => void;
  /// Persist a link's label from the tab editor; `null` clears it, which is a
  /// link's ordinary unlabelled state. Wired by Timeline to `linksRename`.
  onCommitLinkLabel: (linkId: string, label: string | null) => void;
  /// Persist a Group's COMPOSITION name from the clip's inline editor; `null`
  /// clears it back to the derived `Group N`. Wired by Timeline to
  /// `groupsRename`. Separate from `onCommitLabel` because the two write
  /// different things: that one is this clip's own label, this one is the name
  /// every clip placing the composition shows.
  onCommitGroupLabel: (compositionId: string, label: string | null) => void;
  /// Persist a keyframe track edit — a diamond retime. Wired by Timeline to
  /// `updateLayerParamTrack + onMutated`. The multi-key operations do NOT come
  /// through here: they commit the whole selection at once (`keyframeBatch.ts`).
  onCommitParamTrack: (layerId: string, paramKey: string, track: AnimTrack<number>) => void;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  // Null for every block the gesture does not carry, so a pointermove renders
  // the clips that move and nothing else (`layerDragStore.ts`).
  const liveDrag = useLayerDragFor(layer.id);
  // A duplicate leaves its sources where they are, so a source block draws as
  // if nothing were happening; the in-flight clone — one `previewOnly` block
  // per subject — is the only one that follows the pointer.
  const dragState = !previewOnly && liveDrag?.duplicate === true ? null : liveDrag;
  const dragSubject =
    dragState?.subjects.find((subject) => subject.layerId === layer.id) ??
    null;
  const isDragging = dragSubject !== null;
  const isDragAnchor = dragState?.layerId === layer.id;
  const isPendingPlacement = pendingPlacement?.layerId === layer.id;
  const dragValidity =
    isDragging && dragState?.kind === "move" ? dragState.validity : "valid";
  // Not `!== "valid"`: a drag over the drop strip reads `"spawn"`, which is a
  // destination being created rather than a refusal (ADR 0042).
  const dragIsInvalid = placementRefuses(dragValidity);
  const dragInvalidLabel =
    dragValidity === "collision"
      ? t("timeline.drop_collision", { defaultValue: "Overlap" })
      : dragValidity === "locked"
        ? t("timeline.drop_locked", { defaultValue: "Locked" })
        : null;

  const editingLayerId = useEditingLayerId();
  const groupCompositionId =
    layer.params.kind === "CompositionRef" ? layer.params.composition_id : null;
  const editingGroupId = useEditingGroupId();
  // The composition-name editor uses the same slot as the layer-label one: only
  // one input can hold the caret (`renameStore.ts`), and putting them in one
  // place is what keeps the block's sticky-label geometry to a single branch.
  const isEditingGroupName =
    groupCompositionId !== null && editingGroupId === groupCompositionId;
  const isEditing = editingLayerId === layer.id || isEditingGroupName;
  const editingLinkId = useEditingLinkId();
  const linksOff = useLinkOverride();
  const isEditingLinkTab =
    linkTab !== null && editingLinkId === linkTab.linkId;
  const focusedParam = useFocusedParamFor(layer.id);
  const groupOrdinals = useGroupOrdinals();
  // Null for every other kind, and for a Group whose composition the summary no
  // longer carries — `sourceWindowTail` reads that as "draw neither affordance".
  const groupSourceDurationUs = useCompositionDurationUs(groupCompositionId);
  const [draft, setDraft] = useState("");
  // Which of THIS layer+param's keyframes are selected. Reads the shared
  // selection store so the chip diamonds and the sub-lane ones agree.
  const isKfSelected = useIsKeyframeSelected(layer.id, focusedParam);
  // A gesture's preview of the focused property — a menu row armed over the
  // selection, a retime in flight — drawn in place of the committed track.
  const kfPreview = useNumberTrackPreview(layer.id, focusedParam);
  const commitKeyframeBatch = useKeyframeBatchCommit();
  const [interpMenu, setInterpMenu] = useState<{ x: number; y: number; kfId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragTUsRef = useRef<number | null>(null);
  useEffect(() => {
    if (isEditing) {
      setDraft(
        (isEditingGroupName && layer.params.kind === "CompositionRef"
          ? layer.params.composition_label
          : layer.label) ?? "",
      );
      // preventScroll: the timeline is a scroll container, so a plain
      // focus() would scroll the block into view and jolt the timeline.
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeded from
    // whichever name is being edited; `layer.params` is not a stable dep and the
    // two label primitives below are the only content that can change it.
  }, [isEditing, isEditingGroupName, layer.id, layer.label, groupLabel(layer)]);

  // Drop the diamond selection when this layer is no longer the primary
  // selection, so the Timeline's capture-phase keyframe Delete can't stay armed
  // after the user moves on (Delete then reverts to deleting the layer).
  useEffect(() => {
    if (!isPrimary) clearKeyframeSelection();
  }, [isPrimary]);

  const commitRename = () => {
    const next = draft.trim();
    if (isEditingGroupName && groupCompositionId !== null) {
      // Blank clears the name, which is a Group's ordinary unnamed state (the
      // derived `Group N` takes over) — unlike a layer label, where the actor
      // stores the empty string and the naming chain reads it as absent.
      if (next !== (groupLabel(layer) ?? "")) {
        onCommitGroupLabel(groupCompositionId, next || null);
      }
    } else if (next !== (layer.label ?? "")) {
      onCommitLabel(layer.id, next);
    }
    endRename();
  };
  let liveStart = isPendingPlacement
    ? pendingPlacement.tStartUs
    : (dragSubject?.originalTStart ?? layer.t_start_us);
  let liveEnd = isPendingPlacement
    ? pendingPlacement.tEndUs
    : (dragSubject?.originalTEnd ?? layer.t_end_us);
  if (dragSubject && dragState) {
    const dx = dragState.deltaUs;
    switch (dragState.kind) {
      case "move": {
        const moveDeltaUs = Math.max(dx, -dragState.originalTStart);
        const durationUs = dragSubject.originalTEnd - dragSubject.originalTStart;
        liveStart = Math.max(0, dragSubject.originalTStart + moveDeltaUs);
        liveEnd = liveStart + durationUs;
        break;
      }
      case "trim-start":
        liveStart = Math.min(
          dragSubject.originalTStart + dx,
          adjacentFrameBoundaryUs(
            dragSubject.originalTEnd,
            -1,
            fpsNum,
            fpsDen,
          ),
        );
        liveEnd = dragSubject.originalTEnd;
        break;
      case "trim-end":
        liveEnd = Math.max(
          adjacentFrameBoundaryUs(
            dragSubject.originalTStart,
            1,
            fpsNum,
            fpsDen,
          ),
          dragSubject.originalTEnd + dx,
        );
        liveStart = dragSubject.originalTStart;
        break;
    }
  }

  const left = (Math.max(0, liveStart) / 1_000_000) * pxPerSec;
  const width = ((liveEnd - liveStart) / 1_000_000) * pxPerSec;
  const label = layerDisplayName(layer, t, groupOrdinals);

  // Source copies are normally filtered out for cross-track drag/pending
  // states. If one still renders during a transitional frame, keep it
  // non-interactive and visually secondary.
  const dragPreviewTrackId =
    dragSubject && dragState?.kind === "move"
      ? isDragAnchor
        ? previewTrackId(dragState.overTrackId, dragSubject.trackId)
        : dragSubject.trackId
      : null;
  const movedAcrossTracks =
    (dragPreviewTrackId !== null && dragPreviewTrackId !== trackId) ||
    (isPendingPlacement && pendingPlacement.trackId !== trackId);

  // Edge-hover trim: pointerdown within EDGE_ZONE_PX of the layer's
  // left/right edge dispatches trim-start/trim-end; everywhere else
  // dispatches a move. The zone clamps to a third of the chip's width
  // so the two edges never overlap on a narrow clip.
  const EDGE_ZONE_PX = 6;
  const [edgeHover, setEdgeHover] = useState<"left" | "right" | null>(null);

  const edgeZoneFor = (
    clientX: number,
    rect: DOMRect,
  ): "left" | "right" | null => {
    const zone = Math.min(EDGE_ZONE_PX, Math.floor(rect.width / 3));
    if (zone <= 0) return null;
    const rel = clientX - rect.left;
    if (rel < zone) return "left";
    if (rect.width - rel < zone) return "right";
    return null;
  };

  const onPointerMoveHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return; // ignore moves with a button held (drag)
    if (bladeMode) {
      if (layer.locked || trackLocked || isDragging) {
        onBladePreview(null);
      } else {
        onBladePreview(layer, e.clientX);
      }
      if (edgeHover !== null) setEdgeHover(null);
      return;
    }
    if (layer.locked || trackLocked || bladeMode || isDragging) {
      if (edgeHover !== null) setEdgeHover(null);
      return;
    }
    const next = edgeZoneFor(
      e.clientX,
      e.currentTarget.getBoundingClientRect(),
    );
    if (next !== edgeHover) setEdgeHover(next);
  };

  const onPointerLeaveHover = () => {
    if (bladeMode) onBladePreview(null);
    if (edgeHover !== null) setEdgeHover(null);
  };

  const onLayerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || layer.locked || trackLocked) return;
    e.stopPropagation();
    // Clicking the clip body (diamond pointerdown stops propagation, so this
    // only fires off-diamond) deselects any selected keyframe → Delete then
    // targets the layer again.
    clearKeyframeSelection();
    // Blade-tool mode hijacks every pointerdown on the layer surface:
    // the click is a cut request, not a select/drag.
    if (bladeMode) {
      onBladeSplit(layer, e.clientX);
      return;
    }
    const blockRect = e.currentTarget.getBoundingClientRect();
    const zone = edgeZoneFor(e.clientX, blockRect);
    const kind: DragKind =
      zone === "left" ? "trim-start" : zone === "right" ? "trim-end" : "move";
    // Snapshotted BEFORE the click's selection applies — see
    // `DragSeed.selectedAtPointerDown`.
    const selectedAtPointerDown = layerIdsOf(currentSelection());
    // `docs/features.md#links` — match click-selection semantics on
    // pointerdown so drag and click share the same link-aware path.
    const stillSelected = onSelectFromClick(layer.id, {
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
    // A Shift+click that REMOVED this clip from the selection was a deselect,
    // full stop — no drag. Not merely cosmetic: `wasSelectedAtPointerDown` was
    // true a moment ago, which buys a ZERO arm delay in `useLayerDrag`, so
    // without this the smallest pointer wobble would move the clip the user just
    // dropped from the selection.
    if (!stillSelected) return;
    onDragStart({
      kind,
      layerId: layer.id,
      trackId,
      trackKind,
      startX: e.clientX,
      startY: e.clientY,
      // Converted to time HERE, where this Panel's zoom is in scope. Carrying
      // the px would hand a Panel at another zoom a number it cannot read, which
      // is exactly why the crossing used to drop the grab point altogether.
      grabOffsetUs:
        pxPerSec > 0 ? ((e.clientX - blockRect.left) / pxPerSec) * 1_000_000 : 0,
      originalTStart: layer.t_start_us,
      originalTEnd: layer.t_end_us,
      deltaUs: 0,
      overTrackId: trackId,
      duplicate: e.altKey && kind === "move",
      escapeLink: e.altKey && kind !== "move",
      wasSelectedAtPointerDown: isSelected,
      selectedAtPointerDown,
    });
  };

  // A Group's source length is its composition's duration, so the two right-edge
  // affordances below follow the composition rather than any media (ADR 0052
  // §6). Only a Group draws either today — every other kind hands in a null
  // source length and gets nothing back — but the arithmetic is the source
  // window's, not the Group's, so it is asked kind-agnostically: a media clip
  // whose file was replaced by a shorter one is the same picture.
  const sourceTail = sourceWindowTail({
    srcInUs: "src_in_us" in layer.params ? layer.params.src_in_us : 0,
    srcOutUs: "src_out_us" in layer.params ? layer.params.src_out_us : 0,
    sourceDurationUs: groupSourceDurationUs,
  });

  // The name in the two tail tooltips: the SOURCE's name, which for a Group is
  // its composition's rather than this clip's own label — the sentence is about
  // what ran out, not about the clip that shows it.
  const sourceName =
    layer.params.kind === "CompositionRef"
      ? groupDisplayName(
          layer.params.composition_id,
          layer.params.composition_label,
          groupOrdinals,
          t,
        )
      : label;

  const layerWidthPx = Math.max(width, 4);
  const showLabel = layerWidthPx >= LAYER_LABEL_MIN_PX;
  const showFullAffordances = layerWidthPx > LAYER_FULL_LABEL_MIN_PX;
  const visibleLabel = showFullAffordances ? label : shortLayerLabel(label);
  const layerTheme = timelineLayerTheme(layer.params.kind, layer.color_hint);

  const { top: sliceTop, height: sliceHeight } = layerSliceRect(
    laneHeight,
    slice,
  );

  // `docs/features.md#links` — a 2 px left border in the link's hue on every
  // member, plus a chain glyph inside that edge on a clip wide enough for its
  // full label (a narrow clip keeps the accent alone). The glyph is the same
  // `Link2` the inspector's scale-link uses: one chain means "tied together"
  // everywhere. The extra left padding keeps the label clear of the glyph.
  const linkHueValue = linkId !== null ? linkHue(linkId) : null;
  const showLinkGlyph = linkHueValue !== null && showFullAffordances;
  // Dimmed to 40 % under the link override (`linkOverrideStore.ts`), so the
  // canvas itself says links are not in force.
  const linkAccentAlpha = linksOff ? 0.4 : 1;
  const linkStyle: React.CSSProperties = {};
  if (linkHueValue !== null) {
    linkStyle.borderLeft = `2px solid hsl(${linkHueValue} 75% 60% / ${linkAccentAlpha})`;
  }
  if (showLinkGlyph) linkStyle.paddingLeft = 16;
  // The count the anchor's badge draws. During a move the dragged member's
  // ghost carries the drag's own count instead — that is the one moment the
  // invisible fan-out is happening — and every other member draws none.
  const linkHiddenCount =
    linkTab === null
      ? 0
      : dragSubject !== null
        ? isDragAnchor && dragState?.kind === "move"
          ? dragState.hiddenSubjectCount
          : 0
        : linkTab.hidden.length;
  // The tab sits above the block's top edge, in the seam where the lane
  // above's resize handle (`z-[3]`) lives. A selected block is a `z-[2]`
  // stacking context, so the tab cannot out-rank the handle on its own — the
  // BLOCK is lifted while it draws link chrome, or the badge is unclickable.
  const linkChromeShown =
    linkTab !== null &&
    !previewOnly &&
    (linkTab.label !== null || isEditingLinkTab || linkHiddenCount > 0);

  const sliceClasses =
    slice === "top"
      ? "rounded-b-none border-b border-b-black/25"
      : slice === "bottom"
        ? "rounded-t-none border-t border-t-white/10"
        : "";

  // Derive from the LIVE edges (not the committed t_end/t_start) so diamond
  // positions stay consistent with `layerWidthPx` during a trim drag; the
  // actor re-bases keyframes on commit, so this is just the in-flight preview.
  const clipDurationUs = liveEnd - liveStart;
  const { diamonds, extrapMarks } = (() => {
    const none = {
      diamonds: [] as { id: string; x: number; glyph: string }[],
      extrapMarks: [] as { side: "before" | "after"; x: number; mode: Extrapolate }[],
    };
    // When the track is expanded the keyframes render in the sub-lanes
    // below (KeyframeLane), so the collapsed in-clip diamonds are hidden.
    if (isTrackExpanded || !focusedParam) return none;
    const track = kfPreview ?? readParamTrack(layer.params, focusedParam);
    if (!track || track.mode !== "Keyframed") return none;
    // collapsed mode hides out-of-range keys (kept in data)
    const inRange = (k: Keyframe<number>) => k.t_us >= 0 && k.t_us <= clipDurationUs;
    const xOf = (k: Keyframe<number>) => keyframeXWithinClip(k.t_us, clipDurationUs, layerWidthPx);
    const diamonds = track.value.flatMap((k) =>
      inRange(k) ? [{ id: k.id, x: xOf(k), glyph: interpGlyphClass(k.segment.kind) }] : [],
    );
    // A non-Hold side is announced by one mark beside its end key — only when
    // that key is drawn (an end key past the clip edge has nothing visible to
    // extrapolate from) and only with two or more keys (one never extrapolates).
    const extrapMarks: typeof none.extrapMarks = [];
    if (track.value.length > 1) {
      const first = track.value[0]!;
      const last = track.value[track.value.length - 1]!;
      if (track.extrapolate.before !== "Hold" && inRange(first)) {
        extrapMarks.push({ side: "before", x: xOf(first) - EXTRAP_GLYPH_GAP_PX, mode: track.extrapolate.before });
      }
      if (track.extrapolate.after !== "Hold" && inRange(last)) {
        extrapMarks.push({ side: "after", x: xOf(last) + EXTRAP_GLYPH_GAP_PX, mode: track.extrapolate.after });
      }
    }
    return { diamonds, extrapMarks };
  })();

  return (
    <div
      data-drag-validity={
        isDragging && dragState?.kind === "move" ? dragValidity : undefined
      }
      data-duplicate-preview={previewOnly || undefined}
      // Absent on an in-flight duplicate ghost, which draws its SOURCE layer:
      // the attribute is a unique handle onto one clip, and a second element
      // carrying the same id would break every locator built on it.
      data-layer-id={previewOnly ? undefined : layer.id}
      data-link-id={linkId ?? undefined}
      aria-invalid={dragIsInvalid || undefined}
      className={[
        "timeline-layer", // JS hook for the blade-cursor rule; carries no styles itself.
        "absolute flex items-center rounded border border-white/10 px-2",
        "text-[11px] font-semibold text-white select-none cursor-grab",
        "shadow-[0_1px_2px_rgba(0,0,0,0.28)] transition-[outline,box-shadow,border-color] duration-75",
        "hover:border-white/20 hover:shadow-[0_2px_5px_rgba(0,0,0,0.36)]",
        sliceClasses,
        linkChromeShown && !isDragging ? "z-[4]" : isSelected ? "z-[2]" : "",
        isDragging
          ? "z-[3] cursor-grabbing border-white/25 shadow-[0_4px_10px_rgba(0,0,0,0.45)]"
          : "",
        // Outline conditionals are mutually exclusive so Tailwind's emit
        // order never decides the conflict: the locked chrome trumps the
        // selected chrome.
        (layer.locked || trackLocked)
          ? "cursor-not-allowed outline outline-1 outline-dashed outline-black/50"
          : dragIsInvalid
            ? "cursor-not-allowed"
            : isSelected
            ? "outline outline-2 -outline-offset-2 outline-ring"
            : "",
        movedAcrossTracks || previewOnly ? "pointer-events-none" : "",
      ].join(" ")}
      style={{
        left,
        top: sliceTop,
        width: layerWidthPx,
        height: sliceHeight,
        backgroundColor: layerTheme.surface,
        borderColor:
          dragValidity === "collision"
            ? "rgb(252 165 165)"
            : dragValidity === "locked"
              ? "rgb(252 211 77)"
              : undefined,
        outline:
          dragValidity === "collision"
            ? "2px solid rgb(248 113 113)"
            : dragValidity === "locked"
              ? "2px solid rgb(251 191 36)"
              : undefined,
        outlineOffset: dragIsInvalid ? -2 : undefined,
        boxShadow: dragIsInvalid
          ? dragValidity === "collision"
            ? "0 4px 12px rgb(248 113 113 / 0.45)"
            : "0 4px 12px rgb(251 191 36 / 0.38)"
          : undefined,
        opacity: movedAcrossTracks ? 0.3 : layer.enabled ? 1 : 0.45,
        cursor:
          dragIsInvalid
            ? "not-allowed"
            : !layer.locked && !trackLocked && !bladeMode && !isDragging && edgeHover !== null
            ? "ew-resize"
            : undefined,
        ...linkStyle,
      }}
      onClick={(e) => {
        // Selection happens on pointerdown (onLayerPointerDown, which also arms
        // the drag). This handler exists only to stop the click bubbling to the
        // timeline-root background-deselect, which would clear that selection.
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        if (layer.locked || trackLocked || bladeMode) return;
        e.stopPropagation();
        // A Group clip's double-click ENTERS it (AE, Premiere and Resolve all
        // open a nest this way), so the gesture that renames every other clip
        // is spent here on navigation — the same `openGroup` the Edit menu and
        // the clip's own context menu run, which under ADR 0053 means "give
        // this composition a timeline Panel beside this one, and activate it".
        // Renaming a Group is still reachable — `Rename` for the clip's own
        // label, `Rename group…` for the composition's, both on the context
        // menu.
        if (groupCompositionId !== null) {
          openComposition(groupCompositionId, layer.id);
          return;
        }
        beginLayerRename(layer.id);
      }}
      onPointerDown={onLayerPointerDown}
      onPointerMove={onPointerMoveHover}
      onPointerLeave={onPointerLeaveHover}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Locked layers are unselectable; suppress the context menu too.
        if (layer.locked || trackLocked) return;
        onContextMenu(e, layer.id, layer.kind, layer.enabled);
      }}
      title={[
        `${layer.kind}: ${formatTimecode(liveStart, fpsNum, fpsDen)} → ${formatTimecode(liveEnd, fpsNum, fpsDen)}`,
        // The chip is where a Text layer's words live now, and the chip
        // truncates: to 12 characters on a narrow block, to 240px of ellipsis on
        // a wide one, and to nothing at all once the layer has been renamed. The
        // tooltip is the one place the line itself stays readable without
        // opening the inspector.
        layer.params.kind === "Text"
          ? textSnippet(layer.params.content, TEXT_NAME_MAX)
          : "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <TimelineVisualPreview
        layer={layer}
        layerWidthPx={layerWidthPx}
        layerHeightPx={sliceHeight}
        pxPerSec={pxPerSec}
      />
      {dragIsInvalid && (
        <span
          className={`pointer-events-none absolute inset-0 z-[1] rounded ${
            dragValidity === "collision" ? "bg-red-500/30" : "bg-amber-500/25"
          }`}
          aria-hidden="true"
        />
      )}
      {isDragAnchor && dragInvalidLabel && (
        <span
          data-testid="layer-drag-invalid-badge"
          className={`pointer-events-none absolute right-1 top-1 z-[4] rounded px-1 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm ${
            dragValidity === "collision" ? "bg-red-600/90" : "bg-amber-600/90"
          }`}
        >
          {dragInvalidLabel}
        </span>
      )}
      {layer.params.kind !== "Color" && (
        <span
          className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-0.5 opacity-90"
          style={{ backgroundColor: layerTheme.accent }}
          aria-hidden="true"
        />
      )}
      {/* Where the source ran out. Hatched rather than dimmed, because dimming
          is what a disabled layer already looks like, and a diagonal hatch is
          the mark every NLE uses for "no media here". Drawn under the label's
          scrim (`z-[1]`) so a long name stays readable across it. */}
      {sourceTail.overhangFromFraction !== null && (
        <span
          data-testid="layer-overhang-tail"
          className="pointer-events-none absolute inset-y-0 right-0 z-[1] rounded-r"
          style={{
            left: `${sourceTail.overhangFromFraction * 100}%`,
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(0,0,0,0.42) 0 3px, rgba(255,255,255,0.10) 3px 6px)",
          }}
          title={t("timeline.group_overhang", { label: sourceName })}
          aria-hidden="true"
        />
      )}
      {/* The opposite case: there is content past the out edge, so the edge can
          be dragged out. A 2 px tick and nothing more — it is an affordance the
          user needs only while reaching for that edge, and anything larger would
          read as a lane the editor wants managed. */}
      {sourceTail.hasUnusedTail && (
        <span
          data-testid="layer-source-tail-tick"
          className="pointer-events-none absolute inset-y-1 right-0 z-[1] w-0.5 rounded-full opacity-70"
          style={{ backgroundColor: layerTheme.accent }}
          title={t("timeline.group_more_content", { label: sourceName })}
          aria-hidden="true"
        />
      )}
      {showLinkGlyph && (
        <span
          data-testid="link-glyph"
          className="pointer-events-none absolute left-[3px] top-1/2 z-[1] -translate-y-1/2"
          style={{ color: `hsl(${linkHueValue} 75% 72% / ${linkAccentAlpha})` }}
          aria-hidden="true"
        >
          <Link2 size={10} strokeWidth={2} />
        </span>
      )}
      {linkTab !== null && linkHueValue !== null && !previewOnly && (
        <LinkTab
          tab={linkTab}
          hue={linkHueValue}
          accentAlpha={linkAccentAlpha}
          clipWidthPx={layerWidthPx}
          hiddenCount={linkHiddenCount}
          isEditing={isEditingLinkTab}
          onCommitLabel={onCommitLinkLabel}
        />
      )}
      {layer.params.kind === "Audio" && !previewOnly && <AudioSyncBadge layerId={layer.id} />}
      {/* No width gate, unlike the label and the chain glyph. Those two sit in
          the block's flow and a narrow clip has no room to spend on them; this
          one is absolutely positioned in the corner `AudioSyncBadge` already
          uses, so it displaces nothing at any width. A gate would also silence
          it exactly where it earns its keep: at the zoom that makes every Group
          clip a sliver, "is there anything in there" is the live question. */}
      {groupCompositionId !== null && !previewOnly && (
        <GroupMarkerBadge compositionId={groupCompositionId} layerId={layer.id} />
      )}
      {isEditing && showLabel ? (
        <AppInput
          ref={inputRef}
          // Sticky like the label so the editor appears at the clip's current
          // visible left edge, not its (possibly scrolled-off) absolute start.
          // Width pinned inline because .app-input's width:100% would beat a
          // `w-40` utility class.
          className="sticky z-[2]"
          style={{ left: HEADER_COL_PX + 4, width: "10rem", maxWidth: "100%" }}
          value={draft}
          // Named only when it is the composition-name editor: the two editors
          // share this slot, and "Group name" on a clip's own label field would
          // be a lie about what the field writes.
          {...(isEditingGroupName ? { ariaLabel: t("timeline.group_label") } : {})}
          onValueChange={setDraft}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              endRename();
            }
          }}
        />
      ) : showLabel ? (
        <span
          // Sticky so the label stays readable while scrolling a long clip:
          // it pins just past the sticky track-header column and slides along
          // within the clip until the clip's tail scrolls past it. Content-
          // width (capped) so it can actually slide; clips itself with ellipsis.
          className="sticky z-[2] flex items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-sm bg-gradient-to-r from-black/65 via-black/40 to-transparent py-1 pl-1.5 pr-3 text-[10px] leading-none text-white"
          style={{
            left: HEADER_COL_PX + 4,
            maxWidth: showFullAffordances
              ? "min(calc(100% - 8px), 240px)"
              : "min(calc(100% - 8px), 120px)",
          }}
        >
          <span
            className="shrink-0"
            style={{
              color:
                layer.params.kind === "Color"
                  ? "currentColor"
                  : layerTheme.accent,
            }}
          >
            <LayerKindIcon kind={layer.params.kind} />
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {visibleLabel}
          </span>
        </span>
      ) : null}
      {layer.kind === "Motif" && showFullAffordances && (
        <MotifBakeDot layerId={layer.id} />
      )}
      {diamonds.length > 0 && focusedParam && (
        <div
          className="kf-diamond-row"
          aria-hidden
          style={{ pointerEvents: "auto" }}
          onContextMenu={(e) => {
            if (!focusedParam) return;
            const track = readParamTrack(layer.params, focusedParam);
            if (!track || track.mode !== "Keyframed") return;
            const rect = e.currentTarget.getBoundingClientRect();
            const hitId = keyframeHitTest(diamonds, e.clientX - rect.left, 6);
            if (!hitId) return;
            e.preventDefault();
            e.stopPropagation();
            // Right-clicking a diamond INSIDE the selection keeps it, so the
            // menu reaches every key the user swept; outside it, the selection
            // becomes this one key first. The rule `Timeline`'s clip
            // `onContextMenu` states in full.
            const key = { layerId: layer.id, paramKey: focusedParam, kfId: hitId };
            if (!useKeyframeSelectionStore.getState().selected.has(keyframeKey(key))) {
              selectKeyframe(key);
            }
            setInterpMenu({ x: e.clientX, y: e.clientY, kfId: hitId });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const paramTrack = readParamTrack(layer.params, focusedParam);
            if (!paramTrack || paramTrack.mode !== "Keyframed") return;
            const rect = e.currentTarget.getBoundingClientRect();
            const hitId = keyframeHitTest(diamonds, e.clientX - rect.left, 6);
            if (!hitId) return;
            e.stopPropagation();
            const key = paramTrack.value.find((k) => k.id === hitId);
            if (!key) return;
            selectKeyframe({ layerId: layer.id, paramKey: focusedParam, kfId: hitId });
            transportSeek(layer.t_start_us + key.t_us);
            // begin drag-retime
            const startClientX = e.clientX;
            const startTUs = key.t_us;
            const onMove = (me: PointerEvent) => {
              const dxUs = ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
              const nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
              dragTUsRef.current = nextTUs;
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              const nextTUs = dragTUsRef.current;
              dragTUsRef.current = null;
              if (nextTUs != null && nextTUs !== startTUs) {
                onCommitParamTrack(layer.id, focusedParam, retimeKeyframe(paramTrack, hitId, nextTUs));
              }
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
        >
          {diamonds.map((d) => (
            <span
              key={d.id}
              className={`kf-diamond${d.glyph ? ` ${d.glyph}` : ""}${isKfSelected(d.id) ? " is-selected" : ""}`}
              style={{ left: d.x }}
              data-kf-id={d.id}
            />
          ))}
          {extrapMarks.map((m) => (
            <span
              key={`extrap-${m.side}`}
              className={extrapolateClass(m.mode)}
              data-testid="kf-extrap"
              data-side={m.side}
              title={t(extrapolateLabelKey(m.mode))}
              style={{ left: m.x }}
            >
              {extrapolateGlyph(m.mode)}
            </span>
          ))}
        </div>
      )}
      {interpMenu && focusedParam && (() => {
        const track = readParamTrack(layer.params, focusedParam);
        if (!track || track.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={track}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onApply={commitKeyframeBatch}
          />
        );
      })()}
    </div>
  );
}
