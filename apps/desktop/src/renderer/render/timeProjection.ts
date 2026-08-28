// One moment, read in many coordinate systems. The playhead is a single time
// in ROOT time (ADR 0053 decision 2), so a timeline Panel showing a Group has
// to project that time down through the anchor path it was entered by, and a
// scrub in that Panel has to project back up. This module is that projection,
// and nothing else: a summary, an anchor path and a number in, a number out.
//
// The arithmetic is `compositionWalk.ts`'s and is deliberately not restated —
// `childFrame` decides where a child composition's `t = 0` sits in root time
// and how the placement narrows the window, `compositionLocalUs` puts the
// result back on the frame lattice. Reusing them is what keeps a Panel's
// read-out and the Compositor's own recursion in agreement.
//
// Does NOT own: which anchor path a Panel holds (`state/compositionAnchorStore.ts`)
// nor which store a projected time is read from or written to
// (`state/playheadProjection.ts`).

import type { CompositionCrumb } from "../state/compositionAnchorStore";
import type { LayerSummary, ProjectSummary } from "../ipc";
import { childFrame, compositionLocalUs } from "./compositionWalk";

/// Where an anchored composition's clock sits on the root's. Hoisted out of the
/// projection calls on purpose: it is a walk of the summary, and it changes only
/// when the project or the anchor does — never once per composition frame.
export interface AnchorFrame {
  /// Root time of the composition's own `t = 0`: local `t` ↔ root `t + offsetUs`.
  offsetUs: number;
  /// The half-open root-time window the entered placements leave the composition
  /// visible in — `childFrame`'s narrowing, intersected down the path. Infinite
  /// at both ends for the root, which is on screen at every moment.
  windowStartUs: number;
  windowEndUs: number;
  /// The lattice both directions re-snap onto. One rate project-wide
  /// (ADR 0052 §5), so a projection is a shift and never a resample.
  fpsNum: number;
  fpsDen: number;
}

function findLayer(
  summary: ProjectSummary,
  compositionId: string,
  layerId: string,
): LayerSummary | null {
  const comp = summary.compositions[compositionId];
  if (!comp) return null;
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.id === layerId) return layer;
    }
  }
  return null;
}

/// The frame `anchorPath` opens onto — the empty path being the root's, which
/// is the identity.
///
/// Null when the path does not reach the root, and that is the ORPHAN answer:
/// a crumb naming no Group layer (nothing in the project references the
/// composition), a layer the summary has since lost, or a reference that no
/// longer points where the crumb says. Such a composition has no root time at
/// all, so its Panel cannot read the one moment and runs on its own instead.
export function anchorFrame(
  summary: ProjectSummary,
  anchorPath: readonly CompositionCrumb[],
): AnchorFrame | null {
  const root = summary.compositions[summary.root_id];
  if (!root) return null;
  let offsetUs = 0;
  let windowStartUs = Number.NEGATIVE_INFINITY;
  let windowEndUs = Number.POSITIVE_INFINITY;
  let hostId = summary.root_id;
  for (const crumb of anchorPath) {
    if (crumb.layerId === null) return null;
    const ref = findLayer(summary, hostId, crumb.layerId);
    if (ref?.params.kind !== "CompositionRef") return null;
    if (ref.params.composition_id !== crumb.compositionId) return null;
    const child = childFrame(
      ref,
      ref.params.src_in_us,
      offsetUs,
      windowStartUs,
      windowEndUs,
    );
    offsetUs = child.offsetUs;
    windowStartUs = child.windowStartUs;
    windowEndUs = child.windowEndUs;
    hostId = crumb.compositionId;
  }
  return {
    offsetUs,
    windowStartUs,
    windowEndUs,
    fpsNum: root.fps_num,
    fpsDen: root.fps_den,
  };
}

/// The composition's own clock at root time `rootUs`, whether or not the
/// placement shows it there.
///
/// A composition's clock does not stop when its Group scrolls off the root's
/// playhead — the window says only WHEN the placement is on screen. That is the
/// reading an edit "at the playhead" takes, so the operation stays defined
/// wherever the moment sits; `rootToLocalIn` is the reading the drawn playhead
/// takes, because a mark on screen may not claim a position the Panel is not
/// showing.
export function localClockUs(frame: AnchorFrame, rootUs: number): number {
  return compositionLocalUs(rootUs - frame.offsetUs, frame.fpsNum, frame.fpsDen);
}

/// The composition's read-out of root time `rootUs`, or null when the anchor's
/// window has been left — a Group not on screen at this moment has no position,
/// and a clamped one would lie about where the film is.
export function rootToLocalIn(frame: AnchorFrame, rootUs: number): number | null {
  if (rootUs < frame.windowStartUs || rootUs >= frame.windowEndUs) return null;
  return localClockUs(frame, rootUs);
}

/// The root time at which the composition reads `localUs`. Total while the
/// anchor resolves: this is the direction a scrub inside a Group travels, and it
/// has to answer for every position that Panel can put its playhead at — the
/// window governs what is drawn, not what can be pointed at.
export function localToRootIn(frame: AnchorFrame, localUs: number): number {
  return compositionLocalUs(localUs + frame.offsetUs, frame.fpsNum, frame.fpsDen);
}

/// Root time `rootUs` read on the composition `anchorPath` ends at. Null when
/// that composition is off screen at the moment, or has no path to the root at
/// all.
export function rootToLocal(
  summary: ProjectSummary,
  anchorPath: readonly CompositionCrumb[],
  rootUs: number,
): number | null {
  const frame = anchorFrame(summary, anchorPath);
  return frame === null ? null : rootToLocalIn(frame, rootUs);
}

/// The one moment that reads `localUs` on the composition `anchorPath` ends at.
/// Null only for a composition with no path to the root — an orphan has no root
/// time to write.
export function localToRoot(
  summary: ProjectSummary,
  anchorPath: readonly CompositionCrumb[],
  localUs: number,
): number | null {
  const frame = anchorFrame(summary, anchorPath);
  return frame === null ? null : localToRootIn(frame, localUs);
}
