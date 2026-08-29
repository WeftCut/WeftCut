// Where *Move to composition ›* would put the current selection, and why not
// when not.
//
// The sibling of `groupEligibility.ts` for the crossing addressed by NAMING a
// destination instead of by pointing at a Group clip. Same three shapes for the
// same two reasons that file's header gives — a Dock Panel cannot read
// Timeline's locals, and `CommandDef.enabled` is evaluated during someone
// else's render — plus a fourth this gesture needs: a LIST, because which
// composition the user picks is the whole content of the act.
//
// Every disabled state is its own string BECAUSE the tooltip has to name which
// condition failed, and that holds per DESTINATION as well: "the clips are
// already there" and "that composition would end up inside itself" are two
// different things to understand, and one greyed row saying neither would send
// the user looking.
//
// Does NOT own: the projection arithmetic (`render/timeProjection.ts`), which
// composition each surface reads through (`state/playheadProjection.ts`), nor
// the naming of a composition (`workspace/timelineTabName.ts`).

import type { ProjectSummary, TrackSummary } from "../ipc";
import { anchorFrame, rootToLocalIn } from "../render/timeProjection";
import {
  pathToComposition,
  useCompositionAnchorStore,
} from "../state/compositionAnchorStore";
import { playheadTimeUs } from "../state/playheadStore";
import {
  compositionOrRoot,
  currentGroupOrdinals,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import {
  currentSelection,
  layerIdsOf,
  useSelectedLayerIds,
} from "../state/selectionStore";
import { timelineTabLabel } from "../workspace/timelineTabName";
import { selectedWithTracks } from "./groupEligibility";

/// `groupEligibility.ts`'s empty sentinel, held here for its reason.
const NO_TRACKS: readonly TrackSummary[] = [];

/// The i18n callback shape `lib/layerName.ts` takes, so a caller can pass
/// `useTranslation().t` straight through.
type Translate = (key: string, values: Record<string, unknown>) => string;

/// `move_to_composition` is the live direction; the rest are the disabled
/// reasons, one per tooltip string.
///
/// `no_destination` is separate from `needs_selection` because there is nothing
/// about the SELECTION to fix: a project holding one composition, or one whose
/// every other composition a selected Group clip already reaches, offers this
/// gesture nowhere to go.
export type MoveToCompositionState =
  | "move_to_composition"
  | "needs_selection"
  | "locked"
  | "no_destination";

/// Why one destination row is greyed, `eligible` being the live one.
///
/// A `cycle` state exists here and deliberately not in `addToGroupState`: that
/// gesture spends the selection's only Group clip on being the destination, so
/// no member can be one. This gesture names its destination instead, so a
/// member CAN be a Group, and the user can point at a composition it already
/// reaches. Asked before the menu opens rather than after the commit fails.
export type DestinationState = "eligible" | "already_there" | "cycle";

/// One row of the submenu: a composition, whether the selection may go there,
/// and where in that composition's own time it would land.
export interface MoveDestination {
  compositionId: string;
  /// The name this composition is shown under anywhere — the film's own
  /// timeline for the root, which has no name of its own.
  name: string;
  state: DestinationState;
  /// Where the anchor member would start on the destination's clock.
  tStartUs: number;
  /// The landing fell back to the destination's own zero because the
  /// composition has no reading of this moment. A live row still, with a
  /// tooltip that says where the clips will actually appear.
  offScreen: boolean;
}

/// Every composition `compositionId` reaches, itself included — the renderer's
/// answer to main's `compositionRefPath`, over the summary rather than the
/// project.
///
/// `seen`-guarded because a reference cycle is a validated impossibility rather
/// than a structural one (`CompositionCycle`), and an infinite walk here would
/// hang the menu instead of failing a commit — the precaution
/// `projectStore.ts`'s `firstVideoMediaIdIn` takes for the same reason.
function compositionsReachedBy(
  summary: ProjectSummary,
  compositionId: string,
  out: Set<string> = new Set(),
): Set<string> {
  if (out.has(compositionId)) return out;
  out.add(compositionId);
  const comp = summary.compositions[compositionId];
  if (!comp) return out;
  for (const track of comp.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind !== "CompositionRef") continue;
      compositionsReachedBy(summary, layer.params.composition_id, out);
    }
  }
  return out;
}

/// Every composition in the project with the state it offers this selection, in
/// the summary's own key order. Pure, and unnamed: naming needs a locale and
/// the gate does not.
export function moveDestinationStates(
  summary: ProjectSummary | null,
  sourceCompositionId: string | null,
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
): Array<{ compositionId: string; state: DestinationState }> {
  if (!summary) return [];
  const barred = new Set<string>();
  for (const { layer } of selectedWithTracks(selected, tracks)) {
    if (layer.params.kind !== "CompositionRef") continue;
    for (const id of compositionsReachedBy(summary, layer.params.composition_id)) {
      barred.add(id);
    }
  }
  return Object.keys(summary.compositions).map((compositionId) => ({
    compositionId,
    state:
      compositionId === sourceCompositionId
        ? "already_there"
        : barred.has(compositionId)
          ? "cycle"
          : "eligible",
  }));
}

/// Move to composition takes ONE OR MORE layers and puts them somewhere else.
/// The order of the checks is the order the instructions get harder: select
/// something, unlock it, then find it somewhere to go.
///
/// "All in one composition" — the actor's `CrossCompositionSet` — is enforced
/// STRUCTURALLY, not checked, exactly as `addToGroupState` enforces it:
/// `selectedWithTracks` walks only the focused composition's tracks, so a layer
/// selected in another composition is simply not found.
///
/// The lock check mirrors the actor's, which refuses the whole set on any
/// locked member or lane rather than moving the rest: a partial move would be a
/// silent edit to a selection the user made deliberately.
export function moveToCompositionState(
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
  summary: ProjectSummary | null,
  sourceCompositionId: string | null,
): MoveToCompositionState {
  const found = selectedWithTracks(selected, tracks);
  if (found.length === 0) return "needs_selection";
  if (found.some(({ layer, track }) => layer.locked || track.locked)) return "locked";
  const destinations = moveDestinationStates(
    summary,
    sourceCompositionId,
    selected,
    tracks,
  );
  if (!destinations.some((d) => d.state === "eligible")) return "no_destination";
  return "move_to_composition";
}

/// Where the set would land in `compositionId`: that composition's read-out of
/// the one moment (ADR 0053 decision 2), projected through the placement the
/// user is looking at (`pathToComposition` prefers an open Panel's own anchor).
///
/// A Group placed nowhere at this moment has no read-out, and a composition
/// nothing places has no root time at all. Both fall back to the destination's
/// own zero rather than refusing: the gesture named a composition, not a
/// moment, and `t = 0` is the one position every composition has. The window is
/// therefore consulted (`rootToLocalIn`) where an edit at the playhead reads
/// the clock through it — a landing the destination cannot show has to say so
/// rather than quietly pick a time off the picture.
///
/// LANDMINE: the projection is the RENDERER's, over the mirror, and the op it
/// feeds is absolute. That is safe here for two reasons and neither is
/// incidental. The root moment is the renderer's own — main holds no playhead —
/// so it cannot be read anywhere else; and the placements this walks are the
/// ones the user is looking at, which is what "the destination's playhead"
/// means. Nothing here is a `base + delta` over a value the op writes: the
/// cycle rule bars every moved layer from the destination's own path
/// (`feedback_renderer_mirror_read_modify_write`).
export function moveLandingUs(compositionId: string): {
  tStartUs: number;
  offScreen: boolean;
} {
  const summary = useProjectStore.getState().summary;
  const path = summary === null ? null : pathToComposition(compositionId);
  const frame = path === null || summary === null ? null : anchorFrame(summary, path);
  const localUs = frame === null ? null : rootToLocalIn(frame, playheadTimeUs());
  return localUs === null
    ? { tStartUs: 0, offScreen: true }
    : { tStartUs: localUs, offScreen: false };
}

/// The submenu's rows, in the order it shows them: the ROOT first — it is the
/// answer to "get this back out of the Group", which is the most common reason
/// to open this menu — then the Groups by name.
///
/// Imperative, like `addToGroupTarget`, because it reads four stores and
/// answers a right-click rather than a render; `t` comes from the call site for
/// the reason `lib/layerName.ts` takes one.
export function moveDestinations(t: Translate): MoveDestination[] {
  const summary = useProjectStore.getState().summary;
  if (!summary) return [];
  const source = currentOpenComposition();
  const ordinals = currentGroupOrdinals();
  const panelTitle = t("dock_workspace.panels.timeline", {});
  const rows = moveDestinationStates(
    summary,
    source?.id ?? null,
    layerIdsOf(currentSelection()),
    source?.tracks ?? NO_TRACKS,
  ).map(({ compositionId, state }) => ({
    compositionId,
    name: timelineTabLabel(summary, compositionId, ordinals, panelTitle, t),
    state,
    ...moveLandingUs(compositionId),
  }));
  rows.sort((a, b) => {
    if (a.compositionId === summary.root_id) return -1;
    if (b.compositionId === summary.root_id) return 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/// The layers the command would move and the member the landing positions.
/// Null when the gesture has no set at all.
///
/// The anchor is the EARLIEST-starting member, so the set STARTS at the
/// destination's playhead and no other member can land before it — the one
/// choice that makes the actor's "no negative landing" refusal unreachable by
/// this gesture. Ties are free: members sharing a start land at the same time
/// whichever of them is named.
export function moveToCompositionSet(): {
  layerIds: string[];
  anchorLayerId: string;
} | null {
  const found = selectedWithTracks(
    layerIdsOf(currentSelection()),
    currentOpenComposition()?.tracks ?? NO_TRACKS,
  );
  if (found.length === 0) return null;
  const earliest = found.reduce((a, b) =>
    b.layer.t_start_us < a.layer.t_start_us ? b : a,
  );
  return {
    layerIds: found.map(({ layer }) => layer.id),
    anchorLayerId: earliest.layer.id,
  };
}

/// Imperative form, for `CommandDef.enabled` and the App handlers — both run
/// where there is no React.
export function moveToCompositionForSelection(): MoveToCompositionState {
  const summary = useProjectStore.getState().summary;
  const source = currentOpenComposition();
  return moveToCompositionState(
    layerIdsOf(currentSelection()),
    source?.tracks ?? NO_TRACKS,
    summary,
    source?.id ?? null,
  );
}

/// The root's row for this selection, or null when there is no project — what
/// the destination-less form of the command acts on.
function rootDestination(): { compositionId: string; state: DestinationState } | null {
  const summary = useProjectStore.getState().summary;
  if (summary === null) return null;
  const source = currentOpenComposition();
  return (
    moveDestinationStates(
      summary,
      source?.id ?? null,
      layerIdsOf(currentSelection()),
      source?.tracks ?? NO_TRACKS,
    ).find((d) => d.compositionId === summary.root_id) ?? null
  );
}

/// Whether the DESTINATION-LESS form may run — the Edit menu row, the palette
/// entry, a key someone binds. Those surfaces have no room for a list, so they
/// mean the one destination this gesture exists for: the film's own timeline,
/// which is the answer to "get this back out of the Group".
///
/// A selection already in the root therefore greys them, rather than taking
/// whichever Group happens to sort first — a landing decided by alphabetical
/// order is one no user can form an intention about. The submenu has room for
/// the list and keeps offering every Group.
export function canMoveSelectionToRoot(): boolean {
  return (
    moveToCompositionForSelection() === "move_to_composition" &&
    rootDestination()?.state === "eligible"
  );
}

/// The root's id when the destination-less form may run, else null.
export function moveToRootTarget(): string | null {
  return canMoveSelectionToRoot()
    ? (useProjectStore.getState().summary?.root_id ?? null)
    : null;
}

/// Subscription form — two stores, two subscriptions, neither of them a
/// composite selector (`feedback_zustand_composite_selector`), exactly as
/// `useAddToGroupState` does it. The rows themselves are NOT a hook: an array
/// selector is a fresh reference per call, so the menu subscribes to this
/// string and reads `moveDestinations` in the render that answer causes.
export const useMoveToCompositionState = (): MoveToCompositionState => {
  const selected = useSelectedLayerIds();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) => {
    const source = compositionOrRoot(s.summary, focusedId);
    return moveToCompositionState(
      selected,
      source?.tracks ?? NO_TRACKS,
      s.summary,
      source?.id ?? null,
    );
  });
};
