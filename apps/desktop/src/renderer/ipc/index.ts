// Renderer-side IPC surface: typed `invoke` wrappers plus the wire shapes the
// renderer reads back. It owns no state and no persistence.
//
// Re-export convention: types shared with main are single-sourced under
// `src/shared/` (main owns persistence, the renderer consumes) and re-exported
// from here, so every call site can import them from "../ipc". `@/` only
// aliases src/renderer, hence the relative paths to `../../shared/`.

import { invoke } from "@/bridge/ipc";

import type { ExportSettings } from "../render/exportSettings";
import type { MotifManifest } from "../render/motifs/catalog";
import type { DecodeRoute } from "../render/decodeRoute";
import type { RecentEntry } from "../../shared/recents";
export type { RecentEntry } from "../../shared/recents";
import type { Interpolation } from "../../shared/easing";

/// One composition's timeline — the root and every Group share this shape
/// (ADR 0052 §3). Mirrors main/state/summary.ts `CompositionSummary`.
export interface CompositionSummary {
  id: string;
  /// The composition's own label; null on the root and on an unnamed Group
  /// (the UI derives "Group N").
  label: string | null;
  /// The stored number behind the derived "Group N" — assigned at creation from
  /// a monotonic project counter and never rewritten, so naming one Group
  /// renumbers no other and clearing a label restores the original number.
  /// Present on every composition, labelled or not; `0` on the root, which is
  /// never shown as a Group. `lib/layerName.ts` reads it.
  ordinal: number;
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  /// Composition length as an EXCLUSIVE boundary; timeline interval is
  /// `[0, duration_us)`. NOT a frame anchor — see `t_end_us` on
  /// `LayerSummary` for the long version. The playhead's upper bound
  /// is `lastFrameAnchorUs(duration_us, fpsNum, fpsDen)`.
  duration_us: number;
  /// True when the user has explicitly set the composition duration via
  /// `set_composition { duration_us }`. While pinned, layer edits no
  /// longer mutate `duration_us` (except the `>= max(layer.t_end_us)`
  /// overflow guard). `fit_composition_to_layers` clears it.
  duration_pinned: boolean;
  /// True when `set_composition { fps }` would be rejected — the timeline holds
  /// a layer, or some history snapshot / checkpoint does (an unrecorded rate
  /// change lands in all of them, so undo would otherwise resurrect layers
  /// quantized to the old grid). The rate becomes settable again only on a
  /// project whose history has never held a layer, i.e. after emptying the
  /// timeline and reopening the project. History-scoped, so project-wide: the
  /// same value on every composition.
  fps_locked: boolean;
  tracks: TrackSummary[];
  markers: MarkerSummary[];
  /// Transitions between same-track visual layers, composited by the
  /// renderer's two-input transition node.
  transitions: TransitionSummary[];
  /// `docs/features.md#links`. Empty when no links exist. UI uses this to
  /// render the tinted-border indicator and to resolve "what link is
  /// this layer in?" for click-selects-whole-link behavior. A link's members
  /// all live in THIS composition.
  links: LinkSummary[];
}

export interface HistoryView {
  cursor: number;
  len: number;
  can_undo: boolean;
  can_redo: boolean;
  /// `Some(reason)` while the agent holds the revert lock. Editor-mode
  /// disables Undo/Redo with this as tooltip; agent-mode shows a badge.
  lock_reason?: string | null;
}

// ── The FULL history view (`project_history_view`) ──────────────────────────
// Mirrors main/state/history.ts's `HistoryView` / `HistoryEntrySummary` /
// `EntityLabel` — the rows AND the checkpoints, everything the history panel
// draws.
//
// Deliberately NOT named `HistoryView`: that name is taken above by the
// summary-level shape (cursor / len / can_undo / can_redo / lock_reason) that
// rides `ProjectSummary.history` and carries no rows at all. Two different
// shapes serving two different surfaces off two different channels — the
// `HistoryStack*` prefix here is what keeps a call site from importing one and
// expecting the other.

export type HistoryActor = { kind: "User" } | { kind: "Agent"; client: string };

/// The entities an entry touched. Three variants, matching main's `EntityRef`.
export type HistoryEntityRef =
  | { kind: "Track"; id: string }
  | { kind: "Layer"; id: string }
  | { kind: "Marker"; id: string };

/// A name for one `affected` ref. `text` is a stored entity name; the other arm
/// is a DERIVED name — a clip's kind or a track's role/position — which only the
/// UI can translate (`t(l.label_key, l.label_args ?? {})`).
export type HistoryEntityLabel =
  | { text: string }
  | { label_key: string; label_args?: Record<string, string | number> };

export interface HistoryStackEntry {
  op_id: string;
  actor: HistoryActor;
  timestamp: string;
  /// The English phrase main recorded. Kept verbatim for the MCP contract; the
  /// panel renders `label_key` instead.
  summary: string;
  /// i18n key for `summary` (`history.*`), recorded next to it at commit time.
  label_key: string;
  /// Interpolation values for `label_key`; absent for the phrases taking none.
  label_args?: Record<string, string | number>;
  affected: HistoryEntityRef[];
  /// Names for `affected` — PARALLEL to it (same length, same order), resolved
  /// in main against the stored snapshot that still holds each ref.
  entity_labels: HistoryEntityLabel[];
}

export interface HistoryCheckpointSummary {
  id: string;
  label: string;
  actor: HistoryActor;
  created_at: string;
}

export interface HistoryStackView {
  ops: HistoryStackEntry[];
  /// ABSOLUTE stack index of the entry whose state is current — stated in the
  /// same space as `jumpTo`, NOT as an offset into `ops`.
  cursor: number;
  len: number;
  /// Absolute stack index of `ops[0]` (= `len - ops.length`). `ops` is the last
  /// N entries, so `ops[i]`'s absolute index is `window_start + i` — the only
  /// index `projectJumpTo` accepts, and the one `cursor` is stated in. Today's
  /// panel read asks for the whole cap and so always sees 0; deriving indices
  /// from it anyway is what keeps that an optimisation rather than a load-bearing
  /// assumption.
  window_start: number;
  checkpoints: HistoryCheckpointSummary[];
  /// Entries dropped off the FRONT of the stack since it was seeded. Non-zero
  /// means the top row is NOT the start of the project — eviction does not spare
  /// the `Initial` entry, so nothing else on the wire says so.
  evicted: number;
  /// Set while an agent holds the revert lock; jump / undo / redo / restore all
  /// reject with `HistoryLocked` until it clears.
  lock_reason?: string;
}

export interface MediaSummary {
  id: string;
  label: string;
  path: string;
  kind: string;
  duration_us: number | null;
  /// Earliest container PTS that maps to source content time 0, when known.
  start_pts_us?: number | null;
  /// Raw ffprobe duration before subtracting any start offset, for diagnostics.
  container_duration_us?: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  /// False when path_abs doesn't resolve to a real file. UI surfaces a
  /// "missing source" badge; project still opens; layers referencing the
  /// missing item render placeholders.
  available: boolean;
  /// Where preview/export decode from + proxy readiness. See decodeRoute.ts.
  decode_route: DecodeRoute;
  /// Source video codec ("h264"/"hevc"/"prores"/…), null for audio/image.
  codec: string | null;
  /// Source pixel format ("yuv420p"/"yuv420p10le"/…), null for audio/image.
  pix_fmt: string | null;
  /// ffprobe color tags (color_space/range/primaries/transfer) surfaced from the
  /// source bitstream + container. Used to decode the ORIGINAL with its real
  /// matrix/range on DirectExport (see `ffprobeColorToWebCodecs`). Optional:
  /// older summaries / test fixtures omit them; the resolution default fills in.
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
  video_start_pts_us?: number | null;
  audio_start_pts_us?: number | null;
  /// Absolute path of the canonical conformed PCM (VCONF, `jobs/conform.rs`)
  /// once the conform job has produced it. The preview mixer Range-reads
  /// this file; `null` means the audio layer is not yet playable. Optional:
  /// older summaries / test fixtures omit it.
  conform_path?: string | null;
  /// Probed source channel count, null/absent when the media has no audio
  /// stream or hasn't been probed yet. The waveform generator always
  /// downmixes to stereo for storage, so this is the only reliable
  /// mono/stereo signal — see TimelineWaveform's `mediaChannels` prop.
  audio_channels?: number | null;
}

/// One effect in a layer's effect chain. `kind` is the join key into the
/// TS effect catalog (`effectRegistry.ts`); Rust does not validate it.
/// `params` mirrors `BTreeMap<String, Animated<f64>>` — each value is a
/// raw `AnimTrack<number>` resolved per-frame by the renderer, exactly
/// like animated fields on `VideoClipView`.
export interface EffectView {
  id: string;
  kind: string;
  enabled: boolean;
  params: Record<string, AnimTrack<number>>;
}

/// Partial update for an effect — mirrors Rust `EffectPatch`. The UI uses only
/// `enabled` through this path; param edits (incl. keyframes) go through
/// `updateLayerParamTrack` with key `effects[<id>].params[<key>]`.
export interface EffectPatch {
  enabled?: boolean;
  params?: Record<string, AnimTrack<number>>;
}

export interface LayerSummary {
  id: string;
  label: string | null;
  /// Inclusive start of the layer's display interval, in composition µs.
  /// Snapped to the comp-frame grid by the actor on every mutation.
  t_start_us: number;
  /// EXCLUSIVE end of the layer's display interval, in composition µs.
  /// The half-open interval is `[t_start_us, t_end_us)` — the layer is
  /// active at composition time `t` iff `t_start_us ≤ t < t_end_us`.
  ///
  /// This is a *boundary*, NOT a frame anchor. For a layer covering the
  /// entire 10 s 30 fps comp, `t_end_us = 10_000_000` (the boundary
  /// after frame 299, not frame 299's own anchor at 9_966_667). The
  /// playhead, which IS a frame anchor, can never reach `t_end_us` —
  /// its upper bound is `lastFrameAnchorUs` in `frames.ts`. See
  /// `docs/data-model.md` for the boundary-vs-anchor distinction.
  t_end_us: number;
  kind: string;
  color_hint: string;
  enabled: boolean;
  locked: boolean;
  params: LayerParamsView;
  /// Ordered effect chain for this layer. Each entry is resolved per-frame
  /// by the renderer using `params` as raw `AnimTrack<number>` tracks.
  /// Empty when no effects are applied.
  effects: EffectView[];
}

export type LayerParamsView =
  | ({ kind: "VideoClip" } & VideoClipView)
  | ({ kind: "ImageOverlay" } & ImageOverlayView)
  | ({ kind: "Text" } & TextView)
  | ({ kind: "Color" } & ColorView)
  | ({ kind: "Audio" } & AudioView)
  | ({ kind: "Motif" } & MotifView)
  | ({ kind: "CompositionRef" } & CompositionRefView);

/// A Group layer: its source is another composition (ADR 0052 §4) — the entry
/// `ProjectSummary.compositions[composition_id]`. Drawn by one `CompositionNode`
/// per placement, into a texture (`render/sprite/CompositionRefSprite.ts`).
export interface CompositionRefView {
  composition_id: string;
  /// The referenced composition's own label; null → derive "Group N".
  composition_label: string | null;
  /// Window into the referenced composition's time. No upper bound is
  /// enforced: `src_out_us` may overhang its duration (ADR 0052 §6).
  src_in_us: number;
  src_out_us: number;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  scale_linked: boolean;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
  anchor_x: AnimTrack<number>;
  anchor_y: AnimTrack<number>;
}

export interface MotifView {
  motif_id: string;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  /// Uniform-scale intent: true ⇒ scale_x/scale_y are structural twins and the
  /// UI edits them as one collapsed "Scale" (twin invariant lives main-side in
  /// mutations/scaleLink.ts; any divergent write clears this in the same commit).
  scale_linked: boolean;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
  /// Transform pivot — see `VideoClipView.anchor_x`.
  anchor_x: AnimTrack<number>;
  anchor_y: AnimTrack<number>;
  /// Window offset (µs) into the Motif's intrinsic content. Width = layer
  /// width; src_out is derived. 0 = content frame 0.
  src_in_us: number;
  /// User-set props for this Motif instance, validated against the Motif
  /// manifest's `props_schema`. Passed to the Motif's `motif.define({ setup,
  /// frame })` lifecycle when the capture host renders it (see `docs/motifs.md`).
  props: Record<string, unknown>;
}

export interface VideoClipView {
  media_id: string;
  media_label: string;
  src_in_us: number;
  src_out_us: number;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  scale_linked: boolean;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
  /// Transform pivot in normalized layer coordinates — what rotation and flip
  /// turn around. LANDMINE: for media kinds `x`/`y` stay the UNROTATED
  /// top-left, NOT the anchor point (a Text layer's `x`/`y` IS its anchor
  /// point, because measured text bounds move with the content). The
  /// compensation that keeps both true lives in `render/anchorPivot.ts`.
  ///
  /// Animatable like the rest of the transform, so every consumer must resolve
  /// it at the layer-local time — `resolveView.ts` is that one point, and
  /// `DEFAULT_ANCHOR` (anchorPivot.ts) is the one fallback.
  anchor_x: AnimTrack<number>;
  anchor_y: AnimTrack<number>;
  speed: number;
  flip_h: boolean;
  flip_v: boolean;
  fade_in_us: number;
  fade_out_us: number;
}

export interface ImageOverlayView {
  media_id: string;
  media_label: string;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  scale_linked: boolean;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
  /// Transform pivot — see `VideoClipView.anchor_x`.
  anchor_x: AnimTrack<number>;
  anchor_y: AnimTrack<number>;
  fade_in_us: number;
  fade_out_us: number;
}

export interface TextView {
  content: string;
  font_family: string;
  font_size_px: number;
  weight: number;
  italic: boolean;
  align: "Left" | "Center" | "Right";
  /// Transform pivot — see `VideoClipView.anchor_x`. For Text this IS the Pixi
  /// anchor (the content hangs off `x`/`y`), so animating it slides the glyphs.
  anchor_x: AnimTrack<number>;
  anchor_y: AnimTrack<number>;
  color: AnimTrack<Rgba>;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  scale_linked: boolean;
  rotation_deg: AnimTrack<number>;
  opacity: AnimTrack<number>;
  outline: { color: Rgba; width: number } | null;
  shadow: { color: Rgba; offset_x: number; offset_y: number; blur: number } | null;
  /// Layout box in composition px, LOCAL (pre-`scale`). Which fields are set IS
  /// the resize mode: (null, null) auto width, (set, null) auto height, (set,
  /// set) fixed. Plain scalars, never `AnimTrack` — a keyframed box would
  /// re-measure and rebuild the glyph atlas every frame (ADR 0049).
  box_w: number | null;
  box_h: number | null;
  /// The text block's placement INSIDE the box — orthogonal to `anchor_y`,
  /// which places the box against `x`/`y`.
  valign: "Top" | "Middle" | "Bottom";
  /// Line leading; 0 = auto (the font's own metrics).
  line_height: number;
  letter_spacing: number;
}

export interface ColorView {
  color: AnimTrack<Rgba>;
  width: number;
  height: number;
}

export interface AudioView {
  media_id: string;
  media_label: string;
  src_in_us: number;
  src_out_us: number;
  gain_db: AnimTrack<number>;
  pan: AnimTrack<number>;
  fade_in_us: number;
  fade_out_us: number;
  mute: boolean;
  role: AudioRole;
}

/// Audio role stamp (`docs/audio.md`). Serialized from the Rust role enum as
/// kebab-case. Every audio layer carries exactly one; the four canonical roles
/// also back the project-level role mixer (`ProjectSummary.audio_roles`).
export type AudioRole = "dialogue" | "music" | "sfx" | "voiceover";

/// Canonical role order — the order `ProjectSummary.audio_roles` is built in
/// (`src/main/state/summary.ts`), so a role mixer can render rows index-aligned
/// with it.
export const AUDIO_ROLES: AudioRole[] = ["dialogue", "music", "sfx", "voiceover"];

export interface RoleMixView {
  role: AudioRole;
  gain_db: number;
  muted: boolean;
  solo: boolean;
}

/// A/B-roll role stamp (`docs/data-model.md`). Serialized from the Rust
/// `TrackRole` enum as kebab-case. Null for additional / legacy tracks.
/// Roles: a-roll, b-roll, audio-a, audio-b, caption.
export type TrackRole = "a-roll" | "b-roll" | "audio-a" | "audio-b" | "caption";

export interface TrackSummary {
  id: string;
  /// Tracks are kind-agnostic on the backend; this is a derived "dominant
  /// layer class" label (Video / Audio / Subtitle) that the timeline CSS and
  /// the drag-drop checks read.
  kind: string;
  label: string | null;
  enabled: boolean;
  locked: boolean;
  /// Track-level audio mute — audio layers silent, video unaffected.
  muted: boolean;
  /// Track-level solo — when any track is soloed, only soloed tracks
  /// are audible (mute wins over solo).
  solo: boolean;
  /// `null` for tracks created after the reserved 4 (additional video, music,
  /// SFX, captions, voiceover, etc.) and for legacy projects. AB display mode
  /// hides any track where `role === null`; All Tracks ignores the field.
  role: TrackRole | null;
  /// True for every track outside the reserved skeleton, which is exactly
  /// the set cleanup may remove: an unlocked one disappears the moment its
  /// last layer leaves it (ADR 0042). Equivalent to `role === null` — a track
  /// carrying a role is never a cleanup candidate.
  transient: boolean;
  layers: LayerSummary[];
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  /// `compositions[root_id]` is what export renders and what a fresh session's
  /// timeline Panel opens on (`state/compositionAnchorStore.ts`).
  root_id: string;
  compositions: Record<string, CompositionSummary>;
  /// Counted over EVERY composition, not the focused one.
  track_count: number;
  layer_count: number;
  history: HistoryView;
  media: MediaSummary[];
  /// `docs/audio.md`. Always exactly 4 entries in canonical role order
  /// (dialogue, music, sfx, voiceover) — the project-level role mixer.
  audio_roles: RoleMixView[];
}

export interface LinkSummary {
  id: string;
  label: string | null;
  layer_ids: string[];
}

/// Wire mirror of the Rust `Interpolation` enum, single-sourced with main
/// under src/shared (the canonical preset table lives beside it).
export type { EaseDir, Interpolation } from "../../shared/easing";

export interface Keyframe<T> {
  id: string;
  t_us: number;
  value: T;
  interp: Interpolation;
}

/// Wire-compatible mirror of the Rust `Animated<T>` enum
/// (`#[serde(tag = "mode", content = "value")]`).
export type AnimTrack<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[] };

/// Static read of a track — the editing-surface view of "the value"
/// (Static → value; Keyframed → first keyframe, else fallback).
/// UI panels read through this; the RENDER path must use
/// `render/animated.ts`'s time-aware `resolveAnimated` instead.
export function trackStatic<T>(track: AnimTrack<T>, fallback: T): T {
  if (track.mode === "Static") return track.value;
  return track.value.length > 0 ? track.value[0]!.value : fallback;
}
export interface MarkerSummary {
  id: string;
  t_us: number;
  end_t_us: number | null;
  /// The short name — marker lane text and the `Ctrl+K` result row.
  label: string;
  /// The long text; the marker Panel's field and nothing else's.
  note: string;
  color_hint: string;
  /// The layer this marker follows, or null when it is FREE. An id, not a
  /// nested layer view — `tracks` already carries the layer.
  anchor_layer: string | null;
  /// The instant the anchor names in that layer's SOURCE domain, null when the
  /// marker is FREE. The marker Panel's hibernating section shows it, because a
  /// hibernating marker's frozen `t_us` names a moment nothing holds any more
  /// and this is the only position it has left. Unrecoverable in the renderer —
  /// the window `t_us` was derived through has moved.
  anchor_src_us: number | null;
  /// Anchored at source material its layer no longer shows, so it is kept but
  /// not painted. Always false for a free marker. Derived per projection
  /// (`markerHibernating` in main/state/summary.ts), never stored.
  hibernating: boolean;
}

/// The tie a marker carries, as the marker channels take it: a layer of the
/// marker's own composition plus an instant in that layer's SOURCE domain.
/// Mirrors main/state/model.ts `MarkerAnchor`, field names included — it is an
/// argument travelling INTO the actor, not a projection coming back, so it
/// keeps the model's spelling rather than `MarkerSummary`'s flattened
/// `anchor_layer`.
export interface MarkerAnchorArg {
  layer: string;
  src_us: number;
}

/// Motion direction, not reveal side — glossary semantics live with the
/// serde twin (`native/src/state/transition.rs`).
export type TransitionDirection = "left" | "right" | "up" | "down";

export type TransitionKindView =
  | { kind: "Crossfade" }
  | { kind: "Wipe"; direction: TransitionDirection }
  | { kind: "Slide"; direction: TransitionDirection };

/// Wire mirror of the model's `Transition` (summary.ts TransitionView). The
/// transition occupies the incoming layer's first `duration_us` µs — the
/// authorized overlap with `from_layer`. `extended_us` is the borrowed share
/// of that overlap (how much outgoing tail media the transition consumed;
/// 0 = pure placement) — inverse ops and the chip's right edge route by it
/// (ADR 0048).
export interface TransitionSummary {
  id: string;
  from_layer: string;
  to_layer: string;
  duration_us: number;
  kind: TransitionKindView;
  extended_us: number;
}

export interface LayerPatch {
  label?: string;
  t_start_us?: number;
  t_end_us?: number;
  enabled?: boolean;
  locked?: boolean;
}

/** Mirrors `Rgba` in `state/color.rs`. r/g/b/a all 0-255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TextPatch {
  content?: string;
  font_family?: string;
  font_size_px?: number;
  color?: Rgba;
  x?: number;
  y?: number;
  opacity?: number;
  align?: TextView["align"];
  valign?: TextView["valign"];
  /// On the box pair alone, `null` is a VALUE — "back to auto" — and absent is
  /// "don't touch". The mutation layer refuses any patch that would leave
  /// `(box_w: null, box_h: set)`, so leaving Fixed means sending both fields in
  /// one patch, not `box_w: null` by itself (ADR 0049).
  box_w?: number | null;
  box_h?: number | null;
  line_height?: number;
  letter_spacing?: number;
}

export interface VideoClipPatch {
  src_in_us?: number;
  src_out_us?: number;
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  speed?: number;
  flip_h?: boolean;
  flip_v?: boolean;
  fade_in_us?: number;
  fade_out_us?: number;
}

export interface ImageOverlayPatch {
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  fade_in_us?: number;
  fade_out_us?: number;
}

export interface MotifPatch {
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  src_in_us?: number;
  motif_id?: string;
  motif_version?: number;
  /// Props to merge FIELD-WISE into the layer's existing `props` map — each
  /// key present here overwrites that key; absent keys are left intact. The
  /// backend merges (never replaces the whole map) so a stale debounced commit
  /// can't clobber a concurrent edit. Values are passed verbatim; the property
  /// panel types them per the motif's `props_schema` (`number` / hex
  /// `string` / `string`), so no further validation happens on this path.
  props?: Record<string, unknown>;
}

export interface ColorPatch {
  color?: Rgba;
  width?: number;
  height?: number;
}

export interface AudioPatch {
  src_in_us?: number;
  src_out_us?: number;
  gain_db?: number;
  pan?: number;
  fade_in_us?: number;
  fade_out_us?: number;
  mute?: boolean;
  role?: AudioRole;
}

/// Tagged union mirroring `LayerParamsPatch` in
/// `src/main/state/mutations/params.ts`. The discriminant in `kind` must match
/// the layer's current LayerParams kind; mismatches fail with
/// `LayerParamsKindMismatch`.
export type LayerParamsPatch =
  | ({ kind: "Text" } & TextPatch)
  | ({ kind: "VideoClip" } & VideoClipPatch)
  | ({ kind: "ImageOverlay" } & ImageOverlayPatch)
  | ({ kind: "Motif" } & MotifPatch)
  | ({ kind: "Color" } & ColorPatch)
  | ({ kind: "Audio" } & AudioPatch);

export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

// Process-tree resource snapshot from main (app.getAppMetrics()) — re-exported
// from the bridge so `../ipc` stays the import site.
export { getSystemStats, type SystemStats } from "@/bridge/metrics";

// Live HW-decode session budget from main. Same re-export shape as the metrics
// snapshot above, and for the same reason: the PerfHUD reads it from "../ipc".
export { getPreviewGpuBudget, type PreviewGpuBudgetSnapshot } from "@/bridge/previewGpu";

export async function projectSummary(): Promise<ProjectSummary> {
  return invoke<ProjectSummary>("project_summary");
}

/// Tracks are kind-agnostic — the new track accepts any layer kind.
export async function addTrack(): Promise<string> {
  return invoke<string>("add_track");
}

export async function addMediaLayer(
  trackId: string,
  mediaId: string,
  tStartUs: number,
): Promise<string> {
  return invoke<string>("add_media_layer", {
    trackId,
    mediaId,
    tStartUs,
  });
}

export async function addColorLayer(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  color?: Rgba;
  width?: number;
  height?: number;
}): Promise<string> {
  return invoke<string>("add_color_layer", {
    trackId: opts.trackId,
    color: opts.color,
    width: opts.width,
    height: opts.height,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
  });
}

export async function addTextLayer(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  content?: string;
}): Promise<string> {
  return invoke<string>("add_text_layer", {
    trackId: opts.trackId,
    content: opts.content,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
  });
}

export async function projectUndo(): Promise<void> {
  return invoke<void>("project_undo");
}

export async function projectRedo(): Promise<void> {
  return invoke<void>("project_redo");
}

export async function projectSave(): Promise<void> {
  return invoke<void>("project_save");
}

export async function projectSaveAs(path: string): Promise<void> {
  return invoke<void>("project_save_as", { path });
}

export async function projectOpen(path: string): Promise<void> {
  return invoke<void>("project_open", { path });
}

// ============================================================
// Workspace lifecycle (docs/data-model.md)
// ============================================================

export interface CanvasPreset {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

/// Create a fresh workspace at `<parentFolder>/<name>/` with the given
/// canvas params, replace the actor's state, and push to recents.
/// Returns the absolute path of the new workspace folder.
export async function projectNewWorkspace(args: {
  parentFolder: string;
  name: string;
  canvas: CanvasPreset;
}): Promise<string> {
  return invoke<string>("project_new_workspace", {
    parentFolder: args.parentFolder,
    name: args.name,
    width: args.canvas.width,
    height: args.canvas.height,
    fpsNum: args.canvas.fpsNum,
    fpsDen: args.canvas.fpsDen,
  });
}

export async function recentsList(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_list");
}

export async function recentsRemove(path: string): Promise<void> {
  return invoke<void>("recents_remove", { path });
}

export async function recentsMostRecent(): Promise<RecentEntry | null> {
  return invoke<RecentEntry | null>("recents_most_recent");
}

/// Parent folder of the last project the user created via "+ New project".
/// `null` on first launch — the UI falls back to the OS Documents
/// directory via `documentDir` (src/renderer/bridge/path).
export async function recentsLastNewProjectParent(): Promise<string | null> {
  return invoke<string | null>("recents_last_new_project_parent");
}

export async function recentsGetReopenOnLaunch(): Promise<boolean> {
  return invoke<boolean>("recents_get_reopen_on_launch");
}

export async function recentsSetReopenOnLaunch(value: boolean): Promise<void> {
  return invoke<void>("recents_set_reopen_on_launch", { value });
}

// ============================================================
// Keyboard-shortcut overrides
// ============================================================
//
// Per-user app-level overrides for the static defaults declared in
// `shortcuts/defs.ts`. Empty / missing entries inherit the default.
// An empty `keys` array means "explicitly unbound" — distinct from
// "use the default."
//
// Single-sourced in src/shared/keybindings.ts; re-export convention in the file header.
import type { KeybindingsMap } from "../../shared/keybindings";
export type { KeybindingsMap };

export async function keybindingsGet(): Promise<KeybindingsMap> {
  return invoke<KeybindingsMap>("keybindings_get");
}

export async function keybindingsSet(
  action: string,
  keys: string[],
): Promise<void> {
  return invoke<void>("keybindings_set", { action, keys });
}

export async function keybindingsResetAll(): Promise<void> {
  return invoke<void>("keybindings_reset_all");
}

export async function keybindingsExport(dest: string): Promise<void> {
  return invoke<void>("keybindings_export", { dest });
}

export async function keybindingsImport(src: string): Promise<KeybindingsMap> {
  return invoke<KeybindingsMap>("keybindings_import", { src });
}

// ============================================================
// Per-workspace view state: the timeline tab intent, each tab's zoom and
// scroll, and the project's track heights. Lives at `<workspace>/view.json`.
// `renderer/state/viewState.ts` is the renderer's only caller — one read per
// project, one debounced write — because several timeline Panels share this
// one document. Pre-workspace, get returns defaults and set silently no-ops.
// ============================================================

// Single-sourced in src/shared/view-state.ts; re-export convention in the file header.
import type { ViewState } from "../../shared/view-state";
export type { ViewState };

export async function viewStateGet(): Promise<ViewState> {
  return invoke<ViewState>("view_state_get");
}

export async function viewStateSet(state: ViewState): Promise<void> {
  return invoke<void>("view_state_set", { state });
}

export async function exportSettingsGet(): Promise<ExportSettings | null> {
  const v = await invoke<ExportSettings | null>("export_settings_get");
  return v ?? null;
}

export async function exportSettingsSet(
  settings: ExportSettings,
): Promise<void> {
  return invoke<void>("export_settings_set", { settings });
}

/// Absolute path of the current workspace (project) directory, or null when no
/// project is open. Used to default the export output location.
export async function workspaceDir(): Promise<string | null> {
  const v = await invoke<string | null>("workspace_dir");
  return v ?? null;
}

// ============================================================
// App-level settings (A/B-roll redesign, `docs/data-model.md`).
// Strict app-level scope: same value across every project. The pill /
// View menu / `T` shortcut all funnel through `appSettingsSet`. The
// backend emits `app_settings:changed` on every successful write so
// subscribers re-render without an extra round-trip.
// ============================================================

// Single-sourced in src/shared/app-settings.ts (persistence owner:
// src/main/app-settings.ts); re-export convention in the file header.
import type {
  DisplayMode,
  MediaPoolLayout,
  TimelineWheelAxis,
  AppSettings,
  AppSettingsPatch,
} from "../../shared/app-settings";
export type {
  DisplayMode,
  MediaPoolLayout,
  TimelineWheelAxis,
  AppSettings,
  AppSettingsPatch,
};

export async function appSettingsGet(): Promise<AppSettings> {
  return invoke<AppSettings>("app_settings_get");
}

export async function appSettingsSet(
  patch: AppSettingsPatch,
): Promise<AppSettings> {
  return invoke<AppSettings>("app_settings_set", { patch });
}

export const APP_SETTINGS_EVENTS = {
  changed: "app_settings:changed",
} as const;

// ============================================================
// App-level Workspace document (Dock arrangement + named profiles).
// Lives at `<userData>/workspaces.json`, owned by main. The renderer reads it
// once on startup to restore the layout and writes the active profile's current
// arrangement on every layout change; main debounces the disk write and flushes
// on quit. The layout slots are opaque here — the DockWorkspace adapter owns the
// schema. The named-profile operations (switch/save/save-as/rename/delete)
// commit immediately and return the resulting document.
// ============================================================

// Single-sourced in src/shared/workspace.ts; re-export convention in the file header.
import type {
  WorkspaceDocument,
  WorkspaceProfile,
} from "../../shared/workspace";
export type { WorkspaceDocument, WorkspaceProfile };

export async function workspaceGet(): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_get");
}

/// Autosave the ACTIVE profile's current Dock arrangement (opaque). Debounced +
/// flushed on quit in main.
export async function workspaceSetCurrent(current: unknown): Promise<void> {
  return invoke<void>("workspace_set_current", { current });
}

/// Switch the active Workspace profile. Flushes the outgoing profile's buffered
/// current first, then activates `id`. Returns the resulting document.
export async function workspaceSetActive(id: string): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_set_active", { id });
}

/// Save Workspace: promote the active profile's current layout to its saved reset
/// baseline. No-op on the immutable built-in Editing profile.
export async function workspaceSaveBaseline(): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_save_baseline");
}

/// Save Workspace As: create a new custom profile from the current arrangement
/// (seeds both its current layout and its reset baseline) and activate it.
export async function workspaceCreateProfile(
  name: string,
  current: unknown,
): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_create_profile", { name, current });
}

/// Rename a custom profile. No-op on the built-in Editing profile.
export async function workspaceRenameProfile(
  id: string,
  name: string,
): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_rename_profile", { id, name });
}

/// Delete a custom profile; if it was active, Editing becomes active. No-op on
/// the built-in Editing profile.
export async function workspaceDeleteProfile(id: string): Promise<WorkspaceDocument> {
  return invoke<WorkspaceDocument>("workspace_delete_profile", { id });
}

// ── History panel: one read + three actions ─────────────────────────────────

/// Pull the WHOLE edit stack (rows + checkpoints). A read: it never records, and
/// never dirties the project. Main serves `historyView(cap)` — no limit arg
/// crosses the wire, so the panel cannot ask for a window main doesn't intend.
export async function projectHistoryView(): Promise<HistoryStackView> {
  return invoke<HistoryStackView>("project_history_view");
}

/// Move the history cursor to absolute stack index `index` — click-a-row.
/// Cursor-only: records no entry, so the next edit truncates the tail from
/// there. Rejects with `HistoryLocked` while an agent holds the revert lock, and
/// `InvalidArgument` for an index outside `[0, len)`.
export async function projectJumpTo(index: number): Promise<void> {
  return invoke<void>("project_jump_to", { index });
}

/// Create a named checkpoint at the current state, stamped with the `User`
/// actor. Returns its id. Session-only — checkpoints are not persisted.
export async function projectCreateCheckpoint(label: string): Promise<string> {
  return invoke<string>("project_create_checkpoint", { label });
}

/// Delete a checkpoint (and release the full snapshot it pins). Rejects with
/// `CheckpointNotFound` if it is already gone. Changes no project state, so it
/// emits no `project:changed` — the caller refetches the view itself.
export async function projectDeleteCheckpoint(checkpointId: string): Promise<void> {
  return invoke<void>("project_delete_checkpoint", { checkpointId });
}

export async function projectRestoreCheckpoint(checkpointId: string): Promise<void> {
  return invoke<void>("project_restore_checkpoint", { checkpointId });
}

// ============================================================
// Agent session — view mode shared by MCP and the local UI. UI shows
// agent mode when `agent_session_get` returns Some(...); editor mode
// otherwise. Entry: the `begin_agent_session` MCP tool or the local
// `agent_session_begin` channel (View menu / command palette); exit:
// `agent_session_end`.
// ============================================================

export interface AgentSession {
  client: string;
  reason: string;
  /// ISO 8601 timestamp from chrono::DateTime<Utc>.
  started_at: string;
}

export const AGENT_SESSION_EVENTS = {
  changed: "agent_session:changed",
} as const;

export async function agentSessionGet(): Promise<AgentSession | null> {
  return invoke<AgentSession | null>("agent_session_get");
}

export async function agentSessionEnd(): Promise<void> {
  return invoke<void>("agent_session_end");
}

/// Begin a local agent session (client "local"): mints the same
/// "Pre-agent: {reason}" auto-checkpoint the MCP tool creates, then flips
/// the UI into agent mode via the `agent_session:changed` event.
export async function agentSessionBegin(reason: string): Promise<void> {
  return invoke<void>("agent_session_begin", { reason, client: "local" });
}

// ============================================================
// Background import worker (docs/data-model.md)
// ============================================================

export type ImportStatus =
  | { kind: "Pending" }
  | { kind: "Copying" }
  | { kind: "Completed" }
  | { kind: "Failed"; detail: string }
  | { kind: "Cancelled" };

export interface ImportEntry {
  media_id: string;
  source: string;
  destination_rel: string | null;
  status: ImportStatus;
}

export const IMPORT_EVENTS = {
  queue: "import:queue",
  started: "import:started",
  complete: "import:complete",
  error: "import:error",
} as const;

/// Per-media derivative job events. Emitted by `jobs/{proxy,thumbnails,
/// waveform}.rs` so the UI can react to background generation finishing.
/// started/complete/error drive an in-flight count for the small
/// "Generating derivatives…" indicator near the project bar.
export const MEDIA_JOB_EVENTS = {
  started: "media:job_started",
  complete: "media:job_complete",
  error: "media:job_error",
} as const;

export interface MediaJobEvent {
  media_id: string;
  kind: string;
}

export async function importQueueList(): Promise<ImportEntry[]> {
  return invoke<ImportEntry[]>("import_queue_list");
}

export async function importCancel(mediaId: string): Promise<boolean> {
  return invoke<boolean>("import_cancel", { mediaId });
}

export async function importMedia(path: string): Promise<string> {
  return invoke<string>("import_media", { path });
}

/// Remove one item from the project media pool. The guarded path rejects with
/// `MediaInUse { referenced_by }`; callers may then offer an explicit
/// force-confirmation, which also removes those referencing timeline layers.
/// Neither path deletes the source file from disk.
export async function removeMedia(
  mediaId: string,
  force = false,
): Promise<void> {
  return invoke<void>("remove_media", { mediaId, force });
}

/// Audio encode parameters. `sampleRate`/`channels` are null to follow the
/// composition. Mirrors Rust `AudioEncodeSpec` (serde camelCase).
export interface AudioExportSpec {
  codec: "aac" | "opus";
  bitrate: number;
  sampleRate: number | null;
  channels: number | null;
}

/// Audio-only export at `outputPath` (extension picks the muxer: .m4a for AAC,
/// .mka for Opus). `range` trims the audio to the export window (null = whole
/// project). Awaitable; emits no events.
export async function exportProjectAudioOnly(
  outputPath: string,
  audio: AudioExportSpec,
  range: { startUs: number; endUs: number } | null,
): Promise<boolean> {
  return invoke<boolean>("export_project_audio_only", {
    outputPath,
    audio,
    startUs: range?.startUs ?? null,
    endUs: range?.endUs ?? null,
  });
}

/// Mux `video` + `audio` into `output` — always a stream-copy. Every export
/// path (WebCodecs direct-encode, or the native-encode video sink) already
/// writes `video` in its final target codec.
export async function muxExport(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  return invoke<void>("mux_export", {
    videoPath,
    audioPath,
    outputPath,
  });
}

export async function updateLayer(layerId: string, patch: LayerPatch): Promise<void> {
  return invoke<void>("update_layer", { layerId, patch });
}

export interface TrackFlagsPatch {
  enabled?: boolean;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
}

/// Unrecorded toggle path: eye/M/S/lock changes never enter undo history; the
/// actor patches every history snapshot instead.
export async function updateTrackFlags(
  trackId: string,
  patch: TrackFlagsPatch,
): Promise<void> {
  return invoke<void>("update_track_flags", { trackId, patch });
}

/// Name a lane. RECORDED (unlike the flags above) — a name is content, so
/// Ctrl-Z reverts it. `null` (or a blank string, which the actor folds to null)
/// restores the derived name (ADR 0042).
export async function renameTrack(
  trackId: string,
  label: string | null,
): Promise<void> {
  return invoke<void>("rename_track", { trackId, label });
}

/// Drop a point marker at `tUs` (frame-snapped actor-side); returns the new
/// marker id. RECORDED. The label is deliberately empty — a human marker stays
/// unnamed until renamed, so the ruler tooltip falls back to the translated
/// noun. Colour is the actor default; the palette belongs to colour editing.
export async function addMarkerAt(tUs: number): Promise<string> {
  return invoke<string>("add_marker", { tUs, label: "" });
}

/// Rename a marker. RECORDED — but renaming to the unchanged label is an
/// actor-level no-op: ok result, no history entry.
export async function renameMarker(
  markerId: string,
  label: string,
): Promise<void> {
  return invoke<void>("update_marker", { markerId, patch: { label } });
}

/// Rewrite a marker's long text. RECORDED, one entry — the marker Panel's note
/// field commits through here on blur/Enter, never per keystroke.
export async function setMarkerNote(
  markerId: string,
  note: string,
): Promise<void> {
  return invoke<void>("update_marker", { markerId, patch: { note } });
}

/// Recolour a marker. RECORDED, one entry.
///
/// Alpha is the caller's to supply, and the marker Panel supplies 255: the wire
/// carries the colour as `#rrggbb` (`markerColorHint`), so a swatch edit has no
/// alpha to preserve and an opaque write matches what every marker surface
/// paints.
export async function setMarkerColor(
  markerId: string,
  color: Rgba,
): Promise<void> {
  return invoke<void>("update_marker", { markerId, patch: { color } });
}

/// Move a marker to `tUs` — the marker lane's drag, as ONE commit. RECORDED, so
/// one undo puts the mark back where it was.
///
/// On an ANCHORED marker `t_us` names the time the mark should READ, and the
/// actor moves the anchor to make it read that; the marker keeps following its
/// clip from the new offset. Refused when the time falls outside the anchoring
/// clip's half-open span — `markerDragBoundsUs` (timeline/markerAtFrame) answers
/// that at the gesture, so a surface that clamps with it never reaches the
/// refusal.
///
/// `endTUs` is a region's new end, and only a FREE region has one to send: an
/// anchored marker's end is carried by its own anchor (the commit's reconcile
/// shifts it by the same frame delta), so passing one there would move it twice
/// and the actor refuses the pair outright.
export async function moveMarker(
  markerId: string,
  tUs: number,
  endTUs: number | null = null,
): Promise<void> {
  return invoke<void>("update_marker", {
    markerId,
    patch: endTUs === null ? { t_us: tUs } : { t_us: tUs, end_t_us: endTUs },
  });
}

/// Remove a marker. RECORDED; deletion is one undo away, so no confirm dialog
/// stands in front of it.
export async function removeMarker(markerId: string): Promise<void> {
  return invoke<void>("remove_marker", { markerId });
}

/// Tie a marker to a clip in its own composition. From here on the marker's
/// time is derived from that clip's source window every commit, so it follows
/// moves, trims and splits, and goes with the clip if the clip is deleted.
/// RECORDED.
///
/// Refused when the clip is in another composition, carries no source window,
/// or does not cover the marker's own time — `markerAnchorFor`
/// (timeline/markerAtFrame) answers all three at the gesture, so a surface that
/// consults it never reaches the refusal.
export async function attachMarker(
  markerId: string,
  layerId: string,
): Promise<void> {
  return invoke<void>("attach_marker", { markerId, layerId });
}

/// Cut a marker loose from its clip; it stays on the frame it currently sits
/// on and simply stops following. RECORDED. The one exit from hibernation.
export async function detachMarker(markerId: string): Promise<void> {
  return invoke<void>("detach_marker", { markerId });
}

export async function updateLayerParams(
  layerId: string,
  patch: LayerParamsPatch,
): Promise<void> {
  return invoke<void>("update_layer_params", { layerId, patch });
}

/// Append a catalog effect (`kind`) to a layer's chain; returns the new effect id.
export async function addEffect(layerId: string, kind: string): Promise<string> {
  return invoke<string>("add_effect", { layerId, kind });
}

/// Patch an effect (enabled flag and/or scalar params).
export async function updateEffect(
  layerId: string,
  effectId: string,
  patch: EffectPatch,
): Promise<void> {
  return invoke<void>("update_effect", { layerId, effectId, patch });
}

/// Reorder an effect within its layer's chain (0 = applied first).
export async function moveEffect(layerId: string, effectId: string, newIndex: number): Promise<void> {
  return invoke<void>("move_effect", { layerId, effectId, newIndex });
}

/// Remove an effect from a layer's chain by id.
export async function removeEffect(layerId: string, effectId: string): Promise<void> {
  return invoke<void>("remove_effect", { layerId, effectId });
}

/// Set the project-level gain (dB) for one audio role. Unlike the flag
/// mutators, role-gain edits are RECORDED (undoable) — the actor commits each
/// one, so a debounced edit can produce one undo entry per pause.
export async function setRoleGain(role: AudioRole, gainDb: number): Promise<void> {
  return invoke<void>("set_role_gain", { role, gainDb });
}

/// Mute/solo one audio role at the project level. `muted`/`solo` are partial —
/// omit a field to leave it unchanged. UNRECORDED: like the track-flag
/// mutators, these never enter undo history (the actor patches every history
/// snapshot instead).
export async function updateRoleFlags(
  role: AudioRole,
  patch: { muted?: boolean; solo?: boolean },
): Promise<void> {
  return invoke<void>("update_role_flags", { role, patch });
}

/// Write a whole keyframe track to a named animatable param on a layer.
/// `paramKey` is one of the layer kind's animatable f64 fields
/// (x/y/scale_x/scale_y/rotation_deg/opacity for visual kinds; gain_db/pan for audio).
/// The actor normalizes (snap/sort/dedupe) and records the edit (one undo step).
export async function updateLayerParamTrack(
  layerId: string,
  paramKey: string,
  track: AnimTrack<number>,
): Promise<void> {
  return invoke<void>("update_layer_param_track", { layerId, paramKey, track });
}

/// Batch form — write several param tracks on one layer as a single undo step
/// (used by multi-keyframe gestures like dragging a cross-property selection,
/// and by the linked-scale fan-out: scale_x + a twin scale_y in one commit).
export async function updateLayerParamTracks(
  layerId: string,
  entries: [string, AnimTrack<number>][],
): Promise<void> {
  return invoke<void>("update_layer_param_tracks", { layerId, entries });
}

/// Cross-layer batch form — every entry names its own layer, and the whole set
/// lands as ONE undo step no matter how many layers it spans. A batch confined
/// to a single layer belongs in `updateLayerParamTracks` above.
export async function updateParamTracksMulti(
  entries: [layerId: string, paramKey: string, track: AnimTrack<number>][],
): Promise<void> {
  return invoke<void>("update_param_tracks_multi", { entries });
}

/// Toggle a layer's uniform-scale link. `true` is the destructive direction:
/// the actor snaps scale_y to a whole-track copy of scale_x (keyframes
/// included) in the same commit — undo restores both the track and the flag.
export async function setScaleLinked(layerId: string, linked: boolean): Promise<void> {
  return invoke<void>("set_scale_linked", { layerId, linked });
}

export async function moveLayer(
  layerId: string,
  newTrackId: string,
  newTStartUs: number,
  escapeLink = false,
): Promise<void> {
  return invoke<void>("move_layer", {
    layerId,
    newTrackId,
    newTStartUs,
    escapeLink,
  });
}

/// Raise layers onto one fresh lane at the top of the z-stack (ADR 0042). One
/// commit: the lane appears, every listed layer moves onto it, and every lane
/// the raise emptied goes with it, so one undo restores all of them. Returns the
/// new track's id.
///
/// `anchor` is the drop strip's landing — its layer's head goes to `tStartUs`
/// and every other member holds its phase. Omit it to keep every time verbatim,
/// which is the *Move to a new track* command's shape: a menu has no ghost, so
/// it may not name a time the user never saw. One object rather than two loose
/// arguments because half a landing is not a request.
export async function moveLayersToNewTrack(
  layerIds: string[],
  anchor?: { layerId: string; tStartUs: number } | null,
): Promise<string> {
  return invoke<string>("move_layers_to_new_track", {
    layerIds,
    anchorLayerId: anchor?.layerId ?? null,
    anchorTStartUs: anchor?.tStartUs ?? null,
  });
}

/// Restack a visual layer directly above/below an anchor layer in the z-stack
/// (ADR 0044) — the Playhead Panel's drop gesture. One undoable step; degradation and no-op
/// semantics live on the mutation (main/state/mutations/restack.ts).
export async function restackLayer(
  layerId: string,
  anchorLayerId: string,
  position: "above" | "below",
): Promise<void> {
  return invoke<void>("restack_layer", { layerId, anchorLayerId, position });
}

/** `docs/features.md#links` — link-aware trim. `edge` is `"in"` or `"out"`. */
export async function trimLayer(
  layerId: string,
  edge: "in" | "out",
  newTUs: number,
  escapeLink = false,
): Promise<void> {
  return invoke<void>("trim_layer", {
    layerId,
    edge,
    newTUs,
    escapeLink,
  });
}

export async function splitLayerLinked(
  layerId: string,
  atTUs: number,
  escapeLink = false,
): Promise<[string, string]> {
  return invoke<[string, string]>("split_layer_linked", {
    layerId,
    atTUs,
    escapeLink,
  });
}

/** `docs/features.md#links` — bundle ≥2 layer ids into a link. */
export async function linksCreate(
  layerIds: string[],
  label: string | null = null,
  reassign = false,
): Promise<string> {
  return invoke<string>("links_create", {
    layerIds,
    label,
    reassign,
  });
}

export async function linksDissolve(linkId: string): Promise<void> {
  return invoke<void>("links_dissolve", { linkId });
}

/** Set or clear (`null`) a link's label; the tab on its top-most visible
 *  member is the only place the label is drawn. */
export async function linksRename(
  linkId: string,
  label: string | null,
): Promise<void> {
  return invoke<void>("links_rename", { linkId, label });
}

/// `docs/features.md#groups` — pre-compose: the selection (≥ 1 layer, one
/// composition) becomes a new composition placed back as one Group layer at the
/// set's earliest start. Refuses whole on any locked member or track. Returns
/// the new composition's id and the Group layer's id; one undo restores all.
export async function groupsCreate(
  layerIds: string[],
  label: string | null = null,
): Promise<{ composition_id: string; layer_id: string }> {
  return invoke<{ composition_id: string; layer_id: string }>("groups_create", {
    layerIds,
    label,
  });
}

/// Expand a PLAIN Group layer (identity transform, opacity 1, no effects) back
/// into its members in place; refuses with `GroupNotPlain { reason }` otherwise.
/// The composition goes with it when nothing else references it.
export async function groupsUngroup(layerId: string): Promise<void> {
  return invoke<void>("groups_ungroup", { layerId });
}

/// Move existing layers INTO the composition a Group layer references — the
/// crossing addressed by pointing at a Group clip, where the
/// `move_layers_to_composition` op is the one addressed by naming a destination
/// and a landing time.
/// Members land at `t_start_us - group.t_start_us + group.src_in_us`, so they
/// keep the screen position they had. Refuses whole, before any write, on: a
/// set spanning two compositions, a Group clip that is not in the members'
/// composition, a locked member or lane, a member that would land before
/// composition time 0, and a member whose own composition already reaches the
/// destination (`CompositionCycle`). The Group's window is never rewritten, so
/// a destination that grows shows as overhang (ADR 0052 §6).
export async function groupsAddMembers(
  layerIds: string[],
  groupLayerId: string,
): Promise<void> {
  return invoke<void>("groups_add_members", { layerIds, groupLayerId });
}

/// Move layers into a composition named DIRECTLY, at a landing time the caller
/// resolves — the crossing `groupsAddMembers` reaches by pointing at a Group
/// clip instead, and delegates to.
/// `anchorLayerId` is the member `anchorTStartUs` positions; every other member
/// keeps its phase relative to it, which is what carries a transition between
/// two moved members across. `toTrackId` is the caller's lane opinion: `null`
/// bounces to a free lane (a menu has no ghost to make a lie of), a lane id
/// refuses an occupied or locked one, `"spawn"` mints a fresh one.
/// Both endpoints re-snap on the DESTINATION's grid, so two compositions at
/// different rates do not round trip (ADR 0037, ADR 0038). Refuses whole,
/// before any write, on: a set spanning two compositions, a destination that is
/// the set's own composition, a locked member or lane, a member landing before
/// composition time 0, and a member whose own composition already reaches the
/// destination (`CompositionCycle`). The ROOT is an ordinary destination.
export async function moveLayersToComposition(
  layerIds: string[],
  toCompositionId: string,
  anchorLayerId: string,
  anchorTStartUs: number,
  toTrackId: string | "spawn" | null = null,
): Promise<void> {
  return invoke<void>("move_layers_to_composition", {
    layerIds,
    toCompositionId,
    anchorLayerId,
    anchorTStartUs,
    toTrackId,
  });
}

/// Set or clear (`null` / blank) a Group's composition name. The root refuses.
export async function groupsRename(
  compositionId: string,
  label: string | null,
): Promise<void> {
  return invoke<void>("groups_rename", { compositionId, label });
}

/// Delete an orphan composition (no Group layer references it); refuses with
/// `CompositionInUse` otherwise, and refuses the root.
export async function compositionsDelete(compositionId: string): Promise<void> {
  return invoke<void>("compositions_delete", { compositionId });
}

/// Lift an Audio layer onto a freshly-created track inserted directly below its
/// source in the z-stack, so the new row reads one row down the screen. Link
/// membership survives. Returns the new track's id. UI consequence: the combined
/// row collapses to V-only on the source row; the new row below shows the
/// waveform on its own (J/L-cut friendly).
///
/// The lifted track is `transient` like every role-less track, so emptying it
/// later removes it — and lifting can now empty the SOURCE row, which the same
/// rule then removes (ADR 0042). It is also the one track that keeps a stored
/// label, when the source had a name worth recording.
export async function separateAudioToNewTrack(
  layerId: string,
): Promise<string> {
  return invoke<string>("separate_audio_to_new_track", { layerId });
}

export async function duplicateLayer(
  layerId: string,
  tOffsetUs: number,
): Promise<string> {
  return invoke<string>("duplicate_layer", { layerId, tOffsetUs });
}

export async function pasteLayer(
  layerId: string,
  tStartUs: number,
  targetTrackId?: string,
): Promise<string> {
  return invoke<string>(
    "paste_layer",
    targetTrackId === undefined
      ? { layerId, tStartUs }
      : { layerId, tStartUs, targetTrackId },
  );
}

/// The whole-link duplicate: every layer in `layerIds` is cloned as ONE undo
/// step. `layerIds[0]` is the seed — `tStartUs` is its clone's start, and every
/// other clone shifts by the same delta on its own lattice (a slipped audio
/// member keeps its offset). `targetTrackId` re-lanes the seed's clone only;
/// the rest land on their sources' tracks. All-or-nothing: a locked or occupied
/// destination for any member rejects the batch and nothing is created. Two or
/// more clones are linked to each other, never to their sources. Returns
/// source → clone pairs in input order. A single-layer copy with automatic lane
/// placement stays on `pasteLayer`.
export async function pasteLayers(
  layerIds: string[],
  tStartUs: number,
  targetTrackId: string | null = null,
): Promise<{ clones: { source: string; clone: string }[] }> {
  return invoke<{ clones: { source: string; clone: string }[] }>(
    "paste_layers",
    { layerIds, tStartUs, targetTrackId },
  );
}

/// Set `enabled` on exactly these layers in ONE undo step. The caller resolves
/// the set — a link's members when the toggle fans out, the clicked layer alone
/// when escaped; the op never expands it. A layer's own lock does not block the
/// toggle; a locked track rejects the whole batch. One layer: `updateLayer`.
export async function setLayersEnabled(
  layerIds: string[],
  enabled: boolean,
): Promise<void> {
  return invoke<void>("set_layers_enabled", { layerIds, enabled });
}

export async function deleteLayer(layerId: string): Promise<void> {
  return invoke<void>("delete_layer", { layerId });
}

/// The SELECTION's delete: every layer in `layerIds` goes, and the whole set
/// lands as ONE undo step however many tracks it spans — a marquee sweep, a
/// Shift+click set and Select All all arrive here. Deleting exactly one layer
/// belongs in `deleteLayer` above. An empty set is a no-op that records nothing.
///
/// Takes the selection VERBATIM: delete is local at the op level (a link is
/// never fanned out — docs/features.md § Links), because the selection already
/// carries the whole link; clicking one member selects all of them.
export async function deleteLayers(layerIds: string[]): Promise<void> {
  return invoke<void>("delete_layers", { layerIds });
}

// ============================================================
// Transitions (spec § Command surface — three recorded, undoable ops)
// ============================================================

/// Add a transition at a hard cut between same-track adjacent visual layers.
/// Overlap placement (the backend default — this wrapper sends no placement):
/// the incoming layer moves left by the frame-rounded `durationUs`, trimmed
/// ranges preserved, no tail borrowed (ADR 0048). Crossfade must OMIT
/// `direction`; Wipe/Slide must carry one — the backend rejects the other
/// pairing. Throws structured refusals (shared link, t = 0 crossing,
/// duration over a participant's length) — surface them, never clamp.
export async function addTransition(args: {
  fromLayerId: string;
  toLayerId: string;
  durationUs: number;
  kind: TransitionKindView["kind"];
  direction?: TransitionDirection;
}): Promise<string> {
  return invoke<string>("add_transition", {
    fromLayerId: args.fromLayerId,
    toLayerId: args.toLayerId,
    durationUs: args.durationUs,
    kind: args.kind,
    ...(args.direction !== undefined ? { direction: args.direction } : {}),
  });
}

/// Patch duration, kind+direction, and/or the borrowed-tail target in ONE
/// recorded commit (one undo step). Direction rides inside kind — sending
/// direction without kind is rejected, so kind changes to Wipe/Slide must
/// include a direction. Omitting `extendedUs` keeps the routing
/// sanctity-preferring (ADR 0048): growth moves the incoming layer left and
/// never borrows; shrink returns borrowed tail first. Only an explicit
/// `extendedUs` (the chip's right edge) grows the borrow — and only an
/// explicit NEGATIVE one trims the outgoing layer's real tail past its
/// sacred exit frame (the right edge dragged left past S, spec D6).
export async function updateTransition(args: {
  transitionId: string;
  durationUs?: number;
  kind?: TransitionKindView["kind"];
  direction?: TransitionDirection;
  extendedUs?: number;
}): Promise<void> {
  return invoke<void>("update_transition", {
    transitionId: args.transitionId,
    ...(args.durationUs !== undefined ? { durationUs: args.durationUs } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.direction !== undefined ? { direction: args.direction } : {}),
    ...(args.extendedUs !== undefined ? { extendedUs: args.extendedUs } : {}),
  });
}

/// Remove by id; routed restore (ADR 0048): the outgoing layer shrinks back
/// by the transition's `extended_us` and the incoming layer moves right by
/// the remainder (siblings following), restoring the hard cut. Can refuse
/// with TransitionRestoreCollision when the restore destination is occupied.
/// Recorded (undoable).
export async function removeTransition(transitionId: string): Promise<void> {
  return invoke<void>("remove_transition", { transitionId });
}

export interface CompositionPatchPartial {
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  duration_us?: number;
  sample_rate?: number;
  channels?: number;
}

/// Update one or more composition fields. Setting `duration_us` pins
/// the composition duration — call `fitCompositionToLayers()` to clear
/// the pin and resume auto-fit. See ADR 0005.
export async function setComposition(
  patch: CompositionPatchPartial,
): Promise<void> {
  return invoke<void>("set_composition", { patch });
}

/// Clear the composition's duration pin and snap `duration_us` to the
/// layer high-water mark. After this call, subsequent layer edits
/// track duration bidirectionally.
export async function fitCompositionToLayers(): Promise<void> {
  return invoke<void>("fit_composition_to_layers");
}

/// The Shots Panel's per-project review parameters — the score a candidate must
/// exceed to become a boundary, and the shortest span the reduce keeps. Mirrors
/// main `ShotReviewSettings`; both are wire fields of `reduceShotReport`.
///
/// `sensitivity` reads backwards (a higher value yields FEWER cuts) and reaches
/// no label: the human control is a line over the candidate scores, and its
/// meaning is its position. The name survives here and on disk only.
export interface ShotReviewSettings {
  sensitivity: number;
  min_shot_us: number;
}

/// Per-project behavior settings (`Project.settings`). Only the fields
/// the UI consumes are typed; the Rust struct carries more.
export interface ProjectSettingsView {
  prefer_proxies: boolean;
  proxy_overrides: Record<string, boolean>;
  /// `null` on a project nobody has tuned — read as "whatever the detector
  /// defaults to", which is what keeps every threshold literal in Rust.
  shot_review: ShotReviewSettings | null;
}

export interface ProjectSettingsPatch {
  prefer_proxies?: boolean;
  proxy_override?: { media_id: string; value: boolean | null };
  /// `null` clears the tuning and restores the detection defaults. Refused
  /// whole if `sensitivity` is outside [0, 1] or `min_shot_us` is not a
  /// positive whole number — the bounds `reduceShotReport` itself enforces.
  shot_review?: ShotReviewSettings | null;
}

export async function getProjectSettings(): Promise<ProjectSettingsView> {
  return invoke<ProjectSettingsView>("get_project_settings");
}

/// Preference-shaped, not editing-shaped: applied to every history
/// snapshot and not recorded, so undo never flips a settings toggle.
export async function updateProjectSettings(
  patch: ProjectSettingsPatch,
): Promise<void> {
  return invoke<void>("update_project_settings", { patch });
}

export interface McpInfoView {
  bind: string;
  url: string;
  bearer_token: string;
  /// The app binary — doubles as the Node runtime for the stdio shim
  /// (ELECTRON_RUN_AS_NODE). In dev this is the electron binary, which works
  /// the same way.
  exe_path: string;
  /// Set when running from a Linux AppImage: the stable relaunchable file
  /// (exe_path is the transient mount).
  appimage: string | null;
  user_data: string;
  /// <userData>/cli/weftcut-mcp.cjs once installed; null in dev before
  /// build:cli has produced the bundle (the panel then falls back to
  /// HTTP-direct as the primary path).
  shim_path: string | null;
  /// <userData>/skills once installed — the folder the user copies into their
  /// agent client's skills directory. null in dev before build:skills has
  /// staged the bundle (the panel then hides the skill section entirely).
  skills_dir: string | null;
}

/// Returns the live MCP server connection details, or `null` if the server is
/// still starting. Used by the Settings "Agent" tab.
///
/// This and `resetMcpToken` go through main-process handlers — named
/// `window.api.mcp` APIs, not `invoke` commands.
export async function getMcpInfo(): Promise<McpInfoView | null> {
  return (await window.api.mcp.getInfo()) as McpInfoView | null;
}

/// Regenerate the bearer token. The server stays bound on the same port —
/// only the token rotates. Persists to `mcp_auth.json` so the next launch
/// reuses the new token. Returns the fresh token so the panel can update
/// without a follow-up `getMcpInfo` call.
export async function resetMcpToken(): Promise<string> {
  return (await window.api.mcp.resetToken()) as string;
}

export interface ApiKeyStatus {
  provider: string;
  label: string;
  configured: boolean;
}

export async function settingsGetApiKeyStatus(): Promise<ApiKeyStatus[]> {
  return invoke<ApiKeyStatus[]>("settings_get_api_key_status");
}

export async function settingsSetApiKey(provider: string, key: string): Promise<void> {
  return invoke<void>("settings_set_api_key", { provider, key });
}

export async function settingsClearApiKey(provider: string): Promise<void> {
  return invoke<void>("settings_clear_api_key", { provider });
}

export interface ConnectionTestInfo {
  /// The provider tag the result is attributed to (matches `ApiKeyStatus.provider`).
  provider: string;
  /// One-line success summary for the user.
  summary: string;
}

/// Run a cheap smoke check against the configured provider key. Resolves with
/// a structured info object on success; rejects with the structured cloud
/// error message (MissingKey / InvalidKey / RateLimited / ...) so the UI can
/// render it inline.
export async function settingsTestProvider(
  provider: string,
): Promise<ConnectionTestInfo> {
  return invoke<ConnectionTestInfo>("settings_test_provider", { provider });
}

// ============================================================
// Speech backends — the multi-backend generalization of the
// API-key surface. Cloud backends still configure a key (settingsSetApiKey);
// local engines configure binary/model paths + device/threads via the setters
// below. All four channels are intercepted in Electron main (they merge the
// TS-owned speech_config store with Rust availability). PreferredEngine /
// LocalEngineConfig are single-sourced in src/shared/speech-config.ts.
// ============================================================

import type {
  PreferredEngine,
  LocalEngineConfig,
} from "../../shared/speech-config";
export type { PreferredEngine, LocalEngineConfig };

/// Availability verdict tags mirroring Rust `config::Availability`.
export type SpeechAvailability =
  | "available"
  | "needs_key"
  | "needs_binary"
  | "needs_model";

/// One backend row for the Settings → Transcription/Speech panel. `local` is
/// present only for local backends that have stored config (populates the
/// picker fields); cloud backends configure a key instead.
export interface SpeechBackendInfo {
  backend: string;
  label: string;
  locality: "cloud" | "local";
  /// `exactWordTiming`: the engine reports per-word/token timestamps itself
  /// (`word_timing: exact`) rather than interpolating from cue spans — shown
  /// as a badge on the backend row.
  capabilities: { transcription: boolean; tts: boolean; exactWordTiming: boolean };
  availability: SpeechAvailability;
  /// The one backend the resolver would use right now (preference + what is
  /// available). `false` on every row when nothing is configured.
  selected: boolean;
  local?: LocalEngineConfig;
}

export interface SpeechBackendsView {
  preferred_engine: PreferredEngine;
  backends: SpeechBackendInfo[];
}

/// Full backend listing + the user's preferred engine, for the Settings panel.
export async function settingsGetSpeechBackends(): Promise<SpeechBackendsView> {
  return invoke<SpeechBackendsView>("settings_get_speech_backends");
}

/// Persist the user's preferred transcription engine ("auto" | a backend tag).
export async function settingsSetSpeechPreferred(
  engine: PreferredEngine,
): Promise<void> {
  return invoke<void>("settings_set_speech_preferred", { engine });
}

/// Set (or replace) one local engine's binary/model config + optional hints.
/// Persists to the TS store AND pushes into the backend cache so the resolver
/// sees it immediately.
export async function settingsSetLocalBackend(args: {
  backend: string;
  binary: string;
  model: string;
  tokens?: string;
  device?: string;
  threads?: number;
}): Promise<void> {
  return invoke<void>("settings_set_local_backend", {
    backend: args.backend,
    binary: args.binary,
    model: args.model,
    ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
    ...(args.device !== undefined ? { device: args.device } : {}),
    ...(args.threads !== undefined ? { threads: args.threads } : {}),
  });
}

/// Clear one local engine's config (idempotent).
export async function settingsClearLocalBackend(backend: string): Promise<void> {
  return invoke<void>("settings_clear_local_backend", { backend });
}

// ============================================================
// Video-understanding (VLM) backends — the Settings surface for `describe_clip`.
// Structural twin of the speech block above; the differences all follow from
// the subsystem being STATELESS (ADR 0024) and from vision needing an `mmproj`:
//   * an `endpoint` locality (any OpenAI-compatible server, self-hosted or
//     hosted) in place of speech's hosted-provider row — one HTTP describer
//     covers both, so there is no cloud-provider backend here,
//   * a third required local path, `mmproj` (the vision projector),
//   * no Rust-side push on write — the store IS the state.
// All five channels are intercepted in Electron main. VlmPreferredEngine /
// VlmLocalEngineConfig are single-sourced in src/shared/vlm-config.ts.
// ============================================================

import type {
  VlmPreferredEngine,
  VlmLocalEngineConfig,
} from "../../shared/vlm-config";
export type { VlmPreferredEngine, VlmLocalEngineConfig };

/// Availability verdict tags mirroring Rust `vlm::config::Availability`. No
/// `needs_key` twin: nothing here is key-gated — the endpoint's key is optional,
/// so its URL is what decides availability.
export type VlmAvailability =
  | "available"
  | "needs_binary"
  | "needs_model"
  | "needs_endpoint";

/// The endpoint row's stored config as the panel sees it. The API key lives in
/// safeStorage, so it reaches the renderer only as `has_api_key`: main never
/// echoes credential material back, and the field renders as "set" or blank.
export interface VlmEndpointInfo {
  url: string;
  model?: string;
  has_api_key: boolean;
}

/// One backend row for the Settings → Video understanding panel. `local` is
/// present only for local backends with stored config; `endpoint` only for the
/// endpoint row once configured.
export interface VlmBackendInfo {
  backend: string;
  label: string;
  locality: "local" | "endpoint";
  availability: VlmAvailability;
  /// The one backend the resolver would use right now (preference + what is
  /// available). `false` on every row when nothing is configured.
  selected: boolean;
  local?: VlmLocalEngineConfig;
  endpoint?: VlmEndpointInfo;
}

export interface VlmBackendsView {
  preferred_engine: VlmPreferredEngine;
  backends: VlmBackendInfo[];
}

/// Full backend listing + the user's preferred engine, for the Settings panel.
export async function settingsGetVlmBackends(): Promise<VlmBackendsView> {
  return invoke<VlmBackendsView>("settings_get_vlm_backends");
}

/// Persist the user's preferred description engine ("auto" | a backend tag).
export async function settingsSetVlmPreferred(
  engine: VlmPreferredEngine,
): Promise<void> {
  return invoke<void>("settings_set_vlm_preferred", { engine });
}

/// Set (or replace) one local engine's binary/model/mmproj config. All three
/// paths are required — a GGUF without its projector is text-only and the
/// availability probe reports `needs_model`.
export async function settingsSetVlmLocal(args: {
  backend: string;
  binary: string;
  model: string;
  mmproj: string;
  device?: string;
}): Promise<void> {
  return invoke<void>("settings_set_vlm_local", {
    backend: args.backend,
    binary: args.binary,
    model: args.model,
    mmproj: args.mmproj,
    ...(args.device !== undefined ? { device: args.device } : {}),
  });
}

/// Clear one local engine's config (idempotent).
export async function settingsClearVlmLocal(backend: string): Promise<void> {
  return invoke<void>("settings_clear_vlm_local", { backend });
}

/// Set the endpoint, or clear it with an empty `url` (which clears its stored
/// key too). Omitting `apiKey` KEEPS whatever key is stored (the panel never
/// round-trips it, so an untouched field must not erase one); pass `null` to
/// clear it. Main routes the key to safeStorage, the URL/model to the store.
export async function settingsSetVlmEndpoint(args: {
  url: string;
  model?: string;
  apiKey?: string | null;
}): Promise<void> {
  return invoke<void>("settings_set_vlm_endpoint", {
    url: args.url,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
  });
}

export interface WaveformPeaks {
  /// One f32 in [0.0, 1.0] per peak window; max-abs over `1 / peaks_per_second`
  /// of source audio. Resolves rejected with the literal string "not_ready" if
  /// the waveform job hasn't finished — the caller should retry on the
  /// matching `media:job_complete` event.
  peaks: number[];
  peaks_per_second: number;
}

export async function getWaveformPeaks(mediaId: string): Promise<WaveformPeaks> {
  return invoke<WaveformPeaks>("get_waveform_peaks", { mediaId });
}

export interface WaveformLevels {
  channels: number;
  /// Exact effective density of each LOD. This is intentionally a floating
  /// point value (`sampleRate / framesPerPeak`), not a rounded display value:
  /// source-time-to-peak indexing depends on preserving the fractional part.
  levels: Array<{ level: number; peaksPerSecond: number; peakCount: number }>;
}

/// Header-only read of the media's peaks LOD table. Rejects "not_ready" until
/// the waveform job has produced the peaks file.
export async function getWaveformLevels(mediaId: string): Promise<WaveformLevels> {
  return invoke<WaveformLevels>("get_waveform_levels", { mediaId });
}

export interface WaveformTile {
  /// Exact effective density for this LOD; see `WaveformLevels`.
  peaksPerSecond: number;
  /// Parallel arrays; min/max are normalized samples in [-1, 1], rms in [0, 1].
  min: number[];
  max: number[];
  rms: number[];
}

/// Read `count` (min,max,rms) windows for one channel of one LOD level, starting at
/// `startPeak`. The range is clamped to the level's peak count backend-side.
export async function getWaveformTile(
  mediaId: string,
  level: number,
  channel: number,
  startPeak: number,
  count: number,
): Promise<WaveformTile> {
  return invoke<WaveformTile>("get_waveform_tile", {
    mediaId, level, channel, startPeak, count,
  });
}

export interface FilmstripTile {
  /// Absolute path of the cached tile JPG; load via convertFileSrc.
  path: string;
  /// Metadata-derived (informative); layout should trust the ImageBitmap.
  widthPx: number;
  heightPx: number;
}

/// Extract-on-demand filmstrip tile at time-grid key (lod, index). Rejects
/// "not_ready" while a Proxied source has no landed proxy (proxy-wait rule).
export async function getFilmstripTile(
  mediaId: string,
  lod: number,
  index: number,
): Promise<FilmstripTile> {
  return invoke<FilmstripTile>("get_filmstrip_tile", { mediaId, lod, index });
}

/// Returns a `data:image/jpeg;base64,...` URL for the middle thumbnail of a
/// video media item. Rejects with "not_ready" if the thumbnails job is still
/// running.
export async function getMediaThumbnail(mediaId: string): Promise<string> {
  return invoke<string>("get_media_thumbnail", { mediaId });
}

/// One frame of a source at `tUs` (source-absolute microseconds) as a `data:`
/// URL, ready for an `img` src. Served through the same
/// `media://{id}/frame/{t_us}` resource an agent reads, so the extraction is
/// cached per `(source, t_us)` and re-showing a frame is a cache read rather
/// than a second decode.
///
/// Unlike `getMediaThumbnail` this is an ON-DEMAND extract at a time the caller
/// chooses, not a pick from the evenly-spaced thumbnail set — which is why a
/// shot's cover frame cannot be served by the pool thumbnail.
export async function getMediaFrame(
  mediaId: string,
  tUs: number,
): Promise<string> {
  return invoke<string>("get_media_frame", { media_id: mediaId, t_us: tUs });
}

/// Ask the backend to generate the full export proxy for a media item
/// (decode-failure recovery / per-clip generate). Idempotent on the backend.
export async function ensureFullProxy(mediaId: string): Promise<void> {
  await invoke("ensure_full_proxy", { mediaId });
}

/// Ask the backend to build the 720p quick preview proxy for a media on
/// demand (per-clip "Use proxy" / Unsupported-card recovery). Idempotent;
/// no-op on Bypass or when the quick proxy already exists.
export async function generateQuickProxy(mediaId: string): Promise<void> {
  await invoke("generate_quick_proxy", { mediaId });
}

/// Kick a conform job for one media if its VCONF file is absent (export
/// readiness gate + pre-conform-era backfill). No-op for media without an
/// audio stream or when already cached.
export async function ensureConform(mediaId: string): Promise<void> {
  await invoke("ensure_conform", { mediaId });
}

/// Drive-by "Analyze shots" for a media-pool item: warm the deterministic shot
/// report (VSHOT cache, shared with the agent's `analyze_clip` /
/// `auto_split_by_shot`) and return the detected shot count. The main-side
/// `analyze_shots` handler resolves the MediaItem and runs the whole-source
/// analysis through the shot napi. Best-effort — errors are logged and return
/// `null`, so a click never crashes the pool.
export async function analyzeShots(mediaId: string): Promise<number | null> {
  try {
    const r = await invoke<{ shots: number }>("analyze_shots", { mediaId });
    return r?.shots ?? null;
  } catch (err) {
    console.warn("[media-pool] analyze_shots failed", err);
    return null;
  }
}

/// "Mark shot cuts" for one VideoClip layer: materialize its detected shot
/// boundaries as timeline markers in ONE coalesced commit (a single undo step).
/// Reads the same VSHOT-cached report `analyzeShots` warms and the agent's
/// `auto_split_by_shot` splits on, so the markers land on exactly the frames
/// that tool would cut. Returns the number of markers added — `0` when the clip
/// has no interior cut.
///
/// Unlike `analyzeShots` this THROWS on failure rather than logging: it is a
/// write, and a silently-swallowed write would leave the timeline looking
/// unchanged with no reason given. The caller reports it.
export async function dropShotMarkers(layerId: string): Promise<number> {
  const r = await invoke<{ markers: number }>("drop_shot_markers", { layerId });
  return r?.markers ?? 0;
}

/// A per-shot event flag. Mirrors Rust `ShotFlag` (serde lowercase).
export type ShotFlag = "black" | "freeze" | "fade";

/// One candidate cut: the source-absolute time a new shot could begin, plus the
/// raw detector confidence. Mirrors Rust `Cut`, named here for the field it
/// arrives in (`ShotReport.cut_scores`) because a bare `Cut` in an editor reads
/// as an edit operation rather than as a measurement.
///
/// A candidate, not a decision: which of these become boundaries is what a
/// threshold decides.
export interface CutScore {
  t_us: number;
  score: number;
}

/// One shot — the span between two accepted boundaries. Mirrors Rust `Shot`.
///
/// `brightness` / `motion` / `sharpness` are absent unless the scan that
/// produced this span also sampled frames, and `flags` is empty on the same
/// condition. A span the reduce merged or truncated is a DIFFERENT shot from any
/// the scan measured, so its numbers are absent rather than inherited from a
/// neighbour — absent must render as absent, never as zero.
export interface Shot {
  index: number;
  t_start_us: number;
  t_end_us: number;
  /// A representative cover-frame time (the span midpoint), the argument
  /// `getMediaFrame` takes for this shot's still.
  keyframe_t_us: number;
  brightness?: number | null;
  motion?: number | null;
  sharpness?: number | null;
  flags: ShotFlag[];
}

/// The shot list plus the raw candidate signal, both clipped to the analyzed
/// window. Mirrors Rust `ShotReport`. Times are SOURCE-absolute: a report
/// belongs to a source, while every apply step belongs to a layer.
export interface ShotReport {
  shots: Shot[];
  cut_scores: CutScore[];
}

/// The threshold the floor scan runs at — the lowest a threshold control can
/// offer, because nothing below it was ever emitted.
export async function shotFloorSensitivity(): Promise<number> {
  return invoke<number>("shot_floor_sensitivity");
}

/// The detection defaults every omitted parameter resolves to, as Rust states
/// them. A review surface seeds its threshold from here rather than from a
/// literal of its own: a literal would be free to drift from the value the
/// zero-argument apply and the agent's `analyze_clip` both use, and the rows
/// the user reviewed would then name different cuts from the ones an apply
/// makes.
///
/// `min_shot_us` is output granularity, not accuracy — `build_shots` only drops
/// boundaries closer together than it — so the two numbers fix different errors
/// and no control should present them alike.
export interface ShotDefaultOpts {
  sensitivity: number;
  min_shot_us: number;
}

export async function shotDefaultOpts(): Promise<ShotDefaultOpts> {
  return invoke<ShotDefaultOpts>("shot_default_opts");
}

/// The whole-source floor scan for one media. EXPENSIVE the first time (a full
/// decode pass) and a cache hit afterwards, so call it behind a deliberate
/// action, never on selection — ask `shotFloorReportCached` first.
export async function analyzeShotsFloor(mediaId: string): Promise<ShotReport> {
  return invoke<ShotReport>("analyze_shots_floor", { media_id: mediaId });
}

/// Whether a source's floor scan is already on disk. A probe: it stats the
/// cached report and never starts a scan, which is what makes it safe on every
/// selection change.
export async function shotFloorReportCached(
  mediaId: string,
): Promise<boolean> {
  return invoke<boolean>("shot_floor_report_cached", { media_id: mediaId });
}

/// Re-derive a shot list from an already-scanned report at a threshold and
/// minimum shot length, viewed through `[inUs, outUs]`. Pure and cheap — no
/// decode, no file touched — so a threshold can be dragged live.
///
/// `sensitivity` reads backwards on purpose: it is a THRESHOLD, so a higher
/// value yields FEWER cuts. It survives as a field name only; a control shows
/// the line's position over the candidates it crosses.
///
/// A value below `shotFloorSensitivity()` cannot invent candidates the scan
/// never emitted — the answer is simply the scan's own set.
export async function reduceShotReport(
  report: ShotReport,
  params: {
    sensitivity: number;
    minShotUs: number;
    inUs: number;
    outUs: number;
  },
): Promise<ShotReport> {
  return invoke<ShotReport>("reduce_shot_report", {
    report,
    sensitivity: params.sensitivity,
    min_shot_us: params.minShotUs,
    in_us: params.inUs,
    out_us: params.outUs,
  });
}

/// One measured span: the same four measurements a `Shot` carries, keyed by the
/// span they were taken over. Mirrors Rust `SpanStats`.
///
/// Not optional here, unlike on `Shot`: a span either has a measurement or has
/// no entry at all, because the three frames that answer one question answer
/// all four.
export interface SpanStats {
  t_start_us: number;
  t_end_us: number;
  brightness: number;
  motion: number;
  sharpness: number;
  flags: ShotFlag[];
}

/// Measure the given spans of one source and answer for all of them, in request
/// order.
///
/// EXPENSIVE per span nothing has measured yet — three ffmpeg extracts each —
/// and a cache hit per span something has, so the cost of a call is the number
/// of spans a threshold move actually reshaped. Only a deliberate press may
/// reach it: the floor scan is timing-only by design (ADR 0057), and an
/// automatic pass over every reduce would re-couple the cost of a review to the
/// threshold, which is the property that split exists to remove.
///
/// A span is matched EXACTLY. Times are source-absolute, `t_end_us` exclusive,
/// and a span outside `[0, duration]` is refused by index rather than clamped.
export async function attachShotStats(
  mediaId: string,
  spans: { t_start_us: number; t_end_us: number }[],
): Promise<SpanStats[]> {
  return invoke<SpanStats[]>("attach_shot_stats", {
    media_id: mediaId,
    spans,
  });
}

/// Apply shot boundaries to one VideoClip layer. Snake_case because these are
/// the hybrid arm's own argument names and it reads them straight off the
/// forwarded object.
///
/// `cuts_src_us` is the reviewed list — source-absolute microseconds, strictly
/// ascending, each strictly inside the clip's source window. Omit it and the
/// detector supplies the boundaries at `sensitivity` / `min_shot_us`, each
/// falling back to the detection default; that is the path a zero-argument
/// entry takes. A malformed list is refused whole (structured `InvalidArgument`
/// on `cuts_src_us`, naming the offending index) and nothing is written.
///
/// `mode` picks the verb over that one list: `split` cuts at every boundary,
/// `mark` writes an anchored marker at each instead, and `discard` splits and
/// then deletes the segments the reviewer unchecked — all three in one commit,
/// one undo entry.
export interface ApplyShotCutsArgs {
  layer_id: string;
  mode: "split" | "mark" | "discard";
  cuts_src_us?: number[];
  sensitivity?: number;
  min_shot_us?: number;
  /// Delete any resulting segment shorter than this within the SAME commit.
  /// Split-only — a marker has no length to be short.
  drop_short_us?: number;
  /// Which segments `discard` deletes: 0-based indices in timeline order over
  /// the `cuts + 1` segments the split produces, numbered BEFORE any
  /// `drop_short_us` pruning so a row can be named off the cut list alone.
  /// Read only in `discard` mode, where it is required — absent or empty is
  /// refused, because keeping every segment is what `split` is. A set naming
  /// EVERY segment is refused too: erasing the whole clip is a delete, not an
  /// apply.
  discard_segments?: number[];
}

/// What one apply produced, discriminated by the verb asked for: segments are
/// not markers, and a caller that has to sniff which it got would be a caller
/// free to mis-read one as the other.
///
/// `split` with no interior boundary answers with the unchanged layer id and
/// `mark` with an empty list — an idempotent no-op that writes no history
/// entry, rather than an error. `discard` has no such case: with no boundary
/// the clip is one segment, and the set can only be naming that.
///
/// `discard`'s `layer_ids` are the segments that SURVIVED, in timeline order —
/// the discarded ones are gone, not listed.
export type ApplyShotCutsResult =
  | { mode: "split"; layer_ids: string[] }
  | { mode: "mark"; marker_ids: string[] }
  | { mode: "discard"; layer_ids: string[] };

/// Split at, mark, or split-and-discard a clip's shot boundaries in ONE commit
/// (one undo entry). Every verb consumes the same canonical cut list, so a
/// split and a mark of the same request land on identical frames, and a
/// discard's survivors sit on exactly the boundaries a plain split would have
/// produced.
///
/// THROWS, like every write here: a swallowed failure would leave the timeline
/// looking untouched with no reason given.
export async function applyShotCuts(
  args: ApplyShotCutsArgs,
): Promise<ApplyShotCutsResult> {
  return invoke<ApplyShotCutsResult>("apply_shot_cuts", { ...args });
}

// ============================================================
// Speech — transcription and voiceover
// ============================================================
// The renderer half of the two authored speech recipes. Every channel here is
// the SAME tool an agent calls by the same name: `transcribe_clip` and
// `describe_clip` go through the MCP host's own `callClipComputeTool` (slice
// resolution and engine injection included), and `apply_subtitles` /
// `synthesize_speech` go through the same hybrid arms, so a human and an agent
// land the same single commit.
//
// All four THROW. They are the read and write halves of one gesture, and a
// swallowed failure would leave the timeline looking untouched with no reason
// given; the calling dialog shows the message inline and logs a row.

/// One word of a transcript with its own span. Times are timeline-absolute
/// microseconds, already shifted by the slice's offset. Mirrors `speech::Word`.
export interface TranscriptWord {
  t_start_us: number;
  t_end_us: number;
  text: string;
}

/// One cue-sized span. `words` is empty when the engine reported no word-level
/// timing at all (`word_timing: "none"`). Mirrors `speech::Segment`.
export interface TranscriptSegment {
  t_start_us: number;
  t_end_us: number;
  text: string;
  words: TranscriptWord[];
}

/// Provenance of the per-word timestamps: straight from the engine's token
/// offsets, derived by splitting a cue span across its words, or absent.
/// Mirrors `speech::WordTiming` (serde snake_case).
export type WordTiming = "exact" | "interpolated_from_cue" | "none";

/// What `transcribe_clip` answers with. `backend` names the engine that actually
/// served the request, so a resolver fallback is visible rather than silent.
/// `srt` is the rendered cue body — the argument `applySubtitles` takes, which
/// is why a caller never has to walk `segments` to apply a transcript.
export interface TranscriptResult {
  backend: string;
  segments: TranscriptSegment[];
  language?: string | null;
  word_timing: WordTiming;
  srt: string;
}

/// Transcribe one VideoClip or Audio layer's whole span. The engine is chosen by
/// the user's Settings → Transcription preference then availability; when
/// nothing is configured the call rejects with the message that names that
/// panel. `language` blank/omitted lets the engine auto-detect.
///
/// A read: it commits nothing, so it neither enters undo nor dirties the
/// project. Applying the result is `applySubtitles`.
export async function transcribeClip(
  layerId: string,
  opts: { language?: string } = {},
): Promise<TranscriptResult> {
  const language = opts.language?.trim();
  return invoke<TranscriptResult>("transcribe_clip", {
    layer_id: layerId,
    ...(language ? { language } : {}),
  });
}

/// Parse an SRT body and write it as a caption-role track of `Text` layers in
/// ONE commit (`add_caption_track`), so a whole transcript is one undo step.
/// Returns the new track id. Cues self-position from their own timestamps —
/// there is no start/end argument.
///
/// `format` is pinned rather than sniffed: the only body this reaches is the
/// `srt` field of a `transcribe_clip` result. That pin is also what makes the
/// arm's bare-id answer exact — the styling annotation it can append belongs to
/// the ASS branch, which SRT never takes.
export async function applySubtitles(srt: string): Promise<string> {
  return invoke<string>("apply_subtitles", { body: srt, format: "srt" });
}

/// Voiceover request. Snake_case because these are the Rust tool's own argument
/// names and the hybrid arm reads them straight off the forwarded object — one
/// wire schema for both callers.
export interface SynthesizeSpeechArgs {
  /// The script. The provider caps a single call at 4096 characters; the dialog
  /// enforces that in the field rather than letting the request fail.
  text: string;
  voice: string;
  /// Playback rate. Omitted at the provider default (1.0) rather than sent as
  /// `1`: the TTS cache keys an absent speed apart from an explicit 1.0, so
  /// sending it would bill a fresh request for a script an agent's
  /// default-speed call already produced, and vice versa.
  speed?: number;
  /// The Audio track the layer lands on. Passed explicitly by the dialog even
  /// when it matches the default the hybrid would have picked, so where the
  /// audio goes is never a hidden decision.
  target_track_id?: string;
  /// Timeline start in microseconds, in the ROOT composition's clock.
  t_start_us?: number;
}

/// What one synthesis produced. `cached` is true when the request hit the
/// content-addressed cache — same `(model, voice, speed, text)`, so no API call
/// was billed.
export interface SynthesizeSpeechResult {
  layer_id: string;
  media_id: string;
  t_start_us: number;
  t_end_us: number;
  cached: boolean;
}

/// Synthesize a script and attach it as an Audio layer in ONE commit, so one
/// undo removes the layer. Rejects with the resolver's own actionable message
/// when no TTS provider is configured.
///
/// Parses, because the hybrid arm answers with a JSON STRING: its shape is set
/// by the MCP side, where every result becomes one `ToolResult` text block
/// (`main/state/hybrids.ts` states that contract). Peeling it here keeps the
/// arm single and the caller typed.
export async function synthesizeSpeech(
  args: SynthesizeSpeechArgs,
): Promise<SynthesizeSpeechResult> {
  const json = await invoke<string>("synthesize_speech", { ...args });
  return JSON.parse(json) as SynthesizeSpeechResult;
}

// ============================================================
// Silence — detect and mark
// ============================================================
// The two halves of the authored `cut-silences` recipe this editor can honour:
// find the silent ranges, and mark them. The apply half of that recipe needs a
// ripple delete which does not exist here, so nothing below removes anything —
// what lands is a region marker per range, on the waveform the timeline already
// draws.
//
// Both THROW, like every write and every dialog-driven read here: the dialog
// shows the message inline and logs a row.

/// One silent range in the clip's own composition clock — timeline-absolute and
/// already clipped to the layer's span, so a caller never maps source time
/// itself. Mirrors Rust `SilenceRegion` (`native/src/mcp/tools.rs`).
export interface SilenceRegion {
  t_start_us: number;
  t_end_us: number;
}

/// Detect one VideoClip or Audio layer's silent ranges. Reads the PRE-COMPUTED
/// waveform peaks — no decode — which is what makes re-running it on every
/// parameter change affordable, and why the silence dialog's controls are live
/// where the shot Panel's threshold needed a Rust split to become so.
///
/// A read: it commits nothing, so it neither enters undo nor dirties the
/// project. Marking the result is `markSilences`.
///
/// Rejects while the source's waveform job is still running, with a message
/// naming the `media:job_complete` event to wait for — a real state on a fresh
/// import, and one the caller is expected to WAIT on rather than report
/// (`silence/SilenceDialog.tsx`). `threshold_amp` and `min_silence_us` are
/// omitted rather than defaulted here so Rust's own defaults decide.
export async function detectSilences(args: {
  layerId: string;
  thresholdAmp?: number;
  minSilenceUs?: number;
}): Promise<SilenceRegion[]> {
  return invoke<SilenceRegion[]>("detect_silences", {
    layer_id: args.layerId,
    ...(args.thresholdAmp === undefined ? {} : { threshold_amp: args.thresholdAmp }),
    ...(args.minSilenceUs === undefined ? {} : { min_silence_us: args.minSilenceUs }),
  });
}

/// Detect and mark in ONE commit (one undo entry): a region marker per silent
/// range, in the clip's own composition, anchored to the clip so trimming past
/// one hibernates its mark and deleting the clip takes them all (ADR 0056).
/// Detection re-runs inside the same call at the parameters given, so the marks
/// can never be a set the preview did not show.
///
/// `markers` is `0` with no commit at all when nothing is silent above the
/// threshold — re-tuning and re-running costs no undo steps.
export async function markSilences(args: {
  layerId: string;
  thresholdAmp?: number;
  minSilenceUs?: number;
}): Promise<{ markers: number; marker_ids: string[] }> {
  return invoke<{ markers: number; marker_ids: string[] }>("mark_silences", {
    layer_id: args.layerId,
    ...(args.thresholdAmp === undefined ? {} : { threshold_amp: args.thresholdAmp }),
    ...(args.minSilenceUs === undefined ? {} : { min_silence_us: args.minSilenceUs }),
  });
}

/// Export-readiness audio gate (Rust `ensure_export_audio_conform`): media
/// ids of audible in-range audio layers whose conform cache is absent or
/// invalid, each with a conform job kicked. Selection mirrors the Rust mix
/// plan exactly (track mute/solo, layer lock/mute, window overlap, real
/// cache-file validation). Register conform job listeners BEFORE calling
/// (`createConformTracker`) so a fast job can't complete unseen.
export async function ensureExportAudioConform(range: {
  startUs: number;
  endUs: number;
}): Promise<string[]> {
  return invoke<string[]>("ensure_export_audio_conform", {
    startUs: range.startUs,
    endUs: range.endUs,
  });
}

/// Push the preview master-bus meter reading to Rust (~2 Hz while playing)
/// for the MCP `composition://meter` resource. Clamp non-finite dB values
/// before calling — JSON cannot carry -Infinity.
export async function reportAudioMeter(report: {
  rmsDb: number;
  peakDb: number;
}): Promise<void> {
  await invoke("report_audio_meter", { report });
}

// ============================================================
// Content description — describe, and read back what was described
// ============================================================
// The two halves of scene description: run a local vision model over a clip's
// frames, and read the cache a previous run left. `describeClip` is the only
// one that can spend the ~20 s a model costs; `getMediaDescription` never
// computes, which is what lets a Panel ask for it on every selection change.
//
// `describeClip` THROWS, like every dialog-driven compute here — the dialog
// shows the message inline and logs a row. `getMediaDescription` answers `null`
// for the two "nothing to read" states and throws only on a real failure.

/// One described span: a window of the SOURCE plus the model's prose and the
/// tags it extracted. Times are source-absolute microseconds, which is what
/// makes a shot row's own source span the only join needed. Mirrors Rust
/// `DescSegment` (`native/src/vlm/description.rs`).
export interface DescSegment {
  t_start_us: number;
  t_end_us: number;
  text: string;
  tags: string[];
}

/// What `describe_clip` answers with. `backend` and `model` name the engine that
/// actually served the request, so a resolver fallback is visible rather than
/// silent. Mirrors Rust `SceneDescription`.
export interface SceneDescription {
  backend: string;
  model: string;
  segments: DescSegment[];
}

/// The range-lazy cache value behind `media://{id}/description`: which source
/// ranges have been described, and every segment described so far. Mirrors Rust
/// `DescriptionCache`.
///
/// `covered_ranges` is what distinguishes "this stretch holds nothing worth
/// describing" from "this stretch was never looked at" — a described range with
/// no segment in it is a real answer.
export interface DescriptionCache {
  covered_ranges: [number, number][];
  segments: DescSegment[];
}

/// What the model is asked to attend to: the general scene, or the shot type and
/// camera work. Mirrors Rust `Focus` (the wire tags, hyphen included).
export type DescribeFocus = "general" | "shot-type";

/// Describe one VideoClip layer's window with a video-understanding model. The
/// engine is chosen by the user's Settings → Video understanding preference then
/// availability; when nothing is configured the call rejects with the message
/// that names that panel.
///
/// A read: it commits nothing, so it neither enters undo nor dirties the
/// project. What it writes is its own content-addressed cache, keyed by
/// `(source, backend, model, fps, focus)` — so a second call over a window the
/// same key already covers returns from disk with no model spawn.
///
/// `t_start_us` / `t_end_us` default to the layer's own endpoints in Rust, and
/// `fps` / `focus` are omitted rather than defaulted here so Rust's defaults
/// decide — `detectSilences`' rule. Sending an explicit value equal to the
/// default would key the same cache entry, but it would also put a second
/// statement of that default in TypeScript.
export async function describeClip(args: {
  layerId: string;
  tStartUs?: number;
  tEndUs?: number;
  fps?: number;
  focus?: DescribeFocus;
}): Promise<SceneDescription> {
  return invoke<SceneDescription>("describe_clip", {
    layer_id: args.layerId,
    ...(args.tStartUs === undefined ? {} : { t_start_us: args.tStartUs }),
    ...(args.tEndUs === undefined ? {} : { t_end_us: args.tEndUs }),
    ...(args.fps === undefined ? {} : { fps: args.fps }),
    ...(args.focus === undefined ? {} : { focus: args.focus }),
  });
}

/// The description cached for one source's DEFAULT view — the resolver's default
/// engine at the default sampling and focus — or `null` when there is nothing
/// there to read.
///
/// `null` covers both nothing-described-yet and no-engine-configured, because a
/// row that has no description has one empty state either way. Which of the two
/// it is matters only where something can be done about it, and that is the
/// describe dialog, which gets the engine's own sentence.
///
/// Never computes: this is the read path a Panel may issue on every selection
/// change. `describeClip` is the only call that spends a model.
export async function getMediaDescription(
  mediaId: string,
): Promise<DescriptionCache | null> {
  return invoke<DescriptionCache | null>("get_media_description", {
    media_id: mediaId,
  });
}

// ============================================================
// Motifs
// ============================================================

/// Discriminated union mirroring `PropSpec` in `src/shared/motifs/catalog.ts`
/// (which `render/motifs/catalog.ts` re-exports). The picker and the property
/// panel both render through the one shared form generator (`MotifPropField`,
/// renderer/properties/MotifPropFields.tsx). A new prop type must be added in
/// three places: here, in the shared catalog, AND in that generator.
/// `enum` renders as a dropdown; `string.multiline` renders as a textarea.
export type PropSpec =
  | { type: "string"; default: string; max_length?: number; multiline?: boolean }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number }
  | { type: "enum"; default: string; options: string[] };

/// One catalog entry from `list_motifs()`. Mirrors the MCP `list_motifs`
/// manifest payload.
export interface MotifSummary {
  id: string;
  name: string;
  version: number;
  /// `[width, height]` in pixels — the document size the capture engine uses.
  size: [number, number];
  default_duration_s: number;
  /// Optional hard cap on a placed layer's total length, in seconds. When
  /// present, the timeline forbids trimming/adding the motif longer than
  /// this; when absent the motif is freely extendable (holdable overlays).
  /// Static fallback — overridden live by `max_duration_prop` when that names
  /// a prop carrying a valid value.
  max_duration_s?: number;
  /// Optional name of a NUMBER prop whose current value (in seconds) is the
  /// layer's length cap. When set, editing that prop changes the cap live;
  /// falls back to `max_duration_s` when the prop is missing/invalid.
  max_duration_prop?: string;
  /// Fixed bake duration of the animation sequence in seconds (does not
  /// include the holdable tail). When present, `syncCatalog` can forward it
  /// to `MotifManifest` without a double-cast.
  content_duration_s?: number;
  /// Number of rAF ticks the capture engine waits for settle before
  /// snapshotting. Forwarded verbatim from the Rust manifest.
  settle_rafs?: number;
  status?: "builtin" | "installed" | "draft";
  content_hash?: string;
  /// The installed Motif id this draft was forked from (`create_edit_draft`).
  /// Present only on edit-mode drafts; absent for new drafts and installed/builtin entries.
  target_id?: string;
  /// True when a `params.html` sits next to this Motif's `index.html`, i.e. the
  /// Motif owns its parameter UI and the property panel embeds that page
  /// instead of generating the fallback form. Presence of the file is the whole
  /// switch — additive catalog metadata, NOT a `props_schema` / `PropSpec`
  /// change (the data plane above is frozen).
  has_params_ui?: boolean;
  /// Keyed by prop name, in the manifest's authored key order (the TS payload
  /// spreads the manifest as-is) — the fallback form renders rows in this
  /// order. Only the props VALUES object is canonicalized alphabetically.
  props_schema: Record<string, PropSpec>;
}

export async function listMotifs(): Promise<MotifSummary[]> {
  return invoke<MotifSummary[]>("list_motifs");
}

/// Add a motif layer. Mirrors the MCP `add_motif` tool's behavior:
/// - `t_end_us` defaults to `t_start_us + default_duration_s * 1e6`.
/// - `track_id` defaults to first existing Video track or auto-creates
///   one labeled "Motifs".
/// - `props` is validated against the motif's `props_schema`; unknown
///   keys reject, missing keys fall back to defaults.
export async function addMotif(args: {
  motifId: string;
  tStartUs: number;
  tEndUs?: number;
  // Explicit `| undefined` so callers can pass an "auto track" undefined
  // through under `exactOptionalPropertyTypes`.
  trackId?: string | undefined;
  props?: Record<string, unknown>;
}): Promise<string> {
  return invoke<string>("add_motif", {
    motifId: args.motifId,
    tStartUs: args.tStartUs,
    tEndUs: args.tEndUs,
    trackId: args.trackId,
    props: args.props,
  });
}

// ============================================================
// Motif lifecycle IPC wrappers
// ============================================================

/// The event the backend emits after a user-Motif lifecycle mutation (emit
/// sites: `src/main/state/ts-actor-host.ts`, `src/main/motif/watcher.ts`).
export const MOTIFS_CHANGED_EVENT = "motifs:changed";

export interface MotifSource {
  manifest: MotifManifest;
  html: string;
}

export async function getMotifSource(id: string): Promise<MotifSource> {
  return invoke<MotifSource>("get_motif_source", { id });
}

/// Write a draft from authored `{ manifest, html }`. Returns the assigned draft id.
export async function writeMotifDraft(manifest: MotifManifest, html: string): Promise<string> {
  return invoke<string>("write_motif_draft", { args: { manifest, html } });
}

/// Install a draft. `mode` is `{ kind: "new" }` or `{ kind: "update", target_id }`.
export async function installMotif(
  draftId: string,
  mode: { kind: "new" } | { kind: "update"; target_id: string },
): Promise<string> {
  return invoke<string>("install_motif", { args: { draft_id: draftId, mode } });
}

export async function deleteMotif(id: string): Promise<void> {
  await invoke("delete_motif", { id });
}

/// Overwrite an existing draft from its full edited source (in-app source panel).
/// Keeps the draft id stable; the backend re-parses the manifest island, forces
/// id/version, re-composes, and emits `motifs:changed`.
export async function amendMotifDraft(draftId: string, source: string): Promise<void> {
  await invoke("amend_motif_draft", { draftId, source });
}

/// Open a working draft seeded from an installed/built-in Motif (Edit). Built-in
/// → forced fork (no Update target). Returns the working draft id.
export async function createEditDraft(sourceId: string): Promise<string> {
  return invoke<string>("create_edit_draft", { sourceId });
}

/// Import an external `.html` Motif file (an absolute path from the OS dialog) as
/// a draft. Returns the new draft id.
export async function importMotif(path: string): Promise<string> {
  return invoke<string>("import_motif", { path });
}

/// One row of the on-open staleness report (docs/motifs.md "User Motifs"):
/// a Motif some placed layers saw at an older version than the catalog's
/// current. `placed_version` is the lowest seen-at version among them.
export interface MotifStaleEntry {
  motif_id: string;
  name: string;
  placed_version: number;
  current_version: number;
  layer_count: number;
}

/// Compare every placed Motif layer's seen-at `motif_version` against the
/// current catalog. Called once by App on mount (= once per project open).
export async function motifStalenessReport(): Promise<MotifStaleEntry[]> {
  return invoke<MotifStaleEntry[]>("motif_staleness_report");
}

/// Dismiss-=-acknowledge: bump all stale layers' seen-at markers to the
/// current version (one undo entry). Returns the number of layers bumped.
export async function acknowledgeMotifStaleness(): Promise<number> {
  return invoke<number>("acknowledge_motif_staleness");
}

// ============================================================
// Status / log surface (see `docs/status-log.md`)
// ============================================================

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogCategory =
  | { kind: "Shortcut" }
  | { kind: "Mcp" }
  | { kind: "Job" }
  | { kind: "Export" }
  | { kind: "Import" }
  | { kind: "Project" }
  | { kind: "System" }
  | { kind: "Agent" }
  | { kind: "Other"; name: string };

export type LogSource =
  | { kind: "User" }
  | { kind: "Agent"; client: string }
  | { kind: "System" };

export type OpState =
  | { state: "Started"; progress?: null }
  | { state: "Progress"; progress: number }
  | { state: "Ok"; progress?: null }
  | { state: "Err"; progress?: null };

export interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  category: LogCategory;
  source: LogSource;
  message: string;
  i18n_key?: string | null;
  i18n_args?: unknown;
  op_id?: string | null;
  op_state?: OpState | null;
  details?: unknown;
}

export type LogEntryInput = Omit<LogEntry, "id" | "ts">;

export const LOG_EVENTS = {
  entry: "log:entry",
} as const;

export async function logList(): Promise<LogEntry[]> {
  return invoke<LogEntry[]>("log_list");
}

export async function logClear(): Promise<void> {
  return invoke<void>("log_clear");
}

export async function logEmit(input: LogEntryInput): Promise<void> {
  return invoke<void>("log_emit", { input });
}

export async function logDirPath(): Promise<string | null> {
  return invoke<string | null>("log_dir_path");
}

// ============================================================
// Video-sink IPC — 10-bit export pipeline (native encode path)
// ============================================================

/// Arguments for the native-encode video sink. Mirrors `VideoSinkStartArgs`
/// in `export/videosink.rs` (serde camelCase).
export interface VideoSinkStartArgs {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  codec: string;
  /// Target (average) bitrate in bits per second → ffmpeg `-b:v`.
  bitrate: number;
  cbr: boolean;
  gop: number;
  software: boolean;
  outputPath: string;
  /// rawvideo format the worker packs: "yuv420p" | "yuv420p10le"
  /// (E3: "yuv422p" | "yuv422p10le"). Mirrors videosink.rs (serde default
  /// keeps omission = yuv420p10le, but callers should always set it).
  pixFmt: string;
  /// Constant-quality value (rateMode "quality"). Present ⇒ CRF/quality args
  /// replace -b:v. Only sent with software=true.
  crf?: number;
  /// Peak ceiling in bits per second → `-maxrate`. VBR only; omitted ⇒
  /// uncapped ABR. Ignored by the backend under `cbr` (peak = target there).
  maxBitrate?: number;
  /// VBV buffer in BITS → `-bufsize`. Omitted ⇒ the encoder registry derives
  /// it as 2× the ceiling.
  bufferSize?: number;
  /// Software-encoder speed preset: "fast" | "medium" | "slow".
  preset?: string;
  /// Intermediate-codec profile: prores proxy|lt|422|hq, dnxhr lb|sq|hq.
  profile?: string;
}

/// Start a native-encode video sink.
export function exportVideoSinkStart(args: VideoSinkStartArgs): Promise<void> {
  return invoke("export_video_sink_start", { args });
}

/// Finalize the video sink after all frames have been sent. Returns byte
/// count, frame count, and elapsed ms for diagnostics.
export function exportVideoSinkFinish(): Promise<{
  bytes: number;
  frames: number;
  elapsedMs: number;
}> {
  return invoke("export_video_sink_finish");
}

/// Abort a running sink (error / cancel paths). Safe to call even if the
/// sink has already finished — the backend no-ops on a dead sink.
export function exportVideoSinkCancel(): Promise<void> {
  return invoke("export_video_sink_cancel");
}

/// Stream a raw encoded chunk to the native sink. The bytes are forwarded
/// to ffmpeg's input pipe; call in sequence to preserve muxer order.
export function exportVideoSinkWrite(bytes: Uint8Array): Promise<void> {
  return window.api.videoSinkWrite(bytes);
}

/// Caption restyle patch. Fields are snake_case to match the actor
/// `CaptionStylePatch`.
export interface CaptionStylePatch {
  font_family?: string;
  font_size_px?: number;
  color?: Rgba;
  outline_width?: number;
}

/// Project-wide caption restyle: patch every caption-role Track's Text layers
/// atomically as one undo entry — the Caption Panel's corpus-level styling
/// command.
export async function restyleCaptions(patch: CaptionStylePatch): Promise<void> {
  return invoke<void>("restyle_captions", { patch });
}

// ============================================================
// Data location (user-managed data root)
// ============================================================
//
// Main-process actions (not backend/Rust commands) — thin wrappers over
// window.api.dataRoot.* (see src/preload/index.ts). Types are single-sourced in
// src/shared/data-root.ts and re-exported here for call sites. The copy
// migration's progress arrives on the `dataRoot:progress` event
// (DATA_ROOT_EVENTS.progress) — subscribe via the bridge event surface.

import type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
} from "../../shared/data-root";
export type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
  DataRootProgress,
} from "../../shared/data-root";
export { DATA_ROOT_EVENTS } from "../../shared/data-root";

/// The effective data root this process runs on, plus whether it is a fallback.
export async function dataRootCurrent(): Promise<DataRootCurrent> {
  return window.api.dataRoot.current();
}

/// Native folder picker → plan → (copy+verify OR adopt), emitting progress on
/// `dataRoot:progress`. On success writes `data_root` + a pending-delete marker
/// and returns ready-to-relaunch; on failure rolls back and returns the error.
/// Does NOT relaunch — call `dataRootRelaunch()` after showing success.
export async function dataRootPickAndMigrate(): Promise<DataRootMigrateResult> {
  return window.api.dataRoot.pickAndMigrate();
}

/// Relaunch the app onto the newly-written data root (app.relaunch + exit).
export async function dataRootRelaunch(): Promise<void> {
  return window.api.dataRoot.relaunch();
}

/// Open the effective data root in the OS file manager.
export async function dataRootOpenFolder(): Promise<void> {
  return window.api.dataRoot.openFolder();
}

/// After a successful relaunch onto a new root, the old copy awaiting deletion
/// (null when there is nothing pending, or the reboot didn't land on the new root).
export async function dataRootPendingCleanup(): Promise<DataRootPendingCleanup | null> {
  return window.api.dataRoot.pendingCleanup();
}

/// Delete the old copy recorded by the pending-delete marker, then clear it.
/// Only ever called on explicit user confirm — never auto-invoked.
export async function dataRootDeleteOld(): Promise<void> {
  return window.api.dataRoot.deleteOld();
}

/// Dismiss the delete-old prompt without deleting: keep the old copy on disk and
/// clear the marker so the prompt is one-time (no re-prompt on next launch).
export async function dataRootDismissCleanup(): Promise<void> {
  return window.api.dataRoot.dismissCleanup();
}

// ============================================================
// App-managed content downloads (ADR 0039)
// ============================================================
//
// Main-process actions (not backend/Rust commands) — thin wrappers over
// window.api.content.* (see src/preload/index.ts). Types are single-sourced in
// src/shared/content-download.ts and re-exported here for call sites. The
// running download's progress arrives on the `content:progress` event
// (CONTENT_EVENTS.progress) — subscribe via the bridge event surface.

import type {
  ContentDownloadResult,
  ContentListRow,
} from "../../shared/content-download";
export type {
  ContentDownloadProgress,
  ContentDownloadResult,
  ContentItem,
  ContentItemStatus,
  ContentListRow,
} from "../../shared/content-download";
export { CONTENT_EVENTS } from "../../shared/content-download";

/// The whole catalog merged with local install state, one row per item.
export async function contentList(): Promise<ContentListRow[]> {
  return window.api.content.list();
}

/// Start one item's download; resolves with the terminal result (cancellation
/// is its own quiet branch). Progress arrives on `content:progress`.
export async function contentDownload(id: string): Promise<ContentDownloadResult> {
  return window.api.content.download(id);
}

/// Abort an in-flight download; the matching contentDownload() call resolves
/// `{ ok: false, cancelled: true }` and the partial file is deleted.
export async function contentCancel(id: string): Promise<void> {
  return window.api.content.cancel(id);
}

/// Delete every installed version of an item (files only — speech config is
/// left alone; availability degrades truthfully on its own).
export async function contentRemove(id: string): Promise<void> {
  return window.api.content.remove(id);
}

/// Open the downloads bucket of the data root in the OS file manager.
export async function contentOpenFolder(): Promise<void> {
  return window.api.content.openFolder();
}
