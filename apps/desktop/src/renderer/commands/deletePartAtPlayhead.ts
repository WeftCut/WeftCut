// Delete start to playhead / Delete end from playhead: the clip under the
// playhead loses the part before (or after) it and the hole closes, as one undo
// (docs/features.md#delete-start-or-end). The edit is the actor's
// `ripple_delete_part`; this module picks the targets and moves the playhead.
//
// Reads its inputs live and holds no React state, for `splitAtPlayhead`'s
// reason: it runs from a keyboard dispatch, the Edit menu and the palette.

import { rippleDeletePart } from "../ipc";
import { displayMode } from "../settings/appSettingsStore";
import { focusedPlayheadUs, seekLocalUs } from "../state/playheadProjection";
import { currentOpenComposition } from "../state/projectStore";
import { currentSelection, layerIdsOf } from "../state/selectionStore";
import { linkFanoutActive } from "../timeline/linkEligibility";
import { resolveSplitTargets } from "./splitAtPlayhead";

/**
 * Cut at the playhead and ripple-delete `part`.
 *
 * The targets are exactly what Split at playhead would cut
 * (`resolveSplitTargets`): the selection when it straddles the playhead, else
 * every straddling clip the user can see and edit. They go in ONE commit,
 * unlike Split's one per target, because their holes have to close together.
 *
 * Silent when nothing straddles the playhead — over a gap, or on a clip's edge,
 * there is no part to delete. Rejections propagate to `runCommandWithLogging`,
 * as Split's do.
 *
 * After deleting the start the playhead goes to the cut, where what followed it
 * now begins, so playback picks up from the edit. After deleting the end it is
 * already there.
 */
async function deletePartAtPlayhead(part: "start" | "end"): Promise<void> {
  const composition = currentOpenComposition();
  if (!composition) return;
  // Read once, so the targets and the cut agree (`splitAtPlayhead`).
  const tUs = focusedPlayheadUs();
  const fanout = linkFanoutActive();
  const targets = resolveSplitTargets(
    composition,
    tUs,
    layerIdsOf(currentSelection()),
    displayMode() === "AbRoll",
    fanout,
  );
  if (targets.length === 0) return;
  const { at_t_us } = await rippleDeletePart({
    layerIds: targets.map((target) => target.layerId),
    atTUs: tUs,
    part,
    escapeLink: !fanout,
  });
  // On the composition's own clock, so a cut inside an orphan parks its own
  // playhead rather than writing a local time as the film's.
  if (part === "start") seekLocalUs(composition.id, at_t_us);
}

export function deleteStartToPlayhead(): Promise<void> {
  return deletePartAtPlayhead("start");
}

export function deleteEndFromPlayhead(): Promise<void> {
  return deletePartAtPlayhead("end");
}
