// apps/desktop/src/main/state/hybrids.ts
//
// Native-compute → TS-write hybrid orchestrator. A write-bearing native
// channel splits into two halves: Rust does the heavy/impure COMPUTE
// (probe/hash/parse/synthesize) and hands back a serializable result; the TS
// host applies the WRITE through the authoritative TS actor. This file is the
// shared dispatcher both the renderer router (router.ts `{kind:'hybrid'}`)
// and the MCP handler (server.ts) call via the host's `hybridDeps`. One arm
// per hybrid tool.
import type { ActorHandle } from './actor'
import type { AudioParams, Composition, Layer, MediaItem, Rgba, VideoClipParams } from './model'
import { eachLayer, rootComposition } from './model'
import { parseDiscardSegments } from './mutations/split'
import { playsNoSoundError, resolvePauseSubject } from './pauseSubject'
import { snapFrameRound } from './snap'

/** Rust compute facade — each method runs a native (no-actor-write) computation
 *  and returns a serialized result. Built in index.ts from the Backend napi. */
export interface ComputeNapi {
  /** Probe a media file → serialized MediaItem JSON. Stat-only (instant
   *  appearance); the item carries a PROVISIONAL hash. (import_media) */
  probeMedia(path: string): Promise<string>
  /** Standalone BLAKE3 of a source file — the hash-first import's hash pass
   *  Run AFTER the stat-only probe + insert, BEFORE
   *  derivative enqueue, so jobs bake the real cache key. (Backend.hashMediaSource) */
  hashMediaSource(path: string): Promise<string>
  /** Parse a subtitle body → {cues, simplified, label} JSON. (apply_subtitles) */
  parseSubtitles(body: string, format: string | null): Promise<string>
  /** synthesize_speech: TTS + cache + probe → {media_item, …} JSON. */
  synthesizeSpeechCompute(argsJson: string): Promise<string>
  /** The WHOLE-source floor scan for a serialized MediaItem: `ShotReport` JSON
   *  `{shots,cut_scores}` in source-absolute time, from the VSHOT cache
   *  (computed and written through on a miss). The one expensive shot call —
   *  a single decode per source serves every threshold at or above the floor,
   *  and `reduceShotReport` re-derives the rest without touching a file.
   *
   *  Optional, like the three below: a build without the shot compute wired
   *  (some test harnesses) omits them, and the caller throws an actionable error
   *  rather than silently no-op. */
  analyzeShotsFloor?(mediaJson: string): Promise<string>
  /** Re-derive a shot list from an already-scanned report at `sensitivity` /
   *  `minShotUs`, viewed through `[inUs, outUs]`. Synchronous because it is
   *  pure. Sole producer of the canonical cut list, which is what keeps markers
   *  on exactly the frames splits land on. */
  reduceShotReport?(reportJson: string, sensitivity: number, minShotUs: number, inUs: number, outUs: number): string
  /** Whether a source's floor scan is already on disk. A probe, never a scan:
   *  the review surface asks it on every selection change, and clicking a clip
   *  must not be able to start a whole-source decode. */
  shotFloorReportCached?(mediaJson: string): Promise<boolean>
  /** The threshold the floor scan runs at — the lower bound any threshold
   *  control can offer, since nothing below it was ever emitted. Read from the
   *  scan rather than kept as a TS literal, which would be free to drift from
   *  the reports already on disk. */
  shotFloorSensitivity?(): number
  /** The detection defaults (`{ sensitivity, min_shot_us }`) every omitted
   *  parameter resolves to, on the agent's path and the human's alike. Read
   *  rather than mirrored, for the same reason as `shotFloorSensitivity`. */
  shotDefaultOpts?(): ShotDefaultOpts
  /** Pauses in one layer's PLAYED audio, TIMELINE-absolute and already clipped
   *  to the layer's span, from the pre-computed waveform peaks — no decode,
   *  which is what makes a live parameter control affordable.
   *
   *  Routed through the MCP `detect_pauses` tool rather than a bare napi
   *  method, so the subject + media + peaks slice is resolved by the one
   *  function the agent's call goes through too (`mcp/server.ts`
   *  `callClipComputeTool`). Rejects while the source's waveform job is still
   *  running; the message names the event to wait for, and the section waits
   *  on it.
   *
   *  Optional like the shot entries above: a build without it wired refuses
   *  with an actionable error rather than marking nothing. */
  detectPauses?(args: { layer_id: string; threshold_amp?: number; min_pause_us?: number }): Promise<DetectPausesResult>
}

/** One pause in the layer's OWN composition clock. Mirrors native `PauseRegion`
 *  serde (`native/src/mcp/tools.rs`); the renderer reads the same shape through
 *  its own mirror in `renderer/ipc`. */
export interface PauseRegion { t_start_us: number; t_end_us: number }

/** Which peaks file a detection actually read: the media's own (`raw`) or the
 *  effect chain's baked sibling (`fx`). Reported rather than assumed, so a
 *  surface can say which signal the bands describe. */
export type PeaksSource = 'raw' | 'fx'

/** `detect_pauses`' answer. Mirrors native `DetectPausesResult` serde.
 *
 *  `noise_floor_amp` is the 10th percentile of the folded peaks inside the
 *  subject's source window (0 when the window holds none) — it rides along
 *  with the walk that already touched every peak, and it is what gives the
 *  threshold control a referent. */
export interface DetectPausesResult {
  pauses: PauseRegion[]
  noise_floor_amp: number
  peaks_source: PeaksSource
}

/** The subset of a `jobs::shot::ShotReport` the split/marker orchestration
 *  reads: shot spans (source-absolute) whose interior boundaries become cuts.
 *  Mirrors native `Shot` / `ShotReport` serde. The renderer reads the full
 *  shape (scores, stats, flags) through its own mirror in `renderer/ipc`. */
interface ShotReportShot { t_start_us: number; t_end_us: number; keyframe_t_us: number }
interface ShotReport { shots: ShotReportShot[]; cut_scores: Array<{ t_us: number; score: number }> }

export type HybridDeps = {
  actor: ActorHandle
  compute: ComputeNapi
  /** Kick the existing derivative jobs (proxy/conform/thumb/waveform) for a set
   *  of pool items — thin wrapper over the Backend `enqueueJobsForMedia` napi. */
  enqueueDerivatives: (items: unknown[]) => Promise<void>
  /** Queue the background workspace-copy job for an inserted media item. No-op
   *  napi when no workspace; the copy's path/hash write-back is seam-routed. */
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<void>
  /** Current workspace dir, or null. Gate for the workspace-copy enqueue. */
  workspaceDir: () => string | null
  /** node:fs readFile (utf8) — for the subtitle hybrid. */
  readFile: (p: string) => string
  /** Current composition geometry — for caption layout / speech placement. */
  snapshotComposition: () => { width: number; height: number; duration_us: number }
}

/** Return the id of the topmost (last) track, or create a new "Voiceover"
 *  track and return its id. "Topmost" = last in the `tracks` array. */
function ensureAudioTrack(deps: HybridDeps): string {
  const root = rootComposition(deps.actor.snapshot())
  if (root.tracks.length > 0) {
    return root.tracks[root.tracks.length - 1].id
  }
  // No tracks at all — create a "Voiceover" track. Pathological-only branch:
  // production projects always carry the reserved, non-removable A/B-roll tracks,
  // so a zero-track project is unconstructable through the validated actor.
  const r = deps.actor.dispatch('add_track', { label: 'Voiceover' })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}

/** Parse a subtitle body via Rust (compute only) then write the caption track
 *  through the TS actor. Used by both the MCP `apply_subtitles` arm and the
 *  `import_media` `.srt`/`.ass`/`.vtt` branch.
 *
 *  Returns `{ track_id, simplified }`. Both call sites UNWRAP it: the renderer
 *  import branch returns the bare `track_id` string, and the MCP arm builds the
 *  `ToolResult::text` message. Do NOT return this object straight out of
 *  `runHybrid` — server.ts stringifies the hybrid result, so an object would
 *  surface as "[object Object]". */
async function applySubtitleBody(
  body: string,
  format: string | null,
  label: string | null,
  deps: HybridDeps,
): Promise<{ track_id: string; simplified: boolean }> {
  const { cues, simplified } = JSON.parse(await deps.compute.parseSubtitles(body, format)) as {
    cues: unknown[]
    simplified: boolean
  }
  const { width, height } = deps.snapshotComposition()
  const r = deps.actor.dispatch('add_caption_track', { cues, comp_w: width, comp_h: height, label })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return { track_id: r.value as string, simplified }
}

/** The detection defaults as Rust states them (`Backend::shot_default_opts`):
 *  what `reduce` gets for a parameter every human surface may leave out, and
 *  the threshold `analyze_clip` reports at. Read from the addon rather than
 *  mirrored as TS literals, so a default-parameter apply cannot drift from
 *  where the tool says the cuts are. */
export interface ShotDefaultOpts { sensitivity: number; min_shot_us: number }

/** The defaults, or a loud throw where the shot compute is not wired — the
 *  same rule the scan and the reduce follow. */
function shotDefaults(deps: HybridDeps): ShotDefaultOpts {
  const read = deps.compute.shotDefaultOpts
  if (!read) throw new Error('shot cuts: shot detection is not available in this build')
  return read()
}

/** One shot boundary as the PAIR it is: `tUs` is where the cut lands on the
 *  timeline, `srcUs` where it was detected in the source. Kept together because
 *  the snap-then-drop filter in `cutsToTimeline` decides which cuts survive by
 *  their TIMELINE time — a separately-filtered source list would eventually tie
 *  an anchor to a boundary that never became a cut. */
export interface ShotCut { tUs: number; srcUs: number }

/** What any apply verb needs to arrive at a cut list.
 *
 *  `cuts_src_us` present means the caller already decided the boundaries — a
 *  reviewed list with rows vetoed — and the detector is not consulted at all.
 *  Absent means detect at `sensitivity` / `min_shot_us`, each falling back to
 *  the detection default; that is the path the zero-argument clip-menu entries
 *  take.
 *
 *  The list is also what makes the discard verb — split, then delete the shots
 *  the reviewer unchecked, in one commit — cost exactly one extra field: the
 *  boundaries already say where the segments start, so all that is missing is
 *  which of them to keep. */
export interface ShotCutSpec {
  layer_id: string
  /** Source-absolute microseconds, ascending. Arrives UNCHECKED and is refused
   *  by `shotCutList`: only the resolved layer knows which times are interior
   *  to its own source window, and a refusal has to happen before any dispatch
   *  so a malformed list can never be half-applied. */
  cuts_src_us?: unknown
  sensitivity?: number
  min_shot_us?: number
  /** Delete any resulting segment shorter than this within the SAME commit.
   *  Split-only — a marker has no length to be short. */
  drop_short_us?: number
  /** Which of the segments the split produces to delete in the same commit —
   *  0-based indices in timeline order over `cuts + 1` segments, counted before
   *  any `drop_short_us` pruning. Arrives UNCHECKED for the same reason
   *  `cuts_src_us` does: only the resolved cut list knows how many segments
   *  there are to name, and the refusal has to land before any dispatch.
   *  Split-only. */
  discard_segments?: unknown
}

/** The layer with this id and the composition holding it, or `undefined` for
 *  the layer when the project has no such layer. Shared by the two analysis
 *  resolvers below, which differ only in the KIND they admit and the prose they
 *  refuse with — the walk itself has one right answer. */
function findLayer(layerId: string, deps: HybridDeps): { layer: Layer | undefined; composition: Composition } {
  const snap = deps.actor.snapshot()
  for (const e of eachLayer(snap)) {
    if (e.layer.id === layerId) return { layer: e.layer, composition: e.composition }
  }
  return { layer: undefined, composition: rootComposition(snap) }
}

/** Resolve the VideoClip layer a shot operation names, together with the media
 *  it reads and the composition its times are expressed in. Throws (never
 *  silently no-ops) on a missing or non-video layer, or on media the pool has
 *  lost. */
function resolveShotLayer(
  layerId: string,
  deps: HybridDeps,
): { layer: Layer; media: MediaItem; params: VideoClipParams; composition: Composition } {
  const { layer, composition } = findLayer(layerId, deps)
  if (!layer) throw new Error(`shot cuts: layer ${layerId} not found`)
  if (layer.params.kind !== 'VideoClip')
    throw new Error(`shot cuts: layer ${layerId} is not a VideoClip — shots are a video concept`)
  const params = layer.params
  const media = (deps.actor.snapshot().media_pool as Record<string, MediaItem>)[params.media]
  if (!media) throw new Error(`shot cuts: layer ${layerId} references missing media ${params.media}`)
  return { layer, media, params, composition }
}

/** Resolve the AUDIO layer a pause operation acts on, refusing in the CALLER'S
 *  verb — `verb` opens every message here, so a removal never reports itself as
 *  a mark.
 *
 *  Both verbs target the subject and not the layer the caller named: a pause is
 *  a fact about the audio that plays, so a VideoClip delegates to its linked
 *  Audio partner (`pauseSubject.ts`, spec Decision 1) and the picture follows
 *  through the link fan-out the split already does. A `CompositionRef` is not a
 *  subject even though it carries a source window: a Group has no waveform of
 *  its own to read. */
function resolvePauseTarget(
  layerId: string,
  deps: HybridDeps,
  verb: string,
): { subject: Layer; params: AudioParams; composition: Composition } {
  const snapshot = deps.actor.snapshot()
  const resolved = resolvePauseSubject(layerId, snapshot)
  if (!resolved.ok) {
    if (resolved.reason === 'not_found') throw new Error(`${verb}: layer ${layerId} not found`)
    throw playsNoSoundError(verb, layerId, snapshot)
  }
  // The subject is an Audio layer by construction; the narrowing is for the
  // type system, not a branch that can be taken.
  const { subject, composition } = resolved
  if (subject.params.kind !== 'Audio') throw playsNoSoundError(verb, layerId, snapshot)
  return { subject, params: subject.params, composition }
}

/** Turn source-time boundaries into the cuts a split can actually take: map
 *  source→timeline at speed=1 (variable speed deferred, matching `split_layer`
 *  itself), snap each to the composition's frame grid, then drop any that lands
 *  on a layer bound or on a frame a previous cut already claimed.
 *
 *  The ONLY place either apply verb quantizes, and that is what makes "markers
 *  land on exactly the frames splits land on" structural instead of a
 *  convention two call sites happen to share. The snap-then-drop order is
 *  load-bearing: the timeline is frame-quantized and `applySplitLayer` rejects a
 *  split whose SNAPPED time is not strictly interior, so two source boundaries
 *  less than one frame apart would otherwise abort the whole multi-split.
 *
 *  The layer-bound drop is also what enforces "strictly inside the clip" — at
 *  speed 1 the source window `[src_in_us, src_out_us]` maps onto exactly
 *  `[t_start_us, t_end_us]`, so a boundary outside the window cannot survive
 *  the bound check either. */
export function cutsToTimeline(
  srcCutsUs: readonly number[],
  layer: Pick<Layer, 't_start_us' | 't_end_us'>,
  params: Pick<VideoClipParams, 'src_in_us'>,
  fps: { num: number; den: number },
): ShotCut[] {
  const seen = new Set<number>()
  const cuts: ShotCut[] = []
  for (const srcUs of srcCutsUs) {
    const t = snapFrameRound(layer.t_start_us + (srcUs - params.src_in_us), fps.num, fps.den)
    if (t <= layer.t_start_us || t >= layer.t_end_us || seen.has(t)) continue
    seen.add(t)
    cuts.push({ tUs: t, srcUs })
  }
  cuts.sort((a, b) => a.tUs - b.tUs)
  return cuts
}

/** Detect a VideoClip layer's shot boundaries as cut times in the layer's OWN
 *  composition: one whole-source floor scan (VSHOT-cached, so a second call on
 *  the same source skips ffmpeg) narrowed by the pure Rust `reduce` to the
 *  layer's window at the asked-for threshold and spacing, then mapped onto the
 *  frame grid by `cutsToTimeline`.
 *
 *  A consumer of `reduce`, never a second producer: re-implementing the
 *  score filter and the min-spacing merge here would twin the invariant the
 *  Rust unit tests already pin.
 *
 *  Every number returned is expressed in the LAYER'S composition — the frame
 *  grid is its `fps`, the origin is the layer's own `t_start_us` — so
 *  `compositionId` rides out beside the cuts. A layer-addressed write derives
 *  that scope itself and ignores it; anything else (markers) has to be scoped
 *  with it, or it lands in the root carrying times that mean nothing there. */
async function resolveShotCuts(
  layerId: string,
  opts: { sensitivity?: number; minShotUs?: number },
  deps: HybridDeps,
): Promise<{ compositionId: string; cuts: ShotCut[] }> {
  const scan = deps.compute.analyzeShotsFloor
  const reduce = deps.compute.reduceShotReport
  if (!scan || !reduce) throw new Error('shot cuts: shot detection is not available in this build')
  const { layer, media, params, composition } = resolveShotLayer(layerId, deps)
  const defaults = shotDefaults(deps)
  const scanned = await scan(JSON.stringify(media))
  const reduced = JSON.parse(reduce(
    scanned,
    opts.sensitivity ?? defaults.sensitivity,
    opts.minShotUs ?? defaults.min_shot_us,
    params.src_in_us,
    params.src_out_us,
  )) as ShotReport
  // Every span's opening time is a candidate boundary; the window edges among
  // them are dropped by cutsToTimeline's bound check rather than filtered twice.
  const srcCuts = reduced.shots.map((s) => s.t_start_us)
  return { compositionId: composition.id, cuts: cutsToTimeline(srcCuts, layer, params, composition.fps) }
}

/** Structured refusal for a caller-supplied argument, shaped so the renderer's
 *  `parseCommandError` can name the field and show the detail. */
function refuseArg(field: string, detail: string): never {
  throw new Error(JSON.stringify({ error: 'InvalidArgument', field, detail }))
}

/** Validate a caller-filtered list of source-time boundaries against the
 *  layer's own window: finite numbers, strictly ascending, each strictly
 *  interior. Refuses on the FIRST offender and names its index, because a list
 *  the user assembled row by row is worth pointing at rather than silently
 *  pruning — and because the refusal has to land before any dispatch, so a bad
 *  list is never half applied. */
function validateExplicitCuts(raw: unknown, params: VideoClipParams): number[] {
  if (!Array.isArray(raw))
    refuseArg('cuts_src_us', `cuts_src_us must be an array of source-time microseconds, got ${typeof raw}`)
  const cuts: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i]
    if (typeof v !== 'number' || !Number.isFinite(v))
      refuseArg('cuts_src_us', `cuts_src_us[${i}] is ${String(v)} — every entry must be a finite number`)
    if (i > 0 && v <= cuts[i - 1])
      refuseArg('cuts_src_us', `cuts_src_us[${i}] (${v}) must be greater than cuts_src_us[${i - 1}] (${cuts[i - 1]}) — the list must ascend strictly`)
    if (v <= params.src_in_us || v >= params.src_out_us)
      refuseArg('cuts_src_us', `cuts_src_us[${i}] (${v}) is outside the clip's source window (${params.src_in_us}, ${params.src_out_us})`)
    cuts.push(v)
  }
  return cuts
}

/** THE canonical cut list, and the only producer of one: an explicit list the
 *  caller reviewed, or the detector's at the given/default parameters. Both
 *  apply verbs go through here, so a split and a mark of the same request
 *  cannot disagree about where the boundaries are. */
async function shotCutList(spec: ShotCutSpec, deps: HybridDeps): Promise<{ compositionId: string; cuts: ShotCut[] }> {
  if (spec.cuts_src_us === undefined || spec.cuts_src_us === null) {
    return resolveShotCuts(spec.layer_id, { sensitivity: spec.sensitivity, minShotUs: spec.min_shot_us }, deps)
  }
  const { layer, params, composition } = resolveShotLayer(spec.layer_id, deps)
  const srcCuts = validateExplicitCuts(spec.cuts_src_us, params)
  return { compositionId: composition.id, cuts: cutsToTimeline(srcCuts, layer, params, composition.fps) }
}

/** Split a VideoClip layer at its shot boundaries in ONE commit (one undo
 *  entry), returning the SURVIVING segment ids in timeline order. No interior
 *  boundary means the clip is a single shot: nothing is dispatched and the
 *  unchanged layer id comes back, so the answer is idempotent rather than an
 *  error.
 *
 *  `discard_segments` rides the same commit, so split-and-discard is still one
 *  undo — and the undo restores the single pre-split layer, not a split clip
 *  missing its takes. */
export async function splitByShotCuts(spec: ShotCutSpec, deps: HybridDeps): Promise<string[]> {
  // No `composition_id` on the dispatch and none wanted: split_layer_multi is
  // layer-addressed, so it derives the scope from the id it is given.
  const { cuts } = await shotCutList(spec, deps)
  // Checked against the CANONICAL list, which is what the indices count over —
  // and checked ahead of the no-op return below, because with no interior
  // boundary the clip is one segment and any set at all names the whole clip.
  // That is a delete, and it has to be refused rather than answered with the
  // untouched layer id.
  let discard: number[] | null = null
  if (spec.discard_segments !== undefined && spec.discard_segments !== null) {
    // A reviewed list arrives validated (ascending, inside the window), so the
    // only way the canonical list is SHORTER is two boundaries snapping onto one
    // composition frame and `cutsToTimeline` keeping one. The caller numbered
    // its rows over the list it sent; past the collapse every index would name
    // a neighbour of the shot the reviewer unchecked. Refused rather than
    // re-mapped, because the reviewer has not seen the merged list.
    if (Array.isArray(spec.cuts_src_us) && cuts.length < spec.cuts_src_us.length) {
      const lost = spec.cuts_src_us.length - cuts.length
      refuseArg('discard_segments',
        `${lost} of the ${spec.cuts_src_us.length} reviewed boundaries fall on the same frame as a neighbour at this composition's rate, so the segments no longer number as the review shows them — raise the minimum shot length above one frame and review again`)
    }
    const parsed = parseDiscardSegments(spec.discard_segments, cuts.length + 1)
    if (!parsed.ok) refuseArg('discard_segments', parsed.detail)
    discard = parsed.value
  }
  if (cuts.length === 0) return [spec.layer_id]
  const r = deps.actor.dispatch('split_layer_multi', {
    layer: spec.layer_id,
    at_t_us_list: cuts.map((c) => c.tUs),
    drop_short_us: spec.drop_short_us ?? null,
    discard_segments: discard,
  })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string[]
}

/** Materialize a VideoClip layer's shot boundaries as timeline markers in ONE
 *  coalesced commit. Marks go into the CLIP'S composition, the only one their
 *  times are expressed in. Returns the new marker ids; `[]` when there is no
 *  interior boundary.
 *
 *  Every mark is ANCHORED to the clip it was derived from, at the source time
 *  its own cut was detected at. A shot mark asserts "this clip cuts here", so it
 *  has to be a claim about the clip's material rather than about a timeline
 *  instant that happened to coincide once. `reconcileMarkers` then supplies the
 *  two consequences that claim implies for free: trimming past a mark hibernates
 *  it (and re-extending revives it), and deleting the clip takes its marks with
 *  it.
 *
 *  The colour is the `add_markers` arm's shot-marker default, left unpassed on
 *  purpose so one style serves every producer of shot marks. */
export async function markShotCuts(spec: ShotCutSpec, deps: HybridDeps): Promise<string[]> {
  const { compositionId, cuts } = await shotCutList(spec, deps)
  if (cuts.length === 0) return []
  const markers = cuts.map((c, i) => ({ t_us: c.tUs, label: `Cut ${i + 1}`, anchor: { layer: spec.layer_id, src_us: c.srcUs } }))
  const r = deps.actor.dispatch('add_markers', { markers, composition_id: compositionId })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string[]
}

/** The default colour of a pause mark — amber, and deliberately NOT the
 *  `add_markers` shot blue it would otherwise inherit.
 *
 *  Machine-produced marks are a class of their own next to hand-authored notes,
 *  and within that class the two producers answer different questions: a shot
 *  mark says "the picture changes here", a pause says "nobody is speaking
 *  through here". They routinely sit on the same clip, so the ruler has to keep
 *  them apart at a glance — and hue is the only channel free to do it, since a
 *  region already reads as a bar and a point as an L (`renderer/timeline`
 *  marker lane). */
export const PAUSE_MARKER_COLOR: Rgba = { r: 230, g: 160, b: 40, a: 255 }

/** Detect one clip's pauses and materialize each as a REGION marker in ONE
 *  coalesced commit. Marks go into the SUBJECT'S composition — the only one the
 *  detector's timeline-absolute times mean anything on — so a clip inside a
 *  Group marks the Group, exactly as `markShotCuts` does.
 *
 *  Every mark is ANCHORED to the subject at the source instant its own range
 *  begins, for `markShotCuts`' reason: a pause is a fact about the material,
 *  not about a timeline instant that coincided once. `reconcileMarkers` then
 *  supplies the consequences for free — trimming past a range hibernates its
 *  mark (re-extending revives it), and deleting the clip takes its marks with
 *  it. The region's `end_t_us` follows by the same frame delta, so the span the
 *  detector found survives the follow.
 *
 *  Region rather than point markers, and that is the whole shape of the answer:
 *  a pause has a LENGTH, and marking is the verb that leaves the film exactly
 *  as long as it was — so the length has to be legible on the ruler for a human
 *  to judge it. `removePauses` is the other verb over the same detection, for
 *  when the judging is already done, and it is the one that takes a pad: a mark
 *  always describes the WHOLE pause.
 *
 *  No dispatch at all when nothing was found at the threshold — an empty answer
 *  writes no history entry, so re-tuning and re-running costs no undo steps. */
export async function markPauses(
  spec: { layer_id: string; threshold_amp?: number; min_pause_us?: number },
  deps: HybridDeps,
): Promise<string[]> {
  const detect = deps.compute.detectPauses
  if (!detect) throw new Error('mark pauses: pause detection is not available in this build')
  const { subject, params, composition } = resolvePauseTarget(spec.layer_id, deps, 'mark pauses')
  const { pauses } = await detect({
    layer_id: subject.id,
    ...(spec.threshold_amp === undefined ? {} : { threshold_amp: spec.threshold_amp }),
    ...(spec.min_pause_us === undefined ? {} : { min_pause_us: spec.min_pause_us }),
  })
  if (pauses.length === 0) return []
  // The ranges arrive timeline-absolute and clipped to the subject's span, so
  // the anchor's source instant is the inverse of that mapping — at speed 1,
  // the same deferral `cutsToTimeline` records. `t_us`/`end_t_us` are left
  // unsnapped: `applyAddMarker` puts both on the composition grid, and the
  // reconcile in the same commit derives `t_us` back off the anchor through the
  // identical snap, so one snap decides where the bar sits.
  const markers = pauses.map((r) => ({
    t_us: r.t_start_us,
    end_t_us: r.t_end_us,
    label: 'Pause',
    color: PAUSE_MARKER_COLOR,
    anchor: { layer: subject.id, src_us: params.src_in_us + (r.t_start_us - subject.t_start_us) },
  }))
  const res = deps.actor.dispatch('add_markers', { markers, composition_id: composition.id })
  if (!res.ok) throw new Error(JSON.stringify(res.error))
  return res.value as string[]
}

/** What one removal did: the subject's remaining pieces in timeline order, how
 *  many pauses were cut, and how much time went with them (the sum of the
 *  CORES, not of the pauses — the pad stays on the timeline). */
export interface RemovePausesResult {
  surviving_layer_ids: string[]
  removed: number
  removed_us: number
}

/** The answer when nothing is removed. The clip is still there and still whole,
 *  so it is the SURVIVOR — `[]` would say the opposite. `removed: 0` is what
 *  says nothing happened. */
function removedNothing(layerId: string): RemovePausesResult {
  return { surviving_layer_ids: [layerId], removed: 0, removed_us: 0 }
}

/** How much of each pause survives on EACH side when none is asked for, µs.
 *
 *  Erasing a pause outright makes speech breathless and clips the soft word
 *  onsets a 10 ms peak window reads as quiet, so the default keeps a breath
 *  rather than the tightest possible cut; 0 is the explicit way to erase whole.
 *  TWIN of the `/cut-pauses` prompt's stated default (`native/src/mcp/prompts.rs`)
 *  and of the `remove_pauses` tool description — move one, move all three.
 *  Unlike the detection parameters this one is TS's to own: Rust never sees a
 *  pad, because the cut list is built here. */
export const DEFAULT_PAUSE_PAD_US = 100_000

/** Shrink each detected pause to the part a removal actually cuts.
 *
 *  A pause touching the subject's head or tail keeps its pad on the INNER side
 *  only: there is no material outside the clip to breathe into, and the
 *  existing whole-trim rule already discards such a stretch to the clip edge.
 *  A core that collapses is dropped rather than cut as a zero-length hole —
 *  unreachable for an interior pause under the validated `2·pad < min_pause_us`
 *  (`refusePadArgs`), and the honest answer when a caller omitted
 *  `min_pause_us` so the pair could not be checked.
 *
 *  Pure and exported for its own tests: the edge rules are the whole of the
 *  behaviour, and they are invisible in the split dispatch that consumes them. */
export function pauseCores(
  pauses: readonly PauseRegion[],
  padUs: number,
  layer: Pick<Layer, 't_start_us' | 't_end_us'>,
): PauseRegion[] {
  const cores: PauseRegion[] = []
  for (const p of pauses) {
    const start = p.t_start_us <= layer.t_start_us ? p.t_start_us : p.t_start_us + padUs
    const end = p.t_end_us >= layer.t_end_us ? p.t_end_us : p.t_end_us - padUs
    if (end > start) cores.push({ t_start_us: start, t_end_us: end })
  }
  return cores
}

/** The cores as the split can actually take them when the subject travels with a
 *  picture.
 *
 *  `split_layer_multi` re-snaps every spanning link member on ITS OWN grid: the
 *  Audio subject on the 48 kHz lattice, a linked VideoClip on the frame grid. A
 *  boundary that lands between frames is therefore cut in two places up to half a
 *  frame apart, and the picture piece of a KEPT segment then overlaps the next
 *  hole by that half frame — enough for the fan-out to doom it and for the
 *  ripple planner to refuse the whole edit (`RippleInsideHole` over a hole that
 *  has swallowed the clip). Snapping the interior boundaries onto the
 *  composition's frame grid FIRST puts both members' cuts on one instant: a frame
 *  boundary is a sample boundary at every integer rate, and at 29.97 / 59.94 the
 *  residue is ~10 µs, which the fan-out's half-frame slack absorbs. The head and
 *  tail boundaries are the subject's own edges and are left alone.
 *
 *  Only when a frame-grid member shares the link: an unlinked Audio clip keeps
 *  its sample precision, because nothing else has to be cut where it is cut.
 *  A core the snap collapses is dropped, like one the pad collapsed. */
function cutGridCores(
  cores: readonly PauseRegion[],
  subject: Pick<Layer, 'id' | 't_start_us' | 't_end_us'>,
  composition: Composition,
): PauseRegion[] {
  const link = composition.links.find((g) => g.members.includes(subject.id))
  if (!link) return [...cores]
  const kindOf = (id: string): string | undefined => {
    for (const track of composition.tracks) {
      const hit = track.layers.find((l) => l.id === id)
      if (hit) return hit.params.kind
    }
    return undefined
  }
  const sharesFrameGrid = link.members.some((m) => m !== subject.id && kindOf(m) !== 'Audio')
  if (!sharesFrameGrid) return [...cores]
  const { num, den } = composition.fps
  const onFrame = (t: number): number => snapFrameRound(t, num, den)
  const out: PauseRegion[] = []
  for (const c of cores) {
    const start = c.t_start_us <= subject.t_start_us ? c.t_start_us : onFrame(c.t_start_us)
    const end = c.t_end_us >= subject.t_end_us ? c.t_end_us : onFrame(c.t_end_us)
    if (end > start) out.push({ t_start_us: start, t_end_us: end })
  }
  return out
}

/** Refuse a pad that cannot mean what it says, BEFORE any detection runs — a
 *  refusal that arrives after a cache walk reads as a failure of the detector.
 *
 *  `2 · pad < min_pause_us` is checked only when the caller STATED a minimum:
 *  an omitted one resolves to Rust's default (`native/src/mcp/tools.rs`), and a
 *  number invented at this hop to compare against would be free to disagree
 *  with it. An unchecked pair cannot cut anything wrong either way — every core
 *  it collapses is simply dropped. */
function refusePadArgs(padUs: number, minPauseUs: number | undefined): void {
  if (!Number.isFinite(padUs) || padUs < 0)
    refuseArg('pad_us', `pad_us ${String(padUs)} must be a whole number of microseconds ≥ 0`)
  if (minPauseUs !== undefined && 2 * padUs >= minPauseUs)
    refuseArg('pad_us', `pad_us ${padUs} keeps ${2 * padUs}µs of every pause, which is not less than min_pause_us ${minPauseUs} — nothing would be cut`)
}

/** Detect one clip's pauses and CUT the CORE of each out, closing the gap
 *  behind itself, in ONE commit. The other verb over `markPauses`' detection:
 *  same compute, same `waiting_waveform` contract, and the same "no dispatch
 *  when nothing was found" — re-tuning the threshold against a live preview
 *  must cost no undo steps whichever button the tuning ends on.
 *
 *  The core, not the pause: `pad_us` stays on each side (`pauseCores`), so
 *  speech keeps its breath and a soft word onset the peak window read as quiet
 *  is not clipped off. The split targets the SUBJECT Audio layer and the linked
 *  picture follows through `split_layer_multi`'s own link fan-out, which is
 *  what makes a cut by sound land on the frame the sound is on.
 *
 *  ONE `split_layer_multi` and not a split followed by deletes, because the
 *  whole promise here is a single undo that restores the clip whole. The op
 *  already carries both halves: `at_t_us_list` says where to cut and
 *  `discard_segments` which of the resulting pieces never existed as far as the
 *  timeline is concerned. `ripple: true` is what makes the discard a REMOVAL
 *  rather than a lift — the doomed pieces go to the ripple as one set, so two
 *  adjacent cores close as the one hole they are and everything downstream
 *  moves once (ADR 0062).
 *
 *  The cut list is every core boundary STRICTLY inside the clip. A core that
 *  touches the head or the tail contributes no cut on that side, and that is
 *  not an optimization: there is nothing to cut off at a clip's own edge, and a
 *  split there is refused rather than ignored. The segment is discarded whole
 *  instead — dropping the boundary is exactly what makes a leading or trailing
 *  pause one nominal segment rather than an empty one plus a real one.
 *
 *  Which segments to discard is decided by MIDPOINT against the cores rather
 *  than by counting boundaries. The actor re-snaps every cut onto the target's
 *  grid and SKIPS one that no longer lands strictly inside its segment, so a
 *  boundary pair less than a frame apart merges two nominal segments into one;
 *  a midpoint still names the right piece where an index arithmetic over "two
 *  boundaries per core" would name its neighbour.
 *
 *  A clip whose cores cover it end to end names every segment, and
 *  `parseDiscardSegments` refuses that by design — discarding everything is a
 *  delete, not an apply. The refusal arrives here as the actor's
 *  `InvalidArgument` and is passed straight through: the section shows it
 *  inline and the agent reads the field it names.
 *
 *  So do the ripple's own refusals. They are the planner's, raised pre-write:
 *  a clip on another track that STARTS inside a removed core is
 *  `RippleInsideHole`, a link with members on both sides of one is
 *  `RippleLinkStraddles`, a locked downstream lane is `RippleLockedLayer` /
 *  `TrackLocked`, and a mover landing on something that is not moving is
 *  `RippleCollision`. Each names the layer that blocked. The whole commit rolls
 *  back — the clip comes out UNSPLIT, with nothing recorded — so a refusal is
 *  something to fix and re-run, never a half-cut clip to clean up. */
export async function removePauses(
  spec: { layer_id: string; threshold_amp?: number; min_pause_us?: number; pad_us?: number },
  deps: HybridDeps,
): Promise<RemovePausesResult> {
  const detect = deps.compute.detectPauses
  if (!detect) throw new Error('remove pauses: pause detection is not available in this build')
  const padUs = spec.pad_us ?? DEFAULT_PAUSE_PAD_US
  refusePadArgs(padUs, spec.min_pause_us)
  const { subject, composition } = resolvePauseTarget(spec.layer_id, deps, 'remove pauses')
  const { pauses } = await detect({
    layer_id: subject.id,
    ...(spec.threshold_amp === undefined ? {} : { threshold_amp: spec.threshold_amp }),
    ...(spec.min_pause_us === undefined ? {} : { min_pause_us: spec.min_pause_us }),
  })
  // Zero-length ranges are filtered rather than trusted: they name no segment to
  // discard, so a set of nothing but those would dispatch a split that threw
  // nothing away — an undo entry for an edit the user cannot see. The pad shrink
  // then drops anything else that leaves nothing to cut.
  const spans = pauses.filter((r) => r.t_end_us > r.t_start_us)
  const cores = cutGridCores(pauseCores(spans, padUs, subject), subject, composition)
  if (cores.length === 0) return removedNothing(subject.id)

  const seen = new Set<number>()
  const cuts: number[] = []
  for (const core of cores) {
    for (const t of [core.t_start_us, core.t_end_us]) {
      if (t <= subject.t_start_us || t >= subject.t_end_us || seen.has(t)) continue
      seen.add(t)
      cuts.push(t)
    }
  }
  cuts.sort((a, b) => a - b)
  // The nominal segments the actor will number, in the same order: `cuts + 1` of
  // them, spanning the clip end to end.
  const bounds = [subject.t_start_us, ...cuts, subject.t_end_us]
  const discard: number[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const mid = (bounds[i] + bounds[i + 1]) / 2
    if (cores.some((r) => mid > r.t_start_us && mid < r.t_end_us)) discard.push(i)
  }
  const removedUs = cores.reduce((sum, r) => sum + (r.t_end_us - r.t_start_us), 0)
  // Layer-addressed like every other split dispatch, so no `composition_id`: the
  // op derives the scope from the id, and a clip inside a Group ripples the
  // Group's own timeline.
  const res = deps.actor.dispatch('split_layer_multi', {
    layer: subject.id,
    at_t_us_list: cuts,
    discard_segments: discard,
    ripple: true,
  })
  if (!res.ok) throw new Error(JSON.stringify(res.error))
  return { surviving_layer_ids: res.value as string[], removed: cores.length, removed_us: removedUs }
}

/** Run a hybrid tool: Rust compute then TS-actor write.
 *
 *  Return-shape contract, and it is the MCP half that constrains it: server.ts
 *  stringifies whatever comes back into one `ToolResult` text block, so an arm
 *  listed in `mcp/mutationTools.ts` `HYBRID_TOOLS` must return a STRING — a
 *  media id (import_media), the bare caption track id (import_media's
 *  `.srt` branch), the id plus a styling note (apply_subtitles), or a JSON
 *  string (synthesize_speech, auto_split_by_shot, remove_pauses).
 *  `drop_shot_markers`, `apply_shot_cuts` and `mark_pauses` have no MCP tool
 *  at all, so they return the object their IPC caller reads directly —
 *  `apply_shot_cuts` a union discriminated by the `mode` it was asked for, since
 *  what the splitting verbs produce (surviving segments) and what a mark
 *  produces (markers) are not the same kind of thing.
 *
 *  The two pause arms sit on opposite sides of that line, and deliberately:
 *  a mark is composable from `detect_pauses` + `add_markers`, so an agent
 *  needs no tool for it, while the cut is one recorded edit no sequence of
 *  advertised tools reproduces.
 *
 *  Several of these arms are reachable from BOTH sides (`router.ts`
 *  `HYBRID_CHANNELS`): the renderer's speech dialogs call `apply_subtitles`
 *  and `synthesize_speech` by name. The shape stays the MCP one either way;
 *  the renderer's typed wrapper parses it (`renderer/ipc/index.ts`).
 *
 *  Throws on a rejected actor write or an unhandled tool. */
export async function runHybrid(tool: string, args: Record<string, unknown>, deps: HybridDeps): Promise<unknown> {
  switch (tool) {
    case 'import_media': {
      const path = args.path as string
      // Subtitles are CONSUMED into a caption track (not pooled into the media
      // pool). Read the file, derive a label from the filename, hand off to
      // applySubtitleBody (format null → sniff from body), and return the BARE
      // track id string — the channel contract; `simplified` is discarded here.
      if (/\.(srt|ass|vtt)$/i.test(path)) {
        const body = deps.readFile(path)
        // Full filename WITH extension as the label (e.g. "captions.srt").
        const label = path.replace(/\\/g, '/').split('/').pop() ?? null
        return (await applySubtitleBody(body, null, label, deps)).track_id
      }
      // Insert the probed item FIRST so the clip appears in the timeline
      // immediately.
      const item = JSON.parse(await deps.compute.probeMedia(path)) as MediaItem
      const r = deps.actor.dispatch('add_media_item', { media: item })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      // Compute the REAL content hash (a lightweight standalone read pass), set it
      // on the pool item, THEN enqueue derivatives — so every job bakes the final
      // cache key and no derivative ever touches a pending alias (ADR 0007
      // superseded). One extra full read of the source, accepted to start
      // derivatives promptly instead of waiting for the workspace copy.
      const hash = await deps.compute.hashMediaSource(path)
      const hr = deps.actor.dispatch('set_media_hash', { media: item.id, file_hash_blake3: hash })
      // Benign if the media was removed during hashing — nothing left to enqueue.
      if (!hr.ok) return item.id
      const hashedItem: MediaItem = { ...item, file_hash_blake3: hash }
      // Derivative jobs read the SOURCE (hashedItem.path_abs is still the original);
      // content-addressed by the real hash, so source vs the workspace copy is
      // equivalent.
      await deps.enqueueDerivatives([hashedItem])
      // Workspace copy runs in PARALLEL: copies the source into <workspace>/Media,
      // re-confirms the same hash, and flips path_abs via the media:workspace_paths
      // seam. No-op napi when no workspace.
      if (deps.workspaceDir()) await deps.enqueueWorkspaceCopy(item.id, path)
      return item.id
    }
    case 'apply_subtitles': {
      // Body + optional format tag; label is always "Captions". Reached by the
      // agent's `apply_subtitles` tool and by the renderer's transcribe command,
      // which hands over the `srt` its `transcribe_clip` call returned.
      // ToolResult text contract: the bare track id, or the id + a
      // simplified-styling annotation. server.ts wraps this string into
      // `{content:[{type:'text', text}]}`.
      const { track_id, simplified } = await applySubtitleBody(
        args.body as string,
        (args.format as string | null | undefined) ?? null,
        'Captions',
        deps,
      )
      return simplified ? `${track_id} (some ASS styling was simplified)` : track_id
    }
    case 'synthesize_speech': {
      // The TS host applies the WRITES: add_media_item + enqueueDerivatives +
      // resolve track + add Audio layer (voiceover role, single commit).
      const { media_item, duration_us, cached } = JSON.parse(
        await deps.compute.synthesizeSpeechCompute(JSON.stringify(args)),
      ) as { media_item: { id: string }; duration_us: number; cached: boolean }

      const addR = deps.actor.dispatch('add_media_item', { media: media_item })
      if (!addR.ok) throw new Error(JSON.stringify(addR.error))

      await deps.enqueueDerivatives([media_item])

      const tStart = (args.t_start_us as number | undefined) ?? deps.snapshotComposition().duration_us
      const tEnd = tStart + duration_us

      const trackId = (args.target_track_id as string | undefined) ?? ensureAudioTrack(deps)

      // ONE add_layer carrying role:'voiceover' — the 'audio' arm accepts the
      // optional `role` override (actor.ts), so no separate update_layer_params
      // commit and the whole synthesis is a single history entry.
      const layerR = deps.actor.dispatch('add_layer', {
        kind: 'audio',
        track: trackId,
        media: media_item.id,
        src_in_us: 0,
        src_out_us: duration_us,
        role: 'voiceover',
        t_start_us: tStart,
        t_end_us: tEnd,
      })
      if (!layerR.ok) throw new Error(JSON.stringify(layerR.error))
      const layerId = layerR.value as string

      // Return a JSON STRING, never the object — runHybrid's result contract.
      return JSON.stringify({ layer_id: layerId, media_id: media_item.id, t_start_us: tStart, t_end_us: tEnd, cached })
    }
    case 'auto_split_by_shot': {
      // Convenience composite (reproducible with analyze_clip + split_layer):
      // the detector's boundaries for this layer, split in ONE commit
      // (split_layer_multi → single undo). Returns a JSON STRING
      // `{ layer_ids }` — the new segment ids in timeline order.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('auto_split_by_shot: layer_id is required')
      const minShotUs = typeof args.min_shot_us === 'number' ? args.min_shot_us : undefined
      // drop_short deletes any resulting segment shorter than min_shot_us as
      // part of the SAME commit — so drop + split are one undo. The tool's own
      // argument is a boolean, so the length it resolves to is decided here.
      const dropShortUs = args.drop_short === true ? (minShotUs ?? shotDefaults(deps).min_shot_us) : undefined
      const layerIds = await splitByShotCuts({ layer_id: layerId, min_shot_us: minShotUs, drop_short_us: dropShortUs }, deps)
      return JSON.stringify({ layer_ids: layerIds })
    }
    case 'drop_shot_markers': {
      // The zero-argument marker entry: apply_shot_cuts in 'mark' mode at the
      // detection defaults, and nothing more — which is why it takes the same
      // path rather than owning a second producer of cut times. Renderer-only
      // (no MCP def), like apply_shot_cuts itself: an agent that wants markers
      // has add_markers, and a second tool over one report would only be a way
      // for the two surfaces to drift.
      const layerId = args.layerId
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('drop_shot_markers: layerId is required')
      const minShotUs = typeof args.minShotUs === 'number' ? args.minShotUs : undefined
      const ids = await markShotCuts({ layer_id: layerId, min_shot_us: minShotUs }, deps)
      return { markers: ids.length }
    }
    case 'mark_pauses': {
      // The pause entry's write half: detect at the given (or default)
      // parameters and land one region marker per pause. Renderer-only, with no
      // MCP tool of its own — an agent that wants the ranges has `detect_pauses`
      // and `add_markers`, and a second tool over one detection would only be a
      // way for the two surfaces to drift.
      //
      // The count AND the ids: the section's summary names the count, and the
      // ids are what any later "select what I just marked" would need. An
      // object, not the MCP arms' JSON string — nothing stringifies this one.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('mark_pauses: layer_id is required')
      // Left UNDEFINED rather than defaulted here: the detection defaults belong
      // to Rust (`native/src/mcp/tools.rs`), and a number invented at this hop
      // would be free to disagree with the one an omitted parameter resolves to.
      const ids = await markPauses({
        layer_id: layerId,
        ...(typeof args.threshold_amp === 'number' ? { threshold_amp: args.threshold_amp } : {}),
        ...(typeof args.min_pause_us === 'number' ? { min_pause_us: args.min_pause_us } : {}),
      }, deps)
      return { markers: ids.length, marker_ids: ids }
    }
    case 'remove_pauses': {
      // The pause entry's cutting half, and the only pause arm reachable from
      // both surfaces: the section's *Remove pauses* and the agent's tool of the
      // same name land the identical single commit.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('remove_pauses: layer_id is required')
      // Detection parameters left UNDEFINED for `mark_pauses`' reason. `pad_us`
      // is the exception and not an inconsistency: Rust never sees a pad, so
      // `DEFAULT_PAUSE_PAD_US` is the only statement of it there is.
      const removed = await removePauses({
        layer_id: layerId,
        ...(typeof args.threshold_amp === 'number' ? { threshold_amp: args.threshold_amp } : {}),
        ...(typeof args.min_pause_us === 'number' ? { min_pause_us: args.min_pause_us } : {}),
        ...(typeof args.pad_us === 'number' ? { pad_us: args.pad_us } : {}),
      }, deps)
      // A JSON STRING, never the object — runHybrid's MCP result contract. The
      // renderer's typed wrapper parses it back (`renderer/ipc/index.ts`).
      return JSON.stringify(removed)
    }
    case 'apply_shot_cuts': {
      // The reviewed-list channel: one canonical cut list, three verbs over it.
      // Renderer-only, so the answer is an object rather than the MCP arms'
      // string.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('apply_shot_cuts: layer_id is required')
      const mode = args.mode
      if (mode !== 'split' && mode !== 'mark' && mode !== 'discard')
        throw new Error(JSON.stringify({ error: 'InvalidArgument', field: 'mode',
          detail: `mode must be "split", "mark" or "discard", got ${String(args.mode)}` }))
      // `discard` is the only verb that reads the set, and it requires a
      // non-empty one. An absent set reads as empty rather than as "no discard"
      // so that asking for the verb without naming a shot is answered with the
      // verb that means it, instead of quietly splitting.
      const discardSegments = mode === 'discard' ? (args.discard_segments ?? []) : undefined
      if (Array.isArray(discardSegments) && discardSegments.length === 0)
        refuseArg('discard_segments', 'discard needs at least one segment to discard — "split" is the verb that keeps every one')
      const spec: ShotCutSpec = {
        layer_id: layerId,
        cuts_src_us: args.cuts_src_us,
        sensitivity: typeof args.sensitivity === 'number' ? args.sensitivity : undefined,
        min_shot_us: typeof args.min_shot_us === 'number' ? args.min_shot_us : undefined,
        drop_short_us: typeof args.drop_short_us === 'number' ? args.drop_short_us : undefined,
        discard_segments: discardSegments,
      }
      return mode === 'mark'
        ? { mode: 'mark', marker_ids: await markShotCuts(spec, deps) }
        : { mode, layer_ids: await splitByShotCuts(spec, deps) }
    }
    default:
      throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
