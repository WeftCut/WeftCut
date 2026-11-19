import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, waitForHook, DECODE_ADDON, DECODE_COMPONENT_PRESENT } from './helpers/driver'

// Saturated-chart color gate for the native software-decode PREVIEW lane
// (policy ADR 0032). The preview twin of export-prores-fidelity's Gate A: a
// color-tagged ProRes chart, decoded by the native SW session and composited
// live, must show the chart's colors at the preview seam — proving the
// ring's NativeNv12Frames convert through the owned `Nv12Ingest` matrix
// (which the WebGPU-preferring preview renderer runs via the shader's WGSL
// twin), not Chromium's buffer-frame conversion.
//
// WHY THIS GATE EXISTS — the sibling gates are structurally blind here: the
// preview-sw conformance/families gates assert ffmpeg-SSIM ≥ 0.98 on NATURAL
// content, but ffmpeg SSIM weights chroma ~1/6 and a 601↔709 matrix swap
// barely moves luma, so the BT.601 tint (Chromium software-converting
// buffer-defined NV12 VideoFrames as 601 regardless of the stamped
// colorSpace) passes them cleanly. Saturated flat patches turn the same
// defect into tens of 8-bit steps. Never treat a natural-content SSIM floor
// as evidence of matrix correctness (ADR 0032).
//
// Legs:
//   A. bt709-tagged chart — renders WITHOUT the 601 tint.
//   B. smpte170m-tagged chart — still selects BT.601 (no over-correction:
//      a fix that hard-codes 709 would pass leg A and fail this one).
//   C. untagged H.264 charts, SD, HD and a cropped HD picture (1280x544) —
//      the lane reads the absent tag the way every other lane does
//      (`resolveSourceColor`): BT.601 for SD, BT.709 for HD, where 1280 wide
//      is HD at any height. preview-hw-color, preview-lite-color and
//      color-conformance hold the other lanes to the same patches.
//   D. full-range H.264 charts (709full/601full, the ones preview-hw-color
//      reads) — the lane keeps full-range levels end to end.
//   E. RGB-coded charts (libx264rgb tagged gbr, QuickTime Animation untagged)
//      — the pack converts the RGB samples into the YCbCr colour the ingest
//      reads them with (`nativePlaneColor`). No hardware decoder takes these,
//      so the hardware lanes run them here, in software.
// Same run requirements as preview-sw-conformance.spec.ts: a
// VITE_WEFTCUT_E2E=1 build and the built native-decode component.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const CHART_709 = path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_prores.mov')
const CHART_601 = path.resolve(MEDIA_DIR, 'test_1080p_color_601ltd_prores.mov')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')
const MANIFEST_SD = path.resolve(MEDIA_DIR, 'color_manifest_720x480.json')
const MANIFEST_WIDE = path.resolve(MEDIA_DIR, 'color_manifest_1280x544.json')

type Canvas = { width: number; height: number; fpsNum: number; fpsDen: number }
const CANVAS: Canvas = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const CANVAS_SD: Canvas = { width: 720, height: 480, fpsNum: 30, fpsDen: 1 }
const CANVAS_WIDE: Canvas = { width: 1280, height: 544, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000 // mid-chart; the chart is static, any decoded frame shows it

// Component presence (same level-0 probe as export-prores-fidelity.spec.ts):
// without the built addon the app cannot open native SW sessions, so the
// native-sw route never commits and the gate would time out rather than
// mean anything. The lane itself is cross-platform — see DECODE_ADDON.
const COMPONENT_PRESENT = DECODE_COMPONENT_PRESENT

// Patch-center app-error ceiling in 8-bit code units, matching the export
// chart gate (COLOR_APP_MAX): the chain pays the ProRes master's 10-bit→8-bit
// requantization, the NV12 transport's 4:2:2→4:2:0 chroma resample, and the
// ingest's RGBA8 round-trip (≈1–2 steps each on flat patch centers). The
// failure this guards — a wrong matrix in the preview convert — reads as
// 10–30 steps on the saturated patches.
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

/// Where a leg's chart lives and how it is laid out. `nativeSwRoute`: the
/// chart is WebCodecs-blind (ProRes), so import routes it `native-sw`; any
/// other chart reaches the software lane through the engine and lane pins alone.
interface ChartLeg {
  fixture: string
  manifest: string
  canvas: Canvas
  nativeSwRoute: boolean
}

async function runChartLeg(label: string, leg: ChartLeg): Promise<void> {
  const { fixture, canvas } = leg
  test.skip(!existsSync(fixture), `${label} chart fixture not found at ${fixture} (npm run fixtures)`)
  test.skip(!existsSync(leg.manifest), `color manifest not found at ${leg.manifest} (npm run fixtures)`)
  test.setTimeout(240_000)
  const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-sw-color-proj-')
  const manifest = JSON.parse(readFileSync(leg.manifest, 'utf8')) as {
    width: number
    height: number
    patches: ManifestPatch[]
  }
  expect(manifest.width).toBe(canvas.width) // 1:1 chart→composition mapping
  expect(manifest.height).toBe(canvas.height)

  // Pin the resolver to the software lane: ProRes is videotoolbox-eligible, so
  // on a ProRes-engine Mac this spec's clip would otherwise ride the HW lane
  // and never exercise the SOFTWARE path it gates. Forcing a lane the addon
  // never advertises ('software' is not an HW lane) leaves the HW resolver no
  // candidate — clean software fallback, every host.
  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: 'software' } })
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))
  let toggledOn = false
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: `${label}-${Date.now()}`,
      canvas,
    })

    // Pin the ffmpeg engine BEFORE placing the layer (engine resolution reads
    // decode_engine live at acquire — see preview-sw-conformance.spec.ts).
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: fixture })
    expect(kind).toBe('Video')

    if (leg.nativeSwRoute) {
      await waitForHook(page, 'mediaDecodeRouteKind')
      await page.waitForFunction(
        (id) => (window as unknown as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
        mediaId,
        { timeout: 90_000, polling: 500 },
      )
    }
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

    // Seek once, then poll read-only until the SW lane has decoded + bound the
    // target frame (re-seeking every poll would restart the scrub debounce).
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )
    await page.waitForFunction(
      ([id, target]) => {
        const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; ringSize: number; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p) return null
        if (p.sourceKind !== 'sw') return null // the gate is about the NATIVE SW lane
        if (p.ringSize < 1) return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        if (!p.spriteBound) return null
        return true
      },
      [layerId, SEEK_US] as const,
      { timeout: 90_000, polling: 200 },
    )

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
    console.log(`[preview-sw-color] ${label}: worst patch-center error ${worst} (tol ${PATCH_TOL})`)
    // Dump renderer errors BEFORE the patch assertion — a WebGPU pipeline
    // failure surfaces here, and the assertion throwing first would hide it.
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`[preview-sw-color] ${label} renderer errors during run:\n` + errs.join('\n'))
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0)
  } finally {
    // Restore the app-level engine pin (it persists cross-project).
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test.describe('preview native-SW saturated-chart color gate (Electron)', () => {
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native SW sessions`)

  const prores = (fixture: string): ChartLeg => ({ fixture, manifest: MANIFEST, canvas: CANVAS, nativeSwRoute: true })
  const pinned = (name: string, manifest: string, canvas: Canvas): ChartLeg =>
    ({ fixture: path.resolve(MEDIA_DIR, name), manifest, canvas, nativeSwRoute: false })

  test('bt709-tagged ProRes chart previews without the BT.601 tint', async () => {
    await runChartLeg('psc-709', prores(CHART_709))
  })

  test('smpte170m-tagged ProRes chart still selects BT.601 (no over-correction)', async () => {
    await runChartLeg('psc-601', prores(CHART_601))
  })

  test('untagged SD H.264 chart previews as BT.601 on the software lane', async () => {
    await runChartLeg('psc-untagged-sd', pinned('test_480p_color_601ltd_untagged.mp4', MANIFEST_SD, CANVAS_SD))
  })

  test('untagged HD H.264 chart previews as BT.709 on the software lane', async () => {
    await runChartLeg('psc-untagged-hd', pinned('test_1080p_color_709ltd_untagged.mp4', MANIFEST, CANVAS))
  })

  test('untagged cropped HD H.264 chart (1280x544) previews as BT.709 on the software lane', async () => {
    await runChartLeg('psc-untagged-wide', pinned('test_1280x544_color_709ltd_untagged.mp4', MANIFEST_WIDE, CANVAS_WIDE))
  })

  test('gbr-tagged RGB H.264 chart previews as its RGB on the software lane', async () => {
    await runChartLeg('psc-rgb-h264', pinned('test_1080p_color_rgb_h264.mp4', MANIFEST, CANVAS))
  })

  test('untagged QuickTime Animation RGB chart previews as its RGB on the software lane', async () => {
    await runChartLeg('psc-rgb-qtrle', pinned('test_1080p_color_rgb_qtrle.mov', MANIFEST, CANVAS))
  })

  for (const enc of ['709full', '601full'] as const) {
    test(`${enc} H.264 chart keeps full-range levels on the software lane`, async () => {
      await runChartLeg(`psc-${enc}`, pinned(`test_1080p_color_${enc}.mp4`, MANIFEST, CANVAS))
    })
  }
})
