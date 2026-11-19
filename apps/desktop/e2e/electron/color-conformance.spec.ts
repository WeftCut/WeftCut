import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeColor } from '../lib/analyze.mjs'
import { displayedColour } from '../fixtures/generate.mjs'
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
// one rule (`resolveSourceColor`): BT.601 for SD, BT.709 for HD, where 1280 wide
// is HD at any height. Same metric and ceiling as the round-trip cases above;
// ffmpeg would read an untagged source as BT.601 at every size, so the intended
// matrix is passed explicitly.
//
// The RGB-coded charts run through both engines too: the ffmpeg engine's
// session converts the RGB samples into the YCbCr its frames are read with
// (`nativePlaneColor`), and the webcodecs engine decodes the full proxy, whose
// recipe converts them and declares what it converted into. RGB samples have
// no matrix to force, so the analyzer reads the source as it is.
//
// The two full-range charts run here through the ffmpeg engine only (the
// round-trip cases above take them through webcodecs): the native decode
// session packs its frames with swscale, which must not change their levels.
//
// The ffmpeg engine converts declared BT.2020 and EBU primaries into BT.709
// (the owned conversion, `planeConversion`), so through it the BT.2020 SDR
// (8-bit H.264, 10-bit HEVC) and PAL charts are held to `displayedColour` of
// the source as the analyzer reads it (fixtures/generate.mjs), with the same
// ceiling. They run through the ffmpeg engine only; every other chart is held
// to the source as it reads, on both engines.
//
// The ffmpeg pin needs the native-decode component, so its cases run only with
// WEFTCUT_DECODE_E2E=1, like export-prores-fidelity. `nativeHandles` tells the
// two engines apart, so a silent fallback never counts as coverage.

type DecodeEngine = 'webcodecs' | 'ffmpeg'

interface EngineChart {
  label: string
  title: (engine: DecodeEngine) => string
  engines: readonly DecodeEngine[]
  source: string
  manifest: string
  canvas: { width: number; height: number; fpsNum: number; fpsDen: number }
  /// The matrix/range the chart was converted with (generate.mjs
  /// UNTAGGED_COLOR, GAMUT_COLOR; swscale's names); `auto` for an RGB chart,
  /// which has none.
  inMatrix: string
  inRange: string
  /// The primaries the native lanes convert the chart from
  /// (`planeConversion`): its declared BT.2020 or EBU primaries, else BT.709.
  primaries: 'bt709' | 'bt470bg' | 'bt2020'
}

const ENGINE_CHARTS: readonly EngineChart[] = [
  {
    label: 'SD',
    title: (engine) => `untagged SD chart exports as BT.601 through the ${engine} decode engine`,
    engines: ['webcodecs', 'ffmpeg'],
    source: path.resolve(MEDIA_DIR, 'test_480p_color_601ltd_untagged.mp4'),
    manifest: path.resolve(MEDIA_DIR, 'color_manifest_720x480.json'),
    canvas: { width: 720, height: 480, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'smpte170m',
    inRange: 'tv',
    primaries: 'bt709',
  },
  {
    label: 'HD',
    title: (engine) => `untagged HD chart exports as BT.709 through the ${engine} decode engine`,
    engines: ['webcodecs', 'ffmpeg'],
    source: path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_untagged.mp4'),
    manifest: MANIFEST,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'bt709',
    inRange: 'tv',
    primaries: 'bt709',
  },
  {
    label: 'wide',
    title: (engine) => `untagged cropped HD chart (1280x544) exports as BT.709 through the ${engine} decode engine`,
    engines: ['webcodecs', 'ffmpeg'],
    source: path.resolve(MEDIA_DIR, 'test_1280x544_color_709ltd_untagged.mp4'),
    manifest: path.resolve(MEDIA_DIR, 'color_manifest_1280x544.json'),
    canvas: { width: 1280, height: 544, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'bt709',
    inRange: 'tv',
    primaries: 'bt709',
  },
  ...([
    ['rgb-h264', 'gbr-tagged RGB H.264', 'test_1080p_color_rgb_h264.mp4'],
    ['rgb-qtrle', 'untagged QuickTime Animation RGB', 'test_1080p_color_rgb_qtrle.mov'],
  ] as const).map(([label, chart, file]): EngineChart => ({
    label,
    title: (engine) => `${chart} chart exports its RGB through the ${engine} decode engine`,
    engines: ['webcodecs', 'ffmpeg'],
    source: path.resolve(MEDIA_DIR, file),
    manifest: MANIFEST,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    inMatrix: 'auto',
    inRange: 'auto',
    primaries: 'bt709',
  })),
  ...(['709full', '601full'] as const).map((enc): EngineChart => ({
    label: enc,
    title: (engine) => `${enc} chart keeps full-range levels through the ${engine} decode engine`,
    engines: ['ffmpeg'],
    source: path.resolve(MEDIA_DIR, `test_1080p_color_${enc}.mp4`),
    manifest: MANIFEST,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    inMatrix: enc === '709full' ? 'bt709' : 'smpte170m',
    inRange: 'pc',
    primaries: 'bt709',
  })),
  ...([
    ['2020-h264', 'BT.2020 SDR H.264', 'test_1080p_color_2020_h264.mp4', 'color_manifest.json', 1920, 1080, 'bt2020', 'bt2020'],
    ['2020-hevc10', 'BT.2020 SDR 10-bit HEVC', 'test_1080p_color_2020_hevc10.mp4', 'color_manifest.json', 1920, 1080, 'bt2020', 'bt2020'],
    ['pal', 'PAL SD', 'test_576p_color_pal.mp4', 'color_manifest_720x576.json', 720, 576, 'bt470', 'bt470bg'],
  ] as const).map(([label, chart, file, manifest, width, height, inMatrix, primaries]): EngineChart => ({
    label,
    title: (engine) => `${chart} chart exports converted into BT.709 primaries through the ${engine} decode engine`,
    engines: ['ffmpeg'],
    source: path.resolve(MEDIA_DIR, file),
    manifest: path.resolve(MEDIA_DIR, manifest),
    canvas: { width, height, fpsNum: 30, fpsDen: 1 },
    inMatrix,
    inRange: 'tv',
    primaries,
  })),
]

test.describe('chart export color agreement across decode engines (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    test.skip(
      !BASELINE || !ENGINE_CHARTS.some((c) => existsSync(c.source)),
      'color chart fixtures or baseline not present (run `npm run fixtures`; baseline is committed)',
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
    for (const chart of ENGINE_CHARTS) {
      if (!chart.engines.includes(engine)) continue
      test(chart.title(engine), async () => {
        if (engine === 'ffmpeg') {
          test.skip(
            process.env.WEFTCUT_DECODE_E2E !== '1',
            'the ffmpeg export decode engine needs the native-decode component + a VITE_WEFTCUT_E2E=1 build; set WEFTCUT_DECODE_E2E=1 to run',
          )
          test.skip(!DECODE_COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native sessions`)
        }
        test.skip(!existsSync(chart.source), `chart fixture not found at ${chart.source} (npm run fixtures)`)
        test.skip(!existsSync(chart.manifest), `color manifest not found at ${chart.manifest} (npm run fixtures)`)
        test.setTimeout(240000)
        const manifest = JSON.parse(readFileSync(chart.manifest, 'utf8')) as { width: number; height: number }
        expect(manifest.width).toBe(chart.canvas.width) // 1:1 chart→composition mapping
        expect(manifest.height).toBe(chart.canvas.height)
        const output = path.join(tmpDir('weftcut-e2e-engine-color-out-'), `${chart.label}-${engine}.mp4`)

        await newProject(page, {
          parentFolder: tmpDir('weftcut-e2e-engine-color-proj-'),
          name: `e2e-engine-${chart.label}-${engine}-` + Date.now(),
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
        console.log(`[e2e] chart ${chart.label} ${engine}: colorDiag=${JSON.stringify(perf.colorDiag ?? null)}`)
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
        // What the export must show per patch, and how far it is from it.
        const converts = engine === 'ffmpeg' && chart.primaries !== 'bt709'
        const shown = (p: any): number[] => (converts ? displayedColour(p.source, chart.primaries) : p.source)
        const errorOf = (p: any): number =>
          converts
            ? Math.max(...shown(p).map((v, c) => Math.abs(p.output[c] - v)))
            : Math.max(...p.app_error.max)
        const worst = Math.max(...report.patches.map(errorOf))
        console.log(
          `[e2e] chart ${chart.label} ${engine}: worst=${worst} converts=${converts} (faithfulMax=${faithfulMax})`,
        )
        const offenders = report.patches.filter((p: any) => errorOf(p) > faithfulMax)
        expect(
          offenders,
          JSON.stringify(offenders.map((p: any) => ({ id: p.id, error: errorOf(p), output: p.output, expected: shown(p) }))),
        ).toHaveLength(0)
        expect(worst).toBeLessThanOrEqual(faithfulMax)
      })
    }
  }
})
