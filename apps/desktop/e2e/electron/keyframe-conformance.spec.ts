// Keyframe record conformance gate — Auto tangents and the extrapolation modes,
// preview against export.
//
// Solid Color layers (no media, no decode variance) make every expectation a
// hand-derived number. Per scenario the spec authors ONE keyed track through the
// real command surface (`update_layer_param_track` with the full record: per-key
// tangents, continuity, segment class, track-level extrapolation), reads the
// stored track back to check what main's write normalization solved, samples
// fixed composition times from the LIVE preview compositor, exports the same
// project, decodes the SAME frame indices from the output with ffmpeg, and runs
// the IDENTICAL assertions on both legs — plus a direct preview-vs-export
// comparison, so the two legs must agree with each other AND with the
// arithmetic. Every sampled frame is placed where a wrong tangent solve or a
// wrong extrapolation mode lands ≥ 37 px or ≥ 128/255 away from the expectation,
// far beyond the tolerances.
//
// Why a Group carries the keys: a Color layer is a flat rectangle at the
// composition origin with no transform and no opacity (`sprite/ColorSprite.ts`;
// `main/state/mutations/params.ts::f64Lens` answers UnknownKeyframeParam for
// it). A Group (CompositionRef) layer has exactly transform + opacity, and its
// picture is its composition rendered into a texture of that composition's own
// width × height (`sprite/CompositionRefSprite.ts`). So every scenario
// pre-composes one red Color layer into a Group, sizes the Group's composition to
// the shape it needs, and keys the Group layer — the red rectangle IS the Group.
//
// Coordinate convention (`src/renderer/render/anchorPivot.ts`; the rule lives at
// docs/data-model.md#transform): `x`/`y` are composition pixels and mean the
// layer's UNROTATED top-left whatever the anchor; `anchor` is the normalized
// pivot, default (0.5, 0.5) = the texture's centre; rotation turns around the
// pivot without moving `x`/`y`. A W×H Group at rotation 0 therefore covers
// [x, x+W) × [y, y+H), and a rotated one turns about (x + W/2, y + H/2).
//
// Every scenario also lays a full-frame opaque BLACK Color layer under the Group.
// The preview readback renders the stage into a transparent target (an uncovered
// pixel reads alpha 0) while the export clears to opaque black, so a half-
// transparent red over "nothing" is not the same bytes on the two legs; over an
// opaque black layer both blend to (α·255, 0, 0, 255).
//
// Tolerances: ±40/channel on probe pixels (the transitions gate's figure —
// preview readback is near-exact, the export leg absorbs H.264 4:2:0 loss plus a
// worst-case 601↔709 relabel of ~26 counts on saturated red); ±3 px on the red
// run's centre column in the Auto scenario (edge antialiasing is half a pixel a
// side, codec ringing one or two more).
//
// Failure artifacts: every sampled frame — preview PNG and decoded export PNG —
// is written to the test's Playwright output dir (test-results/…), so a red run
// leaves the actual pixels next to the failing assertion.

import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { launchApp, newProject, invokeCmd, driveExport, tmpDir, rootSummary } from './helpers/driver'

/// Type-only, erased by Playwright's transform: the tracks below are written in
/// the record's own shape, so a field rename in the shared record fails HERE at
/// type-check time instead of as a structured parse error deep in the actor.
import type { Animated, Keyframe, Segment } from '../../src/shared/keyframe'

// ── Composition shape ────────────────────────────────────────────────────────
// 30 fps ⇒ every sampled time below is an exact output frame index
// (frameTimeUs(i) = round(i·1e6/30)); 2.25 s, for instance, is NOT (frame 67.5),
// which is why the Loop scenario samples 2.3 s. Every layer runs the full 3 s, so
// the composition autofits to 3 s and the export plans exactly 90 frames.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const LAYER_US = 3_000_000
const TOTAL_FRAMES = 90
const RED = { r: 255, g: 0, b: 0, a: 255 }
const BLACK = { r: 0, g: 0, b: 0, a: 255 }
const TOL = 40
/// Red run centre tolerance, composition px.
const CENTRE_TOL = 3
const frameIndexAt = (us: number) => Math.round((us * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))

interface Rgb { r: number; g: number; b: number }
interface Pt { x: number; y: number }
/// One decoded RGBA frame at composition size, from either leg.
interface Frame { width: number; height: number; data: Uint8Array }

const RED_RGB: Rgb = { r: 255, g: 0, b: 0 }
const BLACK_RGB: Rgb = { r: 0, g: 0, b: 0 }
/// Red at opacity `alpha` over the black backdrop.
const redAt = (alpha: number): Rgb => ({ r: Math.round(255 * alpha), g: 0, b: 0 })

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

/// A pixel the red rectangle painted. The threshold sits halfway between the
/// backdrop (0) and full red (255) so a half-covered edge pixel counts on both
/// legs the same way; the g/b caps exclude nothing today (the frame holds only
/// red and black) and guard against a future non-red overlay being counted.
const isRed = (c: Rgb): boolean => c.r >= 100 && c.g <= 80 && c.b <= 80

/// First / last red column on row `y` and how many red pixels the row holds —
/// `count < last − first + 1` means the run has gaps.
function redRun(f: Frame, y: number): { first: number; last: number; count: number } | null {
  let first = -1
  let last = -1
  let count = 0
  for (let x = 0; x < f.width; x++) {
    if (!isRed(rgbAt(f, { x, y }))) continue
    if (first < 0) first = x
    last = x
    count++
  }
  return first < 0 ? null : { first, last, count }
}

// ── Pure assertion cores — shared verbatim by the preview and export legs ────
function probeMismatches(frame: Frame, probes: Record<string, Pt>, want: Record<string, Rgb>): string[] {
  const errs: string[] = []
  for (const name of Object.keys(probes)) {
    const g = rgbAt(frame, probes[name]!)
    const e = want[name]!
    for (const ch of ['r', 'g', 'b'] as const) {
      if (Math.abs(g[ch] - e[ch]) > TOL) {
        errs.push(
          `@${name}(${probes[name]!.x},${probes[name]!.y}): ${ch}=${g[ch]} want ${e[ch]}±${TOL} ` +
            `(got r=${g.r} g=${g.g} b=${g.b})`,
        )
      }
    }
  }
  return errs
}

/// The WYSIWYG half: the two legs' pixels at the same probes, same tolerance.
function probeLegMismatches(preview: Frame, exported: Frame, probes: Record<string, Pt>): string[] {
  const errs: string[] = []
  for (const name of Object.keys(probes)) {
    const p = rgbAt(preview, probes[name]!)
    const e = rgbAt(exported, probes[name]!)
    for (const ch of ['r', 'g', 'b'] as const) {
      if (Math.abs(p[ch] - e[ch]) > TOL) {
        errs.push(`@${name}: preview ${ch}=${p[ch]} vs export ${ch}=${e[ch]} (>${TOL} apart)`)
      }
    }
  }
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
/// decodes from the start — frame-accurate, unlike a -ss time seek (same
/// approach as the media_conformance analyzer). The output PNG doubles as the
/// failure artifact for this sampled timestamp.
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
/// resolution (`capturePreviewFramePng` re-composites at the seeked position and
/// reads the whole frame in one round trip — the Auto scenario scans a full row,
/// which per-pixel sampling would turn into 640 evaluate calls per frame). Both
/// hooks throw until the PixiPreview bridge registers; the caller's readiness
/// poll absorbs that window, so here a failure is real.
///
/// The 200 ms after the seek is pacing for the re-composite, and it is only safe
/// because the only caller is a poll (`waitPreviewSettled`). Nothing asserts on a
/// single call's frame — a fixed settle in front of an assertion is a flake on a
/// loaded runner (e2e/README.md, "Waiting inside a spec").
async function capturePreviewFrame(page: Page, tUs: number): Promise<{ frame: Frame; png: Buffer }> {
  await page.evaluate((us) => (window as any).__weftcutTest.weftcutSeekUs(us), tUs)
  await page.waitForTimeout(200)
  const b64 = (await page.evaluate(() => (window as any).__weftcutTest.capturePreviewFramePng())) as string
  const png = Buffer.from(b64, 'base64')
  return { frame: decodePng(png), png }
}

// ── Scenario contract ────────────────────────────────────────────────────────
interface Scenario {
  name: string
  /// Sampled composition times by label; the labels name the artifacts.
  times: Record<string, number>
  /// Author the Group + its keyed track through the command surface and assert
  /// the stored record read back from `project_summary`.
  author(page: Page): Promise<void>
  /// Mismatch lines for one decoded frame at `timeName` against the hand-derived
  /// expectation. Pure — the two legs run this exact function.
  check(timeName: string, frame: Frame): string[]
  /// Mismatch lines between the two legs' frames at `timeName`.
  compare(timeName: string, preview: Frame, exported: Frame): string[]
}

function frameMismatches(label: string, frames: Partial<Record<string, Frame>>, sc: Scenario): string[] {
  const errs: string[] = []
  for (const timeName of Object.keys(sc.times)) {
    const frame = frames[timeName]
    if (!frame) {
      errs.push(`${label}/${timeName}: frame not sampled`)
      continue
    }
    for (const e of sc.check(timeName, frame)) errs.push(`${label}/${timeName}: ${e}`)
  }
  return errs
}

/// Poll until the preview reflects the authored project (the project:changed
/// bridge, the Group's render texture and the first composite all land
/// asynchronously after the commits), with a hard deadline. Convergence is
/// checked with the SAME `check` the strict assertion uses — on a broken build the
/// poll times out and the strict assertion then reports the real pixel values.
///
/// The returned frames ARE what the strict assertion must read (and what the
/// artifacts are written from). Re-collecting after convergence would seek again
/// and put `capturePreviewFrame`'s fixed settle back in front of the assertion.
async function waitPreviewSettled(
  page: Page,
  sc: Scenario,
  timeoutMs = 30_000,
): Promise<{ frames: Record<string, Frame>; pngs: Record<string, Buffer> }> {
  const deadline = Date.now() + timeoutMs
  let last: { frames: Record<string, Frame>; pngs: Record<string, Buffer> } | null = null
  let lastError: string | null = null
  for (;;) {
    try {
      const frames: Record<string, Frame> = {}
      const pngs: Record<string, Buffer> = {}
      for (const timeName of Object.keys(sc.times)) {
        const got = await capturePreviewFrame(page, sc.times[timeName]!)
        frames[timeName] = got.frame
        pngs[timeName] = got.png
      }
      last = { frames, pngs }
      if (frameMismatches('poll', frames, sc).length === 0) return last
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
/// Full-frame opaque black under everything (see the header for why both legs
/// need it). Its own track, added first: a later-added track is a higher lane and
/// CompositionNode sweeps lanes bottom-up, so the Group added after it draws on top.
async function addBackdrop(page: Page): Promise<void> {
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  await invokeCmd<string>(page, 'add_color_layer', {
    trackId,
    color: BLACK,
    tStartUs: 0,
    durationUs: LAYER_US,
  })
}

/// A `w × h` red rectangle the scenario can key: one red Color layer of that size
/// on a fresh top track, pre-composed into a Group, and the Group's composition
/// (born at the parent's canvas size) resized to `w × h` so the Group's texture —
/// the extent the anchor pivots within — is exactly the rectangle. The Group
/// layer spans [0, 3 s) like the Color inside it; its transform is the default
/// (x = y = 0, scale 1, anchor centre) until the scenario writes tracks.
async function addRedGroup(page: Page, w: number, h: number): Promise<{ layerId: string; compositionId: string }> {
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const redId = await invokeCmd<string>(page, 'add_color_layer', {
    trackId,
    color: RED,
    tStartUs: 0,
    durationUs: LAYER_US,
    width: w,
    height: h,
  })
  const group = await invokeCmd<{ composition_id: string; layer_id: string }>(page, 'groups_create', {
    layerIds: [redId],
  })
  if (w !== CANVAS.width || h !== CANVAS.height) {
    await invokeCmd(page, 'set_composition', {
      patch: { width: w, height: h },
      compositionId: group.composition_id,
    })
  }
  return { layerId: group.layer_id, compositionId: group.composition_id }
}

const writeTrack = (page: Page, layerId: string, paramKey: string, track: Animated<number>) =>
  invokeCmd(page, 'update_layer_param_track', { layerId, paramKey, track })

const setStatic = (page: Page, layerId: string, paramKey: string, value: number) =>
  writeTrack(page, layerId, paramKey, { mode: 'Static', value })

/// The stored track, off the read surface every other consumer uses.
async function readTrack(page: Page, layerId: string, paramKey: string): Promise<Animated<number>> {
  const s = await rootSummary<{
    duration_us: number
    tracks: Array<{ layers: Array<{ id: string; params: Record<string, unknown> & { kind: string } }> }>
  }>(page)
  const layer = s.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
  if (!layer) throw new Error(`layer ${layerId} is not in the root composition`)
  const track = layer.params[paramKey] as Animated<number> | undefined
  if (!track) throw new Error(`${layer.params.kind} layer ${layerId} carries no ${paramKey} track`)
  return track
}

type Kf = Keyframe<number>
const SPLINE: Segment = { kind: 'Spline' }
const LINEAR: Segment = { kind: 'Linear' }

/// A key with authored identity sides — the linear parametrization's own control
/// points, written as the expressions `1 / 3` / `2 / 3` exactly as both twins
/// write them (`OUT_IDENTITY` / `IN_IDENTITY` in src/shared/keyframe.ts), never
/// as decimals: the read-back compares the stored coordinates exactly.
function freeKey(tUs: number, value: number, segment: Segment): Kf {
  return {
    id: randomUUID(),
    t_us: tUs,
    value,
    in: { x: 2 / 3, y: 2 / 3, mode: 'Free' },
    out: { x: 1 / 3, y: 1 / 3, mode: 'Free' },
    continuity: 'Broken',
    segment,
  }
}

/// A key whose two sides are `Auto`. The coordinates written here are
/// placeholders (the identity): main's write normalization re-solves both sides,
/// and the scenario asserts what it stored — a solve that left these numbers
/// alone fails there, before any pixel is read.
function autoKey(tUs: number, value: number, segment: Segment): Kf {
  return {
    id: randomUUID(),
    t_us: tUs,
    value,
    in: { x: 2 / 3, y: 2 / 3, mode: 'Auto' },
    out: { x: 1 / 3, y: 1 / 3, mode: 'Auto' },
    continuity: 'Smooth',
    segment,
  }
}

// ── Scenario 1: Auto-smoothed x on a 100×100 square ──────────────────────────
// Three `x` keys 120 → 420 → 120 at 0 / 1 / 2 s, ONLY the middle key Auto on
// both sides (Smooth), segments Spline / Spline / Linear, outer keys identity
// Free. The middle key is a peak, so the monotone solver's slope through it is 0
// (dPrev = +300, dNext = −300: a sign change) and it stores
//   out = (1/3, m·dt/(3·dv))     = (1/3, 0)
//   in  = (2/3, 1 − m·dt/(3·dv)) = (2/3, 1)
// Segment 0 is then unit_bezier(1/3, 1/3, 2/3, 1): the x-controls 1/3, 2/3 make
// u linear in time, and at u = 0.5 the y-controls 0, 1/3, 1, 1 give
//   3·(1/2)²·(1/2)·(1/3) + 3·(1/2)·(1/2)²·1 + (1/2)³ = 0.125 + 0.375 + 0.125 = 0.625
// Segment 1 is unit_bezier(1/3, 0, 2/3, 2/3): y-controls 0, 0, 2/3, 1 give
//   3·(1/2)·(1/2)²·(2/3) + (1/2)³ = 0.25 + 0.125 = 0.375
// so x(0.5 s) = 120 + 0.625·300 = 307.5 and x(1.5 s) = 420 − 0.375·300 = 307.5,
// against 270 for a linear (or un-solved identity-tangent) render: the square's
// centre column moves 37.5 px, tolerance 3. 1.0 s sits on the peak key, 2.5 s is
// past the last key and reads the default Hold clamp.
const SQUARE = 100
/// Static `y`: rows [130, 230), centre row 180 — the row the run is read on.
const SQUARE_Y = 130
const SQUARE_ROW = 180
const X_END = 120
const X_PEAK = 420
const AUTO_TIMES = { '0.5s': 500_000, '1.0s': 1_000_000, '1.5s': 1_500_000, '2.5s': 2_500_000 }
const AUTO_X: Record<keyof typeof AUTO_TIMES, number> = {
  '0.5s': X_END + 0.625 * (X_PEAK - X_END), // 307.5
  '1.0s': X_PEAK, // on the key
  '1.5s': X_PEAK + 0.375 * (X_END - X_PEAK), // 307.5
  '2.5s': X_END, // Hold after the last key
}

/// Centre column and length of the red run on the square's centre row, or the
/// reason there is none.
function squareRun(frame: Frame): { centre: number; length: number; count: number } | string {
  const run = redRun(frame, SQUARE_ROW)
  if (!run) return `no red run on row ${SQUARE_ROW}`
  return { centre: (run.first + run.last) / 2, length: run.last - run.first + 1, count: run.count }
}

const autoX: Scenario = {
  name: 'auto-x',
  times: AUTO_TIMES,
  async author(page) {
    const group = await addRedGroup(page, SQUARE, SQUARE)
    await setStatic(page, group.layerId, 'y', SQUARE_Y)
    await writeTrack(page, group.layerId, 'x', {
      mode: 'Keyframed',
      value: [freeKey(0, X_END, SPLINE), autoKey(1_000_000, X_PEAK, SPLINE), freeKey(2_000_000, X_END, LINEAR)],
      extrapolate: { before: 'Hold', after: 'Hold' },
    })

    // What main stored: the middle key's sides solved to the flat-peak numbers
    // with their mode kept, everything else exactly as written.
    const stored = await readTrack(page, group.layerId, 'x')
    if (stored.mode !== 'Keyframed') throw new Error(`x stored as ${stored.mode}, want Keyframed`)
    expect(stored.value.map((k) => [k.t_us, k.value])).toEqual([
      [0, X_END],
      [1_000_000, X_PEAK],
      [2_000_000, X_END],
    ])
    const [first, mid, last] = stored.value as [Kf, Kf, Kf]
    expect(mid.out, 'Auto out at a peak: m = 0 ⇒ y = m·dt/(3·dv) = 0, x stays 1/3, mode kept').toEqual({
      x: 1 / 3,
      y: 0,
      mode: 'Auto',
    })
    expect(mid.in, 'Auto in at a peak: y = 1 − m·dt/(3·dv) = 1, x stays 2/3, mode kept').toEqual({
      x: 2 / 3,
      y: 1,
      mode: 'Auto',
    })
    expect(mid.continuity).toBe('Smooth')
    expect(mid.segment).toEqual(SPLINE)
    expect(first.out, 'a Free identity side is stored as written').toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Free' })
    expect(first.segment).toEqual(SPLINE)
    expect(last.in, 'a Free identity side is stored as written').toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Free' })
    expect(last.segment).toEqual(LINEAR)
    expect(stored.extrapolate).toEqual({ before: 'Hold', after: 'Hold' })
  },
  check(timeName, frame) {
    const run = squareRun(frame)
    if (typeof run === 'string') return [run]
    const want = AUTO_X[timeName as keyof typeof AUTO_TIMES]! + SQUARE / 2
    const errs: string[] = []
    if (Math.abs(run.centre - want) > CENTRE_TOL) {
      errs.push(`red run centre ${run.centre} want ${want}±${CENTRE_TOL} (run length ${run.length})`)
    }
    // ±4: a half-pixel x lands two half-covered edge columns that may or may not
    // clear the red threshold, plus a column of codec softening each side.
    if (Math.abs(run.length - SQUARE) > 4) errs.push(`red run length ${run.length} want ${SQUARE}±4`)
    if (run.count < run.length - 2) errs.push(`red run has gaps: ${run.count} red px over ${run.length} columns`)
    return errs
  },
  compare(_timeName, preview, exported) {
    const p = squareRun(preview)
    const e = squareRun(exported)
    if (typeof p === 'string') return [`preview: ${p}`]
    if (typeof e === 'string') return [`export: ${e}`]
    const errs: string[] = []
    if (Math.abs(p.centre - e.centre) > CENTRE_TOL) {
      errs.push(`red run centre preview ${p.centre} vs export ${e.centre} (>${CENTRE_TOL} apart)`)
    }
    if (Math.abs(p.length - e.length) > 4) errs.push(`red run length preview ${p.length} vs export ${e.length}`)
    return errs
  },
}

// ── Scenario 2: Loop opacity on a full-frame red ─────────────────────────────
// `opacity` keys 1 @ 0 s → 0 @ 1 s, Linear, `extrapolate.after = Loop`. The
// period is 1 s; at t > 1 s the track re-enters the range at (t − 0) mod 1 s:
//   0.5 s: inside the range           → 1 − 0.5 = 0.5  → red 128
//   1.2 s: 0.2 s into period 1        → 1 − 0.2 = 0.8  → red 204
//   1.5 s: 0.5 s into period 1        → 0.5            → red 128
//   2.0 s: exactly two periods after the first key → first.value = 1 → red 255,
//          the documented jump nothing bridges
//   2.3 s: 0.3 s into period 2        → 0.7            → red 179
// The default Hold clamp gives 0 (black) at every time past 1 s; PingPong would
// run period 1 backwards and give 0.2 (red 51) at 1.2 s; Offset and Continue go
// negative there (black). Every alternative is ≥ 76 counts from the expectation.
const LOOP_TIMES = { '0.5s': 500_000, '1.2s': 1_200_000, '1.5s': 1_500_000, '2.0s': 2_000_000, '2.3s': 2_300_000 }
const LOOP_ALPHA: Record<keyof typeof LOOP_TIMES, number> = {
  '0.5s': 0.5,
  '1.2s': 0.8,
  '1.5s': 0.5,
  '2.0s': 1,
  '2.3s': 0.7,
}
/// Two probes well inside the full-frame red: the centre and one off-centre, so
/// a partial coverage bug (a Group texture that stopped following its
/// composition size, say) cannot pass on the centre alone.
const LOOP_PROBES: Record<string, Pt> = { centre: { x: 320, y: 180 }, offCentre: { x: 100, y: 60 } }

const loopOpacity: Scenario = {
  name: 'loop-opacity',
  times: LOOP_TIMES,
  async author(page) {
    const group = await addRedGroup(page, CANVAS.width, CANVAS.height)
    await writeTrack(page, group.layerId, 'opacity', {
      mode: 'Keyframed',
      value: [freeKey(0, 1, LINEAR), freeKey(1_000_000, 0, LINEAR)],
      extrapolate: { before: 'Hold', after: 'Loop' },
    })
    const stored = await readTrack(page, group.layerId, 'opacity')
    if (stored.mode !== 'Keyframed') throw new Error(`opacity stored as ${stored.mode}, want Keyframed`)
    expect(stored.value.map((k) => [k.t_us, k.value])).toEqual([
      [0, 1],
      [1_000_000, 0],
    ])
    expect(stored.extrapolate).toEqual({ before: 'Hold', after: 'Loop' })
  },
  check(timeName, frame) {
    const alpha = LOOP_ALPHA[timeName as keyof typeof LOOP_TIMES]!
    const want = redAt(alpha)
    return probeMismatches(frame, LOOP_PROBES, { centre: want, offCentre: want })
  },
  compare(_timeName, preview, exported) {
    return probeLegMismatches(preview, exported, LOOP_PROBES)
  },
}

// ── Scenario 3: PingPong rotation on a 120×60 rectangle ──────────────────────
// `rotation_deg` keys 0 @ 0 s → 90 @ 1 s, Linear, `extrapolate.after = PingPong`.
// Period 1 s; odd periods run backwards:
//   0.5 s: inside the range                 → 45°
//   1.2 s: period 1 (odd), 0.2 s in → eval(1.0 − 0.2 s) → 72°   (Loop: 18°, Hold: 90°)
//   1.5 s: period 1 (odd), 0.5 s in → eval(0.5 s)       → 45°   (Hold: 90°)
//   2.0 s: period 2 (even), 0 s in  → eval(0 s)         → 0°    (Hold: 90°)
//
// A RECTANGLE, not a square: a square's footprint is the same at θ and θ + 90°,
// so 0° and 90° would be one picture and 72° would be the mirror of 18° — only
// probes that know the rotation direction could tell PingPong from Loop. A 120×60
// rectangle turned 90° stands upright, and probes on the two axes through its
// centre see every case with no direction assumption (a point on an axis is the
// same distance from the rectangle's edges under either rotation sense).
//
// Geometry: the rectangle is centred at (320, 180) — Group x = 320 − 60 = 260,
// y = 180 − 30 = 150 (x/y = unrotated top-left; the default anchor pivots at the
// centre). Half-extents a = 60 along its long axis, b = 30 across. A probe at
// distance d = 52 from the centre is inside iff its coordinates in the
// rectangle's frame, (d·cos θ, d·sin θ) for the x-axis probe and (d·sin θ,
// d·cos θ) for the y-axis probe, fit |·| ≤ a and |·| ≤ b:
//   θ = 0°:  x-axis 52 ≤ 60 → IN (8 px inside)   y-axis 52 > 30 → OUT (22 px)
//   θ = 45°: 52·sin 45° = 36.8 > 30 → both OUT (6.8 px past the long edge)
//   θ = 72°: x-axis 52·sin 72° = 49.5 > 30 → OUT (19.5 px)
//            y-axis (49.5, 16.1) ≤ (60, 30) → IN (10.5 / 13.9 px inside)
//   θ = 90°: x-axis OUT (22 px), y-axis IN (8 px)  — the Hold picture
//   θ = 18°: x-axis (49.5, 16.1) → IN, y-axis 49.5 > 30 → OUT — the Loop picture
// The centre is always red; a probe 100 px above it is always black (the
// half-diagonal is √(60² + 30²) = 67.1 px).
const RECT_W = 120
const RECT_H = 60
const RECT_CENTRE: Pt = { x: 320, y: 180 }
const PROBE_D = 52
const PP_TIMES = { '0.5s': 500_000, '1.2s': 1_200_000, '1.5s': 1_500_000, '2.0s': 2_000_000 }
const PP_PROBES: Record<string, Pt> = {
  centre: RECT_CENTRE,
  xAxis: { x: RECT_CENTRE.x + PROBE_D, y: RECT_CENTRE.y },
  yAxis: { x: RECT_CENTRE.x, y: RECT_CENTRE.y + PROBE_D },
  far: { x: RECT_CENTRE.x, y: RECT_CENTRE.y - 100 },
}
const ppFrame = (xAxis: Rgb, yAxis: Rgb): Record<string, Rgb> => ({
  centre: RED_RGB,
  xAxis,
  yAxis,
  far: BLACK_RGB,
})
const PP_WANT: Record<keyof typeof PP_TIMES, Record<string, Rgb>> = {
  '0.5s': ppFrame(BLACK_RGB, BLACK_RGB), // 45°
  '1.2s': ppFrame(BLACK_RGB, RED_RGB), // 72°
  '1.5s': ppFrame(BLACK_RGB, BLACK_RGB), // 45°
  '2.0s': ppFrame(RED_RGB, BLACK_RGB), // 0°
}

const pingPongRotation: Scenario = {
  name: 'pingpong-rotation',
  times: PP_TIMES,
  async author(page) {
    const group = await addRedGroup(page, RECT_W, RECT_H)
    await setStatic(page, group.layerId, 'x', RECT_CENTRE.x - RECT_W / 2)
    await setStatic(page, group.layerId, 'y', RECT_CENTRE.y - RECT_H / 2)
    await writeTrack(page, group.layerId, 'rotation_deg', {
      mode: 'Keyframed',
      value: [freeKey(0, 0, LINEAR), freeKey(1_000_000, 90, LINEAR)],
      extrapolate: { before: 'Hold', after: 'PingPong' },
    })
    const stored = await readTrack(page, group.layerId, 'rotation_deg')
    if (stored.mode !== 'Keyframed') throw new Error(`rotation_deg stored as ${stored.mode}, want Keyframed`)
    expect(stored.value.map((k) => [k.t_us, k.value])).toEqual([
      [0, 0],
      [1_000_000, 90],
    ])
    expect(stored.extrapolate).toEqual({ before: 'Hold', after: 'PingPong' })
  },
  check(timeName, frame) {
    return probeMismatches(frame, PP_PROBES, PP_WANT[timeName as keyof typeof PP_TIMES]!)
  },
  compare(_timeName, preview, exported) {
    return probeLegMismatches(preview, exported, PP_PROBES)
  },
}

// ── The gate ─────────────────────────────────────────────────────────────────
const SCENARIOS: Scenario[] = [autoX, loopOpacity, pingPongRotation]

for (const sc of SCENARIOS) {
  test(`keyframe conformance: ${sc.name} — preview and export pass identical assertions at the sampled frames`, async () => {
    // Local-only like the other export gates: the export leg needs the real
    // GPU/WebCodecs encode path, absent on headless CI.
    test.skip(
      process.env.WEFTCUT_E2E_NO_EXPORT === '1',
      'keyframe export leg needs a real GPU/WebCodecs encoder not on headless CI; verified locally',
    )
    const ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not available (set FFMPEG or run `npm run ffmpeg:fetch`) — cannot decode the export leg')
    // A cost bound, not the failure detector (e2e/README.md, per-test timeout
    // budgets): `driveExport`'s stall probe is what catches a wedge. The floor is
    // the latest a wedge can happen plus the 180 s finalizing budget — launch +
    // newProject reach the authoring around 60 s on the GPU-less legs, the
    // preview poll and a 3 s flat-colour export add tens of seconds — so 300 s
    // clears it with the run-to-run drift of a hosted runner.
    test.setTimeout(300_000)

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-keyframe-proj-'),
        name: `keyframe-${sc.name}-` + Date.now(),
        canvas: CANVAS,
      })

      await test.step('author', async () => {
        await addBackdrop(page)
        await sc.author(page)
        const s = await rootSummary<{ duration_us: number }>(page)
        expect(s.duration_us, 'every layer runs 3 s, so the composition autofits to 3 s').toBe(LAYER_US)
      })

      // ── Preview leg ────────────────────────────────────────────────────────
      const previewFrames = await test.step('preview leg', async () => {
        const settled = await waitPreviewSettled(page, sc)
        for (const timeName of Object.keys(sc.times)) {
          fs.writeFileSync(test.info().outputPath(`${sc.name}-preview-${timeName}.png`), settled.pngs[timeName]!)
        }
        const errs = frameMismatches(`preview/${sc.name}`, settled.frames, sc)
        expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
        return settled.frames
      })

      // ── Export leg — decode the SAME frame indices, run the SAME checks ─────
      const exportFrames = await test.step('export leg', async () => {
        const output = path.join(tmpDir('weftcut-e2e-keyframe-out-'), `${sc.name}.mp4`)
        const exp = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline', timeout: 150_000 })
        if (!exp.done.ok) throw new Error(`exportTimeline failed (${sc.name}): ${exp.done.error}`)

        const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
          | { totalFrames: number }
          | null
        expect(perf, '__weftcutExportPerf must be set after export (E2E build)').not.toBeNull()
        expect(perf!.totalFrames, '3 s composition at 30 fps plans 90 frames').toBe(TOTAL_FRAMES)

        const frames: Record<string, Frame> = {}
        for (const timeName of Object.keys(sc.times)) {
          const png = test.info().outputPath(`${sc.name}-export-${timeName}.png`)
          extractFramePng(ffmpeg!, output, frameIndexAt(sc.times[timeName]!), png)
          frames[timeName] = decodePng(fs.readFileSync(png))
        }
        const errs = frameMismatches(`export/${sc.name}`, frames, sc)
        expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
        return frames
      })

      // ── WYSIWYG: the two legs against each other at every sampled frame ────
      await test.step('preview ≡ export', async () => {
        const errs: string[] = []
        for (const timeName of Object.keys(sc.times)) {
          for (const e of sc.compare(timeName, previewFrames[timeName]!, exportFrames[timeName]!)) {
            errs.push(`${sc.name}/${timeName}: ${e}`)
          }
        }
        expect(errs, errs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`).toEqual([])
      })

      const firstTime = Object.keys(sc.times)[0]!
      console.log(
        `[keyframe-conformance] ${sc.name}: sampled ${Object.keys(sc.times).join(', ')} ` +
          `(first export frame ${frameIndexAt(sc.times[firstTime]!)}); preview and export agree`,
      )
    } finally {
      await app.close()
    }
  })
}
