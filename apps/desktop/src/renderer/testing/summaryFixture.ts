// The one place renderer tests build a `ProjectSummary`.
//
// The wire shape is per-composition (`compositions[root_id]` + Groups), and
// almost every test only cares about the root's timeline. `summaryFixture`
// takes the root's fields flat under `root` and derives the project-wide counts,
// so a test states what it is about — tracks, links, a duration — and the shape
// around it is assembled here. When the wire changes again, it changes here.

import type {
  AnimTrack,
  CompositionSummary,
  HistoryView,
  LayerSummary,
  MediaSummary,
  ProjectSummary,
  RoleMixView,
} from "../ipc";

/// The root composition id every fixture uses, so a test can address
/// `summary.compositions[ROOT_ID]` without threading the id around.
export const ROOT_ID = "comp-root";

/// A composition with defaults for everything not given. 1920×1080 @ 30 fps,
/// empty timeline, 0 duration — a blank root, hence `ordinal: 0` (the value the
/// actor reserves for the root). A composition handed to `summaryFixture` as a
/// GROUP is numbered there instead; override `ordinal` to pin a specific one.
export function compositionFixture(
  over: Partial<CompositionSummary> = {},
): CompositionSummary {
  return {
    id: ROOT_ID,
    label: null,
    ordinal: 0,
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
  /// Further compositions (Groups), keyed by their own `id`. Each is numbered
  /// 1, 2, 3 … in the order given — what the actor's monotonic counter would
  /// have handed out had they been pre-composed in this order — unless it
  /// already carries a non-zero `ordinal`, which then stands.
  groups?: CompositionSummary[];
  media?: MediaSummary[];
  history?: HistoryView;
  audio_roles?: RoleMixView[];
}

export function summaryFixture(opts: SummaryFixtureOptions = {}): ProjectSummary {
  const root = compositionFixture(opts.root);
  const compositions: Record<string, CompositionSummary> = { [root.id]: root };
  let ordinal = 0;
  for (const g of opts.groups ?? []) {
    ordinal += 1;
    compositions[g.id] = g.ordinal === 0 ? { ...g, ordinal } : g;
  }
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

/// A Group layer (`CompositionRef`) with an identity transform — the shape the
/// Ungroup gate calls PLAIN. One place for the param shape, so a test that cares
/// about one field (a non-identity scale, an overhanging window) names that
/// field and nothing else.
export function groupLayerFixture({
  id = "layer-group",
  compositionId = "comp-group",
  compositionLabel = null,
  tStartUs = 0,
  tEndUs = 2_000_000,
  srcInUs = 0,
  srcOutUs = 2_000_000,
  ...over
}: {
  id?: string;
  compositionId?: string;
  compositionLabel?: string | null;
  tStartUs?: number;
  tEndUs?: number;
  srcInUs?: number;
  srcOutUs?: number;
} & Partial<Omit<LayerSummary, "params">> &
  Partial<{
    x: AnimTrack<number>;
    y: AnimTrack<number>;
    scale_x: AnimTrack<number>;
    scale_y: AnimTrack<number>;
    scale_linked: boolean;
    rotation_deg: AnimTrack<number>;
    anchor_x: AnimTrack<number>;
    anchor_y: AnimTrack<number>;
    opacity: AnimTrack<number>;
  }> = {}): LayerSummary {
  const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });
  const {
    x = num(0),
    y = num(0),
    scale_x = num(1),
    scale_y = num(1),
    scale_linked = true,
    rotation_deg = num(0),
    anchor_x = num(0.5),
    anchor_y = num(0.5),
    opacity = num(1),
    ...envelope
  } = over;
  return {
    id,
    label: null,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "CompositionRef",
    color_hint: "#8a94a0",
    enabled: true,
    locked: false,
    effects: [],
    ...envelope,
    params: {
      kind: "CompositionRef",
      composition_id: compositionId,
      composition_label: compositionLabel,
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
      x,
      y,
      scale_x,
      scale_y,
      scale_linked,
      rotation_deg,
      anchor_x,
      anchor_y,
      opacity,
    },
  };
}
