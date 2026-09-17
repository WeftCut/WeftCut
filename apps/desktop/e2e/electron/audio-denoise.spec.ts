import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeAudioEnvelope } from '../lib/analyze.mjs'
import {
  driveExport,
  importAndPlaceMedia,
  invokeCmd,
  launchApp,
  newProject,
  summary,
  tmpDir,
} from './helpers/driver'

// The `audio.denoise` chain end to end in the real app (ADR 0063,
// docs/audio.md § Clip effects). Two scenarios, two different claims:
//
//   1. The BAKE reaches the export mix. An audio effect is not a realtime
//      filter — it is an offline bake into a sibling conform, and every
//      consumer reads that sibling instead of the raw file. Nothing short of
//      exporting twice, with the effect enabled and disabled, can tell whether
//      the sibling or the original was mixed.
//   2. The REGION is authorable from the timeline. The bounds are the one
//      parameter with no number field as its primary surface: a button arms a
//      one-shot, a drag on the clip paints the span, and the band and its
//      handles live and die with the card that owns them.
//
// The DSP itself is not this file's claim. How far `afftdn` gets with a trained
// profile, and that the pre-region stretch improves as much as the post-region
// one, are measured by the "profile engages" test in `native/src/audio/fx.rs`
// against known fixtures with no app in the way. Here the numbers only have to
// be far enough apart to prove which file the mixer opened.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
/// 12 s of pink noise with a noise-ONLY head and a 440 Hz tone from 2 s. Its
/// spans and their measured levels are recorded in the fixture manifest; see
/// `NOISY_SPEECH_LEVELS` in `fixtures/generate.mjs`.
const SOURCE = path.resolve(MEDIA_DIR, 'noisy-speech.wav')

/// The sample region, in SOURCE µs — the fixture's noise-only head, held clear
/// of both its ends so a bound that lands a few pixels off is still noise.
const PROFILE_IN_US = 200_000
const PROFILE_OUT_US = 1_800_000

/// How much quieter the noise-only window must be with the effect enabled.
///
/// A PLUMBING floor, not the filter's measured result: the shipped ffmpeg drops
/// this fixture's head by ~9.5 dB, and what fails this assertion is an export
/// that mixed the raw conform (0 dB), not a filter that underperformed. The
/// precise DSP gate is the "profile engages" test in `native/src/audio/fx.rs` —
/// lower this number before weakening that one.
const NOISE_DROP_MIN_DB = 6
/// The tone window must SURVIVE the bake: measured 0.03 dB of change, and the
/// tolerance covers the AAC round trip both exports pay.
const TONE_TOL_DB = 1.5

/// Probe times tiling a span, at the analyzer's own 100 ms window pitch — the
/// envelope mode measures one fixed-width window per probe, so a wider span is
/// measured as the windows that cover it.
function windowTimes(fromS: number, toS: number): number[] {
  const stepS = 0.1
  const count = Math.round((toS - fromS) / stepS) + 1
  return Array.from({ length: count }, (_, i) => Number((fromS + i * stepS).toFixed(3)))
}
/// Inside the noise-only head, clear of the region's own edges: what the effect
/// must quieten.
const NOISE_WINDOW_S = windowTimes(0.5, 1.5)
/// Well past the tone's start: what the effect must leave alone.
const TONE_WINDOW_S = windowTimes(4, 6)

/// The `--audio-envelope` report, narrowed to the two fields a LEVEL reader
/// needs. `lib/analyze.mjs` is untyped, so the shape is declared where it is
/// consumed.
interface EnvelopeReport {
  ref_rms_dbfs: number
  points: Array<{ t_s: number; got_db_delta: number }>
}

/// Energy mean of several window levels, as one dBFS number.
///
/// Averaged as POWER, not as dB: a dB mean weights a quiet window as heavily as
/// a loud one, which would understate exactly the change this gate measures.
function powerMeanDb(levelsDbfs: number[]): number {
  const power = levelsDbfs.reduce((sum, db) => sum + 10 ** (db / 10), 0) / levelsDbfs.length
  return 10 * Math.log10(power)
}

/// Both windows of one export, in absolute dBFS.
///
/// `--audio-envelope` is an assertion mode, but its report carries everything an
/// absolute level needs: the file's loudest 100 ms window in dBFS, plus each
/// probe's level RELATIVE to that reference — so their sum is the probe's own
/// level, and the reference cancels out of any comparison between two files. The
/// expectations handed in are therefore placeholders and `pass` is never read;
/// this measures, it does not assert.
///
/// One call per file, because each call re-decodes the whole output: the probes
/// for both windows are batched and split again here.
function windowLevels(output: string): { noiseDbfs: number; toneDbfs: number } {
  const times = [...NOISE_WINDOW_S, ...TONE_WINDOW_S]
  const report = analyzeAudioEnvelope({
    output,
    expects: times.map((t_s) => ({ t_s, expect_rms_db_delta: 0 })),
  }) as EnvelopeReport
  expect(report.points).toHaveLength(times.length)
  const levels = report.points.map((p) => report.ref_rms_dbfs + p.got_db_delta)
  return {
    noiseDbfs: powerMeanDb(levels.slice(0, NOISE_WINDOW_S.length)),
    toneDbfs: powerMeanDb(levels.slice(NOISE_WINDOW_S.length)),
  }
}

interface McpInfo {
  url: string
  bearer_token: string
}

async function connectMcp(page: Page): Promise<Client> {
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'audio-denoise', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

/// `add_effect`'s answer is the new effect's record; `effect_id` is what the next call needs.
async function addEffect(mcp: Client, layerId: string, kind: string): Promise<string> {
  const res = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: layerId, kind } })
  const effectId = (JSON.parse(structuredClone(res.content)[0].text as string) as { effect_id: string }).effect_id
  expect(effectId.length).toBeGreaterThan(0)
  return effectId
}

const staticParam = (value: number) => ({ mode: 'Static', value })

interface SummaryLayer {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string; src_in_us?: number }
  effects: Array<{
    id: string
    kind: string
    enabled: boolean
    params: Record<string, { mode: string; value: number }>
  }>
}

async function layerOf(page: Page, layerId: string): Promise<SummaryLayer> {
  for (const track of (await summary(page)).tracks) {
    for (const layer of track.layers as unknown as SummaryLayer[]) {
      if (layer.id === layerId) return layer
    }
  }
  throw new Error(`layer ${layerId} is not in the project summary`)
}

/// The region as the project holds it, or null while either bound is unwritten —
/// absent IS the unset state, so a half-written pair reads as no region at all.
async function regionOf(
  page: Page,
  layerId: string,
  effectId: string,
): Promise<{ inUs: number; outUs: number } | null> {
  const effect = (await layerOf(page, layerId)).effects.find((e) => e.id === effectId)
  const inUs = effect?.params['profile_in_us']
  const outUs = effect?.params['profile_out_us']
  return inUs && outUs ? { inUs: inUs.value, outUs: outUs.value } : null
}

/// One layer's bake state, off the baker's snapshot route. Bake state is a
/// derivation the baker alone holds (ADR 0063 decision 8), so there is nowhere
/// else to read it from — the project carries no path and no status.
interface LayerFxState {
  desired_sig: string | null
  ready: { sig: string; audio_path: string } | null
  pending: string | null
  error: { message: string } | null
}

async function fxState(page: Page, layerId: string): Promise<LayerFxState | null> {
  const snapshot = await invokeCmd<Record<string, LayerFxState>>(page, 'audio_fx_snapshot', {})
  return snapshot[layerId] ?? null
}

/// Wait until the layer's artifact on disk IS the one its chain asks for.
///
/// `ready.sig === desired_sig` is the whole readiness test: a `ready` from an
/// earlier signature survives a re-bake on purpose (preview is
/// stale-while-revalidate), so "has a ready" is not "is up to date". The polled
/// value is a phrase rather than a boolean so a timeout names what the baker was
/// last doing — a queued bake and a failed one want different fixes.
async function waitForBake(page: Page, layerId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await fxState(page, layerId)
        if (state === null) return 'the baker holds no state for this layer'
        if (state.error !== null) return `failed: ${state.error.message}`
        if (state.desired_sig === null) return 'no effective chain'
        return state.ready?.sig === state.desired_sig
          ? 'ready'
          : `baking ${state.pending ?? '(queued)'}`
      },
      {
        // The bake itself runs at ~300x realtime, but it queues behind the
        // conform this media still owes and shares the import derivatives'
        // ffmpeg semaphore with whatever else this worker is doing.
        timeout: 180_000,
        message: `layer ${layerId} never reached a ready bake`,
      },
    )
    .toBe('ready')
}

/// Poll until `read` answers something other than `was`, then return it — the
/// round trip a committed param takes through the actor and back into the
/// summary. Polled on a boolean so the wait survives a matcher that cannot
/// express "anything but this".
async function readAfterChange<T>(
  read: () => Promise<T>,
  was: T,
  what: string,
): Promise<T> {
  await expect
    .poll(async () => (await read()) !== was, { message: `${what} never changed` })
    .toBe(true)
  return await read()
}

async function exportAudioOnly(page: Page, output: string): Promise<void> {
  const r = await driveExport(
    page,
    { outputAbsPath: output, settings: { includeVideo: false, includeAudio: true } },
    { hook: 'exportTimeline', timeout: 240_000 },
  )
  if (!r.done.ok) {
    throw new Error(
      `audio-only export failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`,
    )
  }
}

async function bootProject(page: Page, name: string): Promise<void> {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-e2e-denoise-proj-'),
    name: `${name}-${Date.now()}`,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  })
}

test.describe('audio denoise (Electron)', () => {
  test.beforeEach(() => {
    test.skip(
      !existsSync(SOURCE),
      `denoise fixture not found at ${SOURCE} (run \`npm run fixtures\`)`,
    )
  })

  test('a baked denoise chain quiets the exported noise window and spares the tone', async () => {
    // Two audio-only exports plus a bake and two analyzer scans. Sized as the
    // e2e README asks: the slowest green run with headroom, clear of
    // driveExport's own finalizing stall budget so the probe reports a wedge
    // before this deadline preempts it.
    test.setTimeout(600_000)
    let app: ElectronApplication | undefined
    let mcp: Client | undefined
    try {
      const launched = await launchApp()
      app = launched.app
      const page = launched.page
      await bootProject(page, 'e2e-denoise-mcp')

      const placed = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE, tStartUs: 0 })
      // The namespace rule the command layer enforces runs off the LAYER kind,
      // so an `audio.*` effect is only addable here because the fixture
      // classified as Audio.
      expect(placed.kind).toBe('Audio')
      const layerId = placed.layerId
      expect((await layerOf(page, layerId)).params.kind).toBe('Audio')

      // Author the chain through the real MCP server — the path an external
      // agent takes, and the one that has to reject a keyframed audio param.
      mcp = await connectMcp(page)
      const effectId = await addEffect(mcp, layerId, 'audio.denoise')
      // The add is in the project, but nothing bakes yet: the region keys are
      // unwritten, so the effect is incomplete and stays out of the effective
      // chain. Reading the region back is the witness that the add landed.
      expect(await regionOf(page, layerId, effectId)).toBeNull()
      expect((await fxState(page, layerId))?.desired_sig ?? null).toBeNull()

      await mcp.callTool({
        name: 'update_effect',
        arguments: {
          layer_id: layerId,
          effect_id: effectId,
          patch: {
            params: {
              strength: staticParam(12),
              margin: staticParam(8),
              profile_in_us: staticParam(PROFILE_IN_US),
              profile_out_us: staticParam(PROFILE_OUT_US),
            },
          },
        },
      })
      expect(await regionOf(page, layerId, effectId)).toEqual({
        inUs: PROFILE_IN_US,
        outUs: PROFILE_OUT_US,
      })

      await waitForBake(page, layerId)
      const baked = await fxState(page, layerId)
      console.log(`[e2e] denoise bake ready: ${baked?.ready?.audio_path}`)

      const outDir = tmpDir('weftcut-e2e-denoise-out-')
      const withFx = path.join(outDir, 'denoise-on.m4a')
      await exportAudioOnly(page, withFx)

      // Disabling drops the effect from the graph AND from the signature, so the
      // layer has no effective chain left and the mix reads the raw conform.
      // Waiting on the baker's own state rather than on the command's return is
      // what proves the second export cannot still be handed the sibling.
      await mcp.callTool({
        name: 'update_effect',
        arguments: { layer_id: layerId, effect_id: effectId, patch: { enabled: false } },
      })
      await expect
        .poll(async () => (await fxState(page, layerId))?.desired_sig ?? null, {
          message: 'disabling the effect left a desired signature behind',
        })
        .toBe(null)
      const withoutFx = path.join(outDir, 'denoise-off.m4a')
      await exportAudioOnly(page, withoutFx)

      const fx = windowLevels(withFx)
      const raw = windowLevels(withoutFx)
      const drop = raw.noiseDbfs - fx.noiseDbfs
      console.log(
        `[e2e] denoise noise window ${NOISE_WINDOW_S[0]}-${NOISE_WINDOW_S.at(-1)}s: `
          + `raw ${raw.noiseDbfs.toFixed(2)} dBFS, effect ${fx.noiseDbfs.toFixed(2)} dBFS, `
          + `drop ${drop.toFixed(2)} dB`,
      )
      console.log(
        `[e2e] denoise tone window ${TONE_WINDOW_S[0]}-${TONE_WINDOW_S.at(-1)}s: `
          + `raw ${raw.toneDbfs.toFixed(2)} dBFS, effect ${fx.toneDbfs.toFixed(2)} dBFS, `
          + `delta ${(fx.toneDbfs - raw.toneDbfs).toFixed(2)} dB`,
      )
      expect(drop).toBeGreaterThanOrEqual(NOISE_DROP_MIN_DB)
      expect(Math.abs(fx.toneDbfs - raw.toneDbfs)).toBeLessThanOrEqual(TONE_TOL_DB)
    } finally {
      await mcp?.close()
      await app?.close()
    }
  })

  test('an armed drag paints the sample region, and the band lives with its card', async () => {
    test.setTimeout(180_000)
    let app: ElectronApplication | undefined
    try {
      const launched = await launchApp()
      app = launched.app
      const page = launched.page
      await bootProject(page, 'e2e-denoise-ui')

      const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE, tStartUs: 0 })

      // Select the clip so the Effect panel renders its chain, then bring that
      // tab forward: the pristine baseline docks it inactive behind Attribute,
      // which leaves the picker rendered but hidden.
      await page.evaluate(
        (id) => (window as any).__weftcutTest.revealLayer({ layerId: id }),
        layerId,
      )
      await page.locator('.weft-dock-tab-label', { hasText: 'Effect' }).click()
      await page.getByTestId('effect-add').waitFor({ state: 'visible' })

      // An Audio layer's picker offers the AUDIO catalog — the row carries the
      // kind in its testid, so picking it is also the assertion that the audio
      // lifecycle reached this panel.
      await page.getByTestId('effect-add').click()
      await page.getByTestId('effect-pick-audio.denoise').click()
      await expect
        .poll(async () => (await layerOf(page, layerId)).effects.length, {
          message: 'the picker did not add an effect',
        })
        .toBe(1)
      const effectId = (await layerOf(page, layerId)).effects[0]!.id
      expect((await layerOf(page, layerId)).effects[0]!.kind).toBe('audio.denoise')

      // No region yet: the card explains itself and there is no band to draw.
      await expect(page.getByTestId('audio-region-state')).toBeVisible()
      await expect(page.getByTestId('audio-region-band')).toHaveCount(0)

      // Arm the one-shot, then paint the region on the clip itself.
      await page.getByTestId('audio-region-select').click()
      const block = page.locator(`[data-layer-id="${layerId}"]`)
      const box = await block.boundingBox()
      if (box === null) throw new Error(`the clip block for ${layerId} has no box`)
      const layer = await layerOf(page, layerId)
      // The clip's px<->us scale, read off the block itself: its box IS the
      // clip's span, so the block's width over its duration is the timeline's
      // zoom without asking the renderer what that zoom is.
      const pxPerUs = box.width / (layer.t_end_us - layer.t_start_us)
      const xAt = (us: number) => box.x + us * pxPerUs
      const y = box.y + box.height / 2
      // A drag, not a click: the region is the span between press and release,
      // and the intermediate move is what a press-with-no-travel would not
      // exercise (that path grows a minimum-length region instead).
      await page.mouse.move(xAt(PROFILE_IN_US), y)
      await page.mouse.down()
      await page.mouse.move(xAt((PROFILE_IN_US + PROFILE_OUT_US) / 2), y, { steps: 4 })
      await page.mouse.move(xAt(PROFILE_OUT_US), y, { steps: 4 })
      await page.mouse.up()

      // Pointer coordinates are whole pixels, so a bound is only as precise as
      // the zoom: the tolerance is a few pixels' worth of the clip's own scale
      // rather than a fixed number of microseconds.
      const tolUs = Math.ceil(3 / pxPerUs)
      await readAfterChange(
        () => regionOf(page, layerId, effectId).then((r) => r?.outUs ?? null),
        null,
        'the armed drag',
      )
      const region = await regionOf(page, layerId, effectId)
      if (region === null) throw new Error('the armed drag wrote no region')
      console.log(
        `[e2e] region drag at ${(pxPerUs * 1_000_000).toFixed(1)} px/s wrote `
          + `${region.inUs}-${region.outUs}us (tolerance ${tolUs}us)`,
      )
      expect(Math.abs(region.inUs - PROFILE_IN_US)).toBeLessThanOrEqual(tolUs)
      expect(Math.abs(region.outUs - PROFILE_OUT_US)).toBeLessThanOrEqual(tolUs)
      await expect(page.getByTestId('audio-region-band')).toBeVisible()

      // The band is drawable exactly while its card is expanded. The header's
      // own `aria-expanded` is the witness that the toggle was processed —
      // without it, "the band is gone" could equally mean "the click has not
      // landed yet".
      const cardTitle = page.getByTestId('effect-collapse-0')
      await cardTitle.click()
      await expect(cardTitle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByTestId('audio-region-band')).toHaveCount(0)
      await cardTitle.click()
      await expect(cardTitle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('audio-region-band')).toBeVisible()

      // One edge handle moves one bound. Grabbed by its own box rather than by
      // the band's, because the handle straddles the edge it drags.
      const handle = page.getByTestId('audio-region-handle-out')
      const handleBox = await handle.boundingBox()
      if (handleBox === null) throw new Error('the out handle has no box')
      const handleX = handleBox.x + handleBox.width / 2
      const handleY = handleBox.y + handleBox.height / 2
      const growUs = 600_000
      await page.mouse.move(handleX, handleY)
      await page.mouse.down()
      await page.mouse.move(handleX + growUs * pxPerUs, handleY, { steps: 4 })
      await page.mouse.up()

      const movedOutUs = await readAfterChange(
        () => regionOf(page, layerId, effectId).then((r) => r?.outUs ?? null),
        region.outUs,
        'the out handle',
      )
      console.log(`[e2e] out handle moved profile_out_us to ${movedOutUs}us`)
      expect(Math.abs((movedOutUs ?? 0) - (region.outUs + growUs))).toBeLessThanOrEqual(tolUs)
      // Only the dragged bound moved — a handle is one bound, never the pair.
      expect((await regionOf(page, layerId, effectId))?.inUs).toBe(region.inUs)
    } finally {
      await app?.close()
    }
  })
})
