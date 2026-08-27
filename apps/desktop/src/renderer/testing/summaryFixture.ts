// The one place renderer tests build a `ProjectSummary`.
//
// The wire shape is per-composition (`compositions[root_id]` + Groups), and
// almost every test only cares about the root's timeline. `summaryFixture`
// takes the root's fields flat under `root` and derives the project-wide counts,
// so a test states what it is about — tracks, links, a duration — and the shape
// around it is assembled here. When the wire changes again, it changes here.

import type {
  CompositionSummary,
  HistoryView,
  MediaSummary,
  ProjectSummary,
  RoleMixView,
} from "../ipc";

/// The root composition id every fixture uses, so a test can address
/// `summary.compositions[ROOT_ID]` without threading the id around.
export const ROOT_ID = "comp-root";

/// A composition with defaults for everything not given. 1920×1080 @ 30 fps,
/// empty timeline, 0 duration — a blank root.
export function compositionFixture(
  over: Partial<CompositionSummary> = {},
): CompositionSummary {
  return {
    id: ROOT_ID,
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
    ...over,
  };
}

export interface SummaryFixtureOptions {
  project_id?: string;
  name?: string;
  /// Fields of the ROOT composition; its id is `ROOT_ID` unless overridden.
  root?: Partial<CompositionSummary>;
  /// Further compositions (Groups), keyed by their own `id`.
  groups?: CompositionSummary[];
  media?: MediaSummary[];
  history?: HistoryView;
  audio_roles?: RoleMixView[];
}

export function summaryFixture(opts: SummaryFixtureOptions = {}): ProjectSummary {
  const root = compositionFixture(opts.root);
  const compositions: Record<string, CompositionSummary> = { [root.id]: root };
  for (const g of opts.groups ?? []) compositions[g.id] = g;
  const all = Object.values(compositions);
  return {
    project_id: opts.project_id ?? "project-1",
    name: opts.name ?? "fixture",
    root_id: root.id,
    compositions,
    track_count: all.reduce((n, c) => n + c.tracks.length, 0),
    layer_count: all.reduce(
      (n, c) => n + c.tracks.reduce((m, t) => m + t.layers.length, 0),
      0,
    ),
    history: opts.history ?? { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: opts.media ?? [],
    audio_roles: opts.audio_roles ?? [],
  };
}

/// The root entry of a fixture summary — for tests that mutate the timeline
/// in place (`rootOf(summary).tracks[0]!.layers[1]!.t_end_us = …`).
export function rootOf(summary: ProjectSummary): CompositionSummary {
  const root = summary.compositions[summary.root_id];
  if (!root) throw new Error("fixture summary has no root composition");
  return root;
}
