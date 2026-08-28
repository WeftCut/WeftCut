import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { analyze, analyzeSelf } from '../lib/analyze.mjs'
import { driveExport, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

/**
 * Two levels of Group transform compose IN THE EXPORT, not only in the preview.
 *
 * `group-render-nested.spec.ts` proves the composition off the live Pixi canvas,
 * where a half-scale Group inside a half-scale Group leaves a quarter-frame box.
 * That says nothing about the export Worker: it builds its own `Compositor` in
 * its own realm (the same split `text-box-cjk-export.spec.ts` exists for), and
 * the recursion that draws a Group clip is per-realm machinery — a walk that
 * flattened only the outermost `CompositionRef` would render a preview-correct,
 * export-wrong file, and nothing short of an export would see it.
 *
 * Shape: a differential between two exports of the same picture, placed two ways.
 *
 *   nested — the content in a Group in a Group, a transform on EACH Group layer.
 *   flat   — the same content one Group deep, that one layer carrying the
 *            COMPOSED transform.
 *
 * The flat leg is a Group rather than a bare layer because the content is Color
 * layers, and `ColorParams` carries no transform at all — a Color layer is a
 * rectangle at its composition's origin (`render/sprite/ColorSprite.ts`). That
 * is what makes it the right content here: it cannot smuggle a transform of its
 * own into either leg, so every pixel of displacement in both files comes from a
 * `CompositionRef`, which is the thing under test. What the differential isolates
 * is therefore the DEPTH of the recursion, one level against two.
 *
 * The composition is affine and neither sprite rotates, so the composed
 * transform is arithmetic on the two levels (`FLAT` below) rather than a number
 * copied from a run. Getting the recursion wrong cannot land on the same
 * geometry: applying only the outer level doubles the box's size, applying only
 * the inner one moves it, and either way the differential collapses.
 *
 * Both legs ride the identical encoder over the identical frame count, so this
 * needs none of the source-fidelity SSIM floors the 1:1 export gates carry
 * (e2e/README.md) — see `SSIM_FLOOR` for what the remaining gap is made of.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
/// RED before the cut, GREEN after. A Group maps parent time to composition
/// time, and two levels compose that too, so the content has to be able to say
/// WHICH frame of the innermost timeline reached the pixel — a still picture
/// would pass this gate with the time mapping broken at either level.
const CUT_US = 1_000_000
const CLIP_US = 2_000_000
const RED = { r: 220, g: 40, b: 40, a: 255 }
const GREEN = { r: 40, g: 200, b: 90, a: 255 }
const TOTAL_FRAMES = 60

/// One transform per level. `x`/`y` are the unrotated top-left in the enclosing
/// composition's pixels and the anchor never enters at rotation 0
/// (`render/anchorPivot.ts`), so a point maps `parent = (x, y) + scale · child`
/// and the two levels compose as below.
///
/// The numbers are chosen so nothing is CLIPPED at any level: a Group's picture
/// is a `RenderTexture` of its composition's frame, so content pushed outside
/// that frame is gone before the parent sees it, and the shallower leg — with one
/// intermediate frame instead of two — would keep it. The inner Group lands in
/// [40, 360) x [20, 200) of the middle composition and the whole nest lands in
/// [180, 340) x [100, 190) of the root; both are inside 640 x 360, and every
/// edge is an integer pixel boundary in both legs.
const INNER = { x: 40, y: 20, scale: 0.5 }
const OUTER = { x: 160, y: 90, scale: 0.5 }
const FLAT = {
  x: OUTER.x + OUTER.scale * INNER.x,
  y: OUTER.y + OUTER.scale * INNER.y,
  scale: OUTER.scale * INNER.scale,
}

/// No audio anywhere in this fixture; including it would only add a
/// no-material audio stage to both legs.
const SETTINGS = { audio: { include: false } } as const

/// Frames 29 and 31 straddle the cut at frame 30 — one frame of slack on each
/// side, so a half-frame rounding difference in the nested time mapping is not
/// what the sample reads. They are the two samples that make the time mapping
/// load-bearing; 5 / 20 / 50 cover the two flat stretches.
const SAMPLES = [5, 20, 29, 31, 50]

/// A floor rather than an equality, though measured runs decode IDENTICAL frames
/// (ssim 1.0, psnr at the analyzer's 100 dB identity clamp) — the content is
/// uniform and every edge is an integer pixel boundary, so the deeper leg's extra
/// resample has nothing to round. The licensed difference the floor leaves room
/// for is that resample: the nested leg's picture crosses two 8-bit
/// `RenderTexture` round trips at half scale each where the flat leg crosses one
/// at quarter scale, and a GPU whose filtering or clamp rounds differently would
/// leave a fringe where the box meets the transparent part of an intermediate
/// frame (~0.2% of the frame, around a 160 x 90 box). A broken recursion is
/// nowhere near this range: it changes the box's SIZE, not its edge.
const SSIM_FLOOR = 0.99

/// The witness's threshold: two frames of the SAME file count as differing below
/// this. The box that changes colour is 6% of the frame, so the whole-frame MSSIM
/// only has to fall a little — measured runs read ~0.95 across the cut, and a
/// chain that rendered nothing would read 1.0.
const SELF_SSIM_MAX = 0.99

interface WireLayer {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string; composition?: string; src_in_us?: number; src_out_us?: number }
}
interface WireComposition {
  id: string
  duration_us: number
  tracks: Array<{ id: string; layers: WireLayer[] }>
}
interface Wire {
  root_id: string
  compositions: Record<string, WireComposition>
}

const wire = (page: Page): Promise<Wire> => invokeCmd<Wire>(page, 'project_summary', {})

const layersOf = (c: WireComposition): WireLayer[] => c.tracks.flatMap((t) => t.layers)

/// The export Worker's own frame count (`window.__weftcutExportPerf`, E2E only).
/// Equal counts are the precondition for comparing the two files index for
/// index at all: `analyze` reads frame N of each, and two files of different
/// length would put a different picture at the same N for reasons that have
/// nothing to do with the transform under test.
const exportedFrames = async (page: Page): Promise<number> => {
  const perf = (await page.evaluate(
    () =>
      (window as unknown as { __weftcutExportPerf?: { totalFrames: number } })
        .__weftcutExportPerf ?? null,
  )) as { totalFrames: number } | null
  if (!perf) throw new Error('no __weftcutExportPerf after the export — is this an E2E build?')
  return perf.totalFrames
}

/// Static scalar tracks for one Group layer's transform. `scale_x`/`scale_y` are
/// written as a pair because the layer carries the linked-scale default
/// (`project_scale_link`); writing one alone would ask the twin to derive the
/// other and the test would be asserting that rule instead of this one.
async function setTransform(
  page: Page,
  layerId: string,
  t: { x: number; y: number; scale: number },
): Promise<void> {
  const entries: Array<[string, number]> = [
    ['x', t.x],
    ['y', t.y],
    ['scale_x', t.scale],
    ['scale_y', t.scale],
  ]
  for (const [paramKey, value] of entries) {
    await invokeCmd(page, 'update_layer_param_track', {
      layerId,
      paramKey,
      track: { mode: 'Static', value },
    })
  }
}

/// A fresh project holding RED [0, 1s) then GREEN [1s, 2s) on ONE lane —
/// sequential, so they share it — pre-composed into a Group. Returns that Group.
async function bootLeg(
  page: Page,
  parentFolder: string,
  name: string,
): Promise<{ composition_id: string; layer_id: string }> {
  await newProject(page, { parentFolder, name, canvas: CANVAS })
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const red = await invokeCmd<string>(page, 'add_color_layer', {
    trackId,
    color: RED,
    tStartUs: 0,
    durationUs: CUT_US,
  })
  const green = await invokeCmd<string>(page, 'add_color_layer', {
    trackId,
    color: GREEN,
    tStartUs: CUT_US,
    durationUs: CUT_US,
  })
  return invokeCmd<{ composition_id: string; layer_id: string }>(page, 'groups_create', {
    layerIds: [red, green],
  })
}

/// Every Group layer in the chain must show its whole composition from its
/// start: src_in 0 over the full duration, so parent time IS composition time
/// and the content's cut stays at 1 s however deep it is nested.
function expectIdentityWindow(ref: WireLayer, where: string): void {
  expect(ref.t_start_us, `${where}: starts at 0`).toBe(0)
  expect(ref.t_end_us, `${where}: spans the whole clip`).toBe(CLIP_US)
  expect(ref.params.src_in_us, `${where}: window opens at 0`).toBe(0)
  expect(ref.params.src_out_us, `${where}: window covers the composition`).toBe(CLIP_US)
}

test('a Group inside a Group exports with both transforms composed', async () => {
  test.setTimeout(300_000)
  const outDir = tmpDir('weftcut-e2e-group-nested-out-')
  const projDir = tmpDir('weftcut-e2e-group-nested-proj-')
  const flatOut = path.join(outDir, 'flat.mp4')
  const nestedOut = path.join(outDir, 'nested.mp4')

  const { app, page } = await launchApp()
  try {
    // ── Leg 1: one Group, the composed transform on it ──────────────────────
    const flatGroup = await bootLeg(page, projDir, `e2e-group-nested-flat-${Date.now()}`)
    await setTransform(page, flatGroup.layer_id, FLAT)
    const wFlat = await wire(page)
    expect(Object.keys(wFlat.compositions)).toHaveLength(2)
    expectIdentityWindow(layersOf(wFlat.compositions[wFlat.root_id]!)[0]!, 'flat Group')

    const flatRun = await driveExport(
      page,
      { outputAbsPath: flatOut, settings: SETTINGS },
      { hook: 'exportTimeline' },
    )
    if (!flatRun.done.ok) throw new Error(`flat export failed: ${flatRun.done.error}`)
    const flatFrames = await exportedFrames(page)

    // ── Leg 2: the same content two Groups deep ─────────────────────────────
    const inner = await bootLeg(page, projDir, `e2e-group-nested-${Date.now()}`)
    // Pre-composing the Group layer it just made is what nests: the outer
    // composition's only member is the inner Group.
    const outer = await invokeCmd<{ composition_id: string; layer_id: string }>(
      page,
      'groups_create',
      { layerIds: [inner.layer_id] },
    )
    // Transforms LAST, so neither pre-compose has to carry one.
    await setTransform(page, inner.layer_id, INNER)
    await setTransform(page, outer.layer_id, OUTER)

    const w = await wire(page)
    expect(Object.keys(w.compositions)).toHaveLength(3)
    const root = w.compositions[w.root_id]!
    const middle = w.compositions[outer.composition_id]!
    const innermost = w.compositions[inner.composition_id]!
    expect(layersOf(root).map((l) => l.params.kind)).toEqual(['CompositionRef'])
    expect(layersOf(middle).map((l) => l.params.kind)).toEqual(['CompositionRef'])
    expect(layersOf(innermost).map((l) => l.params.kind)).toEqual(['Color', 'Color'])
    for (const [label, comp] of [
      ['root', root],
      ['middle', middle],
      ['innermost', innermost],
    ] as const) {
      expect(comp.duration_us, `${label} spans the whole clip`).toBe(CLIP_US)
    }
    expectIdentityWindow(layersOf(root)[0]!, 'outer Group')
    expectIdentityWindow(layersOf(middle)[0]!, 'inner Group')

    const nestedRun = await driveExport(
      page,
      { outputAbsPath: nestedOut, settings: SETTINGS },
      { hook: 'exportTimeline' },
    )
    if (!nestedRun.done.ok) throw new Error(`nested export failed: ${nestedRun.done.error}`)
    const nestedFrames = await exportedFrames(page)

    expect(existsSync(flatOut) && existsSync(nestedOut)).toBe(true)
    expect(flatFrames, 'the flat leg spans the whole 2 s clip').toBe(TOTAL_FRAMES)
    expect(nestedFrames, 'nesting changes the shape, not the duration').toBe(flatFrames)

    // ── The differential ────────────────────────────────────────────────────
    // `window: 0` — index for index. The analyzer's default +/-2 search exists to
    // find a temporal shift against a burned-in counter; here each second is a
    // FLAT colour, so neighbouring frames are identical and its strict-greater
    // best-match would report the window's low end for every sample. What makes
    // the time mapping still load-bearing is WHICH indices are sampled: 29 and
    // 31 straddle the cut, and a mapping off by a frame at either level puts
    // RED where GREEN belongs and scores near zero.
    const report = analyze({
      output: nestedOut,
      source: flatOut,
      samples: SAMPLES,
      ssimMin: SSIM_FLOOR,
      window: 0,
    })
    console.log('[e2e] nested-vs-flat Group export differential:', JSON.stringify(report))

    // WITNESS — without this the differential could pass on two EMPTY files. A
    // recursion that drew nothing at all would make both legs a uniform
    // background and score a perfect match, so the deeper leg has to be shown to
    // carry a picture that CHANGES: frame 5 is the RED half of the innermost
    // timeline and frame 50 the GREEN half, three compositions down. They differ
    // only if the content rendered and if the time mapping composed through both
    // levels.
    const witness = analyzeSelf({ output: nestedOut, samples: [5, 50], ssimMax: SELF_SSIM_MAX })
    console.log('[e2e] nested Group self-ssim witness:', JSON.stringify(witness))
    const pair = witness.pairs[0]
    if (!pair) throw new Error('no self-ssim pair returned: ' + JSON.stringify(witness))
    expect(
      pair.differ,
      `the nested export's frames 5 and 50 do not differ (ssim ${pair.ssim.toFixed(4)}): the Group ` +
        `chain rendered nothing, or rendered one frozen frame — either way the differential below ` +
        `would compare two empty files and pass.`,
    ).toBe(true)

    const short = report.samples.filter((s: { ssim: number }) => s.ssim < SSIM_FLOOR)
    expect(
      short,
      `two levels of Group transform did not compose in the export: ${JSON.stringify(short)}. ` +
        `Expected the nest to land where ONE Group at x=${FLAT.x} y=${FLAT.y} scale=${FLAT.scale} does; ` +
        `the recursion that draws a Group clip is CompositionRefSprite + CompositionNode's ` +
        `CompositionRef arm — check that the export Worker's Compositor walks it to the bottom.`,
    ).toHaveLength(0)
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
