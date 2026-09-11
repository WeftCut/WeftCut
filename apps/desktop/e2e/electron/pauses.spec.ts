import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { invokeCmd, launchApp, newProject, rootSummary, tmpDir, waitForHook } from './helpers/driver'

/**
 * The Pauses section of the Attribute Panel, end to end in the packaged app
 * (`.scratch/pauses/spec.md`, ADR 0067's sibling): a detection a person can see
 * on the clip, a removal that takes the picture with it, and one undo that puts
 * the film back.
 *
 * What only a real window can answer. The detector is covered in Rust against
 * hand-built peaks, the pad math and the audition plan by colocated Vitest over
 * pure inputs, and `LayerContextMenu.test.tsx` greys the row against a summary
 * fixture. None of them can say that a right-click row REVEALS the Attribute
 * Panel and expands a section that was collapsed, that the bands the section
 * publishes reach the subject Audio block (and only that block), that the two
 * numbers the summary prints are the ones the removal actually cuts, or that
 * the linked picture followed a cut decided by sound.
 *
 * WHY THIS FIXTURE. `test_audio_timing_zero_pts.mkv` is 6 s of 320×180 colour
 * video over mono PCM whose recipe is DIGITAL silence (`anullsrc`) broken by
 * three 250 ms 1 kHz islands: 1000 · 250 · 1750 · 250 · 1750 · 250 · 750 ms
 * (`fixtures/generate.mjs` `generateAudioTiming`). Four pauses at the section's
 * defaults, one of them at the head and one at the tail, which is what puts the
 * edge rule of `pauseCores` — pad on the INNER side only — under the same
 * assertion as the two interior ones. Reused rather than minted: the waveform
 * alignment spec already depends on these exact islands, so the numbers below
 * are pinned by a second reader.
 *
 * The removal test is the one that exercises two grids at once: the cut is
 * decided by SOUND (48 kHz lattice) and the picture rides the frame grid, and
 * the first build of this feature refused every A/V-linked clip because of the
 * half-frame drift between them. `removePauses` now lands a picture-linked cut
 * on the frame grid before dispatching, and the multi-split fan-out tolerates
 * half a frame of overlap; the assertions below are what the spec asks for.
 *
 * Not `@serial`: no time is measured, no GPU lane driven, no reference output
 * captured (e2e/README.md § Tiers), so it runs in the `parallel` project and
 * joins `slices.mjs`'s catch-all with no entry of its own.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const FIXTURE = path.resolve(MEDIA_DIR, 'test_audio_timing_zero_pts.mkv')

/// 30 fps, the fixture's own rate — so the picture partner's re-snap is a whole
/// number of frames from the sound's cut rather than an arbitrary remainder,
/// and `VIDEO_SNAP_SLACK_US` below is a frame count instead of a guess.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const FRAME_US = 1_000_000 / 30

/// The fixture's own length, and the span of the clip placed 1:1 at t = 0.
const CLIP_US = 6_000_000

/// What the four pauses come to at the defaults (−34 dB, 500 ms, 100 ms pad),
/// taking each pause's core: head 1000 − 100, two interiors 1750 − 200, tail
/// 750 − 100 (the head and the tail keep their pad on the inner side only).
const NOMINAL_REMOVED_US = 4_650_000

/// How far UNDER the nominal a real detection lands.
///
/// The detector reads a peaks LOD, not samples: `read_peaks_file` picks the
/// finest level still at or above 100 peaks/s, which for a 22 050 Hz peaks file
/// is 176 frames per peak — a window of ~7.98 ms. Any window holding one sample
/// of a tone island reads loud, so each of the SIX interior pause edges (three
/// islands, two edges each) is short by up to one window and the total removal
/// is short by up to six. The head and the tail edges are the clip's own and
/// cost nothing.
///
/// On an A/V-LINKED clip each interior core boundary is then rounded onto the
/// 30 fps frame grid before the split (`removePauses`' `cutGridCores`), which
/// moves it by up to half a frame (16.7 ms) either way — six more edges, so
/// worst case ~100 ms on top of the LOD's 48 ms; measured here the two together
/// come to 50 ms under. Symmetric because what this gate is about is the pad
/// arithmetic, not quantization: a removal off by a fifth of a second is a pad
/// bug and this catches it, while window and frame rounding is the detector
/// and the grid working as designed.
const REMOVED_TOLERANCE_US = 150_000

/// How far the picture may sit from the sound after the cut. Every cut is
/// re-snapped onto the target's own grid — the sound's sample lattice, the
/// picture's frame grid — so a boundary decided by sound can land up to half a
/// frame off on the picture, and the run of six of them accumulates. One frame
/// per cut is the budget the ticket sets; anything past it is a fan-out that
/// lost a cut rather than rounded one.
const CUT_COUNT = 6
const VIDEO_SNAP_SLACK_US = CUT_COUNT * FRAME_US

interface WireLayer {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string; media_id?: string }
}
interface Wire {
  duration_us: number
  tracks: Array<{ id: string; role: string | null; layers: WireLayer[] }>
  links: Array<{ id: string; layer_ids: string[] }>
  history: { cursor: number; len: number }
}

const wire = (page: Page): Promise<Wire> => rootSummary<Wire>(page)

/// Every layer of one kind in timeline order. "The first surviving segment" is
/// a position in time, never an id this spec was handed.
const clipsOfKind = (s: Wire, kind: string): WireLayer[] =>
  s.tracks
    .flatMap((t) => t.layers)
    .filter((l) => l.params.kind === kind)
    .sort((a, b) => a.t_start_us - b.t_start_us)

const spanOf = (layers: readonly WireLayer[]): number =>
  layers.reduce((sum, l) => sum + (l.t_end_us - l.t_start_us), 0)

const trackWithRole = (s: Wire, role: string): string => {
  const track = s.tracks.find((t) => t.role === role)
  if (!track) throw new Error(`the blank skeleton carries no ${role} lane`)
  return track.id
}

const block = (page: Page, layerId: string): Locator =>
  page.locator(`.timeline-layer[data-layer-id="${layerId}"]`)

/// The Pauses section itself — `PropSection` renders a `<section aria-label>`,
/// so the title IS the accessible name and the locator needs no testid.
const pausesSection = (page: Page, title: string): Locator =>
  page.locator(`section.prop-section[aria-label="${title}"]`)

/// Boot an editor holding the fixture's linked A/V pair at t = 0 on the A roll.
///
/// The A ROLL and not a fresh lane: the default A/B Roll display mode renders
/// only role-stamped tracks (`link-visibility.spec.ts` pins that rule), and both
/// halves have to be on screen — the bands are drawn on the audio block and the
/// right-click that opens the section lands on it.
async function seedPair(
  page: Page,
  name: string,
): Promise<{ mediaId: string; videoLayerId: string; audioLayerId: string }> {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-e2e-pauses-'),
    name: `${name}-${Date.now()}`,
    canvas: CANVAS,
  })
  // REQUIRED before any pointer gesture: the launch splash is a full-window
  // overlay that outlives the first timeline render and swallows mousedown.
  await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

  const mediaId = await invokeCmd<string>(page, 'import_media', { path: FIXTURE })
  const videoLayerId = await invokeCmd<string>(page, 'add_media_layer', {
    trackId: trackWithRole(await wire(page), 'a-roll'),
    mediaId,
    tStartUs: 0,
  })
  const placed = await wire(page)
  const audio = clipsOfKind(placed, 'Audio')
  expect(audio, 'the A/V source should have auto-paired an Audio layer').toHaveLength(1)
  expect(
    placed.links.find((l) => l.layer_ids.includes(videoLayerId)),
    'picture and sound should share one link',
  ).toBeTruthy()
  expect(audio[0]!.t_end_us - audio[0]!.t_start_us).toBe(CLIP_US)
  return { mediaId, videoLayerId, audioLayerId: audio[0]!.id }
}

/// Block until the media's PEAKS exist.
///
/// Not politeness — a readiness gate. `detect_pauses` refuses with
/// "waveform not generated yet" until the peaks file is `cached_ok`, and the
/// section recovers from that only through the `media:job_complete` listener it
/// registers ASYNCHRONOUSLY on mount. A waveform that lands inside that window
/// leaves the section reading *Waiting for the waveform…* with nothing left to
/// wake it. `sampleWaveformRms` polls the same producer that reads the same
/// file, so its answer IS the precondition, and it is the suite's existing
/// waveform wait rather than a new one.
async function waitForPeaks(page: Page, mediaId: string): Promise<void> {
  await waitForHook(page, 'sampleWaveformRms')
  const probe = (await page.evaluate(
    ({ id, timesUs }) => (window as any).__weftcutTest.sampleWaveformRms({ mediaId: id, timesUs }),
    { id: mediaId, timesUs: [1_125_000, 2_000_000] },
  )) as { peaksPerSecond: number; rms: number[] }
  // The island at 1.125 s and the quiet at 2 s, so a peaks file that generated
  // but decoded nothing fails HERE rather than as an empty detection later.
  expect(probe.rms[0], 'the fixture should carry its 1 s sound island').toBeGreaterThan(0.05)
  expect(probe.rms[1], 'the fixture should be silent at 2 s').toBeLessThan(0.005)
}

/// Where the removal got to, as one readable phrase: the refusal the section
/// printed, or how many pieces the sound is now in.
///
/// The inline message is read before the count because that is where a refusal
/// lands (`PausesSection`'s `pauses-error`); the status bar is the fallback for
/// a refusal that closed the op without re-rendering the section.
async function removalOutcome(page: Page): Promise<string> {
  const inline = page.getByTestId('pauses-error')
  if ((await inline.count()) > 0) return `refused: ${(await inline.innerText()).trim()}`
  const status = page.locator('.status-bar-message')
  const count = clipsOfKind(await wire(page), 'Audio').length
  if (count === 1 && (await status.count()) > 0) {
    const message = (await status.innerText()).trim()
    if (/refus|blocked|fail/i.test(message)) return `refused: ${message}`
  }
  return `${count} audio segments`
}

/// Wait until the removal has SETTLED — landed or refused — and answer with
/// whichever it was.
///
/// Two terminal states rather than one, so the assertion that follows names the
/// difference: a refusal is final (the verb re-arms and nothing else will
/// change), so polling for the success phrase alone would burn the whole budget
/// and then report a count instead of the refusal's own sentence.
async function settledRemoval(page: Page): Promise<string> {
  let outcome = ''
  await expect
    .poll(
      async () => {
        outcome = await removalOutcome(page)
        return outcome.startsWith('refused:') || outcome === '3 audio segments'
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: 'the removal neither landed nor refused',
      },
    )
    .toBe(true)
  return outcome
}

/// Right-click the clip and run *Detect pauses…* from its context menu.
///
/// The right-click is also the SELECTION: `Timeline.tsx`'s `onContextMenu`
/// selects a clip that was outside the selection, taking the whole link but
/// making the clicked layer the PRIMARY — which is the layer the Attribute
/// Panel renders and the layer the subject rule resolves from.
async function detectFromContextMenu(page: Page, layerId: string, rowLabel: string): Promise<void> {
  const target = block(page, layerId)
  await expect(target).toBeVisible()
  const box = await target.boundingBox()
  if (!box) throw new Error(`the clip block for ${layerId} has no layout box`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  // By accessible name: the row renders its accelerator in an `aria-hidden`
  // span, so a `hasText` anchor would have to know the keystroke (there is no
  // default one, but the row must not depend on that staying true).
  const row = page.getByRole('menuitem', { name: rowLabel, exact: true })
  await expect(row).toHaveCount(1)
  await expect(row).toBeEnabled()
  await row.click()
}

test.describe('pauses', () => {
  test.skip(
    !existsSync(FIXTURE),
    `A/V fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  )

  test('the command opens the section and the bands land on the sound', async () => {
    // Two background jobs (conform + waveform) behind a debounced detection. No
    // export and no analyzer, so the budget is a launch plus the import
    // derivatives on a loaded box.
    test.setTimeout(240_000)
    const { app, page } = await launchApp()
    try {
      const { mediaId, videoLayerId, audioLayerId } = await seedPair(page, 'e2e-pauses')
      await waitForPeaks(page, mediaId)

      // ── The command reveals the Panel and expands the section ────────────
      // Collapsed is the section's default (spec Decision 3), so an expanded
      // body here is the command's own work and not a layout accident.
      await detectFromContextMenu(page, audioLayerId, 'Detect pauses in selected clip…')
      const section = pausesSection(page, 'Pauses')
      await expect(section).toHaveCount(1)
      await expect(section.locator('.prop-section-header')).toHaveAttribute('aria-expanded', 'true')

      // ── Four bands, on the Audio block and nowhere else ──────────────────
      // The count is polled rather than asserted once: the detection is
      // debounced and may still be reading when the section mounts.
      const audioBands = block(page, audioLayerId).locator('[data-testid="pause-band"]')
      await expect(audioBands).toHaveCount(4, { timeout: 60_000 })
      // Each pause draws a core — the part *Remove* takes — so a set of bands
      // with nothing to cut would be caught here rather than by the arithmetic.
      await expect(block(page, audioLayerId).locator('[data-testid="pause-band-core"]')).toHaveCount(4)
      // Decision 5: the picture gets no bands. The link's accent and the
      // delegation line already say it follows; a filmstrip under a band
      // verifies nothing.
      await expect(block(page, videoLayerId).locator('[data-testid="pause-band"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="pause-bands"]')).toHaveCount(1)

      // ── The summary says what the removal will cost, before it runs ──────
      // Wall clock, three decimals (`formatWallClock`): the seconds are pinned,
      // the milliseconds are the LOD's (see REMOVED_TOLERANCE_US).
      const summaryLine = page.getByTestId('pauses-summary')
      await expect(summaryLine).toHaveText(
        /^4 pauses · removes 00:00:04\.\d{3} · result 00:00:01\.\d{3}$/,
      )
      console.log(`[e2e] pauses summary: ${await summaryLine.textContent()}`)
      // Nothing has been written: measuring is not an edit, so re-tuning a
      // threshold against a live preview costs no undo steps.
      await expect(page.getByTestId('pauses-error')).toHaveCount(0)
      expect(clipsOfKind(await wire(page), 'Audio')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  // The two-grid case. `removePauses` decides its cuts on the SUBJECT audio's
  // times and dispatches one `split_layer_multi`, whose `applySplitLayer`
  // re-snaps each spanning link sibling on its OWN grid — sound on the 48 kHz
  // lattice, picture on the frame grid. Left alone, a boundary between frames
  // became two cuts up to half a frame apart (measured: sound 897 729 µs,
  // picture 900 000 µs), the kept picture piece lapped ~13 ms into the next
  // hole, the fan-out doomed it, and the planner refused the merged hole as
  // one that swallowed the clip. `removePauses` therefore snaps a
  // picture-linked cut list onto the frame grid first (a frame boundary IS a
  // sample boundary at every integer rate), and the fan-out only takes a
  // partner that overlaps by more than half a frame or by most of itself. The
  // unlinked-audio case never had the problem: `removed_us` 4 625 760 there,
  // three survivors [0,455417] [455417,918833] [918833,1374250].
  test('Remove pauses cuts the picture in lockstep and one undo puts the film back', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launchApp()
    try {
      const { mediaId, audioLayerId } = await seedPair(page, 'e2e-pauses-remove')
      await waitForPeaks(page, mediaId)
      await detectFromContextMenu(page, audioLayerId, 'Detect pauses in selected clip…')
      await expect(block(page, audioLayerId).locator('[data-testid="pause-band"]')).toHaveCount(4, {
        timeout: 60_000,
      })

      const before = await wire(page)
      await page.getByRole('button', { name: 'Remove pauses', exact: true }).click()
      // Settled on a PHRASE, not a count (`audio-denoise.spec.ts`'s bake wait):
      // every refusal this verb can raise lands inline in the section, and a
      // wait that only counted segments would spend its whole budget and then
      // report "still 1" instead of the sentence that says why.
      const outcome = await settledRemoval(page)
      console.log(`[e2e] removal outcome: ${outcome}`)
      expect(outcome).toBe('3 audio segments')

      const after = await wire(page)
      const audioAfter = clipsOfKind(after, 'Audio')
      const videoAfter = clipsOfKind(after, 'VideoClip')
      // Three tone islands, three surviving segments — on BOTH halves, which is
      // the whole claim: the cut list was decided by sound and the picture was
      // cut in lockstep.
      expect(audioAfter).toHaveLength(3)
      expect(videoAfter).toHaveLength(3)

      const audioLeft = spanOf(audioAfter)
      const videoLeft = spanOf(videoAfter)
      const removedUs = CLIP_US - audioLeft
      console.log(
        `[e2e] removed ${(removedUs / 1000).toFixed(1)}ms of ${(NOMINAL_REMOVED_US / 1000).toFixed(0)}ms nominal; `
          + `audio left ${(audioLeft / 1000).toFixed(1)}ms, picture left ${(videoLeft / 1000).toFixed(1)}ms`,
      )
      expect(Math.abs(removedUs - NOMINAL_REMOVED_US)).toBeLessThanOrEqual(REMOVED_TOLERANCE_US)
      expect(Math.abs(videoLeft - audioLeft)).toBeLessThanOrEqual(VIDEO_SNAP_SLACK_US)
      // The gaps are CLOSED, not merely emptied: a removal is a ripple (ADR
      // 0062), so the survivors abut and the film is shorter by what went.
      expect(audioAfter[0]!.t_start_us).toBe(0)
      expect(audioAfter[1]!.t_start_us).toBe(audioAfter[0]!.t_end_us)
      expect(audioAfter[2]!.t_start_us).toBe(audioAfter[1]!.t_end_us)

      // ── ONE undo puts both halves back whole ─────────────────────────────
      // The whole promise of dispatching a single `split_layer_multi`: six cuts
      // and four discards are one entry, not ten.
      expect(after.history.cursor).toBe(before.history.cursor + 1)
      await invokeCmd(page, 'project_undo', {})
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'Audio').length, {
          timeout: 30_000,
          message: 'one undo did not restore the sound',
        })
        .toBe(1)
      const undone = await wire(page)
      const audioBack = clipsOfKind(undone, 'Audio')
      const videoBack = clipsOfKind(undone, 'VideoClip')
      expect(audioBack).toHaveLength(1)
      expect(videoBack).toHaveLength(1)
      expect(audioBack[0]!.t_end_us - audioBack[0]!.t_start_us).toBe(CLIP_US)
      expect(videoBack[0]!.t_end_us - videoBack[0]!.t_start_us).toBe(CLIP_US)
    } finally {
      await app.close()
    }
  })

  test('a picture clip delegates to its sound, and loses the section when that sound goes', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launchApp()
    try {
      const { mediaId, videoLayerId, audioLayerId } = await seedPair(page, 'e2e-pauses-delegate')
      await waitForPeaks(page, mediaId)

      // ── Selecting the PICTURE still measures the sound ───────────────────
      await detectFromContextMenu(page, videoLayerId, 'Detect pauses in selected clip…')
      const section = pausesSection(page, 'Pauses')
      await expect(section).toHaveCount(1)
      await expect(section.locator('.prop-section-header')).toHaveAttribute('aria-expanded', 'true')
      // The first line of the body names the clip the numbers are about, so a
      // user who selected picture is not told a figure about something else.
      const delegated = page.getByTestId('pauses-delegated')
      await expect(delegated).toHaveText(/^Measured on the linked audio “.+”$/)
      await expect(delegated).toContainText('test_audio_timing_zero_pts')
      // Same subject, so the same four bands — and still on the AUDIO block,
      // even though the selection is the picture.
      await expect(block(page, audioLayerId).locator('[data-testid="pause-band"]')).toHaveCount(4, {
        timeout: 60_000,
      })
      await expect(block(page, videoLayerId).locator('[data-testid="pause-band"]')).toHaveCount(0)

      // ── Take the sound away ──────────────────────────────────────────────
      // Dissolve first, then delete: with the link intact the delete would fan
      // out and take the picture with it, and what this test needs is a picture
      // clip that plays nothing.
      const linkId = (await wire(page)).links.find((l) => l.layer_ids.includes(videoLayerId))?.id
      expect(linkId, 'the pair should still be linked before the dissolve').toBeTruthy()
      await invokeCmd(page, 'links_dissolve', { linkId })
      await invokeCmd(page, 'delete_layer', { layerId: audioLayerId })
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'Audio').length, {
          timeout: 30_000,
          message: 'the audio partner was never deleted',
        })
        .toBe(0)

      // No subject, so no section at all — a header with nothing under it is
      // not an explanation (spec Decision 3). Asserted after a WITNESS that the
      // delete landed in the renderer's own mirror, not after a settle: the
      // block is gone from the timeline, so the panel has seen the change.
      await expect(block(page, audioLayerId)).toHaveCount(0)
      await expect(pausesSection(page, 'Pauses')).toHaveCount(0)

      // ── …and the row says why ────────────────────────────────────────────
      const target = block(page, videoLayerId)
      const box = await target.boundingBox()
      if (!box) throw new Error('the picture block has no layout box')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      const row = page.getByRole('menuitem', { name: 'Detect pauses in selected clip…', exact: true })
      await expect(row).toHaveCount(1)
      await expect(row).toHaveAttribute('aria-disabled', 'true')
      // The reason that belongs to pauses alone (spec Decision 1): the file may
      // well carry a track, but nothing plays it.
      await expect(row).toHaveAttribute('title', 'This clip plays no sound')
      await page.keyboard.press('Escape')
      await expect(row).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('the Chinese build says 停顿 on every surface and 静默 on none', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launchApp({ locale: 'zh-CN' })
    try {
      const { mediaId, audioLayerId } = await seedPair(page, 'e2e-pauses-zh')
      await waitForPeaks(page, mediaId)

      await detectFromContextMenu(page, audioLayerId, '检测停顿…')
      const section = pausesSection(page, '停顿')
      await expect(section).toHaveCount(1)
      await expect(section.locator('.prop-section-header')).toHaveAttribute('aria-expanded', 'true')
      await expect(block(page, audioLayerId).locator('[data-testid="pause-band"]')).toHaveCount(4, {
        timeout: 60_000,
      })
      await expect(page.getByTestId('pauses-summary')).toHaveText(
        /^4 处停顿，移除 00:00:04\.\d{3}，结果 00:00:01\.\d{3}$/,
      )
      await expect(section.getByRole('button', { name: '标记停顿', exact: true })).toBeEnabled()
      await expect(section.getByRole('button', { name: '移除停顿', exact: true })).toBeEnabled()

      // The retired nouns, checked over the whole section rather than per row:
      // 静默 is the old name, 静音 is mute, and 图层 is banned from copy
      // everywhere (CONTEXT.md's Layer entry). A rename that missed one string
      // fails here whichever line it hid on.
      const sectionText = (await section.innerText()).replace(/\s+/g, '')
      for (const retired of ['静默', '静音', '图层']) {
        expect(sectionText, `the Pauses section still says ${retired}`).not.toContain(retired)
      }
      expect(sectionText).toContain('停顿')

      // Same sweep over the row that opens it, which is the other surface the
      // rename had to reach.
      const target = block(page, audioLayerId)
      const box = await target.boundingBox()
      if (!box) throw new Error('the sound block has no layout box')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      const menuText = await page.locator('.app-menu-list').first().innerText()
      expect(menuText).toContain('检测停顿')
      for (const retired of ['静默', '静音']) {
        expect(menuText, `the clip menu still says ${retired}`).not.toContain(retired)
      }
      await page.keyboard.press('Escape')
    } finally {
      await app.close()
    }
  })
})
