// Which composition each surface of the editor shows, and how it got there.
//
// A timeline Panel is one composition (ADR 0053), so "where the editor is
// looking" is three facts, not one. The ANCHOR is per composition: the path of
// `CompositionRef` layers a Panel was entered through, root excluded — the
// direction root-to-local is unambiguous, local-to-root is not, and the anchor
// is what resolves it. The FOCUSED composition is the one whose Panel last held
// the keyboard, and it is the editing target: the inspector, the Playhead
// Panel, the creation channels and every timeline-scoped command read it. The
// preview's RENDER TARGET is separate from both, because the workflow this
// exists for is editing one composition while watching another.
//
// EXPORT ALWAYS RENDERS THE ROOT — a Group is a source, and rendering one on
// its own would produce a file no user asked for. That is why export code reads
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
import { compositionOrRoot } from "../ipc/compositions";
import {
  closeTimelinePanel,
  openTimelinePanel,
} from "../workspace/timelinePanels";
import { collapseReveal } from "./navigation";
import { useProjectStore } from "./projectStore";
import { clearRange } from "./rangeStore";
import { clearLayerSelection } from "./selectionStore";
import {
  compositionTabIntent,
  loadViewState,
  notePreviewRenderTarget,
  publishCompositionTabs,
  resetViewState,
  type OpenTabIntent,
} from "./viewState";

/// One step of an anchor path, root excluded: `layerId` is the Group layer that
/// was entered (null when the composition was opened by id — a search hit, the
/// media pool, the e2e hook — and no reference to it was found),
/// `compositionId` the composition it opens onto. The last step's
/// `compositionId` is the anchored composition itself.
export interface CompositionCrumb {
  layerId: string | null;
  compositionId: string;
}

/// Stable empty reference, so a Panel with no anchor of its own (the root's)
/// does not re-render on every unrelated store tick.
const NO_CRUMBS: readonly CompositionCrumb[] = [];

interface State {
  /// The project these anchors belong to; a different `project_id` on the next
  /// summary resets everything to that project's root.
  projectId: string | null;
  /// `composition_id → the path it was entered through`. One entry per open
  /// timeline Panel, plus the root's, which is always anchored at the root.
  anchors: ReadonlyMap<string, readonly CompositionCrumb[]>;
  /// The composition of the timeline Panel that last held focus. Null only
  /// before the first summary arrives — `compositionOrRoot` treats null as
  /// "the root".
  focusedId: string | null;
  /// The composition the preview is LOCKED to, or null for "follow focus" —
  /// the default, and where a target the summary has lost falls back to. Not
  /// derived from the anchors: a locked target may have no timeline open at
  /// all, which is the point of it (ADR 0053 decision 3).
  previewTargetId: string | null;
  /// The local moment an ORPHAN composition's Panel is parked at. There is one
  /// playhead and it is a ROOT time (ADR 0053), so a composition with no path to
  /// the root has no reading of it at all — its Panel scrubs on an axis of its
  /// own, kept here, and those scrubs leave the film alone. A composition that
  /// IS placed never has an entry: its position is a projection, not a second
  /// number. Never persisted.
  orphanPlayheads: ReadonlyMap<string, number>;
}

const INITIAL: State = {
  projectId: null,
  anchors: new Map(),
  focusedId: null,
  previewTargetId: null,
  orphanPlayheads: new Map(),
};

export const useCompositionAnchorStore = create<State>(() => INITIAL);

/// Move the keyboard's editing target. Everything that is "where the user is in
/// THIS timeline" resets — selection, range, reveal. The PLAYHEAD does not: it
/// is one moment in root time and every Panel draws its own projection of it
/// (ADR 0053 decision 2), so activating another tab changes which timeline the
/// keyboard edits, never which frame the film is parked on. `displayMode` is
/// left alone for a nearer reason — A/B Roll vs All Tracks is a preference about
/// how to look, not about what to look at.
function focusOn(nextId: string): void {
  const s = useCompositionAnchorStore.getState();
  if (s.focusedId === nextId) return;
  useCompositionAnchorStore.setState({ focusedId: nextId });
  clearLayerSelection();
  clearRange();
  collapseReveal();
  publishIntent();
}

function setAnchor(
  compositionId: string,
  crumbs: readonly CompositionCrumb[],
): void {
  const anchors = new Map(useCompositionAnchorStore.getState().anchors);
  anchors.set(compositionId, crumbs);
  useCompositionAnchorStore.setState({ anchors });
  publishIntent();
}

/// Hand the tab intent to the `view.json` owner (`viewState.ts`): which
/// compositions have a Panel, in tab order, each with the Group clip it was
/// entered through, and which one holds the keyboard. Those two facts ARE the
/// intent, so this runs after every change to either — the owner drops a
/// publication that says nothing new, which is what makes it safe on the
/// per-frame path `syncOpenCompositions` sits on.
function publishIntent(): void {
  const summary = useProjectStore.getState().summary;
  if (!summary) return;
  const { anchors, focusedId } = useCompositionAnchorStore.getState();
  const open: OpenTabIntent[] = [];
  for (const [compositionId, crumbs] of anchors) {
    open.push({
      compositionId,
      anchorLayerId: crumbs[crumbs.length - 1]?.layerId ?? null,
    });
  }
  publishCompositionTabs(
    open,
    new Set(Object.keys(summary.compositions)),
    focusedId,
  );
}

/// The project this session has already applied the stored ACTIVE tab for. The
/// tab set is replayed as often as the Dock rebuilds its tree, and only the
/// first of those replays is the fresh session the stored focus belongs to.
let intentAppliedForProjectId: string | null = null;

/// Drop everything remembered about the project being left. Its `view.json` is
/// a different file from the incoming project's, and the owner writes to
/// whichever workspace directory is open when the write lands, so the outgoing
/// document has to be forgotten before the incoming one is read.
function forgetProjectView(): void {
  resetViewState();
  intentAppliedForProjectId = null;
}

/// The path from the root to `target` through Group layers, root excluded, or
/// null when no composition references it. Breadth-first so the shortest path
/// wins when a Group is placed more than once — the anchor a Panel opened by id
/// gets, since there is no gesture to read one off.
function pathFromRoot(
  summary: ProjectSummary,
  target: string,
): CompositionCrumb[] | null {
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

/// The anchor to give `compositionId`, entered through `viaLayerId` (a
/// double-click, `Open group`) or by id (null).
///
/// A gesture's own path wins over a search of the project: the Group layer
/// names its parent, and the parent's anchor is already the path the user
/// walked, so a composition placed twice is anchored at the placement that was
/// actually clicked rather than at whichever one the walk reaches first.
function resolveAnchor(
  summary: ProjectSummary,
  compositionId: string,
  viaLayerId: string | null,
): readonly CompositionCrumb[] {
  if (compositionId === summary.root_id) return NO_CRUMBS;
  if (viaLayerId === null) {
    return pathFromRoot(summary, compositionId) ?? [{ layerId: null, compositionId }];
  }
  const parent = useProjectStore.getState().compositionIdByLayerId.get(viaLayerId);
  const parentPath =
    parent === undefined || parent === summary.root_id
      ? NO_CRUMBS
      : anchorPath(parent) ?? pathFromRoot(summary, parent) ?? NO_CRUMBS;
  return [...parentPath, { layerId: viaLayerId, compositionId }];
}

/// Anchor + focus + Panel, the three halves of "the editor is looking at this
/// composition now". Focus lands before the Panel opens so the reset a switch
/// owes (selection, range, playhead) is done by the time the new Panel paints.
function enter(
  compositionId: string,
  crumbs: readonly CompositionCrumb[],
): void {
  setAnchor(compositionId, crumbs);
  focusOn(compositionId);
  openTimelinePanel(compositionId);
}

/// Open `compositionId` in a timeline Panel of its own: ensure the Panel
/// exists, activate it, and make it the editing target. `viaLayerId` is the
/// Group layer it was entered through; null means "by id", which takes the
/// shortest path from the root as its anchor. Returns false, changing nothing,
/// for an id the summary does not carry (a stale search entry, a typo in the
/// e2e hook).
export function openComposition(
  compositionId: string,
  viaLayerId: string | null,
): boolean {
  const summary = useProjectStore.getState().summary;
  if (!summary || !summary.compositions[compositionId]) return false;
  enter(compositionId, resolveAnchor(summary, compositionId, viaLayerId));
  return true;
}

/// Re-anchor an already open composition on a different placement of it — the
/// tab's `Switch anchor` menu. Only the anchor moves: the Panel, its scroll and
/// its selection all stand, because the composition being shown has not
/// changed, only the account of where it sits in the film. False when the layer
/// is not a Group clip pointing at `compositionId`.
export function switchAnchor(compositionId: string, viaLayerId: string): boolean {
  const summary = useProjectStore.getState().summary;
  if (!summary) return false;
  const layer = useProjectStore.getState().layerById.get(viaLayerId);
  if (layer?.params.kind !== "CompositionRef") return false;
  if (layer.params.composition_id !== compositionId) return false;
  setAnchor(compositionId, resolveAnchor(summary, compositionId, viaLayerId));
  return true;
}

/// The keyboard landed in a timeline Panel — `useFocusRegions` is the only
/// caller, and it is where a region name is narrowed (see the LANDMINE in
/// `focus/focusRegion.ts`). A Panel bound to a composition the summary no
/// longer carries is ignored: the reconcile below is what retires it.
export function focusComposition(compositionId: string): void {
  const summary = useProjectStore.getState().summary;
  if (!summary || !summary.compositions[compositionId]) return;
  if (!useCompositionAnchorStore.getState().anchors.has(compositionId)) {
    setAnchor(compositionId, resolveAnchor(summary, compositionId, null));
  }
  focusOn(compositionId);
}

/// Lock the preview to one composition, or release it with null so it follows
/// focus again. The Preview Panel's own control is the only gesture that calls
/// this; the reconcile below calls it to release a lock the project has lost.
///
/// No anchor is created for the target. A locked composition is being WATCHED,
/// not entered, and giving it one would put a path in the store that no Panel
/// walked — the projection reads `pathToComposition` instead.
export function setPreviewRenderTarget(compositionId: string | null): void {
  if (useCompositionAnchorStore.getState().previewTargetId === compositionId) return;
  useCompositionAnchorStore.setState({ previewTargetId: compositionId });
  notePreviewRenderTarget(compositionId);
}

/// Reconcile the anchors with the Panels the Dock actually holds — the Workspace
/// calls this on every layout change, so closing a tab, dragging one out and
/// undoing a Panel open all land here.
///
/// An empty list is NOT "nothing is open": the Dock reports it while the
/// baseline layout is still being built and while the timeline row is unbound,
/// and dropping the editing target then would clear a selection no gesture
/// touched.
export function syncOpenCompositions(compositionIds: readonly string[]): void {
  if (compositionIds.length === 0) return;
  const open = new Set(compositionIds);
  const s = useCompositionAnchorStore.getState();
  // An unchanged tab set must not be a store write. EVERY Dock layout change
  // arrives here, a splitter drag frame included, and the anchors feed each
  // Panel's depth tint and its tab — republishing them per frame would re-render
  // both for the length of the drag.
  const changed =
    open.size !== s.anchors.size ||
    compositionIds.some((id) => !s.anchors.has(id));
  if (changed) {
    const anchors = new Map<string, readonly CompositionCrumb[]>();
    for (const id of compositionIds) {
      anchors.set(id, s.anchors.get(id) ?? NO_CRUMBS);
    }
    useCompositionAnchorStore.setState({ anchors });
  }
  // Closing the tab you were editing in IS leaving it; the leftmost surviving
  // timeline takes over, which is where the eye goes next anyway.
  if (s.focusedId === null || !open.has(s.focusedId)) focusOn(compositionIds[0]!);
  else if (changed) publishIntent();
}

/// Called by `projectStore.apply` on every summary, and the whole of "which
/// timelines exist now". A new project starts at its root with nothing
/// remembered; otherwise the open tabs are re-derived as the stored intent
/// intersected with the compositions this summary carries, so a Group that was
/// undone away loses its Panel and one that came back gets it again.
///
/// A dead FOCUSED composition falls back to the nearest surviving step of its
/// own anchor, then the root; falling back rather than holding the dead id is
/// what keeps every consumer's "focused composition" a real timeline, and the
/// anchor-first rule keeps the user as close as possible to where they were.
export function reconcileCompositionAnchors(summary: ProjectSummary | null): void {
  if (!summary) {
    useCompositionAnchorStore.setState(INITIAL);
    forgetProjectView();
    return;
  }
  const s = useCompositionAnchorStore.getState();
  if (s.projectId !== summary.project_id) {
    forgetProjectView();
    useCompositionAnchorStore.setState({
      projectId: summary.project_id,
      anchors: new Map([[summary.root_id, NO_CRUMBS]]),
      focusedId: summary.root_id,
      previewTargetId: null,
      orphanPlayheads: new Map(),
    });
    return;
  }
  const anchors = new Map(s.anchors);
  let changed = false;
  for (const id of s.anchors.keys()) {
    if (summary.compositions[id]) continue;
    anchors.delete(id);
    closeTimelinePanel(id);
    changed = true;
  }
  // A lock on a composition the project no longer carries releases back to
  // following focus. There is nothing left to name, and holding the dead id
  // would leave the preview showing whatever it last drew.
  if (s.previewTargetId !== null && !summary.compositions[s.previewTargetId]) {
    setPreviewRenderTarget(null);
  }
  // Open tabs are DERIVED: the intent `view.json` holds, intersected with the
  // compositions this summary carries (ADR 0053). The loop above is one half of
  // that intersection — undoing the pre-compose that made a Group retires its
  // Panel and LEAVES its intent entry — and this is the other: the redo puts
  // the same uuid back in the summary, so the tab returns with the zoom, scroll
  // and anchor still recorded against it.
  const reopened: string[] = [];
  for (const tab of compositionTabIntent()) {
    const id = tab.composition_id;
    if (id === summary.root_id || anchors.has(id)) continue;
    if (!summary.compositions[id]) continue;
    anchors.set(id, resolveAnchor(summary, id, tab.anchor_layer_id));
    reopened.push(id);
    changed = true;
  }
  if (changed) useCompositionAnchorStore.setState({ anchors });
  for (const id of reopened) openTimelinePanel(id);
  if (s.focusedId !== null && summary.compositions[s.focusedId]) {
    if (changed) publishIntent();
    return;
  }
  const dead = s.anchors.get(s.focusedId ?? "") ?? NO_CRUMBS;
  let i = dead.length - 1;
  while (i >= 0 && !summary.compositions[dead[i]!.compositionId]) i--;
  enter(
    i >= 0 ? dead[i]!.compositionId : summary.root_id,
    i >= 0 ? dead.slice(0, i + 1) : NO_CRUMBS,
  );
}

/// Bring this project's remembered tabs back: read `view.json`, open a Panel
/// for every entry the summary still carries, and hand the keyboard to the one
/// that had it.
///
/// Idempotent, and it has to be. A layout snapshot names one folded `timeline`
/// slot — no composition uuid may enter the app-level document (ADR 0053) — so
/// every Dock rebuild, a Workspace restore or a profile switch included, comes
/// back holding the root's timeline alone. This runs after each of those and
/// re-adds only what is missing, which is the unfold that pairs with the fold
/// on serialize.
export async function restoreCompositionTabs(): Promise<void> {
  const opening = useProjectStore.getState().summary;
  if (!opening) return;
  const projectId = opening.project_id;
  const state = await loadViewState();
  const summary = useProjectStore.getState().summary;
  if (!summary || summary.project_id !== projectId) return;
  // Snapshotted: opening a Panel republishes the intent, which replaces the
  // array this is walking.
  for (const tab of [...compositionTabIntent()]) {
    const id = tab.composition_id;
    if (id === summary.root_id || !summary.compositions[id]) continue;
    if (useCompositionAnchorStore.getState().anchors.has(id)) continue;
    setAnchor(id, resolveAnchor(summary, id, tab.anchor_layer_id));
    openTimelinePanel(id);
  }
  // The stored focus and the stored preview lock are a fresh session's opening
  // position, not something to re-apply on a later geometry restore: `state` is
  // the document as it was READ, so replaying it would undo whatever the user
  // has changed since.
  if (intentAppliedForProjectId === projectId) return;
  intentAppliedForProjectId = projectId;
  const active = state.active_composition_id;
  if (active !== null && summary.compositions[active]) focusOn(active);
  const target = state.preview_render_target_id;
  if (target !== null && summary.compositions[target]) setPreviewRenderTarget(target);
}

// ===== Readers ==============================================================

/// Imperative read for event-time callers (creation channels stamp the focused
/// composition on their args; `undefined` when no project is loaded, which the
/// main side reads as the root).
export function focusedCompositionId(): string | undefined {
  return useCompositionAnchorStore.getState().focusedId ?? undefined;
}

/// The path `compositionId` was entered through, or null when it has none —
/// nothing has opened it, so nothing has decided where it sits.
export function anchorPath(
  compositionId: string,
): readonly CompositionCrumb[] | null {
  return useCompositionAnchorStore.getState().anchors.get(compositionId) ?? null;
}

/// Where `compositionId` sits, for a surface that has no Panel to read an
/// anchor from: the anchor when a Panel already holds one, so the preview and
/// that Panel agree about which placement is being watched, and the shortest
/// path from the root otherwise. Null for a composition the root does not reach
/// — an orphan, which has no root time at all.
///
/// The preview's render target is the caller: it may name a composition with no
/// timeline open at all (ADR 0053 decision 3).
export function pathToComposition(
  compositionId: string,
): readonly CompositionCrumb[] | null {
  const summary = useProjectStore.getState().summary;
  if (!summary) return null;
  if (compositionId === summary.root_id) return NO_CRUMBS;
  return anchorPath(compositionId) ?? searchPathFromRoot(summary, compositionId);
}

/// One-entry memo over `pathFromRoot`, keyed on the summary's IDENTITY so any
/// project change invalidates it. The preview asks this question on every
/// engine emit while it is locked to a composition no Panel has anchored, and
/// the search is a walk of the whole reference graph that allocates a crumb
/// array per Group clip it passes — per-frame work `playheadStore.ts`'s tiers
/// do not allow.
let pathSearchMemo: {
  summary: ProjectSummary;
  compositionId: string;
  path: CompositionCrumb[] | null;
} | null = null;

function searchPathFromRoot(
  summary: ProjectSummary,
  compositionId: string,
): CompositionCrumb[] | null {
  if (
    pathSearchMemo !== null &&
    pathSearchMemo.summary === summary &&
    pathSearchMemo.compositionId === compositionId
  ) {
    return pathSearchMemo.path;
  }
  const path = pathFromRoot(summary, compositionId);
  pathSearchMemo = { summary, compositionId, path };
  return path;
}

/// The composition the preview DRAWS: the locked one while the project still
/// carries it, and the editing target otherwise. Every surface that describes
/// what is on the canvas — its size, its clock, its transport — reads this, and
/// nothing else resolves the pair on its own.
export function previewRenderTargetId(): string | null {
  const { summary } = useProjectStore.getState();
  const { previewTargetId, focusedId } = useCompositionAnchorStore.getState();
  if (previewTargetId !== null && summary?.compositions[previewTargetId]) {
    return previewTargetId;
  }
  return compositionOrRoot(summary, focusedId)?.id ?? null;
}

/// Where an ORPHAN composition's Panel is parked, on its own clock. 0 until it
/// is scrubbed — an axis nothing places has no other opening position.
export function orphanPlayheadUs(compositionId: string): number {
  return useCompositionAnchorStore.getState().orphanPlayheads.get(compositionId) ?? 0;
}

/// Park an orphan's Panel. Only `state/playheadProjection.ts` calls this, and
/// only after it has established that the composition has no root time —
/// writing here for a placed composition would be the second playhead ADR 0053
/// refuses.
export function setOrphanPlayheadUs(compositionId: string, localUs: number): void {
  const s = useCompositionAnchorStore.getState();
  if (s.orphanPlayheads.get(compositionId) === localUs) return;
  const orphanPlayheads = new Map(s.orphanPlayheads);
  orphanPlayheads.set(compositionId, localUs);
  useCompositionAnchorStore.setState({ orphanPlayheads });
}

/// Whether placing `compositionId` in the FOCUSED composition would make it
/// contain itself. Every step of that Panel's anchor names a composition the
/// focused one sits inside, so a composition on that path — or the focused one
/// itself — is exactly the set the pool's drag has to refuse, and the root
/// (never a pool row) is never on it.
///
/// The commit refuses the same placement anyway (`CompositionCycle`, over the
/// whole reference graph), which is what catches a loop that closes off this
/// path. This is the half that refuses it BEFORE release, because a gesture the
/// user has already completed is the wrong place to learn it was impossible.
export function wouldCycleInOpenComposition(compositionId: string): boolean {
  const { focusedId } = useCompositionAnchorStore.getState();
  if (focusedId === compositionId) return true;
  return (anchorPath(focusedId ?? "") ?? NO_CRUMBS).some(
    (c) => c.compositionId === compositionId,
  );
}

/// Every placement of `compositionId` in the project — one entry per Group clip
/// pointing at it, each with the anchor that placement would give and where it
/// starts in ROOT time. The tab's `Switch anchor` menu is the only caller, and
/// it offers the list only when there is more than one.
export interface CompositionPlacement {
  /// The Group layer this placement is.
  layerId: string;
  crumbs: readonly CompositionCrumb[];
  /// Where the placement's own start sits on the root's clock.
  rootStartUs: number;
}

export function compositionPlacements(
  summary: ProjectSummary,
  compositionId: string,
): CompositionPlacement[] {
  const out: CompositionPlacement[] = [];
  const walk = (
    hostId: string,
    crumbs: readonly CompositionCrumb[],
    offsetUs: number,
    seen: ReadonlySet<string>,
  ): void => {
    const host = summary.compositions[hostId];
    if (!host) return;
    for (const track of host.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "CompositionRef") continue;
        const child = layer.params.composition_id;
        const next = [...crumbs, { layerId: layer.id, compositionId: child }];
        const rootStartUs = offsetUs + layer.t_start_us;
        if (child === compositionId) {
          out.push({ layerId: layer.id, crumbs: next, rootStartUs });
        }
        if (seen.has(child)) continue;
        // A composition's own `t = 0` in root time — `childFrame`'s offset,
        // which is where a nested placement's start has to be measured from.
        walk(child, next, rootStartUs - layer.params.src_in_us, new Set(seen).add(child));
      }
    }
  };
  walk(summary.root_id, NO_CRUMBS, 0, new Set([summary.root_id]));
  return out;
}

export const useFocusedCompositionId = (): string | null =>
  useCompositionAnchorStore((s) => s.focusedId);

/// The anchor path of one composition, for React. Empty for the root and for a
/// composition nothing has opened.
export const useAnchorPath = (
  compositionId: string | null,
): readonly CompositionCrumb[] =>
  useCompositionAnchorStore(
    (s) => (compositionId === null ? undefined : s.anchors.get(compositionId)) ?? NO_CRUMBS,
  );

/// What the preview's control SHOWS: the locked composition, or null for
/// "follow focus". The raw choice, not the resolved target — the control has to
/// be able to say that it is following.
export const usePreviewTargetChoice = (): string | null =>
  useCompositionAnchorStore((s) => s.previewTargetId);

/// The composition the preview draws, for React — `previewRenderTargetId` with
/// a subscription. Three ATOMIC selectors rather than one composite: each
/// yields a primitive, so an unrelated tick in either store bails out instead
/// of re-rendering the canvas host.
export const usePreviewRenderTargetId = (): string | null => {
  const previewTargetId = useCompositionAnchorStore((s) => s.previewTargetId);
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    previewTargetId !== null && s.summary?.compositions[previewTargetId]
      ? previewTargetId
      : (compositionOrRoot(s.summary, focusedId)?.id ?? null),
  );
};
