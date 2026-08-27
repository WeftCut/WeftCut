// Pure accessors over the per-composition wire shape. No store, no bridge —
// the export Worker imports these too.

import type { CompositionSummary, ProjectSummary } from "./index";

/// `summary.compositions[id]`, falling back to the root when `id` is null or
/// names a composition the summary no longer carries. The scope store may point
/// at a missing id for the span of one `apply` (it falls back on the same tick
/// — see `reconcileCompositionScope`); a consumer rendering in that gap gets a
/// real timeline rather than undefined. Null only when there is no project. The
/// result is a sub-object of the summary, so its reference is stable between
/// summaries when nothing changed.
export function compositionOrRoot(
  summary: ProjectSummary | null,
  id: string | null,
): CompositionSummary | null {
  if (!summary) return null;
  return (
    (id !== null ? summary.compositions[id] : undefined) ??
    summary.compositions[summary.root_id] ??
    null
  );
}

/// The root — what export renders, whatever composition is open
/// (`state/compositionScopeStore.ts` says why). Throws rather than returning a
/// fallback: a summary without its root is a main-side bug, and the callers are
/// explicit actions (export) whose error surfaces as such.
export function rootCompositionOf(summary: ProjectSummary): CompositionSummary {
  const root = summary.compositions[summary.root_id];
  if (!root) {
    throw new Error(`project summary carries no root composition ${summary.root_id}`);
  }
  return root;
}

/// The "no project" composition: nothing to draw, nothing to walk. Lets a
/// consumer that would otherwise guard every read hold a composition that is
/// never null — loops over its tracks are simply empty.
export const EMPTY_COMPOSITION: CompositionSummary = Object.freeze({
  id: "",
  label: null,
  width: 1920,
  height: 1080,
  fps_num: 30,
  fps_den: 1,
  duration_us: 0,
  duration_pinned: false,
  fps_locked: false,
  tracks: [],
  markers: [],
  transitions: [],
  links: [],
}) as CompositionSummary;
