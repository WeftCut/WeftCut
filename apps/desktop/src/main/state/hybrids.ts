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
import type { Composition, Layer, MediaItem, VideoClipParams } from './model'
import { eachLayer, rootComposition } from './model'
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

/** What either apply verb needs to arrive at a cut list.
 *
 *  `cuts_src_us` present means the caller already decided the boundaries — a
 *  reviewed list with rows vetoed — and the detector is not consulted at all.
 *  Absent means detect at `sensitivity` / `min_shot_us`, each falling back to
 *  the detection default; that is the path the zero-argument clip-menu entries
 *  take.
 *
 *  A third verb — split, then delete the spans the user unchecked, in one
 *  commit — needs no field beyond these: it is `split_layer_multi` over the
 *  same `cuts_src_us`, and the spans to drop are the gaps between consecutive
 *  kept boundaries, which the list already names. */
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
}

/** Resolve the VideoClip layer a shot operation names, together with the media
 *  it reads and the composition its times are expressed in. Throws (never
 *  silently no-ops) on a missing or non-video layer, or on media the pool has
 *  lost. */
function resolveShotLayer(
  layerId: string,
  deps: HybridDeps,
): { layer: Layer; media: MediaItem; params: VideoClipParams; composition: Composition } {
  const snap = deps.actor.snapshot()
  let layer: Layer | undefined
  let composition = rootComposition(snap)
  for (const e of eachLayer(snap)) {
    if (e.layer.id === layerId) { layer = e.layer; composition = e.composition; break }
  }
  if (!layer) throw new Error(`shot cuts: layer ${layerId} not found`)
  if (layer.params.kind !== 'VideoClip')
    throw new Error(`shot cuts: layer ${layerId} is not a VideoClip — shots are a video concept`)
  const params = layer.params
  const media = (snap.media_pool as Record<string, MediaItem>)[params.media]
  if (!media) throw new Error(`shot cuts: layer ${layerId} references missing media ${params.media}`)
  return { layer, media, params, composition }
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

/** Structured refusal for a caller-supplied cut list, shaped so the renderer's
 *  `parseCommandError` can name the field and show the detail. */
function refuseCuts(detail: string): never {
  throw new Error(JSON.stringify({ error: 'InvalidArgument', field: 'cuts_src_us', detail }))
}

/** Validate a caller-filtered list of source-time boundaries against the
 *  layer's own window: finite numbers, strictly ascending, each strictly
 *  interior. Refuses on the FIRST offender and names its index, because a list
 *  the user assembled row by row is worth pointing at rather than silently
 *  pruning — and because the refusal has to land before any dispatch, so a bad
 *  list is never half applied. */
function validateExplicitCuts(raw: unknown, params: VideoClipParams): number[] {
  if (!Array.isArray(raw))
    refuseCuts(`cuts_src_us must be an array of source-time microseconds, got ${typeof raw}`)
  const cuts: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i]
    if (typeof v !== 'number' || !Number.isFinite(v))
      refuseCuts(`cuts_src_us[${i}] is ${String(v)} — every entry must be a finite number`)
    if (i > 0 && v <= cuts[i - 1])
      refuseCuts(`cuts_src_us[${i}] (${v}) must be greater than cuts_src_us[${i - 1}] (${cuts[i - 1]}) — the list must ascend strictly`)
    if (v <= params.src_in_us || v >= params.src_out_us)
      refuseCuts(`cuts_src_us[${i}] (${v}) is outside the clip's source window (${params.src_in_us}, ${params.src_out_us})`)
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
 *  entry), returning the segment ids in timeline order. No interior boundary
 *  means the clip is a single shot: nothing is dispatched and the unchanged
 *  layer id comes back, so the answer is idempotent rather than an error. */
export async function splitByShotCuts(spec: ShotCutSpec, deps: HybridDeps): Promise<string[]> {
  // No `composition_id` on the dispatch and none wanted: split_layer_multi is
  // layer-addressed, so it derives the scope from the id it is given.
  const { cuts } = await shotCutList(spec, deps)
  if (cuts.length === 0) return [spec.layer_id]
  const r = deps.actor.dispatch('split_layer_multi', {
    layer: spec.layer_id,
    at_t_us_list: cuts.map((c) => c.tUs),
    drop_short_us: spec.drop_short_us ?? null,
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

/** Run a hybrid tool: Rust compute then TS-actor write.
 *
 *  Return-shape contract, and it is the MCP half that constrains it: server.ts
 *  stringifies whatever comes back into one `ToolResult` text block, so an arm
 *  listed in `mcp/mutationTools.ts` `HYBRID_TOOLS` must return a STRING — a
 *  media id (import_media), the bare caption track id (import_media's
 *  `.srt` branch), the id plus a styling note (apply_subtitles), or a JSON
 *  string (synthesize_speech, auto_split_by_shot). `drop_shot_markers` and
 *  `apply_shot_cuts` have no MCP tool at all, so they return the object their
 *  IPC caller reads directly — `apply_shot_cuts` a union discriminated by the
 *  `mode` it was asked for, since what a split produces (segments) and what a
 *  mark produces (markers) are not the same kind of thing.
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
      // agent's `apply_subtitles` tool and by the renderer's auto-caption entry,
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
    case 'apply_shot_cuts': {
      // The reviewed-list channel: one canonical cut list, two verbs over it.
      // Renderer-only, so the answer is an object rather than the MCP arms'
      // string.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('apply_shot_cuts: layer_id is required')
      const mode = args.mode
      if (mode !== 'split' && mode !== 'mark')
        throw new Error(JSON.stringify({ error: 'InvalidArgument', field: 'mode',
          detail: `mode must be "split" or "mark", got ${String(args.mode)}` }))
      const spec: ShotCutSpec = {
        layer_id: layerId,
        cuts_src_us: args.cuts_src_us,
        sensitivity: typeof args.sensitivity === 'number' ? args.sensitivity : undefined,
        min_shot_us: typeof args.min_shot_us === 'number' ? args.min_shot_us : undefined,
        drop_short_us: typeof args.drop_short_us === 'number' ? args.drop_short_us : undefined,
      }
      return mode === 'split'
        ? { mode: 'split', layer_ids: await splitByShotCuts(spec, deps) }
        : { mode: 'mark', marker_ids: await markShotCuts(spec, deps) }
    }
    default:
      throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
