// What a timeline Panel's tab says: the composition's name on the tab, and the
// route to it in the tooltip. Pure functions, so the tab renderer holds only
// its subscriptions and the Dock chrome it talks to.
//
// The naming itself is not decided here — `lib/layerName.ts` owns the one name
// a Group is shown under, on the clip, in the inspector and now on the tab.

import type {
  CompositionCrumb,
  CompositionPlacement,
} from "../state/compositionAnchorStore";
import type { ProjectSummary } from "../ipc";
import { formatTimecode } from "../frames";
import { groupDisplayName } from "../lib/layerName";

type Translate = (key: string, values: Record<string, unknown>) => string;

/// The separator between steps of a composition path. One home for it, because
/// the tooltip and the anchor menu both draw the same route.
const PATH_SEPARATOR = " › ";

/// The project's own step of a path. The root composition is never named in the
/// UI — it IS the timeline — so the path starts at the project instead, and
/// falls back to a generic word for a project saved under no name yet.
export function projectPathLabel(
  summary: ProjectSummary | null,
  t: Translate,
): string {
  return (
    summary?.name.trim() || t("dock_workspace.timeline_tab.project", {})
  );
}

/// `project › Group 1 › Group 2` for an anchor path, root excluded — the route
/// the tab was opened along, not a route recomputed from the project, so a
/// Group placed twice reads as the placement its Panel is anchored on.
export function compositionPathText(
  summary: ProjectSummary | null,
  crumbs: readonly CompositionCrumb[],
  ordinals: ReadonlyMap<string, number> | undefined,
  t: Translate,
): string {
  const steps = [projectPathLabel(summary, t)];
  for (const crumb of crumbs) {
    steps.push(
      groupDisplayName(
        crumb.compositionId,
        summary?.compositions[crumb.compositionId]?.label ?? null,
        ordinals,
        t,
      ),
    );
  }
  return steps.join(PATH_SEPARATOR);
}

/// One `Switch anchor` row: where the placement sits, and where it starts on
/// the ROOT's clock. Both halves are needed to tell placements apart — two
/// clips of one Group can share a parent, and two parents can hold a clip at
/// the same local time — and the root's clock is the one they have in common.
export function anchorEntryLabel(
  summary: ProjectSummary | null,
  placement: CompositionPlacement,
  ordinals: ReadonlyMap<string, number> | undefined,
  t: Translate,
): string {
  const root = summary?.compositions[summary.root_id];
  return t("dock_workspace.timeline_tab.anchor_entry", {
    // The route to the composition the clip SITS IN, which is its path minus
    // the step it opens onto.
    path: compositionPathText(
      summary,
      placement.crumbs.slice(0, -1),
      ordinals,
      t,
    ),
    time: formatTimecode(
      placement.rootStartUs,
      root?.fps_num ?? 30,
      root?.fps_den ?? 1,
    ),
  });
}

/// The name on the tab. A Panel showing the root prints the Panel kind's own
/// title — "the timeline" is what the root is called — and every Group prints
/// the name its clip carries.
export function timelineTabLabel(
  summary: ProjectSummary | null,
  compositionId: string | null,
  ordinals: ReadonlyMap<string, number> | undefined,
  panelTitle: string,
  t: Translate,
): string {
  if (
    compositionId === null ||
    summary === null ||
    compositionId === summary.root_id
  ) {
    return panelTitle;
  }
  return groupDisplayName(
    compositionId,
    summary.compositions[compositionId]?.label ?? null,
    ordinals,
    t,
  );
}
