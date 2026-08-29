import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyze } from '../lib/analyze.mjs'
import {
  driveExport,
  importAndPlaceMedia,
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
} from './helpers/driver'

/**
 * Pre-compose is invisible: it changes the project's SHAPE, not its picture, its
 * sound, or the time anything happens at (ADR 0052, docs/features.md § Groups).
 *
 * The fixture is deliberately the awkward one — an auto-paired A/V clip, a
 * lower-third Text layer on its own lane, and a Crossfade between the clip and
 * the layer that follows it — because pre-compose then has to carry four things
 * across a composition boundary at once: members re-based to the selection's
 * start, parent lanes mapped bottom-up onto the child's A roll / B roll so
 * relative z-order survives, the link moving with its members, and the
 * transition moving because BOTH participants are inside. Any one of those going
 * wrong changes the frame, the mix, or both, and none of it is visible from a
 * project summary that says the layers are all still there.
 *
 * Four assertions, in the order a defect would surface:
 *
 *   0. WITNESS — a third export with the lower third switched off must FAIL the
 *      floor the picture comparison passes. Two exports of one project agree
 *      trivially if both are wrong the same way, and this is what says the
 *      comparison is looking at a real composite.
 *   1. PICTURE — the two exports are the same file frame for frame
 *      (`analyze` output-vs-output, the `text-box-cjk-export` shape).
 *   2. SOUND — both exports still carry the source's per-second tone markers in
 *      the right output seconds, at the same measured boundary offset. The
 *      Rust mixer walks the project itself (`audio/mix.rs`), so a Group is a
 *      second place its walk can stop early.
 *   3. SHAPE — ungroup puts the project back: the saved `project.json` compares
 *      equal to the pre-Group one modulo the ids both structural ops re-mint.
 *
 * Local-only, like every gate that needs real media (`npm run fixtures`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
/// The per-second tone-marker A/V fixture (shared with `audio.spec.ts`): source
/// second k carries F_k = 400 + 120k Hz, which is what lets the analyzer's
/// `--audio` mode say which source second landed in which output second. The
/// video half carries a burned-in counter, so neighbouring frames are distinct
/// and the picture differential's alignment search means something.
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps_audio.mp4')

/// 640x360 rather than the source's 1080p: the differential compares exports of
/// the same composite, so the composition's own resolution is not under test and
/// a quarter-size frame is a quarter of the encode cost — three exports over.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// The clip is trimmed to a whole 2 s so the export is exactly 2 s of audio —
/// `analyze --audio` walks every FULL second of the output and requires a tone
/// in each, so a fixture whose timeline outran its audio would report the
/// silence as a misaligned second.
const CLIP_END_US = 2_000_000
const TRANSITION_US = 500_000
/// Overlap placement (the default) moves the incoming layer LEFT by the
/// duration, so the tail Color lands here and the timeline still ends at
/// `CLIP_END_US`.
const TAIL_START_US = CLIP_END_US - TRANSITION_US
const TOTAL_FRAMES = 60
const TAIL = { r: 30, g: 60, b: 200, a: 255 }

/// Frames 48 and 55 sit INSIDE the crossfade window (frames 45-59), which is
/// the part of the picture pre-compose is most likely to change: the transition
/// bakes at the root in one leg and inside the Group's own frame in the other.
/// 5 / 20 / 35 cover the plain video stretch.
const SAMPLES = [5, 20, 35, 48, 55]

/// Both legs encode the same composite through the same encoder at the same
/// settings, so this is not a source-fidelity floor (`exportSsimFloor`): measured
/// runs decode IDENTICAL frames (ssim 1.0, psnr at the analyzer's 100 dB identity
/// clamp). A floor rather than an equality because there IS one licensed
/// difference — the Group's picture crosses an 8-bit `RenderTexture` before the
/// root stages it 1:1, and the identity draw only rounds to nothing while the
/// composite is 8-bit too. The 10-bit lane quantizes through a Group by design
/// (`CompositionRefSprite`), so an equality assertion here would break the day
/// this gate is run at `bitDepth: 10`.
const SSIM_FLOOR = 0.99

/// The analyzer's own audio tolerance is 66 ms (AAC priming), so this is not a
/// second copy of that bound: both files were muxed the same way, and what is
/// asserted is that the two measured boundary offsets AGREE. A Group that
/// shifted the mix by a frame would move one of them by 33 ms.
const AUDIO_OFFSET_AGREEMENT_MS = 5

interface WireLayer {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string; composition?: string; src_in_us?: number; src_out_us?: number }
}
interface WireTrack {
  id: string
  role: string | null
  layers: WireLayer[]
}
interface WireComposition {
  id: string
  duration_us: number
  tracks: WireTrack[]
  links: Array<{ id: string; layer_ids: string[] }>
  transitions: Array<{ id: string; from_layer: string; to_layer: string; duration_us: number }>
}
interface Wire {
  root_id: string
  compositions: Record<string, WireComposition>
}

const wire = (page: Page): Promise<Wire> => invokeCmd<Wire>(page, 'project_summary', {})
const layersOf = (c: WireComposition): WireLayer[] => c.tracks.flatMap((t) => t.layers)
const byId = (c: WireComposition, id: string): WireLayer => {
  const l = layersOf(c).find((x) => x.id === id)
  if (!l) throw new Error(`layer ${id} is not in composition ${c.id}`)
  return l
}

const exportedFrames = async (page: Page): Promise<number> => {
  const perf = (await page.evaluate(
    () =>
      (window as unknown as { __weftcutExportPerf?: { totalFrames: number } })
        .__weftcutExportPerf ?? null,
  )) as { totalFrames: number } | null
  if (!perf) throw new Error('no __weftcutExportPerf after the export — is this an E2E build?')
  return perf.totalFrames
}

const setTrackValue = (page: Page, layerId: string, paramKey: string, value: number) =>
  invokeCmd(page, 'update_layer_param_track', {
    layerId,
    paramKey,
    track: { mode: 'Static', value },
  })

// ── The project-shape comparison ─────────────────────────────────────────────
// `project.json` is the whole model (`serializeProject`), so comparing the saved
// bytes is the broadest statement available about the round trip — every field
// of every layer, track, link and transition, not a projection someone has to
// remember to extend. Three things stand between the bytes and an equality:
// re-minted ids, one wall-clock stamp, and the media pool.
//
// The media pool is EXCLUDED and replaced by its key set, because it is the one
// part of the file that moves on its own: `conform_path`, `decode_route`'s
// `quick_proxy` and `thumbnails_dir` are cache bookkeeping filled in by
// background jobs, and the two exports between the two saves are exactly when
// those jobs land. Neither structural op writes any of it — what they COULD
// break is which media the project references, which is what the key set says.

interface ProjectJson {
  root_id: string
  compositions: Record<
    string,
    {
      tracks: Array<{ id: string; layers: Array<{ id: string; effects?: Array<{ id: string }> }> }>
      markers?: Array<{ id: string }>
      transitions?: Array<{ id: string }>
      links?: Array<{ id: string }>
    }
  >
  media_pool: Record<string, unknown>
  next_group_ordinal: number
}

/// Every id pre-compose or ungroup RE-MINTS, mapped to a token derived from the
/// project's shape.
///
/// LANDMINE — the walk order is load-bearing, and it is not the generic
/// key-sorted one used for the comparison itself. A link stores its members
/// sorted by RAW id, so tokenizing in key order would visit `links` before
/// `tracks` and let the freshly-minted ids' sort order decide which layer gets
/// which token: two isomorphic projects would then normalize differently and the
/// gate would fail on nothing. Ids are minted here in TRACK then LAYER order,
/// which is a property of the timeline rather than of the ids.
///
/// Composition ids, the media pool's keys and `project_id` are deliberately NOT
/// tokenized: the round trip must leave them untouched, so leaving them verbatim
/// makes an unexpected change fail loudly instead of being normalized away.
function idTokens(project: ProjectJson): Map<string, string> {
  const tokens = new Map<string, string>()
  const add = (id: unknown): void => {
    if (typeof id !== 'string' || tokens.has(id)) return
    tokens.set(id, `#id${tokens.size}`)
  }
  const compositionOrder = [
    project.root_id,
    ...Object.keys(project.compositions)
      .filter((k) => k !== project.root_id)
      .sort(),
  ]
  for (const cid of compositionOrder) {
    const c = project.compositions[cid]
    if (!c) continue
    for (const t of c.tracks) {
      add(t.id)
      for (const l of t.layers) {
        add(l.id)
        for (const e of l.effects ?? []) add(e.id)
      }
    }
    for (const m of c.markers ?? []) add(m.id)
    for (const tr of c.transitions ?? []) add(tr.id)
    for (const k of c.links ?? []) add(k.id)
  }
  return tokens
}

function normalizeProject(value: unknown, tokens: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeProject(v, tokens))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // The save stamp moves by construction — it is the one field that says
      // nothing about the shape.
      if (key === 'modified_at') continue
      const next = normalizeProject((value as Record<string, unknown>)[key], tokens)
      // Members are stored sorted by raw id (`serializeLink`), which ungroup
      // re-mints; sort by token so the ORDER is a fact about the members rather
      // than about the ids they happen to have been given.
      out[key] = key === 'members' && Array.isArray(next) ? [...next].sort() : next
    }
    return out
  }
  return typeof value === 'string' ? (tokens.get(value) ?? value) : value
}

/// Save and read back the on-disk project. Save rather than a wire read because
/// no command returns the serialized project, and `project.json` is the shape
/// that has to survive.
async function saveAndRead(
  page: Page,
  projectDir: string,
): Promise<{ shape: unknown; mediaIds: string[]; nextGroupOrdinal: number }> {
  await invokeCmd(page, 'project_save')
  const file = path.join(projectDir, 'project.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ProjectJson
  // The ordinal counter is lifted OUT of the compared shape and returned beside
  // it, not normalized away: it is monotonic, so a pre-compose spends a number
  // the ungroup never refunds, and it is the one field a round trip legitimately
  // moves. Returning it keeps the caller able to say by how much — a counter
  // dropped here would be a counter this test could no longer see run away.
  const { media_pool: mediaPool, next_group_ordinal: nextGroupOrdinal, ...timeline } = raw
  return {
    shape: normalizeProject(timeline, idTokens(raw)),
    mediaIds: Object.keys(mediaPool).sort(),
    nextGroupOrdinal,
  }
}

test('pre-composing an A/V pair, a lower third and a transition changes nothing that renders', async () => {
  test.skip(!existsSync(SOURCE), `tone source not found at ${SOURCE} (run \`npm run fixtures\`)`)
  test.setTimeout(300_000)
  const outDir = tmpDir('weftcut-e2e-group-conf-out-')
  const plainOut = path.join(outDir, 'plain.mp4')
  const groupedOut = path.join(outDir, 'grouped.mp4')
  const witnessOut = path.join(outDir, 'no-lower-third.mp4')
  const parentFolder = tmpDir('weftcut-e2e-group-conf-proj-')
  const name = `e2e-group-conf-${Date.now()}`
  const projectDir = path.join(parentFolder, name)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder, name, canvas: CANVAS })

    // ── Fixture ─────────────────────────────────────────────────────────────
    const { layerId: videoId } = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE })
    const w0 = await wire(page)
    const root0 = w0.compositions[w0.root_id]!
    const audioId = layersOf(root0).find((l) => l.params.kind === 'Audio')?.id
    expect(audioId, 'the A/V source must have auto-paired an Audio layer').toBeTruthy()
    const clipTrackId = root0.tracks.find((t) => t.layers.some((l) => l.id === videoId))!.id

    // Both halves trimmed with `escapeLink: true`: the aligned-edge fan-out
    // would do it in one call, but which edges count as aligned is another
    // slice's gate — here the geometry has to be exact, not inferred.
    for (const layerId of [videoId, audioId!]) {
      await invokeCmd(page, 'trim_layer', {
        layerId,
        edge: 'out',
        newTUs: CLIP_END_US,
        escapeLink: true,
      })
    }

    // The crossfade's other participant. It shares the clip's lane because a
    // transition's participants must (`add_transition`), and it is a Color layer
    // rather than a second video clip so the fixture costs one decode session.
    const tailId = await invokeCmd<string>(page, 'add_color_layer', {
      trackId: clipTrackId,
      color: TAIL,
      tStartUs: CLIP_END_US,
      durationUs: TRANSITION_US,
    })
    await invokeCmd<string>(page, 'add_transition', {
      fromLayerId: videoId,
      toLayerId: tailId,
      durationUs: TRANSITION_US,
      kind: 'Crossfade',
    })

    // The lower third. No `trackId`: the automatic placement is what puts it on
    // a lane of its own ABOVE the clip's, and that z-order is what pre-compose's
    // bottom-up lane mapping has to preserve.
    const textId = await invokeCmd<string>(page, 'add_text_layer', {
      tStartUs: 0,
      durationUs: CLIP_END_US,
      content: 'LOWER THIRD',
    })
    await invokeCmd(page, 'update_layer_params', {
      layerId: textId,
      patch: { kind: 'Text', font_size_px: 36 },
    })
    await setTrackValue(page, textId, 'x', 160)
    await setTrackValue(page, textId, 'y', 270)

    // The geometry every export below depends on. Asserted here so a fixture
    // that drifted fails as a fixture rather than as a conformance regression.
    const w1 = await wire(page)
    const root1 = w1.compositions[w1.root_id]!
    expect(byId(root1, videoId).t_end_us).toBe(CLIP_END_US)
    expect(byId(root1, audioId!).t_end_us).toBe(CLIP_END_US)
    expect(byId(root1, tailId).t_start_us).toBe(TAIL_START_US)
    expect(byId(root1, tailId).t_end_us).toBe(CLIP_END_US)
    expect(root1.duration_us).toBe(CLIP_END_US)
    expect(root1.transitions).toHaveLength(1)
    expect(root1.links).toHaveLength(1)
    const clipLane = root1.tracks.findIndex((t) => t.id === clipTrackId)
    const textLane = root1.tracks.findIndex((t) => t.layers.some((l) => l.id === textId))
    expect(textLane, 'the lower third must sit on a lane of its own').not.toBe(clipLane)
    expect(textLane, 'later lane = drawn on top (CompositionNode sweeps tracks in order)').toBeGreaterThan(clipLane)

    const shapeBefore = await saveAndRead(page, projectDir)

    // ── Leg 1: export the flat project ──────────────────────────────────────
    const plainRun = await driveExport(
      page,
      { outputAbsPath: plainOut },
      { hook: 'exportTimeline' },
    )
    if (!plainRun.done.ok) {
      throw new Error(`flat export failed: ${plainRun.done.error} | kind=${plainRun.lastKind} detail=${plainRun.lastDetail}`)
    }
    const plainFrames = await exportedFrames(page)

    // ── Witness: the differential can see a one-layer change ────────────────
    // A gate that compares two exports of the same project passes trivially if
    // BOTH files are wrong the same way — an empty frame, a missing overlay lane.
    // This export is the same timeline with the lower third switched off, and it
    // has to FAIL the floor the real comparison below passes. It proves two
    // things at once: the Text layer reaches the exported picture at all (nothing
    // else here does — the export burns pixels no probe can read), and the floor
    // is tight enough to notice when one lane stops contributing.
    await invokeCmd(page, 'set_layers_enabled', { layerIds: [textId], enabled: false })
    const witnessRun = await driveExport(
      page,
      { outputAbsPath: witnessOut },
      { hook: 'exportTimeline' },
    )
    if (!witnessRun.done.ok) throw new Error(`witness export failed: ${witnessRun.done.error}`)
    await invokeCmd(page, 'set_layers_enabled', { layerIds: [textId], enabled: true })
    const witness = analyze({
      output: witnessOut,
      source: plainOut,
      samples: SAMPLES,
      ssimMin: SSIM_FLOOR,
    })
    console.log('[e2e] lower-third witness (text disabled vs the flat export):', JSON.stringify(witness))
    const unseen = witness.samples.filter((s: { ssim: number }) => s.ssim >= SSIM_FLOOR)
    expect(
      unseen,
      `switching the lower third off changed nothing the comparison can see: ${JSON.stringify(unseen)}. ` +
        `Either the Text layer never reached the export (check the font collection pass) or the ` +
        `SSIM floor is too loose for the differential below to mean anything.`,
    ).toHaveLength(0)

    // ── Pre-compose all four layers ─────────────────────────────────────────
    const group = await invokeCmd<{ composition_id: string; layer_id: string }>(
      page,
      'groups_create',
      { layerIds: [videoId, audioId!, tailId, textId] },
    )
    const w2 = await wire(page)
    expect(Object.keys(w2.compositions)).toHaveLength(2)
    const root2 = w2.compositions[w2.root_id]!
    const child = w2.compositions[group.composition_id]!
    // The root is now ONE Group layer over the same span, and everything that
    // renders moved inside — including the link and the transition, both of
    // which had all their participants in the selection.
    expect(layersOf(root2).map((l) => l.params.kind)).toEqual(['CompositionRef'])
    expect(byId(root2, group.layer_id).t_start_us).toBe(0)
    expect(byId(root2, group.layer_id).t_end_us).toBe(CLIP_END_US)
    expect(byId(root2, group.layer_id).params.src_in_us).toBe(0)
    expect(byId(root2, group.layer_id).params.src_out_us).toBe(CLIP_END_US)
    expect(root2.duration_us).toBe(CLIP_END_US)
    expect(root2.transitions).toHaveLength(0)
    expect(root2.links).toHaveLength(0)
    expect(layersOf(child).map((l) => l.id).sort()).toEqual([videoId, audioId!, tailId, textId].sort())
    expect(child.transitions).toHaveLength(1)
    expect(child.links).toHaveLength(1)
    expect(child.duration_us).toBe(CLIP_END_US)

    // ── Leg 2: export the pre-composed project ──────────────────────────────
    const groupedRun = await driveExport(
      page,
      { outputAbsPath: groupedOut },
      { hook: 'exportTimeline' },
    )
    if (!groupedRun.done.ok) {
      throw new Error(`grouped export failed: ${groupedRun.done.error} | kind=${groupedRun.lastKind} detail=${groupedRun.lastDetail}`)
    }
    const groupedFrames = await exportedFrames(page)
    expect(existsSync(plainOut) && existsSync(groupedOut)).toBe(true)
    expect(plainFrames, 'the flat leg covers the whole 2 s timeline').toBe(TOTAL_FRAMES)
    expect(groupedFrames, 'a Group layer over the same span exports the same frames').toBe(plainFrames)

    // ── 1. PICTURE ──────────────────────────────────────────────────────────
    // The flat export stands in as the analyzer's `--source`: the default mode
    // is a generic two-file comparison (best-match index within +/-`window`, then
    // SSIM/PSNR at the same index), and with real video on both sides the
    // burned-in counter makes the +/-2 search a genuine no-temporal-shift check —
    // a Group that mapped time even one frame off would best-match a neighbour.
    const picture = analyze({
      output: groupedOut,
      source: plainOut,
      samples: SAMPLES,
      ssimMin: SSIM_FLOOR,
    })
    console.log('[e2e] pre-compose picture differential:', JSON.stringify(picture))
    const shifted = picture.samples.filter((s: { aligned: boolean }) => !s.aligned)
    expect(
      shifted,
      `pre-composing moved the picture in TIME: ${JSON.stringify(shifted)}. Parent time maps to ` +
        `composition time as t - t_start_us + src_in_us; check CompositionRefSprite's mapping ` +
        `and the Group layer's window.`,
    ).toHaveLength(0)
    const degraded = picture.samples.filter((s: { ssim: number }) => s.ssim < SSIM_FLOOR)
    expect(
      degraded,
      `pre-composing changed the picture: ${JSON.stringify(degraded)}. The Group holds the whole ` +
        `timeline — an A/V clip, a lower third on its own lane, and the crossfade between the ` +
        `clip and the tail — so suspect the lane mapping (z-order) or the transition that moved ` +
        `into the child composition.`,
    ).toHaveLength(0)
    expect(picture.pass).toBe(true)

    // ── 2. SOUND ────────────────────────────────────────────────────────────
    // Tone markers, not a waveform diff: `--audio` reports which source second
    // landed in each output second, so it fails loudly on the two ways a Group
    // breaks a mix — silence (the walk never reached the layer) and a shift (it
    // reached it without the offset). Both files are measured the same way and
    // their boundary offsets are then required to AGREE, which is the part that
    // makes this a differential rather than two independent smoke tests.
    const plainAudio = analyze({ output: plainOut, source: SOURCE, samples: [0], audio: true })
    const groupedAudio = analyze({ output: groupedOut, source: SOURCE, samples: [0], audio: true })
    console.log(
      `[e2e] pre-compose audio: flat=${JSON.stringify(plainAudio)} grouped=${JSON.stringify(groupedAudio)}`,
    )
    expect(plainAudio.pass, 'the flat export carries the source tones').toBe(true)
    expect(
      groupedAudio.pass,
      `the pre-composed export does NOT carry the source tones: ${JSON.stringify(groupedAudio)}. ` +
        `The Rust mixer walks the project itself (audio/mix.rs) — check that it recurses through ` +
        `CompositionRef layers with the ref's time offset.`,
    ).toBe(true)
    expect(groupedAudio.seconds).toBe(plainAudio.seconds)
    expect(
      Math.abs(groupedAudio.offset_ms - plainAudio.offset_ms),
      `the mix moved: flat ${plainAudio.offset_ms} ms vs grouped ${groupedAudio.offset_ms} ms`,
    ).toBeLessThanOrEqual(AUDIO_OFFSET_AGREEMENT_MS)

    // ── 3. SHAPE ────────────────────────────────────────────────────────────
    // Ungroup is allowed because pre-compose leaves the Group layer plain
    // (identity transform, opacity 1, no effects, Normal blend) — the one
    // precondition `groups_ungroup` enforces.
    await invokeCmd(page, 'groups_ungroup', { layerId: group.layer_id })
    const w3 = await wire(page)
    expect(
      Object.keys(w3.compositions),
      'the child composition goes when its last reference does',
    ).toHaveLength(1)
    const { nextGroupOrdinal: ordinalAfter, ...after } = await saveAndRead(page, projectDir)
    const { nextGroupOrdinal: ordinalBefore, ...before } = shapeBefore
    expect(
      after,
      'pre-compose then ungroup must be a round trip: the saved project differs by more than ' +
        'the ids the two ops re-mint and the one number the pre-compose spent',
    ).toEqual(before)
    // Spent, not refunded — by exactly the one composition pre-compose made.
    // A counter that rewound here would let undo resurrect a Group wearing a
    // live Group's number, which is the whole reason it is monotonic.
    expect(
      ordinalAfter,
      'the ordinal counter must advance by one and never rewind',
    ).toBe(ordinalBefore + 1)
  } finally {
    await app.close()
  }
})
