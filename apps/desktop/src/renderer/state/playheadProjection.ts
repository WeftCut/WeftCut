// The one moment, read and written in a composition's own coordinates.
//
// `playheadStore` holds a single time in ROOT time (ADR 0053 decision 2). This
// module is where that number meets the path a surface reads it through — the
// anchor a Panel was entered through, or the preview's own route to its render
// target. Every surface that speaks a composition's own clock — a ruler line, a
// timecode, a snap target, an edit "at the playhead" — reads through here, and
// every scrub writes back through here. Nothing else may translate on its own;
// a second copy of this arithmetic is how two Panels start disagreeing about
// where the film is.
//
// The arithmetic itself is `render/timeProjection.ts` (pure); which composition
// each Panel shows and how it got there is `compositionAnchorStore.ts`.
//
// PERFORMANCE (`playheadStore.ts` states the tiers): an anchor frame is a walk
// of the summary, so anything on the per-frame path hoists one with
// `useAnchorFrame` and subscribes through `subscribeLocalPlayhead` — never
// resolves a frame inside the callback. N open timelines multiply every
// subscriber the playback loop has, so the cheapest tier that fits is the only
// tier allowed.

import { useMemo } from "react";

import { lastFrameAnchorUs } from "../frames";
import type { ProjectSummary } from "../ipc";
import {
  anchorFrame,
  localClockUs,
  localToRootIn,
  rootToLocalIn,
  type AnchorFrame,
} from "../render/timeProjection";
import {
  anchorPath,
  orphanPlayheadUs,
  pathToComposition,
  previewRenderTargetId,
  type CompositionCrumb,
  setOrphanPlayheadUs,
  useAnchorPath,
  useCompositionAnchorStore,
  useFocusedCompositionId,
  usePreviewRenderTargetId,
} from "./compositionAnchorStore";
import { seekToClamped } from "./navigation";
import {
  playheadTimeUs,
  setPlayheadTimeUs,
  usePlayheadStore,
  usePlayheadTimeUs,
  usePlayheadTimeUsThrottled,
} from "./playheadStore";
import { compositionOrRoot, useProjectStore } from "./projectStore";

/// The frame a Panel reads through before a project has named a root: offset 0
/// and on screen at every moment, so the unbound timeline row
/// (`compositionId === null`) behaves as the root does.
///
/// The rate is the degenerate one `compositionLocalUs` passes through
/// untouched. There is no lattice yet to snap to, and naming a real rate here
/// would quantize times against a grid no composition has agreed to — a number
/// that later reads as a decision rather than as the absence of one.
const NO_PROJECT_FRAME: AnchorFrame = {
  offsetUs: 0,
  windowStartUs: Number.NEGATIVE_INFINITY,
  windowEndUs: Number.POSITIVE_INFINITY,
  fpsNum: 0,
  fpsDen: 0,
};

/// The frame a Panel showing `compositionId` reads through, given the anchor it
/// holds. Null is the orphan answer, and an EMPTY path on a non-root
/// composition counts as one: the anchor is what says where a Group sits, so a
/// Panel that has never been given one has no licence to read the root's clock
/// as its own.
function frameFor(
  summary: ProjectSummary | null,
  compositionId: string | null,
  path: readonly CompositionCrumb[] | null,
): AnchorFrame | null {
  if (summary === null) return NO_PROJECT_FRAME;
  if (compositionId === null || compositionId === summary.root_id) {
    return anchorFrame(summary, []);
  }
  if (path === null || path.length === 0) return null;
  return anchorFrame(summary, path);
}

/// Where `compositionId`'s clock sits on the root's, or null when it has no path
/// to the root — an orphan, or a Group nested somewhere the root does not reach.
export function anchorFrameOf(compositionId: string | null): AnchorFrame | null {
  const summary = useProjectStore.getState().summary;
  return frameFor(
    summary,
    compositionId,
    compositionId === null ? null : anchorPath(compositionId),
  );
}

/// The anchor frame for React, recomputed only when the project or this Panel's
/// anchor moves. The dep every per-frame subscription re-registers on.
export function useAnchorFrame(compositionId: string | null): AnchorFrame | null {
  const summary = useProjectStore((s) => s.summary);
  const path = useAnchorPath(compositionId);
  return useMemo(
    () => frameFor(summary, compositionId, path),
    [summary, compositionId, path],
  );
}

/// What a Panel DRAWS, given an already-resolved frame: the one moment on this
/// composition's clock, or null when its placement is not on screen at that
/// moment. An orphan reads its own parked moment instead, which is the whole of
/// its axis.
export function localPlayheadIn(
  compositionId: string | null,
  frame: AnchorFrame | null,
): number | null {
  if (frame === null) {
    return compositionId === null ? null : orphanPlayheadUs(compositionId);
  }
  return rootToLocalIn(frame, playheadTimeUs());
}

/// The same reading for a caller with no frame in hand — resolves one, so it
/// belongs at event time and never on the per-frame path.
export function playheadLocalUs(compositionId: string | null): number | null {
  return localPlayheadIn(compositionId, anchorFrameOf(compositionId));
}

/// Root time `rootUs` on `compositionId`'s clock, window ignored — the reading
/// for a time that is not the playhead (scrolling a Panel to a moment, say).
/// Falls through unchanged for an orphan: nothing places it, so no root time has
/// a reading on its axis.
export function localClockUsOf(compositionId: string | null, rootUs: number): number {
  const frame = anchorFrameOf(compositionId);
  return frame === null ? rootUs : localClockUs(frame, rootUs);
}

/// What an EDIT at the playhead uses: the one moment on `compositionId`'s clock,
/// window ignored. A composition's clock runs whether or not its placement shows
/// it (`localClockUs`), so "insert here", "split here" and "what is this
/// parameter worth now" stay answerable from a Panel whose Group has scrolled
/// off the film — where a drawn playhead would have to admit it has no position.
export function playheadClockUs(compositionId: string | null): number {
  const frame = anchorFrameOf(compositionId);
  if (frame === null) {
    return compositionId === null ? 0 : orphanPlayheadUs(compositionId);
  }
  return localClockUs(frame, playheadTimeUs());
}

/// The editing target's reading of the moment — every command that acts "at the
/// playhead" in the timeline holding the keyboard.
export function focusedPlayheadUs(): number {
  return playheadClockUs(focusedId());
}

/// The moment at which `compositionId` reads `localUs`, or null when it has no
/// root time to name — the reverse projection a Panel's scrub travels.
export function rootUsOf(compositionId: string | null, localUs: number): number | null {
  const frame = anchorFrameOf(compositionId);
  return frame === null ? null : localToRootIn(frame, localUs);
}

/// The moment at which the editing target reads `localUs` — what a surface
/// speaking the focused timeline's clock (the transport timecode, Home/End)
/// hands to a root-time seek. Falls through unchanged for an orphan, whose seek
/// `seekLocalUs` refuses anyway.
export function focusedRootUs(localUs: number): number {
  const frame = anchorFrameOf(focusedId());
  return frame === null ? localUs : localToRootIn(frame, localUs);
}

/// Move the one moment so `compositionId` reads `localUs` — a scrub, a ruler
/// click, a nudge, wherever the gesture happened.
///
/// An ORPHAN has no root time to write, so its Panel parks on its own axis and
/// the film stays where it is. That is not a degraded seek: nothing places the
/// composition, so there is no moment of the film its position could name.
export function seekLocalUs(compositionId: string | null, localUs: number): void {
  seekIn(compositionId, anchorFrameOf(compositionId), localUs);
}

/// The write half, given an already-resolved frame — shared with the preview's
/// own transport, whose frame comes from the render target rather than from any
/// Panel's anchor.
function seekIn(
  compositionId: string | null,
  frame: AnchorFrame | null,
  localUs: number,
): void {
  if (frame === null) {
    if (compositionId === null) return;
    setOrphanPlayheadUs(compositionId, clampOrphanUs(compositionId, localUs));
    return;
  }
  seekToClamped(localToRootIn(frame, localUs));
}

/// An orphan clamps against its own duration, the way every other seek clamps
/// against the root's: its timeline is the only one its playhead is on.
function clampOrphanUs(compositionId: string, localUs: number): number {
  const comp = useProjectStore.getState().summary?.compositions[compositionId];
  if (!comp) return Math.max(0, localUs);
  return Math.max(
    0,
    Math.min(localUs, lastFrameAnchorUs(comp.duration_us, comp.fps_num, comp.fps_den)),
  );
}

// ===== The preview's clock ==================================================
//
// The preview draws its RENDER TARGET (`compositionAnchorStore.ts`) — the
// composition it is locked to, or the editing target while it follows focus —
// so the PlaybackEngine's one number is that composition's local time, not the
// root's. Every root-time caller of the transport goes through the conversions
// below; an unconverted `transportSeek` puts the monitor on the wrong frame the
// moment the target is anything but the root, and silently agrees with itself
// there.
//
// The target's frame does NOT come from an anchor. An anchor belongs to a
// Panel, and a locked target may have no Panel at all — that is the whole point
// of locking one — so `pathToComposition` supplies the path instead.

function previewFrameOf(targetId: string | null): AnchorFrame | null {
  const summary = useProjectStore.getState().summary;
  return frameFor(
    summary,
    targetId,
    targetId === null ? null : pathToComposition(targetId),
  );
}

/// The preview engine's own clock for a root moment.
///
/// The target's CLOCK, not its drawn read-out: a composition keeps running
/// whether or not its placement shows it there (`localClockUs`), and a moment
/// the placement does not reach lands outside the target's own timeline, where
/// it has nothing to draw. An ORPHAN target has no reading of a root moment at
/// all, so it holds at the position its own Panel parked it on and the film
/// moving past leaves it alone.
export function previewLocalUs(rootUs: number): number {
  const targetId = previewRenderTargetId();
  const frame = previewFrameOf(targetId);
  if (frame === null) return targetId === null ? rootUs : orphanPlayheadUs(targetId);
  return localClockUs(frame, rootUs);
}

/// Wired as the engine's `onTimeUpdate`: the per-frame emit, lifted out of the
/// target's clock so the one store keeps holding one moment. Playing an ORPHAN
/// target writes its own axis instead — it has no root time, and dragging the
/// film along with it would be the second playhead ADR 0053 refuses.
export function setPlayheadFromPreview(localUs: number): void {
  const targetId = previewRenderTargetId();
  const frame = previewFrameOf(targetId);
  if (frame === null) {
    if (targetId !== null) setOrphanPlayheadUs(targetId, localUs);
    return;
  }
  if (isClockFloorEcho(frame, localUs)) return;
  setPlayheadTimeUs(localToRootIn(frame, localUs));
}

/// LANDMINE: the engine's clock has a floor at zero, so a moment BEFORE the
/// target's own `t = 0` reaches the engine as that floor rather than as itself,
/// and the engine then emits the floor back. Taken for the film's own moment it
/// would pull the playhead forward to where the target starts — and, since
/// every seek re-projects, would make every moment before that unreachable
/// while the lock stands. So the floor is not allowed to speak for the film:
/// the target simply sits at its first frame until the moment reaches it.
///
/// Only the emit that IS the floor is dropped. A running target keeps writing,
/// which is what makes playing a locked composition move the film with it.
function isClockFloorEcho(frame: AnchorFrame, localUs: number): boolean {
  return localUs === 0 && localClockUs(frame, playheadTimeUs()) < 0;
}

/// The render target's reading of the one moment — what the preview's own
/// timecode field opens on, on the clock the canvas is showing. The same
/// number the engine is running at, which is what makes the field's commit a
/// no-op when nothing is typed.
export function previewClockUs(): number {
  return previewLocalUs(playheadTimeUs());
}

/// Move the one moment so the RENDER TARGET reads `localUs` — the preview
/// transport's seeks (its timecode field, its skip buttons), which speak the
/// clock of the picture rather than of the timeline holding the keyboard.
export function seekPreviewLocalUs(localUs: number): void {
  const targetId = previewRenderTargetId();
  seekIn(targetId, previewFrameOf(targetId), localUs);
}

/// The render target's frame for React — the dep a per-frame subscription on
/// the preview's clock re-registers on (`PlayheadTimecode`). Recomputed only
/// when the project, the lock or the anchors move, never per frame.
export function usePreviewTargetFrame(): AnchorFrame | null {
  const summary = useProjectStore((s) => s.summary);
  const targetId = usePreviewRenderTargetId();
  const anchors = useCompositionAnchorStore((s) => s.anchors);
  return useMemo(
    () =>
      frameFor(
        summary,
        targetId,
        targetId === null ? null : pathToComposition(targetId),
      ),
    // `anchors` is read through `pathToComposition`, not passed: a Panel
    // opening on the target re-anchors it, and the frame has to follow.
    [summary, targetId, anchors],
  );
}

// ===== React readers ========================================================

/// Panel-rate React subscription (tier 3) to one composition's read-out of the
/// moment — the "value at the playhead" surfaces (inspector rows, keyframe
/// navigators, the Playhead Panel).
export function useLocalPlayheadUsThrottled(
  compositionId: string | null,
  intervalMs = 100,
  enabled = true,
): number {
  const rootUs = usePlayheadTimeUsThrottled(intervalMs, enabled);
  const frame = useAnchorFrame(compositionId);
  const orphanUs = useOrphanPlayheadUs(compositionId);
  return frame === null ? orphanUs : localClockUs(frame, rootUs);
}

/// An orphan's parked moment, for React. Atomic selector — it returns the
/// number, never the map (`feedback_zustand_composite_selector`).
function useOrphanPlayheadUs(compositionId: string | null): number {
  return useCompositionAnchorStore((s) =>
    compositionId === null ? 0 : s.orphanPlayheads.get(compositionId) ?? 0,
  );
}

/// The editing target's read-out at panel rate — the surfaces that follow the
/// keyboard rather than a Panel of their own.
export function useFocusedPlayheadUsThrottled(intervalMs = 100, enabled = true): number {
  return useLocalPlayheadUsThrottled(useFocusedCompositionId(), intervalMs, enabled);
}

/// The editing target's read-out at FRAME rate (tier 4) — leaf components only.
export function useFocusedPlayheadUs(): number {
  const compositionId = useFocusedCompositionId();
  const rootUs = usePlayheadTimeUs();
  const frame = useAnchorFrame(compositionId);
  const orphanUs = useOrphanPlayheadUs(compositionId);
  return frame === null ? orphanUs : localClockUs(frame, rootUs);
}

/// Transient (tier 2) subscription to one Panel's read-out of the moment: the
/// pattern the playhead line and follow-playhead use, calling `apply` with the
/// projected time or null when the Panel has nothing to draw.
///
/// `frame` is hoisted by the caller (`useAnchorFrame`) so the per-frame path
/// walks nothing and allocates nothing; re-subscribe when it changes. An orphan
/// listens to the anchor store instead — its moment only moves when its own
/// Panel scrubs, so playback never reaches it.
export function subscribeLocalPlayhead(
  compositionId: string | null,
  frame: AnchorFrame | null,
  apply: (localUs: number | null) => void,
): () => void {
  if (frame === null) {
    apply(localPlayheadIn(compositionId, null));
    if (compositionId === null) return () => {};
    return useCompositionAnchorStore.subscribe(() =>
      apply(orphanPlayheadUs(compositionId)),
    );
  }
  apply(rootToLocalIn(frame, playheadTimeUs()));
  return usePlayheadStore.subscribe((s) => apply(rootToLocalIn(frame, s.timeUs)));
}

/// The editing target, resolved the way every other consumer resolves it: an id
/// the summary has lost reads as the root for the tick it takes the anchor store
/// to fall back, so a projection never runs against a composition that is gone.
function focusedId(): string | null {
  const { summary } = useProjectStore.getState();
  return compositionOrRoot(summary, useCompositionAnchorStore.getState().focusedId)?.id ?? null;
}
