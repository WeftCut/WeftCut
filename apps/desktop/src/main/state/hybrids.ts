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
import type { Layer, MediaItem, VideoClipParams } from './model'
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
  /** auto_split_by_shot: the WHOLE-source shot report JSON `{shots,cut_scores}`
   *  (source-absolute time) for a serialized MediaItem under detection-opts JSON
   *  (`{sensitivity?,min_shot_us?,passes?}`), from the VSHOT cache — the same
   *  content-addressed report the `analyze_clip` tool reads, so a prior
   *  analyze_clip at matching params is a hit. Optional: a build without the shot
   *  compute wired (some test harnesses) omits it, and the arm throws an
   *  actionable error rather than silently no-op. */
  analyzeShots?(mediaJson: string, optsJson: string): Promise<string>
}

/** The subset of a whole-source `jobs::shot::ShotReport` the split/marker
 *  orchestration reads: shot spans (source-absolute) whose interior boundaries
 *  become cuts. Mirrors native `Shot` / `ShotReport` serde. */
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

/** One detected shot boundary as the PAIR it is: `tUs` is where the cut lands on
 *  the timeline, `srcUs` where it was detected in the source. Kept together
 *  because the snap-then-drop filter in `resolveShotCuts` decides which cuts
 *  survive by their TIMELINE time — a separately-filtered source list would
 *  eventually tie an anchor to a boundary that never became a cut. */
interface ShotCut { tUs: number; srcUs: number }

/** Resolve a VideoClip layer's detected shot boundaries as cut times in the
 *  layer's OWN composition, shared by `auto_split_by_shot` (splits) and
 *  `dropShotMarkers` (markers) so both mark/split the exact same places from ONE
 *  cached report.
 *
 *  Flow: resolve the layer + its media from the actor snapshot → Rust
 *  `analyzeShots` (whole-source report, VSHOT-cached, shared with analyze_clip)
 *  → keep each interior shot boundary strictly inside the layer's
 *  `[src_in_us, src_out_us]` source window → map source→timeline at speed=1
 *  (variable speed deferred, matching `split_layer` itself) → snap each cut to
 *  the composition frame grid, then drop any that lands on the layer bounds or a
 *  prior cut. The snap-then-drop is load-bearing: the timeline is frame-
 *  quantized and `applySplitLayer` rejects a split whose SNAPPED time is not
 *  strictly interior, so two source cuts less than one frame apart would
 *  otherwise abort the whole multi-split — and markers must land on the same
 *  frames the splits do. Throws (never silently no-ops) on a missing/non-video
 *  layer, missing media, or an un-wired compute.
 *
 *  Every number here is expressed in the LAYER'S composition — the frame grid is
 *  its `fps`, the origin is the layer's own `t_start_us` — so `compositionId`
 *  rides out beside the cuts. A layer-addressed write derives that scope itself
 *  and ignores it; anything else (markers) has to be scoped with it, or it lands
 *  in the root carrying times that mean nothing there. */
async function resolveShotCuts(
  layerId: string,
  minShotUs: number | undefined,
  deps: HybridDeps,
): Promise<{ layer: Layer; media: MediaItem; params: VideoClipParams; compositionId: string; cuts: ShotCut[] }> {
  const analyze = deps.compute.analyzeShots
  if (!analyze) throw new Error('auto_split_by_shot: shot analysis is not available in this build')
  const snap = deps.actor.snapshot()
  let layer: Layer | undefined
  let comp = rootComposition(snap)
  for (const e of eachLayer(snap)) {
    if (e.layer.id === layerId) { layer = e.layer; comp = e.composition; break }
  }
  if (!layer) throw new Error(`auto_split_by_shot: layer ${layerId} not found`)
  if (layer.params.kind !== 'VideoClip')
    throw new Error(`auto_split_by_shot: layer ${layerId} is not a VideoClip — shots are a video concept`)
  const params = layer.params
  const media = (snap.media_pool as Record<string, MediaItem>)[params.media]
  if (!media) throw new Error(`auto_split_by_shot: layer ${layerId} references missing media ${params.media}`)

  const opts: Record<string, unknown> = {}
  if (typeof minShotUs === 'number') opts.min_shot_us = minShotUs
  const report = JSON.parse(await analyze(JSON.stringify(media), JSON.stringify(opts))) as ShotReport

  const seen = new Set<number>()
  const cuts: ShotCut[] = []
  for (const s of report.shots) {
    const c = s.t_start_us
    if (c <= params.src_in_us || c >= params.src_out_us) continue // strictly interior only
    // Map source→timeline (speed=1), then snap to the frame grid the split uses.
    const t = snapFrameRound(layer.t_start_us + (c - params.src_in_us), comp.fps.num, comp.fps.den)
    // Drop cuts that snap onto the layer bounds or a prior cut: a zero-length
    // split is invalid (SplitOutsideLayer) and a repeated frame is a no-op.
    if (t <= layer.t_start_us || t >= layer.t_end_us || seen.has(t)) continue
    seen.add(t)
    cuts.push({ tUs: t, srcUs: c })
  }
  cuts.sort((a, b) => a.tUs - b.tUs)
  return { layer, media, params, compositionId: comp.id, cuts }
}

/** Materialize a VideoClip layer's detected shot boundaries as timeline markers
 *  in ONE coalesced commit — the human "Analyze shots" surface. Reads the SAME
 *  cached shot report + source→timeline mapping as `auto_split_by_shot`, so the
 *  markers land exactly where the tool would split (acceptance: markers stay
 *  consistent with the tool's cuts). The marks go into the CLIP'S composition,
 *  which is the only one their times are expressed in. Returns the new marker
 *  ids; `[]` when the clip has no interior cut.
 *
 *  Every mark is ANCHORED to the clip it was derived from, at the source time
 *  its own cut was detected at. A shot mark asserts "this clip cuts here", so it
 *  has to be a claim about the clip's material rather than about a timeline
 *  instant that happened to coincide once. `reconcileMarkers` then supplies the
 *  two consequences that claim implies for free: trimming past a mark hibernates
 *  it (and re-extending revives it), and deleting the clip takes its marks with
 *  it. */
export async function dropShotMarkers(layerId: string, deps: HybridDeps, minShotUs?: number): Promise<string[]> {
  const { compositionId, cuts } = await resolveShotCuts(layerId, minShotUs, deps)
  if (cuts.length === 0) return []
  const markers = cuts.map((c, i) => ({ t_us: c.tUs, label: `Cut ${i + 1}`, anchor: { layer: layerId, src_us: c.srcUs } }))
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
 *  string (synthesize_speech, auto_split_by_shot). `drop_shot_markers` is the
 *  one arm with no MCP tool at all, so it returns the object its IPC caller
 *  reads directly.
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
      // Rust detects the source's shot cuts (VSHOT cache, shared with
      // analyze_clip); the TS host clips them to this layer's window, maps them
      // to timeline time, and splits at every in-window cut in ONE commit
      // (split_layer_multi → single undo). Returns a JSON STRING
      // `{ layer_ids }` — the new segment ids in timeline order.
      const layerId = args.layer_id
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('auto_split_by_shot: layer_id is required')
      const minShotUs = typeof args.min_shot_us === 'number' ? args.min_shot_us : undefined
      const dropShort = args.drop_short === true

      // No `composition_id` on the dispatch below and none wanted: split_layer_multi
      // is layer-addressed, so it derives the scope from the id it is given.
      const { cuts } = await resolveShotCuts(layerId, minShotUs, deps)
      // No interior cut ⇒ the clip is a single shot; nothing to split. Return
      // the (unchanged) layer id so the agent gets a stable, idempotent answer.
      if (cuts.length === 0) return JSON.stringify({ layer_ids: [layerId] })

      // drop_short deletes any resulting segment shorter than min_shot_us
      // (default 500000, matching the detection default) as part of the SAME
      // commit — so drop + split are one undo.
      const dropShortUs = dropShort ? (minShotUs ?? 500_000) : null
      const r = deps.actor.dispatch('split_layer_multi', {
        layer: layerId, at_t_us_list: cuts.map((c) => c.tUs), drop_short_us: dropShortUs,
      })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return JSON.stringify({ layer_ids: r.value as string[] })
    }
    case 'drop_shot_markers': {
      // The human twin of auto_split_by_shot: the SAME cuts, marked instead of
      // cut. Renderer-only (no MCP def) — an agent that wants markers has
      // add_markers, and a second tool over one report would only be a way for
      // the two surfaces to drift.
      const layerId = args.layerId
      if (typeof layerId !== 'string' || layerId.length === 0)
        throw new Error('drop_shot_markers: layerId is required')
      const minShotUs = typeof args.minShotUs === 'number' ? args.minShotUs : undefined
      const ids = await dropShotMarkers(layerId, deps, minShotUs)
      return { markers: ids.length }
    }
    default:
      throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
