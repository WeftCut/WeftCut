import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeColor } from '../lib/analyze.mjs'
import {
  launchApp,
  newProject,
  driveExport,
  invokeCmd,
  tmpDir,
  colorFaithfulMax,
  DECODE_ADDON,
  DECODE_COMPONENT_PRESENT,
} from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')
const BASELINE_PATH = path.resolve(MEDIA_DIR, '..', 'color_baseline.json')

// Axis-A color conformance gate. Per encoding, export 1:1 and measure app-only
// color loss under a PERCEPTUAL metric: the analyzer decodes the OUTPUT by its
// own embedded color tag and the SOURCE forced to its matrix/range (the DECODE
// map below), then asks "does the export SHOW the same colors as the source?".
//
// Why perceptual (not matrix-roundtrip): the WebCodecs H.264 encoder (HW and
// SW, verified) ignores the input frame's colorSpace and tags every HD output
// bt709 — it CANNOT emit a 601-tagged HD file. So a faithful 601 export is
// legitimately bt709-tagged (normalized to 709). A matrix-roundtrip check
// (force-decode the output as the source matrix) measured the relabel, not the
// colors. All four encodings are FAITHFUL; 601->709 normalization and
// full->limited range conversion cost only codec round-trip. ADR 0014.
//
// Fixtures come from global-setup; the committed baseline gates faithfulness.
// GPU-less CI legs recalibrate the ceiling via WEFTCUT_E2E_COLOR_FAITHFUL_MAX:
// the software raster's chroma rounding exceeds the real-GPU ceiling (README
// §Export SSIM floors) without being an app color bug.

// Reference matrix/range each encoding's SOURCE is decoded with (its tags are
// incomplete — only a matrix is present). The OUTPUT is decoded by its own tag.
const DECODE: Record<string, [string, string]> = {
  '709ltd': ['bt709', 'tv'],
  '601ltd': ['smpte170m', 'tv'],
  '709full': ['bt709', 'pc'],
  '601full': ['smpte170m', 'pc'],
}

const sourceFor = (enc: string) => path.resolve(MEDIA_DIR, `test_1080p_color_${enc}.mp4`)

// Guarded baseline load — recorded from a real run; committed (not gitignored).
const BASELINE = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null

test.describe('color round-trip conformance (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    // Skip the whole group (without launching) when neither the fixtures nor
    // the baseline are present — the common CI case.
    test.skip(
      !BASELINE || !Object.keys(DECODE).some((enc) => existsSync(sourceFor(enc))),
      'color fixtures or baseline not present (run `npm run fixtures`; baseline is committed)',
    )
    ;({ app, page } = await launchApp())
  })

  test.afterAll(async () => {
    await app?.close()
  })

  for (const enc of Object.keys(DECODE)) {
    const source = sourceFor(enc)
    test(`${enc} color round-trip`, async () => {
      test.skip(!existsSync(source), `color source fixture not found at ${source}`)
      test.skip(!BASELINE?.[enc], `baseline not recorded for ${enc} in ${BASELINE_PATH}`)
      test.setTimeout(240000)
      const output = path.join(tmpDir('weftcut-e2e-color-out-'), `color-${enc}.mp4`)

      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-color-proj-'),
        name: `e2e-color-${enc}-` + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })

      const r = await driveExport(page, { mediaAbsPath: source, outputAbsPath: output })
      if (!r.done.ok) throw new Error(`exportClip failed (${enc}): ` + r.done.error)

      const [im, ir] = DECODE[enc]!
      const report = analyzeColor({ output, source, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 })
      const expectFaithful = BASELINE[enc].expectFaithful
      const faithfulMax = colorFaithfulMax(BASELINE.faithfulMax)
      console.log(
        `[e2e] color ${enc}: worst_app_max=${report.worst_app_max} ` +
          `(expectFaithful=${expectFaithful}, faithfulMax=${faithfulMax})`,
      )

      if (expectFaithful) {
        // Faithful round-trip: app-only color error must be ~0 across all
        // patches (flat patches, matching matrix). 709-limited is native space.
        const offenders = report.patches.filter(
          (p: any) => Math.max(...p.app_error.max) > faithfulMax,
        )
        expect(
          offenders,
          JSON.stringify(offenders.map((p: any) => ({ id: p.id, max: p.app_error.max }))),
        ).toHaveLength(0)
        expect(report.worst_app_max).toBeLessThanOrEqual(faithfulMax)
      } else {
        // KNOWN BUG sentinel: assert the bug is STILL present so the suite stays
        // green; when the color-management fix lands, worst_app_max drops
        // <= faithfulMax and THIS assertion fails — flip expectFaithful then.
        expect(report.worst_app_max).toBeGreaterThan(faithfulMax)
      }
    })
  }
})

// Export half of the untagged-chart agreement: the same untagged charts the
// preview gates sample (preview-sw-color, preview-hw-color, preview-lite-color)
// exported 1:1 through BOTH export decode engines must show the source's
// colours. The charts carry no colour tag, so every lane fills the absence from
// one rule (`resolveSourceColor`): BT.601 below 720 lines, BT.709 from 720 up.
// Same metric and ceiling as the round-trip cases above; ffmpeg would read an
// untagged source as BT.601 at every size, so the intended matrix is passed
// explicitly.
//
// The ffmpeg pin needs the native-decode component, so its cases run only with
// WEFTCUT_DECODE_E2E=1, like export-prores-fidelity. `nativeHandles` tells the
// two engines apart, so a silent fallback never counts as coverage.

interface UntaggedChart {
  label: string
  source: string
  manifest: string
  canvas: { width: number; height: number; fpsNum: number; fpsDen: number }
  /// The matrix/range the chart was converted with (generate.mjs UNTAGGED_COLOR).
  inMatrix: string
  inRange: string
}

const UNTAGGED_CHARTS: readonly UntaggedChart[] = [
  {
    label: 'SD',
    source: path.resolve(MEDIA_DIR, 'test_480p_color_601ltd_untagged.mp4'),
    manifest: path.resolve(MEDIA_DIR, 'color_manifest_720x480.json'),
    canvas: { width: 720, height: 480, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'smpte170m',
    inRange: 'tv',
  },
  {
    label: 'HD',
    source: path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_untagged.mp4'),
    manifest: MANIFEST,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'bt709',
    inRange: 'tv',
  },
]

test.describe('untagged-chart export color agreement (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    test.skip(
      !BASELINE || !UNTAGGED_CHARTS.some((c) => existsSync(c.source)),
      'untagged color fixtures or baseline not present (run `npm run fixtures`; baseline is committed)',
    )
    ;({ app, page } = await launchApp())
    // The native leg starts while import work can still hold a task slot; two
    // slots keep 3-core Macs from returning busy (export-prores-fidelity).
    await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { processing: 'high' } } })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  for (const engine of ['webcodecs', 'ffmpeg'] as const) {
    for (const chart of UNTAGGED_CHARTS) {
      const reads = chart.inMatrix === 'bt709' ? 'BT.709' : 'BT.601'
      test(`untagged ${chart.label} chart exports as ${reads} through the ${engine} decode engine`, async () => {
        if (engine === 'ffmpeg') {
          test.skip(
            process.env.WEFTCUT_DECODE_E2E !== '1',
            'the ffmpeg export decode engine needs the native-decode component + a VITE_WEFTCUT_E2E=1 build; set WEFTCUT_DECODE_E2E=1 to run',
          )
          test.skip(!DECODE_COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native sessions`)
        }
        test.skip(!existsSync(chart.source), `untagged chart fixture not found at ${chart.source} (npm run fixtures)`)
        test.skip(!existsSync(chart.manifest), `color manifest not found at ${chart.manifest} (npm run fixtures)`)
        test.setTimeout(240000)
        const manifest = JSON.parse(readFileSync(chart.manifest, 'utf8')) as { width: number; height: number }
        expect(manifest.width).toBe(chart.canvas.width) // 1:1 chart→composition mapping
        expect(manifest.height).toBe(chart.canvas.height)
        const output = path.join(tmpDir('weftcut-e2e-untagged-color-out-'), `untagged-${chart.label}-${engine}.mp4`)

        await newProject(page, {
          parentFolder: tmpDir('weftcut-e2e-untagged-color-proj-'),
          name: `e2e-untagged-${chart.label}-${engine}-` + Date.now(),
          canvas: chart.canvas,
        })

        const r = await driveExport(page, {
          mediaAbsPath: chart.source,
          outputAbsPath: output,
          settings: { decodeEngine: engine },
        })
        if (!r.done.ok) throw new Error(`exportClip failed (${chart.label}, ${engine}): ` + r.done.error)
        // __weftcutExportPerf is republished on each export's `done`, so it is
        // read before the next case overwrites it.
        const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
          | { nativeHandles: number; colorDiag?: unknown }
          | null
        if (!perf) throw new Error('export settled but __weftcutExportPerf is missing (VITE_WEFTCUT_E2E build?)')
        console.log(`[e2e] untagged ${chart.label} ${engine}: colorDiag=${JSON.stringify(perf.colorDiag ?? null)}`)
        if (engine === 'ffmpeg') {
          expect(perf.nativeHandles, 'ffmpeg pin must engage the native session').toBeGreaterThanOrEqual(1)
        } else {
          expect(perf.nativeHandles, 'webcodecs pin must not open native sessions').toBe(0)
        }

        const report = analyzeColor({
          output,
          source: chart.source,
          manifest: chart.manifest,
          inMatrix: chart.inMatrix,
          inRange: chart.inRange,
          sample: 10,
        })
        const faithfulMax = colorFaithfulMax(BASELINE.faithfulMax)
        console.log(
          `[e2e] untagged ${chart.label} ${engine}: worst_app_max=${report.worst_app_max} (faithfulMax=${faithfulMax})`,
        )
        const offenders = report.patches.filter(
          (p: any) => Math.max(...p.app_error.max) > faithfulMax,
        )
        expect(
          offenders,
          JSON.stringify(offenders.map((p: any) => ({ id: p.id, max: p.app_error.max, output: p.output, source: p.source }))),
        ).toHaveLength(0)
        expect(report.worst_app_max).toBeLessThanOrEqual(faithfulMax)
      })
    }
  }
})
