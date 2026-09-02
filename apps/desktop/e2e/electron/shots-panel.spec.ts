import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
  rootSummary,
  tmpDir,
  waitForHook,
} from './helpers/driver'

/**
 * The Shots Panel end to end: a real whole-source ffmpeg floor scan, the real
 * Rust `reduce` behind the threshold line, and `apply_shot_cuts` + undo read
 * back off the project.
 *
 * The colocated Vitest file covers every state of this Panel with
 * `reduceShotReport` mocked, so what it cannot see is the only thing asserted
 * here: that the candidates a real scan finds are the ticks the strip draws,
 * that moving the line re-derives the row list THROUGH Rust, and that pressing
 * Split lands two layers on the timeline at the boundary the surviving tick
 * names.
 *
 * `test_shot_cuts_6s.mp4` is the one fixture in the suite that has cuts at all
 * — every other video is `testsrc2` / `color=` / `nullsrc`, whose per-frame
 * scene scores peak at 0.0326, below any usable threshold. Its two candidates
 * score 1.000 and 0.520, and that pair is the point: they straddle the
 * detector's 0.4 default, so a line raised past 0.52 drops exactly one of them.
 * The fixture's own manifest pins those numbers (`e2e/fixtures/generate.mjs`,
 * `SHOT_CUTS`), and the scores are identical whichever tier `pick_source`
 * hands the detector — original, quick proxy or full master — so the
 * background proxy job cannot shift what this spec expects. It does race the
 * scan: the import's quick-proxy transcode lands while or after the floor scan
 * runs, so by the time the split changes the subject, the tier a fresh scan
 * would use may not be the one the report was cached under. The post-split row
 * count is therefore also the assertion that a cached report is found on any
 * tier (`find_cached_report`), not only on the tier a fresh scan would read.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/media/test_shot_cuts_6s.mp4')
/// 30 fps, matching the fixture: the row timecodes are read on the
/// COMPOSITION's clock, so a mismatched rate would make `00:00:02:00` a
/// different instant from the 2 s candidate.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/// The detector's own default, as `shot_default_opts` states it
/// (`native/src/jobs/shot/mod.rs`). Asserted rather than assumed: the line's
/// opening position is what decides whether the first row list a reviewer sees
/// is the three-shot one.
const DEFAULT_SENSITIVITY = '0.4'
/// The whole-source scan's threshold — the lowest the line may sit, since a
/// value under it can only ask for candidates the scan never emitted.
const FLOOR_SENSITIVITY = 0.05
/// Two PageUp presses from the default: above the 0.520 candidate and below the
/// 1.000 one, so exactly one of the two survives the line.
const RAISED_SENSITIVITY = '0.6'

const CUT_A_US = 2_000_000
const CUT_B_US = 4_000_000

/// Only the fields this spec reads, spelled out rather than intersected onto
/// the driver's loose `CompositionSummary` (group-timeline.spec.ts' shape).
interface WireLayer {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string }
}
interface Wire {
  tracks: Array<{ id: string; role?: string | null; layers: WireLayer[] }>
}

/// Every layer on the root timeline, in ascending start order. The split's
/// assertions read this rather than counting timeline blocks: a block is a
/// projection with its own visibility rules, while the layer list is what the
/// apply actually produced.
async function placedLayers(page: Page): Promise<WireLayer[]> {
  const s = await rootSummary<Wire>(page)
  return s.tracks
    .flatMap((track) => track.layers)
    .sort((a, b) => a.t_start_us - b.t_start_us)
}

const shotRows = (page: Page): Locator =>
  page.locator('[data-testid="shots-list"] .shots-row')
const scoreTicks = (page: Page): Locator =>
  page.locator('[data-testid="shots-score-strip"] .shots-tick')
const scoreTick = (page: Page, srcUs: number): Locator =>
  page.locator(`[data-testid="shots-score-strip"] .shots-tick[data-src-us="${srcUs}"]`)
const thresholdHandle = (page: Page): Locator =>
  page.locator('[data-testid="shots-score-strip"] .shots-threshold[role="slider"]')

/// The primary selection, which is the Panel's whole subject. The hook wait is
/// what names a missing control surface: `expect.poll` swallows the callback's
/// throw and retries, so without it a non-`VITE_WEFTCUT_E2E` build reads as a
/// selection that never landed.
async function selectedLayerId(page: Page): Promise<string | null> {
  await waitForHook(page, 'getSelectedLayerId')
  return page.evaluate(
    () => (window as any).__weftcutTest.getSelectedLayerId() as string | null,
  )
}

// Raw pointer at the centre rather than `locator.click()`: that scrolls the
// target into view first, and a clip at t = 0 sits at the scroll origin, where
// the scroll can slide it under the sticky header column.
const clickCentre = async (page: Page, target: Locator): Promise<void> => {
  const box = await target.boundingBox()
  if (!box) throw new Error('target has no layout box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('Shots Panel', () => {
  test.skip(
    !existsSync(FIXTURE),
    `shot fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  )

  test('the threshold line drives the rows, and Split at cuts lands them on the timeline', async () => {
    // Measured at 5.1-5.4 s locally across four green runs; the rest is CI
    // headroom, and it is the GPU-less legs that need it — `launchApp` +
    // `newProject` alone reach the first guard around 60 s there, the scan
    // decodes the whole source behind the import's own quick-proxy transcode on
    // the shared ffmpeg semaphore, and every row then pulls three frame
    // extracts through that same gate.
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const parent = tmpDir('weftcut-shots-')
      await newProject(page, { parentFolder: parent, name: 'shots-panel', canvas: CANVAS })
      // REQUIRED before any pointer gesture: the splash overlay outlives the
      // first dock render and swallows mousedown while the target is visible.
      await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

      // Onto the A ROLL by name, not through `importAndPlaceMedia`: that mints
      // a fresh track, and the default A/B-roll display mode draws only the
      // reserved lanes — so the clip would exist with no block to click, which
      // is the same fact history-panel's `layerIds` helper works around.
      const mediaId = await invokeCmd<string>(page, 'import_media', { path: FIXTURE })
      const aRoll = (await rootSummary<Wire>(page)).tracks.find(
        (track) => track.role === 'a-roll',
      )
      expect(aRoll, 'the blank skeleton carries an A roll').toBeTruthy()
      const layerId = await invokeCmd<string>(page, 'add_media_layer', {
        trackId: aRoll!.id,
        mediaId,
        tStartUs: 0,
      })
      // The one-layer baseline the split's "now two" is measured against.
      await expect.poll(async () => (await placedLayers(page)).length).toBe(1)
      const placed = (await placedLayers(page))[0]!
      // The Panel's subject is a `VideoClip` and nothing else, so a fixture that
      // classified some other way would leave it in its empty state for a
      // reason no assertion below would name.
      expect(placed.params.kind).toBe('VideoClip')
      const spanEndUs = placed.t_end_us

      // ── Select the clip, then open the Panel ───────────────────────────────
      // In that order on purpose: the Panel resolves its subject from the
      // standing selection on mount, so this is also the check that it does not
      // need a selection CHANGE to find one.
      const clip = page.locator(`.timeline-layer[data-layer-id="${layerId}"]`)
      await expect(clip).toBeVisible()
      await clickCentre(page, clip)
      await expect.poll(() => selectedLayerId(page)).toBe(layerId)

      // Closed by default — a Panel with a subject only while a video clip is
      // selected would otherwise spend permanent screen on a review nobody
      // asked for. Nothing was written to put it in the View menu either:
      // `ViewMenu` maps over `PANEL_KINDS`, so registering the Panel did that.
      await expect(dockPanel(page, 'shots')).toHaveCount(0)
      // View is the third menu (File, Edit, View, …).
      await page.locator('.menu-trigger').nth(2).click()
      await page.locator('.app-menu-item').filter({ hasText: /^Shots$/ }).click()
      await expect(dockPanel(page, 'shots')).toHaveCount(1)

      // ── Analyze: one deliberate press, one whole-source scan ──────────────
      // The offer standing here IS the "no scan on selection" check: rows and
      // this button are two branches of the same conditional, so a Panel that
      // had scanned on selection would show a list instead. Clicking clips is
      // the highest-frequency gesture in the app and the scan decodes the whole
      // source, which is why one deliberate press is the only way in.
      const analyzeButton = page.locator('.shots-offer button')
      await expect(analyzeButton).toBeVisible()
      await analyzeButton.click()
      await expect(shotRows(page)).toHaveCount(3, { timeout: 120_000 })

      // ── The strip is the scan, not a redraw of the rows ───────────────────
      // Exactly two ticks: the floor scan at 0.05 emits these and no others,
      // because within a solid-colour segment consecutive frames are identical
      // and score zero. A third tick would mean the chain invented a candidate.
      await expect(scoreTicks(page)).toHaveCount(2)
      await expect(thresholdHandle(page)).toHaveAttribute(
        'aria-valuenow',
        DEFAULT_SENSITIVITY,
      )
      await expect(thresholdHandle(page)).toHaveAttribute('aria-valuemax', '1')
      // Numeric and not a string compare: the floor crosses the napi boundary
      // as an `f32` widened to `f64`, so the attribute carries 0.05's binary
      // expansion rather than the literal.
      expect(
        Number(await thresholdHandle(page).getAttribute('aria-valuemin')),
      ).toBeCloseTo(FLOOR_SENSITIVITY)
      // At the default both candidates are boundaries, which is why the list
      // opens at three shots.
      await expect(scoreTick(page, CUT_A_US)).toHaveAttribute('data-accepted', 'true')
      await expect(scoreTick(page, CUT_B_US)).toHaveAttribute('data-accepted', 'true')

      // ── Raise the line past 0.520: the weaker cut stops being a boundary ───
      // The keyboard rather than a drag, because a press is an exact value
      // where a pointer y is a geometry the dock's width decides.
      await thresholdHandle(page).press('PageUp')
      await thresholdHandle(page).press('PageUp')
      await expect(thresholdHandle(page)).toHaveAttribute(
        'aria-valuenow',
        RAISED_SENSITIVITY,
      )
      await expect(scoreTick(page, CUT_B_US)).toHaveAttribute('data-accepted', 'false')
      await expect(scoreTick(page, CUT_A_US)).toHaveAttribute('data-accepted', 'true')
      // The EFFECT, which is the whole reason this Panel is worth opening: the
      // rows are Rust's answer at the new threshold, not a client-side filter.
      await expect(shotRows(page)).toHaveCount(2)
      // …and the one that survives opens on the 2 s cut. Read off the row's own
      // timecode, so the assertion is the sentence a reviewer reads.
      await expect(
        page.locator('[data-testid="shots-list"] .shots-row[data-index="1"] .shots-timecode'),
      ).toHaveText('00:00:02:00')

      // ── Lower it back: the line is what drives the list, both ways ─────────
      await thresholdHandle(page).press('PageDown')
      await thresholdHandle(page).press('PageDown')
      await expect(thresholdHandle(page)).toHaveAttribute(
        'aria-valuenow',
        DEFAULT_SENSITIVITY,
      )
      await expect(shotRows(page)).toHaveCount(3)
      await expect(scoreTick(page, CUT_B_US)).toHaveAttribute('data-accepted', 'true')

      // ── Split at cuts, at one boundary ────────────────────────────────────
      await thresholdHandle(page).press('PageUp')
      await thresholdHandle(page).press('PageUp')
      await expect(shotRows(page)).toHaveCount(2)

      await page.locator('[data-testid="shots-apply-split"]').click()
      await expect.poll(async () => (await placedLayers(page)).length).toBe(2)
      const segments = await placedLayers(page)
      // Two segments meeting at the surviving boundary, together covering
      // exactly what the one clip covered: a split moves nothing and drops
      // nothing.
      expect(segments.map((l) => [l.t_start_us, l.t_end_us])).toEqual([
        [0, CUT_A_US],
        [CUT_A_US, spanEndUs],
      ])
      // On ONE lane: a split is not a placement, so it never reaches for a new
      // track.
      const holding = (await rootSummary<Wire>(page)).tracks.filter(
        (track) => track.layers.length > 0,
      )
      expect(holding).toHaveLength(1)
      expect(holding[0]!.layers).toHaveLength(2)

      // A split's LEFT half reuses the layer it cut (`mutations/split.ts`), so
      // the reviewed id never vanishes: `retainLayerSelection` keeps it, and
      // the Panel re-resolves a subject whose source window is now one shot.
      // That window holds no interior candidate, so there is nothing for a line
      // to sort and the strip says so in place of a plot.
      await expect(shotRows(page)).toHaveCount(1)
      await expect(page.locator('[data-testid="shots-no-candidates"]')).toHaveCount(1)
      await expect(page.locator('[data-testid="shots-score-strip"]')).toHaveCount(0)

      // ── One Ctrl+Z puts the clip back whole, review and all ───────────────
      // The whole apply is one entry. `undo` is unscoped, so the chord fires
      // wherever the split press left focus; the threshold writes cannot be in
      // the way because `update_project_settings` is unrecorded.
      await page.keyboard.press(`${MOD}+Z`)
      await expect.poll(async () => (await placedLayers(page)).length).toBe(1)
      const restored = (await placedLayers(page))[0]!
      expect(restored.t_start_us).toBe(0)
      expect(restored.t_end_us).toBe(spanEndUs)
      // The window is the whole source again, so the review the reviewer was in
      // the middle of comes back at the line they left it on — the report is
      // read from its sidecar, not re-scanned.
      await expect(scoreTicks(page)).toHaveCount(2)
      await expect(shotRows(page)).toHaveCount(2)
    } finally {
      await app.close()
    }
  })
})
