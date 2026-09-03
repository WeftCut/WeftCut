import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, DECODE_ADDON, DECODE_COMPONENT_PRESENT } from './helpers/driver'

// Saturated-chart color gate for the HARDWARE preview lanes — the resident
// pixel-fidelity gate none of them otherwise has. Four legs per lane, the full
// matrix a session must honor:
//   709ltd / 601ltd / 709full / 601full  (H.264 charts, npm run fixtures)
// A matrix swap reads 10–30 8-bit steps on the saturated patches; a range
// mix-up reads as a global contrast shift; both are far beyond PATCH_TOL.
//
// WHAT IS UNDER TEST DIFFERS BY LANE FAMILY, and the difference is the reason
// this file runs everywhere rather than on Windows alone.
//
//   d3d11va (shared texture, Windows) — the A′ color-sovereign path: native
//   decodes on the GPU, converts NV12→RGBA with its OWN shader (constants
//   derived from the same kr/kb source as Nv12Ingest / yuv10.ts), and shares
//   sRGB-passthrough RGBA that the preload's createImageBitmap copies
//   byte-for-byte (proven by the poc rgba probe). Here the tags and the
//   conversion are ONE act: `preview_gpu_open` is HANDED matrix/full_range by
//   the renderer (backend.rs) and converts by them, so what this gate reads is
//   whether that shader's constants are right.
//
//   videotoolbox / nvdec / vaapi (copy-back) — no bespoke shader: the lane
//   copies back into NV12 / I420P10 ship bytes (ADR 0034) that go through the
//   same renderer ingest the SOFTWARE lane feeds, so the shader math is
//   already gated cross-platform by preview-sw-color. What is NOT gated
//   anywhere else is the seam these lanes introduce: the color tags are read
//   ONCE at open from the decoder context and cloned onto every frame
//   (preview_sw/decoder.rs), so they describe what the BITSTREAM says — while
//   the bytes are whatever surface format the hwaccel chose. Those can
//   disagree. VideoToolbox hands back either `420v` or `420f`; take a
//   full-range surface for a stream tagged `tv` and Nv12Ingest (`const full =
//   f.colorSpace?.fullRange === true`) expands already-expanded data, i.e. a
//   black-level and contrast shift. So on a copy-back lane this gate asserts
//   that the bytes are actually IN the encoding their metadata claims.
//
// Neither claim is reachable by reading the metadata back: it is cloned from a
// single source and so cannot contradict itself. Only pixels answer it. And
// the sibling SSIM gate (preview-hw-conformance) covers the same lanes while
// being structurally blind to exactly this — chroma carries ~1/6 of SSIM's
// weight and a range shift is a low-amplitude global gain that its contrast
// normalization discounts (ADR 0032, the same reason preview-sw-color exists).
//
// Model: preview-sw-color.spec.ts (chart method) + preview-hw-conformance
// (lane forcing + clean-skip). Needs a VITE_WEFTCUT_E2E=1 build + the built
// native-decode addon.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')

const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000

// The component probe is platform-generic (DECODE_ADDON resolves the addon
// filename per OS), and it is kept as its OWN condition rather than ANDed into
// a platform check — the previous `!(win32 && present)` printed "native-decode
// component not built (…index.darwin-arm64.node)" on a Mac whose addon was
// sitting right there, and a macOS hardware report duly filed the skip as a
// broken platform probe. Same conflation that had cost preview-sw-color its
// coverage on two of three legs. A skip reason is read by people who were not
// here.
const COMPONENT_PRESENT = DECODE_COMPONENT_PRESENT

type HwLane = 'nvdec' | 'vaapi' | 'd3d11va' | 'videotoolbox'

// Skip-path audit seam, same contract as preview-hw-conformance: an OUTER
// `WEFTCUT_FORCE_HW_LANE` (exported around the runner by an operator)
// overrides the platform's own lanes. Pinning a lane the box does not
// advertise makes main's `decodeCap:probeHw` hide every HW lane, so all legs
// must then SKIP, never FAIL. It has to be read HERE because launchApp
// spreads this spec's env LAST.
const OUTER_LANE_PIN = process.env.WEFTCUT_FORCE_HW_LANE as HwLane | undefined

// Which lanes to pin on this host, from `HW_LANE_PRIORITY` filtered to the OS
// that has them. Only the host's OWN lanes are enumerated, because a leg costs
// a full app launch even when it ends in a clean skip — pinning videotoolbox
// on Windows would buy four launches to learn what this table already says.
// Linux carries two: which one engages depends on the GPU present, and the
// other self-skips.
//
// The three desktop platforms are exhaustive (the app does not run anywhere
// else), so the `?? []` fallback is unreachable rather than a silent hole.
const PLATFORM_LANES: Partial<Record<NodeJS.Platform, readonly HwLane[]>> = {
  win32: ['d3d11va'],
  darwin: ['videotoolbox'],
  linux: ['nvdec', 'vaapi'],
}
const LANES: readonly HwLane[] = OUTER_LANE_PIN ? [OUTER_LANE_PIN] : (PLATFORM_LANES[process.platform] ?? [])

/// Which transport a lane's title should name — the same derivation
/// preview-hw-conformance makes from `frameKind`, stated here per lane because
/// this spec pins the lane before any frame exists to ask.
const transportWord = (lane: HwLane) => (lane === 'd3d11va' ? 'shared-texture' : 'copy-back')

// Patch-center ceiling in 8-bit code units. The chain pays the H.264 chart's
// own quantization, its 4:2:0 chroma siting, and the converting shader's RGBA8
// rounding (≈1–2 steps each on flat patch centers) — same error classes (and
// the same ceiling) as the preview-sw-color ProRes gate. Those classes are
// lane-independent: a copy-back lane swaps WHICH shader rounds, not how much.
// The defect classes this guards — wrong constants in the native shader on
// d3d11va, a surface whose range contradicts its tags on a copy-back lane —
// read as tens of steps either way.
const PATCH_TOL = 8

interface ManifestPatch {
  id: string
  x: number
  y: number
  w: number
  h: number
  rgb: [number, number, number]
}

interface PatchOffender {
  id: string
  expected: [number, number, number]
  got: [number, number, number]
  maxErr: number
}

async function runChartLeg(label: string, fixture: string, lane: HwLane): Promise<void> {
  test.skip(!existsSync(fixture), `${label} chart fixture not found at ${fixture} (npm run fixtures)`)
  test.skip(!existsSync(MANIFEST), `color manifest not found at ${MANIFEST} (npm run fixtures)`)
  test.setTimeout(240_000)
  const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-hw-color-proj-')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    width: number
    height: number
    patches: ManifestPatch[]
  }
  expect(manifest.width).toBe(CANVAS.width) // 1:1 chart→composition mapping

  // Pin the resolver to this leg's lane only (+ software fallback). Where the
  // lane can't engage, the probe below reports hwLane === null and the leg
  // SKIPS cleanly instead of failing (preview-hw-conformance model).
  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: lane } })
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))
  let toggledOn = false
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: `${label}-${Date.now()}`,
      canvas: CANVAS,
    })

    // Pin the ffmpeg engine BEFORE placing the layer (engine resolution reads
    // decode_engine live at acquire — see preview-sw-conformance.spec.ts).
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: fixture })
    expect(kind).toBe('Video')

    await page.waitForFunction(
      () => {
        try {
          ;(window as unknown as { __weftcutTest: { activeClipProbe(id?: string): unknown } }).__weftcutTest.activeClipProbe()
          return true
        } catch {
          return false
        }
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )

    // Seek once, then poll read-only until a lane has decoded + bound the
    // target frame. Accept HW or the software fallback here; the clean-skip
    // below sorts out WHICH engaged.
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )
    const handle = await page.waitForFunction(
      ([id, target]) => {
        const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; hwLane: string | null; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p) return null
        if (p.sourceKind !== 'native-gpu' && p.sourceKind !== 'sw') return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        if (!p.spriteBound) return null
        return p
      },
      [layerId, SEEK_US] as const,
      { timeout: 90_000, polling: 200 },
    )
    const probe = (await handle.jsonValue()) as { sourceKind: string; hwLane: string | null }

    test.skip(
      probe.hwLane !== lane,
      `${lane} not engaged on this machine (hwLane=${probe.hwLane}, sourceKind=${probe.sourceKind}) — lane unavailable`,
    )
    expect(probe.sourceKind).toBe('native-gpu')

    // Sample every patch center off the LIVE composited canvas (absolute
    // composition pixels — the chart is placed 1:1 at the origin).
    const offenders: PatchOffender[] = []
    let worst = 0
    for (const patch of manifest.patches) {
      const cx = patch.x + Math.floor(patch.w / 2)
      const cy = patch.y + Math.floor(patch.h / 2)
      const s = (await page.evaluate(
        ([x, y]) => (window as unknown as { __weftcutTest: { weftcutSampleComposite(x: number, y: number): Promise<{ r: number; g: number; b: number }> } }).__weftcutTest.weftcutSampleComposite(x, y),
        [cx, cy] as const,
      )) as { r: number; g: number; b: number }
      const got: [number, number, number] = [s.r, s.g, s.b]
      const maxErr = Math.max(
        Math.abs(got[0] - patch.rgb[0]),
        Math.abs(got[1] - patch.rgb[1]),
        Math.abs(got[2] - patch.rgb[2]),
      )
      worst = Math.max(worst, maxErr)
      if (maxErr > PATCH_TOL) offenders.push({ id: patch.id, expected: patch.rgb, got, maxErr })
    }
    // eslint-disable-next-line no-console
    console.log(`[preview-hw-color] ${label}: worst patch-center error ${worst} (tol ${PATCH_TOL})`)
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`[preview-hw-color] ${label} renderer errors during run:\n` + errs.join('\n'))
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0)
  } finally {
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test.describe('preview hardware-lane saturated-chart color gate (Electron)', () => {
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native GPU sessions`)

  for (const lane of LANES) {
    for (const enc of ['709ltd', '601ltd', '709full', '601full'] as const) {
      test(`${enc} chart previews correctly through the ${lane} ${transportWord(lane)} lane @serial`, async () => {
        await runChartLeg(`phc-${lane}-${enc}`, path.resolve(MEDIA_DIR, `test_1080p_color_${enc}.mp4`), lane)
      })
    }
  }
})
