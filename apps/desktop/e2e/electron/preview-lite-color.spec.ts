import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, colorFaithfulMax } from './helpers/driver'

// Saturated-chart color gate for the Lite engine's PREVIEW (WebCodecs decode
// of the original, converted by the browser's 2D-canvas path; ADR 0014). The
// charts carry no colour tag at all, so what this reads is how the lane fills
// the absence: the decoder config takes every field from the source's
// resolved colour (`resolveSourceColor` through `withDefaultColorSpace`), and
// must land on the same patches the native lanes do (preview-sw-color,
// preview-hw-color) and export does (color-conformance).
//
// Same sampling method as preview-sw-color. Needs a VITE_WEFTCUT_E2E=1 build;
// no native-decode component.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')

type Canvas = { width: number; height: number; fpsNum: number; fpsDen: number }

const SEEK_US = 500_000 // mid-chart; the chart is static, any decoded frame shows it

// Patch-center ceiling in 8-bit code units, the preview colour gates' shared
// value (preview-sw-color, preview-hw-color): the H.264 chart's own
// quantization, its 4:2:0 chroma siting and the RGBA8 round-trip cost ≈1–2
// steps each on flat patch centers. A matrix read the wrong way reads as 10–30
// steps on the saturated patches.
//
// Unlike the native lanes, this lane's conversion is the browser's, so a leg
// whose raster is software takes the ceiling the export colour gate takes
// there (`colorFaithfulMax`: its chroma rounding reaches 12 on the BT.709
// blue channel). A matrix read the wrong way still reads above it (24–39).
const PATCH_TOL = colorFaithfulMax(8)

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

async function runChartLeg(label: string, fixture: string, manifestPath: string, canvas: Canvas): Promise<void> {
  test.skip(!existsSync(fixture), `${label} chart fixture not found at ${fixture} (npm run fixtures)`)
  test.skip(!existsSync(manifestPath), `color manifest not found at ${manifestPath} (npm run fixtures)`)
  test.setTimeout(240_000)
  const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-lite-color-proj-')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    width: number
    height: number
    patches: ManifestPatch[]
  }
  expect(manifest.width).toBe(canvas.width) // 1:1 chart→composition mapping
  expect(manifest.height).toBe(canvas.height)

  const { app, page } = await launchApp()
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

    // Pin the Lite (webcodecs) engine BEFORE placing the layer (engine
    // resolution reads decode_engine live at acquire — see
    // preview-sw-conformance.spec.ts).
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'webcodecs' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('webcodecs')
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

    // Seek once, then poll read-only until the WebCodecs lane has decoded +
    // bound the target frame of the ORIGINAL. The resolver stays pending until
    // the import-time decodability probe lands, hence the long timeout; a
    // proxy decode is not this lane and never satisfies the wait.
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )
    await page.waitForFunction(
      ([id, target]) => {
        const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; builtFromKey: string | null; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p) return null
        if (p.sourceKind !== 'webcodecs') return null
        if (!p.builtFromKey?.startsWith('webcodecs:original:')) return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        if (!p.spriteBound) return null
        return true
      },
      [layerId, SEEK_US] as const,
      { timeout: 120_000, polling: 200 },
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
    console.log(`[preview-lite-color] ${label}: worst patch-center error ${worst} (tol ${PATCH_TOL})`)
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`[preview-lite-color] ${label} renderer errors during run:\n` + errs.join('\n'))
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0)
  } finally {
    // Restore the app-level engine pin (it persists cross-project).
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test.describe('preview Lite-engine untagged-chart color gate (Electron)', () => {
  test('untagged SD H.264 chart previews as BT.601 on the Lite engine', async () => {
    await runChartLeg(
      'plc-untagged-sd',
      path.resolve(MEDIA_DIR, 'test_480p_color_601ltd_untagged.mp4'),
      path.resolve(MEDIA_DIR, 'color_manifest_720x480.json'),
      { width: 720, height: 480, fpsNum: 30, fpsDen: 1 },
    )
  })

  test('untagged HD H.264 chart previews as BT.709 on the Lite engine', async () => {
    await runChartLeg(
      'plc-untagged-hd',
      path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_untagged.mp4'),
      path.resolve(MEDIA_DIR, 'color_manifest.json'),
      { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    )
  })
})
