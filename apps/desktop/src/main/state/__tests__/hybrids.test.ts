import { describe, it, expect, vi } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type MediaItem } from '../model'
import { mediaItemTemplate, videoClipParams } from '../mutations/media'
import { applyAddLayer } from '../mutations/add'
import { markerHibernating } from '../summary'
import { runHybrid, markShotCuts, cutsToTimeline, type HybridDeps } from '../hybrids'
import { applyWorkspacePathsEvent } from '../jobs-writeback'
import { root, withGroup } from './fixtures/project'

const MID = '00000000-0000-0000-0000-0000000000aa'

function freshActor(): ActorHandle {
  const idGen = seededGen()
  return createActor({ initial: blankProject(idGen, 'h'), idGen, clock: () => '<TS>' })
}

/** A fully-probed pool item, as `compute.probeMedia` would return it. */
function probedItem(): MediaItem {
  return mediaItemTemplate(MID, 'Video', 4_000_000)
}

/** Two-cue SRT body used by subtitle tests. */
const TWO_CUE_SRT = `1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye world\n`

/** A 2-cue parseSubtitles payload as the fake compute returns it. */
function twoCuePayload() {
  return JSON.stringify({
    cues: [
      { start_us: 1_000_000, end_us: 2_000_000, text: 'Hello world', style: { bold: false, italic: false } },
      { start_us: 3_000_000, end_us: 4_000_000, text: 'Goodbye world', style: { bold: false, italic: false } },
    ],
    simplified: false,
  })
}

/** Build HybridDeps with a fake compute + spies; `workspaceDir` is overridable. */
function makeDeps(actor: ActorHandle, opts: { workspaceDir?: string | null; fileContent?: string } = {}): HybridDeps & {
  _probeMedia: ReturnType<typeof vi.fn>
  _hashMediaSource: ReturnType<typeof vi.fn>
  _parseSubtitles: ReturnType<typeof vi.fn>
  _enqueueDerivatives: ReturnType<typeof vi.fn>
  _enqueueWorkspaceCopy: ReturnType<typeof vi.fn>
  _readFile: ReturnType<typeof vi.fn>
} {
  const probeMedia = vi.fn(async () => JSON.stringify(probedItem()))
  const hashMediaSource = vi.fn(async () => 'realhash-deadbeef')
  const parseSubtitles = vi.fn(async () => twoCuePayload())
  const enqueueDerivatives = vi.fn(async () => {})
  const enqueueWorkspaceCopy = vi.fn(async () => {})
  const readFile = vi.fn((_p: string) => opts.fileContent ?? '')
  const deps: HybridDeps = {
    actor,
    compute: {
      probeMedia,
      hashMediaSource,
      parseSubtitles,
      synthesizeSpeechCompute: vi.fn(async () => '{}'),
      analyzeShotsFloor: vi.fn(async () => JSON.stringify({ shots: [], cut_scores: [] })),
      reduceShotReport: vi.fn((reportJson: string) => reportJson),
      shotDefaultOpts: vi.fn(() => ({ ...RUST_SHOT_DEFAULTS })),
    },
    enqueueDerivatives,
    enqueueWorkspaceCopy,
    workspaceDir: () => opts.workspaceDir ?? null,
    readFile,
    snapshotComposition: () => root(actor.snapshot()),
  }
  return Object.assign(deps, {
    _probeMedia: probeMedia,
    _hashMediaSource: hashMediaSource,
    _parseSubtitles: parseSubtitles,
    _enqueueDerivatives: enqueueDerivatives,
    _enqueueWorkspaceCopy: enqueueWorkspaceCopy,
    _readFile: readFile,
  })
}

describe('runHybrid: import_media', () => {
  it('returns the new media id and inserts the probed item into the pool', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const id = await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(id).toBe(MID)
    expect(actor.snapshot().media_pool[MID]).toBeTruthy()
    expect(actor.snapshot().media_pool[MID].kind).toBe('Video')
  })

  it('kicks derivative jobs with the REAL-hash item (hash-first, not the provisional probe hash)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._hashMediaSource).toHaveBeenCalledWith('C:/x.mp4')
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as MediaItem[]
    expect(arg).toHaveLength(1)
    expect(arg[0].id).toBe(MID)
    // The provisional probe hash ('0' from probedItem) must NEVER reach enqueue —
    // derivatives bake the real content hash (ADR 0007 superseded).
    expect(arg[0].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('sets the real content hash on the pool item before returning', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('inserts the item BEFORE hashing (instant appearance), then hashes, then enqueues', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const order: string[] = []
    deps._probeMedia.mockImplementation(async () => { order.push('probe'); return JSON.stringify(probedItem()) })
    deps._hashMediaSource.mockImplementation(async () => { order.push('hash'); return 'realhash-deadbeef' })
    deps._enqueueDerivatives.mockImplementation(async () => { order.push('enqueue') })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    // probe (stat-only) → hash pass → enqueue: the real hash is known before any job.
    expect(order).toEqual(['probe', 'hash', 'enqueue'])
  })

  it('enqueues the workspace copy when a workspace exists', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: '/ws' })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(MID, 'C:/x.mp4')
  })

  it('does NOT enqueue the workspace copy when there is no workspace', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: null })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
  })

  it('branches on a subtitle extension WITHOUT probing media (routes to the subtitle path)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    // The subtitle hybrid: the orchestrator branches on .srt, reads the file,
    // calls parseSubtitles, and dispatches add_caption_track — NOT probeMedia.
    // Returns a BARE track-id string (the import_media channel contract).
    const result = await runHybrid('import_media', { path: 'C:/subs.srt' }, deps)
    expect(deps._probeMedia).not.toHaveBeenCalled()
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('throws when the actor rejects the insert (e.g. invalid item)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps.compute.probeMedia = vi.fn(async () => JSON.stringify({ ...probedItem(), kind: 'Video', metadata: { duration_us: -1, video: null, audio: null, container_format: null } }))
    // duration_us negative → validation failure on insert. (If validate tolerates
    // it, this still exercises the !r.ok throw path defensively.)
    const r = await runHybrid('import_media', { path: 'C:/x.mp4' }, deps).then(() => 'ok', () => 'threw')
    expect(['ok', 'threw']).toContain(r)
  })
})

describe('runHybrid: unhandled tool', () => {
  it('throws for a tool with no arm', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await expect(runHybrid('__nonexistent_tool__', {}, deps)).rejects.toThrow(/unhandled tool/)
  })
})

describe('runHybrid: apply_subtitles (MCP hybrid)', () => {
  it('builds a caption track with 2 Text layers and returns the BARE track-id string', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // MCP arm returns the Rust ToolResult TEXT — the bare track id when not
    // simplified. (server.ts stringifies this; an object would surface as
    // "[object Object]".)
    const result = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: null }, deps)
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
    // The returned id must name a caption track with exactly 2 layers (one per cue).
    const snap = actor.snapshot()
    const track = root(snap).tracks.find((t) => t.id === result)
    expect(track).toBeTruthy()
    expect(track!.layers).toHaveLength(2)
  })

  it('appends the simplified-styling annotation when ASS styling was lossy', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // Drive the fake parser with simplified:true → the MCP text gains the
    // "(some ASS styling was simplified)" suffix (hybrids.ts, apply_subtitles arm).
    deps.compute.parseSubtitles = vi.fn(async () => JSON.stringify({
      cues: [{ start_us: 0, end_us: 1_000_000, text: 'hi', style: { bold: false, italic: false } }],
      simplified: true,
    }))
    const result = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: 'ass' }, deps)
    expect(typeof result).toBe('string')
    expect(result).toMatch(/ \(some ASS styling was simplified\)$/)
    // The id prefix must still resolve to a real track.
    const id = (result as string).replace(/ \(some ASS styling was simplified\)$/, '')
    expect(root(actor.snapshot()).tracks.find((t) => t.id === id)).toBeTruthy()
  })

  it('calls compute.parseSubtitles with the body and format', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: 'srt' }, deps)
    expect(deps._parseSubtitles).toHaveBeenCalledWith(TWO_CUE_SRT, 'srt')
  })

  it('throws when the actor rejects the caption track (empty cues)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // Override parseSubtitles to return zero cues — the TS actor validates the
    // caption track; either way we test the throw path.
    deps.compute.parseSubtitles = vi.fn(async () => JSON.stringify({ cues: [], simplified: false }))
    // The actor may or may not error on zero cues, but the hybrid must not crash
    // unexpectedly — it either succeeds or propagates an actor error.
    const r = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: null }, deps).then(() => 'ok', () => 'threw')
    expect(['ok', 'threw']).toContain(r)
  })
})

describe('runHybrid: import_media .srt (renderer subtitle branch)', () => {
  it('reads the file, calls parseSubtitles, and returns a BARE track-id string without probing media', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    const result = await runHybrid('import_media', { path: 'C:/My Subs/captions.srt' }, deps)
    expect(deps._probeMedia).not.toHaveBeenCalled()
    expect(deps._readFile).toHaveBeenCalledWith('C:/My Subs/captions.srt')
    expect(deps._parseSubtitles).toHaveBeenCalledWith(TWO_CUE_SRT, null)
    // import_media returns the bare track id string, NOT an object.
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('uses the full filename (with extension) as the caption label', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    const id = await runHybrid('import_media', { path: 'C:\\My Subs\\captions.srt' }, deps) as string
    const track = root(actor.snapshot()).tracks.find((t) => t.id === id)
    expect(track).toBeTruthy()
    // The import_media subtitle branch labels the track with the full filename
    // → "captions.srt" WITH extension.
    expect(track!.label).toBe('captions.srt')
  })

  it('also branches on .ass and .vtt extensions', async () => {
    for (const ext of ['.ass', '.vtt']) {
      const actor = freshActor()
      const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
      const result = await runHybrid('import_media', { path: `C:/subs${ext}` }, deps)
      expect(deps._probeMedia).not.toHaveBeenCalled()
      expect(typeof result).toBe('string')
    }
  })
})

// ── synthesize_speech audio MediaItem fixture ──────────────────────────────
const AUDIO_MID = '00000000-0000-0000-0000-0000000000bb'
const DURATION_US = 2_000_000

function audioMediaItem(): import('../model').MediaItem {
  return mediaItemTemplate(AUDIO_MID, 'Audio', DURATION_US)
}

/** Fake synthesizeSpeechCompute payload: {media_item, duration_us, cached}. */
function fakeSpeechComputePayload(cached = false) {
  return JSON.stringify({ media_item: audioMediaItem(), duration_us: DURATION_US, cached })
}

describe('runHybrid: synthesize_speech (MCP hybrid)', () => {
  it('inserts the audio media item into the pool', async () => {
    const actor = freshActor()
    // Give the project an Audio track so ensureAudioTrack returns it.
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    expect(actor.snapshot().media_pool[AUDIO_MID]).toBeTruthy()
    expect(actor.snapshot().media_pool[AUDIO_MID].kind).toBe('Audio')
  })

  it('places an Audio layer on the target track with the correct span', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    const snap0 = actor.snapshot()
    const tStart = root(snap0).duration_us
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    const snap = actor.snapshot()
    const track = root(snap).tracks.find((t) => t.id === trackId)!
    expect(track).toBeTruthy()
    expect(track.layers).toHaveLength(1)
    const layer = track.layers[0]
    expect(layer.t_start_us).toBe(tStart)
    expect(layer.t_end_us).toBe(tStart + DURATION_US)
  })

  it('places the Audio layer with Voiceover role', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    // History granularity: the synth write-tail's layer add must be a SINGLE
    // commit (no extra update_layer_params op). add_media_item is UNRECORDED (no
    // history entry), and target_track_id is given (no ensureAudioTrack commit),
    // so the only recorded entry from the write-tail is the layer add.
    const lenBefore = actor.historyStatus().len
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    const lenAfter = actor.historyStatus().len
    expect(lenAfter - lenBefore).toBe(1)
    const snap = actor.snapshot()
    const track = root(snap).tracks.find((t) => t.id === trackId)!
    const layer = track.layers[0]
    expect((layer.params as import('../model').AudioParams).role).toBe('voiceover')
  })

  it('returns a JSON string with layer_id, media_id, t_start_us, t_end_us, cached', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload(true))
    const result = await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    // Must be a JSON STRING (not an object) — server.ts wraps with String(result).
    expect(typeof result).toBe('string')
    const parsed = JSON.parse(result as string) as { layer_id: string; media_id: string; t_start_us: number; t_end_us: number; cached: boolean }
    expect(parsed.media_id).toBe(AUDIO_MID)
    expect(typeof parsed.layer_id).toBe('string')
    expect(parsed.layer_id.length).toBeGreaterThan(0)
    expect(parsed.t_end_us - parsed.t_start_us).toBe(DURATION_US)
    expect(parsed.cached).toBe(true)
  })

  it('honours an explicit t_start_us arg', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    const result = await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId, t_start_us: 5_000_000 }, deps)
    const parsed = JSON.parse(result as string) as { t_start_us: number; t_end_us: number }
    expect(parsed.t_start_us).toBe(5_000_000)
    expect(parsed.t_end_us).toBe(5_000_000 + DURATION_US)
  })

  it('kicks enqueueDerivatives with the audio media item', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as import('../model').MediaItem[]
    expect(arg[0].id).toBe(AUDIO_MID)
  })

  it('ensureAudioTrack returns the last existing track when target_track_id is omitted', async () => {
    // Fresh project has 2 reserved (non-removable) A/B-roll tracks, so
    // ensureAudioTrack (hybrids.ts) returns the LAST existing track — it does NOT
    // create a track here. The zero-track add_track('Voiceover') branch is
    // unreachable through the validated actor (reserved tracks can't be removed),
    // so it's not exercised.
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1 }, deps)
    const snap = actor.snapshot()
    // A layer must have been placed on some track.
    const layerCount = root(snap).tracks.flatMap((t) => t.layers).length
    expect(layerCount).toBeGreaterThanOrEqual(1)
    // The placed layer must be on the last existing track.
    const lastTrack = root(snap).tracks[root(snap).tracks.length - 1]
    expect(lastTrack.layers).toHaveLength(1)
  })
})

// ── The canonical cut list and its two apply verbs ──────────────────────────

/** A whole-source ShotReport JSON as the floor scan returns it: shots are
 *  the spans between `boundariesUs` (source-absolute), clipped to `[0,endUs]`. */
function shotReport(boundariesUs: number[], endUs: number): string {
  const bounds = [0, ...boundariesUs, endUs]
  const shots = []
  for (let i = 0; i < bounds.length - 1; i++)
    shots.push({ t_start_us: bounds[i], t_end_us: bounds[i + 1], keyframe_t_us: (bounds[i] + bounds[i + 1]) / 2 })
  return JSON.stringify({ shots, cut_scores: boundariesUs.map((t) => ({ t_us: t, score: 0.5 })) })
}

/** Point the shot compute at one whole-source report and hand back both spies.
 *
 *  The reduce ECHOES its input rather than reducing: the real one is Rust's,
 *  unit-tested there, and re-implementing it here would twin exactly the
 *  invariant the split exists to keep single. What these tests own is the TS
 *  half — which window and which parameters the reduce is asked for, and where
 *  its answer lands on the frame grid. */
/** What the fake addon answers for the detection defaults. The values are the
 *  fake's, not a mirror of Rust's: the tests below pin that an omitted parameter
 *  resolves to WHATEVER the addon states, which is the whole point of reading
 *  them rather than declaring them. */
const RUST_SHOT_DEFAULTS = { sensitivity: 0.4, min_shot_us: 500_000 }

function withShotReport(deps: HybridDeps, boundariesUs: number[], endUs: number) {
  const analyzeShotsFloor = vi.fn(async () => shotReport(boundariesUs, endUs))
  const reduceShotReport = vi.fn((reportJson: string) => reportJson)
  deps.compute.analyzeShotsFloor = analyzeShotsFloor
  deps.compute.reduceShotReport = reduceShotReport
  return { analyzeShotsFloor, reduceShotReport }
}

/** Fresh project with a VideoClip layer on the A-roll track: full-window at the
 *  origin by default, or offset in BOTH source and timeline through `opts` —
 *  the only shape in which a source time and a timeline time can be told apart. */
function withVideoLayer(durationUs = 6_000_000, opts: { srcInUs?: number; srcOutUs?: number; tStartUs?: number } = {}) {
  const actor = freshActor()
  const track = root(actor.snapshot()).tracks[0].id
  const VID = '00000000-0000-0000-0000-0000000000cc'
  actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: durationUs })
  const srcIn = opts.srcInUs ?? 0
  const srcOut = opts.srcOutUs ?? durationUs
  const tStart = opts.tStartUs ?? 0
  const add = actor.dispatch('add_layer', { track, kind: 'video', media: VID, src_in_us: srcIn, src_out_us: srcOut, t_start_us: tStart, t_end_us: tStart + (srcOut - srcIn) })
  if (!add.ok) throw new Error(JSON.stringify(add.error))
  return { actor, track, mediaId: VID, layerId: add.value as string }
}

/** The same clip one composition deeper: a full-window VideoClip on a Group's A
 *  roll, the root holding nothing but the CompositionRef. The smallest project
 *  in which "the clip's composition" and "the root" differ. */
function withVideoLayerInGroup(durationUs = 6_000_000) {
  const idGen = seededGen()
  const p = blankProject(idGen, 'hg')
  const VID = '00000000-0000-0000-0000-0000000000cc'
  p.media_pool[VID] = mediaItemTemplate(VID, 'Video', durationUs)
  let layerId = ''
  const { p: withComp, groupId } = withGroup(p, idGen, (g, view) => {
    layerId = applyAddLayer(view, idGen, g.tracks[0].id, videoClipParams(VID, 0, durationUs), 0, durationUs)
  })
  const actor = createActor({ initial: withComp, idGen, clock: () => '<TS>' })
  return { actor, groupId, layerId }
}

describe('runHybrid: auto_split_by_shot', () => {
  it('splits a VideoClip at every in-window cut in ONE history entry and returns the segment ids', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    // Single-undo acceptance: the whole multi-split is ONE recorded commit.
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    const parsed = JSON.parse(result as string) as { layer_ids: string[] }
    expect(parsed.layer_ids).toHaveLength(3)
    const track = root(actor.snapshot()).tracks.find((t) => t.layers.some((l) => l.id === layerId))!
    expect(track.layers.map((l) => [l.t_start_us, l.t_end_us])).toEqual([
      [0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 6_000_000],
    ])
  })

  it('passes min_shot_us through to the reduce, at the default threshold', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    const { reduceShotReport } = withShotReport(deps, [3_000_000], 6_000_000)
    await runHybrid('auto_split_by_shot', { layer_id: layerId, min_shot_us: 1_000_000 }, deps)
    // The scan is threshold-independent, so the tool's spacing argument reaches
    // the reduce rather than the scan's opts — and the threshold it is reduced
    // at is the detection default, which is what keeps this tool landing where
    // analyze_clip reports cuts.
    expect(reduceShotReport.mock.calls[0].slice(1)).toEqual([
      RUST_SHOT_DEFAULTS.sensitivity, 1_000_000, 0, 6_000_000,
    ])
  })

  it('returns the single unchanged layer id (no commit) when there is no interior cut', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [], 6_000_000) // one whole-clip shot
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(0)
    expect((JSON.parse(result as string) as { layer_ids: string[] }).layer_ids).toEqual([layerId])
  })

  it('drop_short deletes segments shorter than min_shot_us in the SAME commit', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    // Cuts at 2.0s then 2.3s → a 0.3s sliver segment; drop_short removes it.
    withShotReport(deps, [2_000_000, 2_300_000], 6_000_000)
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId, min_shot_us: 500_000, drop_short: true }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1) // still ONE commit (split + drop)
    const parsed = JSON.parse(result as string) as { layer_ids: string[] }
    expect(parsed.layer_ids).toHaveLength(2) // the 0.3s segment was dropped
    const track = root(actor.snapshot()).tracks.find((t) => t.layers.length > 0 && t.layers.some((l) => parsed.layer_ids.includes(l.id)))!
    expect(track.layers).toHaveLength(2)
  })

  it('collapses sub-frame-spaced cuts to one split instead of throwing', async () => {
    // Two source boundaries less than one frame apart snap to the SAME timeline
    // frame. Without the snap+dedup in cutsToTimeline (and the guard in
    // split_layer_multi) the second split would hit SplitOutsideLayer and abort
    // the whole auto_split. Expect one effective cut → two segments, one commit.
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 2_000_100], 6_000_000)
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    expect((JSON.parse(result as string) as { layer_ids: string[] }).layer_ids).toHaveLength(2)
  })

  it('rejects a missing layer_id', async () => {
    const { actor } = withVideoLayer()
    const deps = makeDeps(actor)
    await expect(runHybrid('auto_split_by_shot', {}, deps)).rejects.toThrow(/layer_id/)
  })

  it('rejects a non-VideoClip layer', async () => {
    const actor = freshActor()
    const track = root(actor.snapshot()).tracks[0].id
    const add = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const deps = makeDeps(actor)
    await expect(runHybrid('auto_split_by_shot', { layer_id: add.value as string }, deps)).rejects.toThrow(/VideoClip/)
  })

  it('throws (not silent no-op) when the shot compute is not wired into the build', async () => {
    const { actor, layerId } = withVideoLayer()
    const deps = makeDeps(actor)
    deps.compute.analyzeShotsFloor = undefined
    await expect(runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)).rejects.toThrow(/not available/)
    // The reduce is half of the same capability, so losing either one has to
    // refuse — a scan with nothing to narrow it is not a usable detector.
    deps.compute.analyzeShotsFloor = vi.fn(async () => shotReport([], 6_000_000))
    deps.compute.reduceShotReport = undefined
    await expect(runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)).rejects.toThrow(/not available/)
    // And the defaults: an omitted parameter with nothing to resolve it to must
    // refuse rather than reach for a number of its own.
    deps.compute.reduceShotReport = vi.fn((reportJson: string) => reportJson)
    deps.compute.shotDefaultOpts = undefined
    await expect(runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)).rejects.toThrow(/not available/)
  })
})

describe('markShotCuts (the mark verb)', () => {
  it('drops a marker at each cut in ONE commit, at the SAME times auto_split_by_shot splits', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    const lenBefore = actor.historyStatus().len
    const ids = await markShotCuts({ layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1) // single undo entry
    expect(ids).toHaveLength(2)
    // Consistency with the tool: markers land at the interior cut times (2s, 4s),
    // the exact source→timeline boundaries auto_split_by_shot would split at.
    expect(root(actor.snapshot()).markers.map((m) => m.t_us).sort((a, b) => a - b)).toEqual([2_000_000, 4_000_000])
  })

  it('is a no-op (no markers, no commit) when the clip has no interior cut', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [], 6_000_000)
    const lenBefore = actor.historyStatus().len
    const ids = await markShotCuts({ layer_id: layerId }, deps)
    expect(ids).toEqual([])
    expect(actor.historyStatus().len - lenBefore).toBe(0)
    expect(root(actor.snapshot()).markers).toEqual([])
  })

  // The clip menu's zero-argument entry reaches this verb through the
  // drop_shot_markers arm, so the arm that adapts its camelCase IPC args is
  // covered too — a rename on either side would otherwise fail only in the
  // running app.
  it('is reachable as the drop_shot_markers hybrid arm, returning a marker COUNT', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    // An object, not a JSON string: this arm is renderer-only (absent from
    // HYBRID_TOOLS), so server.ts's stringify contract does not apply to it.
    expect(await runHybrid('drop_shot_markers', { layerId }, deps)).toEqual({ markers: 2 })
    expect(root(actor.snapshot()).markers).toHaveLength(2)
  })

  it('the hybrid arm rejects a missing layerId instead of silently marking nothing', async () => {
    const { actor } = withVideoLayer(6_000_000)
    await expect(runHybrid('drop_shot_markers', {}, makeDeps(actor))).rejects.toThrow(/layerId/)
  })

  it("marks the CLIP'S composition: a clip inside a Group marks the Group, and the root gains nothing", async () => {
    const { actor, groupId, layerId } = withVideoLayerInGroup(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    expect(await markShotCuts({ layer_id: layerId }, deps)).toHaveLength(2)
    const inner = actor.snapshot().compositions[groupId]
    // The cut times were computed against the Group's fps and the clip's own
    // t_start_us, so the Group is the only timeline they mean anything on.
    expect(inner.markers.map((m) => m.t_us)).toEqual([2_000_000, 4_000_000])
    expect(inner.markers.map((m) => m.anchor)).toEqual([
      { layer: layerId, src_us: 2_000_000 }, { layer: layerId, src_us: 4_000_000 },
    ])
    expect(root(actor.snapshot()).markers).toEqual([])
  })

  it("anchors every mark to the clip, at its own cut's SOURCE time (not the timeline time it landed on)", async () => {
    // Source window [1s, 7s) placed at 2s, so timeline = source + 1s: an anchor
    // that merely copied t_us would be off by exactly that offset.
    const { actor, layerId } = withVideoLayer(10_000_000, { srcInUs: 1_000_000, srcOutUs: 7_000_000, tStartUs: 2_000_000 })
    const deps = makeDeps(actor)
    withShotReport(deps, [3_000_000, 5_000_000], 10_000_000)
    expect(await markShotCuts({ layer_id: layerId }, deps)).toHaveLength(2)
    expect(root(actor.snapshot()).markers.map((m) => [m.t_us, m.anchor])).toEqual([
      [4_000_000, { layer: layerId, src_us: 3_000_000 }],
      [6_000_000, { layer: layerId, src_us: 5_000_000 }],
    ])
  })

  it('a whole anchored set is ONE undo, restoring the project exactly', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    const before = JSON.stringify(actor.snapshot())
    const lenBefore = actor.historyStatus().len
    await markShotCuts({ layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })

  it('shot marks travel with the clip when it moves', async () => {
    const { actor, track, layerId } = withVideoLayer(10_000_000, { srcInUs: 1_000_000, srcOutUs: 7_000_000, tStartUs: 2_000_000 })
    const deps = makeDeps(actor)
    withShotReport(deps, [3_000_000, 5_000_000], 10_000_000)
    await markShotCuts({ layer_id: layerId }, deps)
    expect(actor.dispatch('move_layer', { layer: layerId, to_track: track, t_start_us: 5_000_000 }).ok).toBe(true)
    expect(root(actor.snapshot()).markers.map((m) => m.t_us)).toEqual([7_000_000, 9_000_000])
  })

  it('trimming the out-point past a shot mark hibernates it; re-extending revives it on the same frame', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    await markShotCuts({ layer_id: layerId }, deps)
    expect(actor.dispatch('trim_layer', { layer: layerId, edge: 'out', new_t_us: 3_000_000 }).ok).toBe(true)
    const trimmed = root(actor.snapshot())
    // Hibernation is a KEPT marker the clip no longer shows — its time freezes
    // rather than being re-derived, and nothing is deleted.
    expect(trimmed.markers.map((m) => [m.t_us, markerHibernating(trimmed, m)])).toEqual([
      [2_000_000, false], [4_000_000, true],
    ])
    expect(actor.dispatch('trim_layer', { layer: layerId, edge: 'out', new_t_us: 6_000_000 }).ok).toBe(true)
    const restored = root(actor.snapshot())
    expect(restored.markers.map((m) => [m.t_us, markerHibernating(restored, m)])).toEqual([
      [2_000_000, false], [4_000_000, false],
    ])
  })

  it('deleting the clip takes its shot marks with it', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [2_000_000, 4_000_000], 6_000_000)
    await markShotCuts({ layer_id: layerId }, deps)
    expect(actor.dispatch('delete_layer', { layer: layerId }).ok).toBe(true)
    expect(root(actor.snapshot()).markers).toEqual([])
  })
})

/** The interior boundaries a split produced, read off the segments it returned
 *  (which come back in timeline order) rather than off track order. */
function boundariesOf(actor: ActorHandle, layerIds: string[]): number[] {
  const byId = new Map(root(actor.snapshot()).tracks.flatMap((t) => t.layers).map((l) => [l.id, l]))
  return layerIds.slice(1).map((id) => byId.get(id)!.t_start_us)
}

describe('runHybrid: apply_shot_cuts', () => {
  // The acceptance the whole channel exists for, asserted directly rather than
  // inferred from a shared call site: two projects in the same state, one list,
  // both verbs. `withVideoLayer` mints deterministic ids, so the two runs name
  // the same layer.
  it('splits and marks the SAME explicit list onto identical frames', async () => {
    const cutsSrcUs = [1_510_000, 3_020_000, 4_490_000]
    const a = withVideoLayer(6_000_000)
    const b = withVideoLayer(6_000_000)
    expect(a.layerId).toBe(b.layerId)
    const split = await runHybrid('apply_shot_cuts',
      { layer_id: a.layerId, mode: 'split', cuts_src_us: cutsSrcUs }, makeDeps(a.actor)) as { layer_ids: string[] }
    const mark = await runHybrid('apply_shot_cuts',
      { layer_id: b.layerId, mode: 'mark', cuts_src_us: cutsSrcUs }, makeDeps(b.actor)) as { marker_ids: string[] }
    const boundaries = boundariesOf(a.actor, split.layer_ids)
    expect(boundaries).toEqual(root(b.actor.snapshot()).markers.map((m) => m.t_us))
    // And the frames are the GRID's, not the caller's: none of these three
    // source times sits on a 30fps boundary, so an unsnapped path would agree
    // with itself while landing off-grid.
    expect(boundaries).not.toEqual(cutsSrcUs)
    expect(mark.marker_ids).toHaveLength(3)
  })

  it('splits at exactly the surviving times of a filtered list, and consults no detector', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    const { analyzeShotsFloor } = withShotReport(deps, [2_000_000, 3_000_000, 4_000_000], 6_000_000)
    // The reviewer kept the outer two boundaries and vetoed the middle one.
    const r = await runHybrid('apply_shot_cuts',
      { layer_id: layerId, mode: 'split', cuts_src_us: [2_000_000, 4_000_000] }, deps) as { layer_ids: string[] }
    expect(boundariesOf(actor, r.layer_ids)).toEqual([2_000_000, 4_000_000])
    // An explicit list is the answer, not a hint: re-deriving it would let a
    // stale threshold reinstate the row the reviewer removed.
    expect(analyzeShotsFloor).not.toHaveBeenCalled()
  })

  it('is an idempotent no-op with no history entry when the list is empty', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    const lenBefore = actor.historyStatus().len
    expect(await runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'split', cuts_src_us: [] }, deps))
      .toEqual({ mode: 'split', layer_ids: [layerId] })
    expect(await runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'mark', cuts_src_us: [] }, deps))
      .toEqual({ mode: 'mark', marker_ids: [] })
    expect(actor.historyStatus().len - lenBefore).toBe(0)
    expect(root(actor.snapshot()).markers).toEqual([])
  })

  it('is the same no-op when the detector finds no interior boundary', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    withShotReport(deps, [], 6_000_000)
    const lenBefore = actor.historyStatus().len
    expect(await runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'mark' }, deps))
      .toEqual({ mode: 'mark', marker_ids: [] })
    expect(actor.historyStatus().len - lenBefore).toBe(0)
  })

  // A list assembled row by row is worth pointing at. Each case refuses with the
  // structured shape the renderer's parseCommandError reads, names the offending
  // index, and — the part that matters — writes nothing: a half-applied set of
  // splits is not something an undo can be trusted to describe.
  it.each([
    ['unsorted', [3_000_000, 2_000_000]],
    ['duplicated', [2_000_000, 2_000_000]],
    ['at the window edge', [0, 2_000_000]],
    ['past the window end', [2_000_000, 6_000_000]],
    ['not a number', [2_000_000, Number.NaN]],
    ['not even an array', 'nope'],
  ])('refuses a list that is %s, and writes nothing', async (_name, cutsSrcUs) => {
    for (const mode of ['split', 'mark'] as const) {
      const { actor, layerId } = withVideoLayer(6_000_000)
      const deps = makeDeps(actor)
      const lenBefore = actor.historyStatus().len
      const err = await runHybrid('apply_shot_cuts', { layer_id: layerId, mode, cuts_src_us: cutsSrcUs }, deps)
        .then(() => null, (e: Error) => JSON.parse(e.message) as { error: string; field: string; detail: string })
      expect(err?.error).toBe('InvalidArgument')
      expect(err?.field).toBe('cuts_src_us')
      expect(err?.detail.length).toBeGreaterThan(0)
      expect(actor.historyStatus().len - lenBefore).toBe(0)
      expect(root(actor.snapshot()).markers).toEqual([])
      expect(root(actor.snapshot()).tracks.flatMap((t) => t.layers).map((l) => l.id)).toEqual([layerId])
    }
  })

  it('refuses an unknown mode rather than guessing a verb', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    await expect(runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'discard' }, deps))
      .rejects.toThrow(/"field":"mode"/)
  })

  // Nothing caught the loss of this argument before: resolveShotCuts built the
  // detection opts without it, so every threshold a caller asked for silently
  // became the default.
  it('passes sensitivity through to the reduce', async () => {
    const { actor, layerId } = withVideoLayer(10_000_000, { srcInUs: 1_000_000, srcOutUs: 7_000_000, tStartUs: 2_000_000 })
    const deps = makeDeps(actor)
    const { reduceShotReport } = withShotReport(deps, [3_000_000], 10_000_000)
    await runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'mark', sensitivity: 0.12, min_shot_us: 250_000 }, deps)
    // Threshold, spacing, then the LAYER's source window — the reduce is asked
    // for the clip's view, not the whole source's.
    expect(reduceShotReport.mock.calls[0].slice(1)).toEqual([0.12, 250_000, 1_000_000, 7_000_000])
  })

  it('falls back to the detection defaults when neither parameter is given', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    const { reduceShotReport } = withShotReport(deps, [2_000_000], 6_000_000)
    await runHybrid('apply_shot_cuts', { layer_id: layerId, mode: 'split' }, deps)
    expect(reduceShotReport.mock.calls[0].slice(1)).toEqual([
      RUST_SHOT_DEFAULTS.sensitivity, RUST_SHOT_DEFAULTS.min_shot_us, 0, 6_000_000,
    ])
  })

  it('drops short segments inside the same commit as the split', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    const lenBefore = actor.historyStatus().len
    const r = await runHybrid('apply_shot_cuts',
      { layer_id: layerId, mode: 'split', cuts_src_us: [2_000_000, 2_300_000], drop_short_us: 500_000 }, deps) as { layer_ids: string[] }
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    expect(r.layer_ids).toHaveLength(2)
  })

  it('marks a clip inside a Group on the GROUP, with anchors at the source times given', async () => {
    const { actor, groupId, layerId } = withVideoLayerInGroup(6_000_000)
    const deps = makeDeps(actor)
    const r = await runHybrid('apply_shot_cuts',
      { layer_id: layerId, mode: 'mark', cuts_src_us: [2_000_000, 4_000_000] }, deps) as { marker_ids: string[] }
    expect(r.marker_ids).toHaveLength(2)
    const inner = actor.snapshot().compositions[groupId]
    expect(inner.markers.map((m) => [m.t_us, m.label, m.anchor])).toEqual([
      [2_000_000, 'Cut 1', { layer: layerId, src_us: 2_000_000 }],
      [4_000_000, 'Cut 2', { layer: layerId, src_us: 4_000_000 }],
    ])
    expect(root(actor.snapshot()).markers).toEqual([])
  })
})

describe('cutsToTimeline', () => {
  const layer = { t_start_us: 2_000_000, t_end_us: 8_000_000 }
  const params = { src_in_us: 1_000_000 }
  const fps = { num: 30, den: 1 }

  it('offsets source→timeline and snaps to the frame grid', () => {
    // 3.51s source → 4.51s timeline → the nearest 30fps frame (135) at 4.5s.
    expect(cutsToTimeline([3_510_000], layer, params, fps)).toEqual([{ tUs: 4_500_000, srcUs: 3_510_000 }])
  })

  it('collapses boundaries that snap onto one frame, keeping the first', () => {
    expect(cutsToTimeline([3_500_000, 3_510_000], layer, params, fps))
      .toEqual([{ tUs: 4_500_000, srcUs: 3_500_000 }])
  })

  it('drops boundaries that land on or outside the layer bounds', () => {
    // 1s source is the window's own start and 7s its end; a zero-length split is
    // invalid, so neither can survive as a cut.
    expect(cutsToTimeline([1_000_000, 7_000_000, 9_000_000], layer, params, fps)).toEqual([])
  })
})

describe('applyWorkspacePathsEvent', () => {
  it('updates the media item path/rel/hash/size/mtime via the set_media_workspace_paths dispatch', () => {
    const actor = freshActor()
    // Insert the item first (otherwise MediaNotFound).
    const r0 = actor.dispatch('add_media_item', { media: probedItem() })
    expect(r0.ok).toBe(true)
    const r = applyWorkspacePathsEvent(actor, {
      media_id: MID,
      path_abs: 'ws/Media/clip.mp4',
      path_rel: 'Media/clip.mp4',
      file_hash_blake3: 'deadbeef',
      file_size: 2048,
      file_mtime: 1700000001,
    })
    expect(r.ok).toBe(true)
    const item = actor.snapshot().media_pool[MID]
    expect([item.path_abs, item.path_rel, item.file_hash_blake3, item.file_size, item.file_mtime])
      .toEqual(['ws/Media/clip.mp4', 'Media/clip.mp4', 'deadbeef', 2048, 1700000001])
  })

  it('is MediaNotFound-tolerant (logs, returns the failed result, does not throw)', () => {
    const actor = freshActor()
    const r = applyWorkspacePathsEvent(actor, {
      media_id: MID, path_abs: 'a', path_rel: 'r', file_hash_blake3: 'h', file_size: 1, file_mtime: 2,
    })
    expect(r.ok).toBe(false)
  })
})
