// Colour keyframing conformance gate — an `Animated<Rgba>` track through the
// preview and the export, at the same frames, against the same numbers.
//
// The sibling gate (keyframe-conformance.spec.ts) keys the SCALAR record and
// pre-composes a Group to get a keyable transform; a colour needs none of that.
// `color` on a Color layer is the track, and the layer is a flat full-frame
// rectangle of exactly that colour — so every sampled pixel IS the value the
// engine resolved, with no geometry, no decode variance and no compositing
// between the number and the assertion.
//
// What only an end-to-end run can catch: colour is interpolated in OkLab with
// premultiplied alpha inside the shared eval leaf (ADR 0021), and the preview
// (wasm) and the export (native) reach it by different code paths. The midpoint
// of red → green is the OkLab mix, a markedly lighter and warmer colour than the
// channel-wise average — so a leg that fell back to sRGB lerp lands ~80 counts
// away on two channels, far outside the tolerance, on BOTH the expectation check
// and the leg-to-leg comparison.
//
// The expected midpoint is the same number `animatedColorGolden.fixture.json`
// carries for its `red_to_green` case at the segment midpoint (Chromium
// `color-mix(in oklab)` is that fixture's external authority), so this gate and
// the unit goldens cannot drift apart silently.
//
// Tolerances: ±40/channel, the figure the transitions and keyframe gates use —
// preview readback is near-exact, the export leg absorbs H.264 4:2:0 chroma loss
// plus a worst-case 601↔709 relabel on saturated primaries.
//
// Failure artifacts: every sampled frame — preview PNG and decoded export PNG —
// is written to the test's Playwright output dir (test-results/…).

import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { launchApp, newProject, invokeCmd, driveExport, tmpDir, rootSummary } from './helpers/driver'

/// Type-only, erased by Playwright's transform: the track below is written in
/// the record's own shape, so a field rename in the shared record fails HERE at
/// type-check time instead of as a structured parse error deep in the actor.
import type { Animated, Keyframe } from '../../src/shared/keyframe'

// 30 fps ⇒ every sampled time is an exact output frame index. The layers run the
// full 3 s, so the composition autofits to 3 s and the export plans 90 frames.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const LAYER_US = 3_000_000
const TOTAL_FRAMES = 90
const TOL = 40
const frameIndexAt = (us: number) => Math.round((us * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))

interface Rgba { r: number; g: number; b: number; a: number }
interface Rgb { r: number; g: number; b: number }
interface Pt { x: number; y: number }
/// One decoded RGBA frame at composition size, from either leg.
interface Frame { width: number; height: number; data: Uint8Array }

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 }
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 }
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 }

/// The OkLab midpoint of red → green, as `animatedColorGolden.fixture.json`
/// pins it for `red_to_green` at t = 0.5 s of a 1 s segment. NOT the sRGB
/// average (128, 128, 0) — the whole point of the mix.
const OKLAB_MID: Rgb = { r: 208, g: 168, b: 0 }
const SRGB_AVERAGE: Rgb = { r: 128, g: 128, b: 0 }

/// Keys at 0 s and 2 s, so the midpoint the sample reads is the 1 s frame.
const T_START_US = 0
const T_MID_US = 1_000_000
const T_END_US = 2_000_000
const TIMES = { '0.0s': T_START_US, '1.0s': T_MID_US, '2.0s': T_END_US }
const WANT: Record<keyof typeof TIMES, Rgb> = {
  '0.0s': { r: RED.r, g: RED.g, b: RED.b },
  '1.0s': OKLAB_MID,
  '2.0s': { r: GREEN.r, g: GREEN.g, b: GREEN.b },
}

/// Four probes spread over the frame: a full-frame Color layer is one flat
/// colour everywhere, so a bug that painted only part of it cannot pass on the
/// centre alone.
const PROBES: Record<string, Pt> = {
  centre: { x: 320, y: 180 },
  upperLeft: { x: 60, y: 40 },
  lowerRight: { x: 580, y: 320 },
  edge: { x: 2, y: 178 },
}

function decodePng(buf: Buffer): Frame {
  const png = PNG.sync.read(buf)
  if (png.width !== CANVAS.width || png.height !== CANVAS.height) {
    throw new Error(`decoded frame is ${png.width}x${png.height}, want ${CANVAS.width}x${CANVAS.height}`)
  }
  return { width: png.width, height: png.height, data: png.data }
}

function rgbAt(f: Frame, p: Pt): Rgb {
  const i = (p.y * f.width + p.x) * 4
  return { r: f.data[i]!, g: f.data[i + 1]!, b: f.data[i + 2]! }
}

// ── Pure assertion cores — shared verbatim by the preview and export legs ────
function probeMismatches(frame: Frame, want: Rgb): string[] {
  const errs: string[] = []
  for (const name of Object.keys(PROBES)) {
    const g = rgbAt(frame, PROBES[name]!)
    for (const ch of ['r', 'g', 'b'] as const) {
      if (Math.abs(g[ch] - want[ch]) > TOL) {
        errs.push(`@${name}(${PROBES[name]!.x},${PROBES[name]!.y}): ${ch}=${g[ch]} want ${want[ch]}±${TOL} (got r=${g.r} g=${g.g} b=${g.b})`)
      }
    }
  }
  return errs
}

/// The WYSIWYG half: the two legs' pixels at the same probes, same tolerance.
function probeLegMismatches(preview: Frame, exported: Frame): string[] {
  const errs: string[] = []
  for (const name of Object.keys(PROBES)) {
    const p = rgbAt(preview, PROBES[name]!)
    const e = rgbAt(exported, PROBES[name]!)
    for (const ch of ['r', 'g', 'b'] as const) {
      if (Math.abs(p[ch] - e[ch]) > TOL) {
        errs.push(`@${name}: preview ${ch}=${p[ch]} vs export ${ch}=${e[ch]} (>${TOL} apart)`)
      }
    }
  }
  return errs
}

/// The mix is what this gate exists for, so it is asserted as its own claim
/// rather than only as a consequence of the ±40 window: the sRGB average is 80
/// counts away on r and 40 on g, and a leg that produced it must say so in the
/// failure text.
function oklabMixMismatches(label: string, frame: Frame): string[] {
  const c = rgbAt(frame, PROBES.centre!)
  const errs: string[] = []
  if (Math.abs(c.r - SRGB_AVERAGE.r) <= TOL && Math.abs(c.g - SRGB_AVERAGE.g) <= TOL) {
    errs.push(`${label}: midpoint r=${c.r} g=${c.g} is the sRGB average (${SRGB_AVERAGE.r}, ${SRGB_AVERAGE.g}), not the OkLab mix (${OKLAB_MID.r}, ${OKLAB_MID.g})`)
  }
  return errs
}

function frameMismatches(label: string, frames: Partial<Record<string, Frame>>): string[] {
  const errs: string[] = []
  for (const timeName of Object.keys(TIMES)) {
    const frame = frames[timeName]
    if (!frame) {
      errs.push(`${label}/${timeName}: frame not sampled`)
      continue
    }
    for (const e of probeMismatches(frame, WANT[timeName as keyof typeof TIMES]!)) errs.push(`${label}/${timeName}: ${e}`)
  }
  const mid = frames['1.0s']
  if (mid) for (const e of oklabMixMismatches(label, mid)) errs.push(e)
  return errs
}

// ── ffmpeg (export decode) ───────────────────────────────────────────────────
/// Honor an explicit FFMPEG override, else PATH (run-e2e's preflight wires the
/// bundled resources/ffmpeg/<os> binaries into both). Null ⇒ cannot decode the
/// export — the gate skips rather than passing vacuously.
function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { stdio: 'ignore' })
  return r.status === 0 ? cand : null
}

/// Decode frame `n` (0-based decode index) of `mp4` to a PNG. select=eq(n,N)
/// decodes from the start — frame-accurate, unlike a -ss time seek. The output
/// PNG doubles as the failure artifact for this sampled timestamp.
function extractFramePng(ffmpeg: string, mp4: string, n: number, outPng: string): void {
  execFileSync(ffmpeg, [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
    '-i', mp4,
    '-vf', `select=eq(n\\,${n})`,
    '-frames:v', '1', '-vsync', '0',
    outPng,
  ])
}

// ── Preview sampling ─────────────────────────────────────────────────────────
/// Seek the live preview and capture the composited canvas at composition
/// resolution. The 200 ms after the seek is pacing for the re-composite, and it
/// is only safe because the only caller is a poll (`waitPreviewSettled`).
async function capturePreviewFrame(page: Page, tUs: number): Promise<{ frame: Frame; png: Buffer }> {
  await page.evaluate((us) => (window as any).__weftcutTest.weftcutSeekUs(us), tUs)
  await page.waitForTimeout(200)
  const b64 = (await page.evaluate(() => (window as any).__weftcutTest.capturePreviewFramePng())) as string
  const png = Buffer.from(b64, 'base64')
  return { frame: decodePng(png), png }
}

/// Poll until the preview reflects the authored project, with a hard deadline.
/// Convergence is checked with the SAME assertion core the strict check uses —
/// on a broken build the poll times out and the strict assertion then reports
/// the real pixel values.
async function waitPreviewSettled(
  page: Page,
  timeoutMs = 30_000,
): Promise<{ frames: Record<string, Frame>; pngs: Record<string, Buffer> }> {
  const deadline = Date.now() + timeoutMs
  let last: { frames: Record<string, Frame>; pngs: Record<string, Buffer> } | null = null
  let lastError: string | null = null
  for (;;) {
    try {
      const frames: Record<string, Frame> = {}
      const pngs: Record<string, Buffer> = {}
      for (const timeName of Object.keys(TIMES)) {
        const got = await capturePreviewFrame(page, TIMES[timeName as keyof typeof TIMES]!)
        frames[timeName] = got.frame
        pngs[timeName] = got.png
      }
      last = { frames, pngs }
      if (frameMismatches('poll', frames).length === 0) return last
    } catch (e) {
      // Preview bridge not registered yet (both hooks throw until it is) — keep
      // polling. The message is kept so a deadline with no frame names the real
      // reason, a capture of the wrong size included.
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (Date.now() > deadline) {
      if (!last) throw new Error(`preview never produced a frame: ${lastError ?? 'no attempt completed'}`)
      return last // strict assertion downstream reports the real pixel values
    }
    await page.waitForTimeout(400)
  }
}

// ── Authoring through the command surface ────────────────────────────────────
/// A key with authored identity sides — the linear parametrization's own control
/// points, written as the expressions `1 / 3` / `2 / 3` exactly as both twins
/// write them (`OUT_IDENTITY` / `IN_IDENTITY` in src/shared/keyframe.ts), never
/// as decimals: the read-back compares the stored coordinates exactly.
function linearKey(tUs: number, value: Rgba): Keyframe<Rgba> {
  return {
    id: randomUUID(),
    t_us: tUs,
    value,
    in: { x: 2 / 3, y: 2 / 3, mode: 'Free' },
    out: { x: 1 / 3, y: 1 / 3, mode: 'Free' },
    continuity: 'Broken',
    segment: { kind: 'Linear' },
  }
}

/// The stored track, off the read surface every other consumer uses.
async function readColorTrack(page: Page, layerId: string): Promise<Animated<Rgba>> {
  const s = await rootSummary<{
    tracks: Array<{ layers: Array<{ id: string; params: Record<string, unknown> & { kind: string } }> }>
  }>(page)
  const layer = s.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
  if (!layer) throw new Error(`layer ${layerId} is not in the root composition`)
  const track = layer.params.color as Animated<Rgba> | undefined
  if (!track) throw new Error(`${layer.params.kind} layer ${layerId} carries no color track`)
  return track
}

/// Full-frame opaque black under everything. The preview readback renders the
/// stage into a transparent target while the export clears to opaque black, so
/// anything the keyed layer does not cover would not be the same bytes on the
/// two legs. Its own track, added first: a later-added track is a higher lane
/// and CompositionNode sweeps lanes bottom-up.
async function addBackdrop(page: Page): Promise<void> {
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  await invokeCmd<string>(page, 'add_color_layer', { trackId, color: BLACK, tStartUs: 0, durationUs: LAYER_US })
}

test('colour keyframing: preview and export agree on the OkLab mix at the sampled frames', async () => {
  // Local-only like the other export gates: the export leg needs the real
  // GPU/WebCodecs encode path, absent on headless CI.
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'colour keyframe export leg needs a real GPU/WebCodecs encoder not on headless CI; verified locally',
  )
  const ffmpeg = ffmpegBin()
  test.skip(ffmpeg === null, 'ffmpeg not available (set FFMPEG or run `npm run ffmpeg:fetch`) — cannot decode the export leg')
  // A cost bound, not the failure detector: `driveExport`'s stall probe is what
  // catches a wedge. Matches the sibling keyframe gate's budget.
  test.setTimeout(300_000)

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-kfcolor-proj-'),
      name: 'keyframe-color-' + Date.now(),
      canvas: CANVAS,
    })

    const layerId = await test.step('author', async () => {
      await addBackdrop(page)
      const trackId = await invokeCmd<string>(page, 'add_track', {})
      const id = await invokeCmd<string>(page, 'add_color_layer', {
        trackId,
        color: RED,
        tStartUs: 0,
        durationUs: LAYER_US,
      })
      // The colour is a track like any other param — same command, same record,
      // `Rgba` values instead of numbers.
      await invokeCmd(page, 'update_layer_param_track', {
        layerId: id,
        paramKey: 'color',
        track: {
          mode: 'Keyframed',
          value: [linearKey(T_START_US, RED), linearKey(T_END_US, GREEN)],
          extrapolate: { before: 'Hold', after: 'Hold' },
        } satisfies Animated<Rgba>,
      })

      const stored = await readColorTrack(page, id)
      if (stored.mode !== 'Keyframed') throw new Error(`color stored as ${stored.mode}, want Keyframed`)
      expect(stored.value.map((k) => [k.t_us, k.value])).toEqual([
        [T_START_US, RED],
        [T_END_US, GREEN],
      ])
      expect(stored.value[0]!.out, 'a Free identity side is stored as written').toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Free' })
      expect(stored.extrapolate).toEqual({ before: 'Hold', after: 'Hold' })

      const s = await rootSummary<{ duration_us: number }>(page)
      expect(s.duration_us, 'every layer runs 3 s, so the composition autofits to 3 s').toBe(LAYER_US)
      return id
    })
    expect(layerId, 'the keyed layer must exist').toBeTruthy()

    // ── Preview leg ──────────────────────────────────────────────────────────
    const previewFrames = await test.step('preview leg', async () => {
      const settled = await waitPreviewSettled(page)
      for (const timeName of Object.keys(TIMES)) {
        fs.writeFileSync(test.info().outputPath(`color-preview-${timeName}.png`), settled.pngs[timeName]!)
      }
      const errs = frameMismatches('preview', settled.frames)
      expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
      return settled.frames
    })

    // ── Export leg — decode the SAME frame indices, run the SAME checks ───────
    const exportFrames = await test.step('export leg', async () => {
      const output = path.join(tmpDir('weftcut-e2e-kfcolor-out-'), 'keyframe-color.mp4')
      const exp = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline', timeout: 150_000 })
      if (!exp.done.ok) throw new Error(`exportTimeline failed: ${exp.done.error}`)

      const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
        | { totalFrames: number }
        | null
      expect(perf, '__weftcutExportPerf must be set after export (E2E build)').not.toBeNull()
      expect(perf!.totalFrames, '3 s composition at 30 fps plans 90 frames').toBe(TOTAL_FRAMES)

      const frames: Record<string, Frame> = {}
      for (const timeName of Object.keys(TIMES)) {
        const png = test.info().outputPath(`color-export-${timeName}.png`)
        extractFramePng(ffmpeg!, output, frameIndexAt(TIMES[timeName as keyof typeof TIMES]!), png)
        frames[timeName] = decodePng(fs.readFileSync(png))
      }
      const errs = frameMismatches('export', frames)
      expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
      return frames
    })

    // ── WYSIWYG: the two legs against each other at every sampled frame ──────
    await test.step('preview ≡ export', async () => {
      const errs: string[] = []
      for (const timeName of Object.keys(TIMES)) {
        for (const e of probeLegMismatches(previewFrames[timeName]!, exportFrames[timeName]!)) {
          errs.push(`${timeName}: ${e}`)
        }
      }
      expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
    })

    console.log(
      `[keyframe-color] sampled ${Object.keys(TIMES).join(', ')} ` +
        `(export frames ${Object.values(TIMES).map(frameIndexAt).join(', ')}); ` +
        `midpoint is the OkLab mix (${OKLAB_MID.r}, ${OKLAB_MID.g}, ${OKLAB_MID.b}) on both legs`,
    )
  } finally {
    await app.close()
  }
})
