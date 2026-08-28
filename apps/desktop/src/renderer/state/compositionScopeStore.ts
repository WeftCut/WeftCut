// Which composition the editor is looking at.
//
// The summary carries every composition (`ProjectSummary.compositions`); this
// store names the one the timeline, the inspector, the Playhead panel and the
// ruler show. It is After Effects' model: opening a Group swaps the timeline for
// the Group's own, the preview follows the open composition, and EXPORT ALWAYS
// RENDERS THE ROOT — a Group is a source, and rendering one on its own would
// produce a file no user asked for. That is why export code reads
// `rootCompositionOf(summary)` and never this store.
//
// Session state, like the playhead and the range: where you are in a work
// session, not a property of the project. A module-level store rather than App
// state because the readers sit off App's props chain (Dock Panels, imperative
// command handlers, the search palette), and because a switch has to reach the
// selection, range and playhead stores in one place.
//
// React subscribers use the ATOMIC hooks below (`feedback_zustand_composite_selector`).

import { create } from "zustand";
import type { ProjectSummary } from "../ipc";
import { seekToClamped, collapseReveal } from "./navigation";
import { playheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import { clearRange } from "./rangeStore";
import { clearLayerSelection } from "./selectionStore";

/// One step of the path entered through, root excluded: `layerId` is the Group
/// layer that was opened (null when the composition was opened by id — the e2e
/// hook, a search hit — and no reference to it was found), `compositionId` the
/// composition it opened. `crumbs.at(-1)?.compositionId` is the open one.
export interface CompositionCrumb {
  layerId: string | null;
  compositionId: string;
}

interface State {
  /// The project the scope belongs to; a different `project_id` on the next
  /// summary resets everything to that project's root.
  projectId: string | null;
  /// The open composition's id. Null only before the first summary arrives —
  /// `compositionOrRoot` treats null as "the root".
  openId: string | null;
  crumbs: readonly CompositionCrumb[];
  /// Where the playhead was when each composition was last left. A Group has
  /// its own time axis, so returning to it at the frame the user was looking at
  /// is what makes the round trip feel like one timeline per composition rather
  /// than one playhead dragged across all of them. Never persisted.
  playheads: ReadonlyMap<string, number>;
}

const INITIAL: State = {
  projectId: null,
  openId: null,
  crumbs: [],
  playheads: new Map(),
};

export const useCompositionScopeStore = create<State>(() => INITIAL);

/// The switch itself. Everything that is "where the user is in THIS timeline"
/// resets — selection, range, reveal — and the playhead is restored to where it
/// was last left in the target (0 the first time), clamped to the target's own
/// last frame in case it shrank meanwhile. `displayMode` is left alone: A/B Roll
/// vs All Tracks is a preference about how to look, not what to look at.
function switchTo(nextId: string, crumbs: readonly CompositionCrumb[]): void {
  const s = useCompositionScopeStore.getState();
  if (s.openId === nextId) {
    if (s.crumbs !== crumbs) useCompositionScopeStore.setState({ crumbs });
    return;
  }
  const playheads = new Map(s.playheads);
  if (s.openId !== null) playheads.set(s.openId, playheadTimeUs());
  useCompositionScopeStore.setState({ openId: nextId, crumbs, playheads });
  clearLayerSelection();
  clearRange();
  collapseReveal();
  seekToClamped(playheads.get(nextId) ?? 0);
}

/// The path from the root to `target` through Group layers, root excluded, or
/// null when no composition references it. Breadth-first so the shortest path
/// wins when a Group is placed more than once.
function pathFromRoot(summary: ProjectSummary, target: string): CompositionCrumb[] | null {
  const queue: Array<{ id: string; crumbs: CompositionCrumb[] }> = [{ id: summary.root_id, crumbs: [] }];
  const seen = new Set<string>([summary.root_id]);
  while (queue.length > 0) {
    const { id, crumbs } = queue.shift()!;
    const comp = summary.compositions[id];
    if (!comp) continue;
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "CompositionRef") continue;
        const child = layer.params.composition_id;
        const next = [...crumbs, { layerId: layer.id, compositionId: child }];
        if (child === target) return next;
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push({ id: child, crumbs: next });
      }
    }
  }
  return null;
}

/// Open `compositionId`. `viaLayerId` is the Group layer it was entered through
/// (a double-click, `Open group`); it becomes the next crumb. Null means "by
/// id" — the crumbs are then reconstructed from the root so the breadcrumb
/// still reads as a path. Returns false, changing nothing, for an id the
/// summary does not carry (a stale search entry, a typo in the e2e hook).
export function openComposition(compositionId: string, viaLayerId: string | null): boolean {
  const summary = useProjectStore.getState().summary;
  if (!summary || !summary.compositions[compositionId]) return false;
  const s = useCompositionScopeStore.getState();
  let crumbs: CompositionCrumb[];
  if (compositionId === summary.root_id) crumbs = [];
  else if (viaLayerId !== null) crumbs = [...s.crumbs, { layerId: viaLayerId, compositionId }];
  else crumbs = pathFromRoot(summary, compositionId) ?? [{ layerId: null, compositionId }];
  switchTo(compositionId, crumbs);
  return true;
}

/// Go back to the crumb at `index` (`-1` or anything below: the root).
export function leaveToCrumb(index: number): void {
  const summary = useProjectStore.getState().summary;
  if (!summary) return;
  const s = useCompositionScopeStore.getState();
  const kept = index < 0 ? [] : s.crumbs.slice(0, index + 1);
  const target = kept.at(-1)?.compositionId ?? summary.root_id;
  if (!summary.compositions[target]) return;
  switchTo(target, kept);
}

/// One level up — the parent the open composition was entered from.
export function leaveComposition(): void {
  leaveToCrumb(useCompositionScopeStore.getState().crumbs.length - 2);
}

/// Called by `projectStore.apply` on every summary. Two jobs: a new project
/// starts at its root with nothing remembered, and an open composition that the
/// summary no longer carries — undoing the pre-compose that created it while
/// standing inside it — falls back to the nearest surviving crumb, then the
/// root. Falling back rather than holding the dead id is what keeps every
/// consumer's "open composition" a real timeline; the crumb-first rule keeps the
/// user as close as possible to where they were.
export function reconcileCompositionScope(summary: ProjectSummary | null): void {
  if (!summary) {
    useCompositionScopeStore.setState(INITIAL);
    return;
  }
  const s = useCompositionScopeStore.getState();
  if (s.projectId !== summary.project_id) {
    useCompositionScopeStore.setState({
      projectId: summary.project_id,
      openId: summary.root_id,
      crumbs: [],
      playheads: new Map(),
    });
    return;
  }
  if (s.openId !== null && summary.compositions[s.openId]) return;
  let i = s.crumbs.length - 1;
  while (i >= 0 && !summary.compositions[s.crumbs[i]!.compositionId]) i--;
  const crumbs = s.crumbs.slice(0, i + 1);
  switchTo(i >= 0 ? crumbs[i]!.compositionId : summary.root_id, crumbs);
}

// ===== Readers ==============================================================

/// Imperative read for event-time callers (creation channels stamp the open
/// composition on their args; `undefined` when no project is loaded, which the
/// main side reads as the root).
export function openCompositionId(): string | undefined {
  return useCompositionScopeStore.getState().openId ?? undefined;
}

export const useOpenCompositionId = (): string | null =>
  useCompositionScopeStore((s) => s.openId);

export const useCrumbs = (): readonly CompositionCrumb[] =>
  useCompositionScopeStore((s) => s.crumbs);
