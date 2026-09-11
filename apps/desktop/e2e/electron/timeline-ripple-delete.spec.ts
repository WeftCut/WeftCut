import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { invokeCmd, launchApp, newProject, tmpDir, waitForHook, rootSummary } from './helpers/driver'

/**
 * Ripple delete in the packaged app: the KEY, the linked partner, a downstream
 * transition, and a refusal that was predicted before it was sent (ADR 0062).
 *
 * What only a real window can answer. The planner and the mutation are covered
 * by colocated Vitest suites that hand `planRipple` a hand-built view, and
 * `LayerContextMenu.test.tsx` greys the row against a summary fixture. None of
 * them can say that `Shift+Delete` reaches `App`'s handler from a focused
 * timeline, that the selection the key acts on is the one the clicks built, that
 * a transition authored through the real command surface survives the sweep, or
 * that a refusal the renderer predicted on its mirror is the same refusal the
 * actor throws and the status bar prints.
 *
 * WHY THE SELECTION IS MADE WITH `Alt`. A split leaves every piece of a linked
 * clip in ONE link (`mutations/split.ts` — the right half joins its sibling's
 * link unconditionally), and a PLAIN click on a linked layer selects the whole
 * link (`Timeline.tsx` `selectFromClick`). So after two splits a plain click on
 * the middle picture piece selects all six pieces, and the ripple would close
 * the clip's entire footprint rather than the middle slice's. `Alt`+click
 * escapes the link and takes the clicked layer alone; `Alt`+`Shift`+click then
 * ADDS the audio partner without dragging its link along. Two clicks, exactly
 * two ids — which is what the first test's arithmetic is about.
 *
 * The A/V pair is placed on the reserved A ROLL rather than on a fresh lane,
 * because the default A/B Roll display mode renders only role-stamped tracks
 * (`link-visibility.spec.ts` is the spec that pins that rule): on the A roll
 * both halves are on screen and clickable with no inline reveal to keep alive.
 * The overlay layers the second and third tests add ride the B ROLL for the same
 * reason — they are never clicked, but a lane the display filter hides is a lane
 * a failure screenshot cannot explain.
 *
 * Not `@serial`: it measures no time, drives no GPU lane and captures no
 * reference output (e2e/README.md § Tiers), so it runs in the `parallel` project
 * and joins `slices.mjs`'s catch-all with no entry of its own.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// An AV source: `add_media_layer` auto-pairs a video carrying audio into a
/// linked video + Audio layer on the ONE track (`auto_pair_audio_on_import`
/// defaults to true), which is the only way to mint a link without a second
/// clip. The video-only `test_1080p_30fps.mp4` would leave no audio partner and
/// nothing to say about "both partners". 10 s at 30 fps
/// (`fixtures/generate.mjs` `DURATION_SECONDS`), so the cuts below sit well
/// inside it — but no assertion hardcodes the length: every span is read off the
/// project and only DELTAS are asserted.
const FIXTURE = path.resolve(__dirname, '../fixtures/media/test_1080p_30fps_audio.mp4')

/// 30 fps, so every time this spec names is an exact lattice point on BOTH
/// grids: 2 s is frame 60 and audio sample 96 000, 1 s is frame 30 and sample
/// 48 000. That is what makes the shift assertions integer-exact instead of
/// approximate — a mover re-snaps on its own lattice (`grid.ts` `shiftOnGrids`),
/// and a delta that is a whole number of both makes the snap an identity.
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

interface WireLayer {
  id: string
  label: string | null
  t_start_us: number
  t_end_us: number
  locked: boolean
  params: { kind: string; content?: string }
}
interface WireTrack {
  id: string
  role: string | null
  locked: boolean
  layers: WireLayer[]
}
interface Wire {
  duration_us: number
  tracks: WireTrack[]
  links: Array<{ id: string; label: string | null; layer_ids: string[] }>
  transitions: Array<{
    id: string
    from_layer: string
    to_layer: string
    duration_us: number
    extended_us: number
  }>
  markers: Array<{ id: string; t_us: number; end_t_us: number | null; anchor_layer: string | null }>
  history: { cursor: number; len: number }
}

const wire = (page: Page): Promise<Wire> => rootSummary<Wire>(page)

/// Every layer of one kind, in timeline order — the shape every assertion below
/// reads, since "the middle piece" and "the right piece" are positions in time
/// and not ids the spec was handed.
const clipsOfKind = (s: Wire, kind: string): WireLayer[] =>
  s.tracks
    .flatMap((t) => t.layers)
    .filter((l) => l.params.kind === kind)
    .sort((a, b) => a.t_start_us - b.t_start_us)

const trackWithRole = (s: Wire, role: string): string => {
  const track = s.tracks.find((t) => t.role === role)
  if (!track) throw new Error(`the blank skeleton carries no ${role} lane`)
  return track.id
}

const layerById = (s: Wire, id: string): WireLayer => {
  const layer = s.tracks.flatMap((t) => t.layers).find((l) => l.id === id)
  if (!layer) throw new Error(`the root composition holds no layer ${id}`)
  return layer
}

/// The comparable shape of the timeline: identities, lanes, times, and the three
/// derived collections a ripple can disturb. `history` is deliberately OUT — an
/// undo rewinds the cursor, so a snapshot carrying it could never compare equal
/// across the one undo the first test asserts — and so is everything volatile
/// (timestamps, media probe state, the fps lock).
const shapeOf = (s: Wire) => ({
  duration_us: s.duration_us,
  tracks: s.tracks.map((t) => ({
    id: t.id,
    role: t.role,
    locked: t.locked,
    layers: t.layers.map((l) => ({
      id: l.id,
      kind: l.params.kind,
      label: l.label,
      t_start_us: l.t_start_us,
      t_end_us: l.t_end_us,
    })),
  })),
  links: s.links.map((g) => ({ id: g.id, label: g.label, layer_ids: [...g.layer_ids].sort() })),
  transitions: s.transitions.map((tr) => ({
    id: tr.id,
    from_layer: tr.from_layer,
    to_layer: tr.to_layer,
    duration_us: tr.duration_us,
    extended_us: tr.extended_us,
  })),
  markers: s.markers.map((m) => ({
    id: m.id,
    t_us: m.t_us,
    end_t_us: m.end_t_us,
    anchor_layer: m.anchor_layer,
  })),
})

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  await waitForHook(page, 'getSelectedLayerIds')
  const ids = (await page.evaluate(() =>
    (window as unknown as { __weftcutTest: { getSelectedLayerIds(): string[] } }).__weftcutTest.getSelectedLayerIds(),
  )) as string[]
  return ids.slice().sort()
}

const block = (page: Page, layerId: string): Locator =>
  page.locator(`.timeline-layer[data-layer-id="${layerId}"]`)

/// Boot into an editor holding the fixture's linked A/V pair at t = 0 on the A
/// roll, cut at every time in `cutsUs`. The cuts are applied in DESCENDING order
/// and every one targets the SAME id: `applySplitLayer` gives the LEFT half the
/// original id, so cutting at 4 s and then at 2 s walks that id leftward and no
/// step has to guess which piece the previous one produced.
async function seedSplitPair(
  page: Page,
  cutsUs: readonly number[],
): Promise<{ videoLayerId: string; audioLayerId: string }> {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-e2e-ripple-'),
    name: 'e2e-ripple-' + Date.now(),
    canvas: CANVAS,
  })
  // REQUIRED before any pointer gesture: the launch splash is a full-window
  // overlay that outlives the first timeline render.
  await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

  const mediaId = await invokeCmd<string>(page, 'import_media', { path: FIXTURE })
  const videoLayerId = await invokeCmd<string>(page, 'add_media_layer', {
    trackId: trackWithRole(await wire(page), 'a-roll'),
    mediaId,
    tStartUs: 0,
  })

  const placed = await wire(page)
  const audioLayerId = clipsOfKind(placed, 'Audio')[0]?.id
  expect(audioLayerId, 'the AV source should have auto-paired an Audio layer').toBeTruthy()
  const link = placed.links.find((g) => g.layer_ids.includes(videoLayerId))
  expect(link, 'video and audio halves should share one link').toBeTruthy()
  const video = layerById(placed, videoLayerId)
  expect(
    video.t_end_us,
    'the fixture must outlast every cut this spec makes',
  ).toBeGreaterThan(Math.max(...cutsUs))

  for (const atTUs of [...cutsUs].sort((a, b) => b - a)) {
    await invokeCmd(page, 'split_layer_linked', { layerId: videoLayerId, atTUs, escapeLink: false })
  }
  return { videoLayerId, audioLayerId: audioLayerId! }
}

/// Select exactly the picture piece and its audio partner: `Alt` escapes the
/// link on the first click, `Alt`+`Shift` adds the second layer without pulling
/// its link in. Centre clicks — `LayerBlock`'s 6 px edge zones arm a TRIM at the
/// ends, and with `Alt` held an edge press would escape the link into a trim
/// drag instead of selecting.
async function selectPair(page: Page, videoId: string, audioId: string): Promise<void> {
  await expect(block(page, videoId)).toBeVisible()
  await expect(block(page, audioId)).toBeVisible()
  await block(page, videoId).click({ modifiers: ['Alt'] })
  await block(page, audioId).click({ modifiers: ['Alt', 'Shift'] })
  expect(await selectedLayerIds(page)).toEqual([videoId, audioId].sort())
}

test.describe('ripple delete', () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  )

  test('Shift+Delete closes the span on both linked partners and one undo puts the film back', async () => {
    test.setTimeout(150_000)
    const { app, page } = await launchApp()
    try {
      const { videoLayerId, audioLayerId } = await seedSplitPair(page, [2_000_000, 4_000_000])

      const before = await wire(page)
      const videoBefore = clipsOfKind(before, 'VideoClip')
      const audioBefore = clipsOfKind(before, 'Audio')
      expect(videoBefore.map((l) => l.t_start_us)).toEqual([0, 2_000_000, 4_000_000])
      expect(audioBefore.map((l) => l.t_start_us)).toEqual([0, 2_000_000, 4_000_000])
      // The two title prefixes the block locators would read: `LayerBlock`'s
      // tooltip opens with the kind's UI label (Video / Audio), which is how a spec tells the
      // picture slice of a combined row from its audio slice.
      await expect(block(page, videoBefore[1]!.id)).toHaveAttribute('title', /^Video: /)
      await expect(block(page, audioBefore[1]!.id)).toHaveAttribute('title', /^Audio: /)
      const shapeBefore = shapeOf(before)

      await selectPair(page, videoBefore[1]!.id, audioBefore[1]!.id)
      await page.keyboard.press('Shift+Delete')

      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip').length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(2)

      const after = await wire(page)
      const videoAfter = clipsOfKind(after, 'VideoClip')
      const audioAfter = clipsOfKind(after, 'Audio')
      expect(videoAfter).toHaveLength(2)
      expect(audioAfter).toHaveLength(2)
      // The gap is CLOSED, not merely emptied — on the picture and on the sound,
      // which is the whole reason the deletion took two layers.
      expect(videoAfter[1]!.t_start_us, 'the right picture piece abuts the left one').toBe(
        videoAfter[0]!.t_end_us,
      )
      expect(audioAfter[1]!.t_start_us, 'the right audio piece abuts the left one').toBe(
        audioAfter[0]!.t_end_us,
      )
      // The surviving pieces are the ones that were there: the ripple re-times,
      // it does not re-create.
      expect(videoAfter.map((l) => l.id)).toEqual([videoBefore[0]!.id, videoBefore[2]!.id])
      expect(audioAfter.map((l) => l.id)).toEqual([audioBefore[0]!.id, audioBefore[2]!.id])
      expect(videoAfter[1]!.t_start_us).toBe(videoBefore[2]!.t_start_us - 2_000_000)
      expect(audioAfter[1]!.t_start_us).toBe(audioBefore[2]!.t_start_us - 2_000_000)
      // 2 s is 60 whole frames and 96 000 whole samples, so the film gets
      // shorter by exactly the span that was closed (ADR 0005's autofit).
      expect(after.duration_us).toBe(before.duration_us - 2_000_000)
      // Deletes AND sweep in ONE commit: two layers gone and four re-timed is
      // one row on the stack, which is what makes the undo below one keystroke.
      expect(after.history.len).toBe(before.history.len + 1)

      await invokeCmd(page, 'project_undo', {})
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip').length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(3)
      expect(shapeOf(await wire(page))).toEqual(shapeBefore)
      // The restored layers are still linked to each other, so the pair that
      // comes back is a pair and not two strangers at the same time.
      const restored = await wire(page)
      const restoredLink = restored.links.find((g) => g.layer_ids.includes(videoLayerId))
      expect(restoredLink?.layer_ids).toContain(audioLayerId)
    } finally {
      await app.close()
    }
  })

  test('a downstream transition survives the ripple with both participants shifted by the same amount', async () => {
    test.setTimeout(150_000)
    const { app, page } = await launchApp()
    try {
      await seedSplitPair(page, [2_000_000, 3_000_000, 4_000_000])

      // The transition rides two Color layers on the B roll, NOT two pieces of
      // the split clip: `applyAddTransition` refuses
      // `TransitionParticipantsShareLink` when both participants are in one link
      // (moving the incoming one would drag the outgoing one and the overlap
      // would never open), and every piece of a split linked clip IS in one
      // link. Two unlinked overlays downstream of the cut are the same
      // geometry the ticket asks about — a transition the ripple never touched —
      // and they also prove the harder half: the post-move collision scan must
      // keep honouring the overlap a transition authorizes on a lane the
      // deletion had nothing to do with.
      const bRoll = trackWithRole(await wire(page), 'b-roll')
      const fromLayerId = await invokeCmd<string>(page, 'add_color_layer', {
        trackId: bRoll,
        color: { r: 255, g: 0, b: 0, a: 255 },
        tStartUs: 5_000_000,
        durationUs: 2_000_000,
      })
      const toLayerId = await invokeCmd<string>(page, 'add_color_layer', {
        trackId: bRoll,
        color: { r: 0, g: 0, b: 255, a: 255 },
        tStartUs: 7_000_000,
        durationUs: 2_000_000,
      })
      const transitionId = await invokeCmd<string>(page, 'add_transition', {
        fromLayerId,
        toLayerId,
        durationUs: 1_000_000,
        kind: 'Crossfade',
      })

      const before = await wire(page)
      // Overlap placement (the backend default) moved the incoming overlay left
      // by the duration; the outgoing one never extends.
      expect(before.transitions).toHaveLength(1)
      expect(before.transitions[0]).toMatchObject({
        id: transitionId,
        from_layer: fromLayerId,
        to_layer: toLayerId,
        duration_us: 1_000_000,
        extended_us: 0,
      })
      expect(layerById(before, fromLayerId).t_start_us).toBe(5_000_000)
      expect(layerById(before, toLayerId).t_start_us).toBe(6_000_000)

      const videoBefore = clipsOfKind(before, 'VideoClip')
      const audioBefore = clipsOfKind(before, 'Audio')
      expect(videoBefore.map((l) => l.t_start_us)).toEqual([0, 2_000_000, 3_000_000, 4_000_000])

      // The SECOND pair — [2 s, 3 s) — so the span closed is 1 s and every
      // downstream landing is that much earlier.
      await selectPair(page, videoBefore[1]!.id, audioBefore[1]!.id)
      await page.keyboard.press('Shift+Delete')

      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip').length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(3)

      const after = await wire(page)
      // Same transition, same numbers. `duration_us` and `extended_us` are
      // re-derived from the landing rather than carried, so this is the
      // assertion that a uniform shift left them where they were.
      expect(after.transitions).toHaveLength(1)
      expect(after.transitions[0]).toMatchObject({
        id: transitionId,
        from_layer: fromLayerId,
        to_layer: toLayerId,
        duration_us: 1_000_000,
        extended_us: 0,
      })
      // BOTH participants moved, and by the SAME amount — a differing pair is
      // what the planner refuses as a collision rather than shipping a
      // transition whose overlap no longer matches its duration.
      const shiftOf = (id: string): number =>
        layerById(before, id).t_start_us - layerById(after, id).t_start_us
      expect(shiftOf(fromLayerId)).toBe(1_000_000)
      expect(shiftOf(toLayerId)).toBe(1_000_000)
      expect(layerById(after, fromLayerId).t_start_us).toBe(4_000_000)
      expect(layerById(after, toLayerId).t_start_us).toBe(5_000_000)

      // The picture pieces are still in order and abutting where the cut was.
      const videoAfter = clipsOfKind(after, 'VideoClip')
      expect(videoAfter.map((l) => l.id)).toEqual([
        videoBefore[0]!.id,
        videoBefore[2]!.id,
        videoBefore[3]!.id,
      ])
      expect(videoAfter.map((l) => l.t_start_us)).toEqual([0, 2_000_000, 3_000_000])
      expect(videoAfter[1]!.t_start_us).toBe(videoAfter[0]!.t_end_us)
      expect(after.duration_us).toBe(before.duration_us - 1_000_000)
    } finally {
      await app.close()
    }
  })

  // The gap gesture (ADR 0069). What only a real window can answer: that a
  // press on lane background resolves through the lane's measured x to the gap
  // the store then holds, that the highlight the lane draws is that gap, and
  // that bare `Delete` over it reaches `App`'s handler and closes it on BOTH
  // lanes of the combined A/V row. The gap is made with a PLAIN delete of the
  // middle pair, so the span [2 s, 4 s) is left standing where the middle piece
  // was — which is also where the click goes, measured off the piece's block
  // before it is lifted.
  test('clicking the gap a plain Delete left selects it, and Delete closes it on both lanes', async () => {
    test.setTimeout(150_000)
    const { app, page } = await launchApp()
    try {
      await seedSplitPair(page, [2_000_000, 4_000_000])

      const before = await wire(page)
      const videoBefore = clipsOfKind(before, 'VideoClip')
      const audioBefore = clipsOfKind(before, 'Audio')
      const aRoll = trackWithRole(before, 'a-roll')
      const middle = block(page, videoBefore[1]!.id)
      await expect(middle).toBeVisible()
      // Scrolled into view BEFORE the box is read, because this is the one
      // press in the file a locator cannot make: the piece is deleted below and
      // the point is pressed against the empty lane it leaves behind. A box read
      // off screen would be remembered as a coordinate no pointer can reach —
      // `toBeVisible()` does not mean in-viewport.
      await middle.scrollIntoViewIfNeeded()
      const middleBox = await middle.boundingBox()
      if (!middleBox) throw new Error('the middle picture piece has no layout box')

      // The lift: the pair goes and its span stays empty (`delete_layers`, the
      // key's own op). Nothing downstream moves — that is what the gap IS.
      await invokeCmd(page, 'delete_layers', { layerIds: [videoBefore[1]!.id, audioBefore[1]!.id] })
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip').length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(2)
      const gapped = await wire(page)
      expect(clipsOfKind(gapped, 'VideoClip').map((l) => l.t_start_us)).toEqual([0, 4_000_000])
      expect(clipsOfKind(gapped, 'Audio').map((l) => l.t_start_us)).toEqual([0, 4_000_000])
      const shapeGapped = shapeOf(gapped)

      // A plain click where the middle piece was: lane background now, and a
      // gap by the one gap rule — its left edge the head's end, its right the
      // tail's start.
      await page.mouse.click(middleBox.x + middleBox.width / 2, middleBox.y + middleBox.height / 2)
      await waitForHook(page, 'getSelectedGap')
      const selectedGap = () =>
        page.evaluate(() =>
          (window as unknown as {
            __weftcutTest: { getSelectedGap(): { trackId: string; s: number; e: number } | null }
          }).__weftcutTest.getSelectedGap(),
        )
      await expect.poll(selectedGap).toEqual({ trackId: aRoll, s: 2_000_000, e: 4_000_000 })
      // The highlight is the store's gap, drawn on the lane it names.
      const highlight = page.locator('[data-testid="timeline-gap-selection"]')
      await expect(highlight).toHaveCount(1)
      await expect(highlight).toHaveAttribute('data-track-id', aRoll)
      await expect(highlight).toHaveAttribute('data-start-us', '2000000')
      await expect(highlight).toHaveAttribute('data-end-us', '4000000')
      // Nothing else is selected: a gap and a clip set are branches of one union.
      expect(await selectedLayerIds(page)).toEqual([])

      // BARE Delete, not Shift+Delete: over a gap the key closes.
      await page.keyboard.press('Delete')
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip')[1]!.t_start_us, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(2_000_000)

      const after = await wire(page)
      const videoAfter = clipsOfKind(after, 'VideoClip')
      const audioAfter = clipsOfKind(after, 'Audio')
      // Closed on the picture AND the sound: the closing sweeps every lane.
      expect(videoAfter.map((l) => l.id)).toEqual([videoBefore[0]!.id, videoBefore[2]!.id])
      expect(audioAfter.map((l) => l.id)).toEqual([audioBefore[0]!.id, audioBefore[2]!.id])
      expect(videoAfter[1]!.t_start_us).toBe(videoAfter[0]!.t_end_us)
      expect(audioAfter[1]!.t_start_us).toBe(audioAfter[0]!.t_end_us)
      expect(after.duration_us).toBe(gapped.duration_us - 2_000_000)
      // One entry for the closing, and nothing deleted by it.
      expect(after.history.len).toBe(gapped.history.len + 1)
      // The gap is gone, so the selection that named it is gone with it — the
      // store re-derives the gap against every summary rather than keeping a
      // highlight over a span that no longer exists.
      expect(await selectedGap()).toBeNull()
      await expect(highlight).toHaveCount(0)

      await invokeCmd(page, 'project_undo', {})
      await expect
        .poll(async () => clipsOfKind(await wire(page), 'VideoClip')[1]!.t_start_us, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(4_000_000)
      expect(shapeOf(await wire(page))).toEqual(shapeGapped)
    } finally {
      await app.close()
    }
  })

  test('a clip starting inside the span greys the Ripple delete row with the reason, and the key writes nothing', async () => {
    test.setTimeout(150_000)
    const { app, page } = await launchApp()
    try {
      await seedSplitPair(page, [2_000_000, 4_000_000])

      // A Text layer whose start sits INSIDE the middle slice. Its own label is
      // never written by `applyAddLayer`, so the name in the refusal is derived
      // from the words it renders (`lib/layerName.ts`'s Text rung) — which is
      // why the content is a word worth reading in a sentence.
      const blockerId = await invokeCmd<string>(page, 'add_text_layer', {
        trackId: trackWithRole(await wire(page), 'b-roll'),
        content: 'Blocker',
        tStartUs: 2_500_000,
        durationUs: 1_000_000,
      })

      const before = await wire(page)
      const blocker = layerById(before, blockerId)
      expect(blocker.label, 'nothing writes a Text layer a label, so the name is derived').toBeNull()
      expect(blocker.params.content).toBe('Blocker')
      expect(blocker.t_start_us).toBe(2_500_000)
      const shapeBefore = shapeOf(before)

      const videoBefore = clipsOfKind(before, 'VideoClip')
      const audioBefore = clipsOfKind(before, 'Audio')
      await selectPair(page, videoBefore[1]!.id, audioBefore[1]!.id)

      // A right-click INSIDE the selection keeps it (`Timeline.tsx`'s
      // `onContextMenu` only re-selects a clip that was outside), so the row
      // below is greyed against the same two ids the key will send.
      // Through the LOCATOR, not `page.mouse` at a box read a moment earlier:
      // `locator.click()` scrolls the block into view, waits for its box to hold
      // still across two frames, and re-reads the point it presses. The same
      // absolute-coordinate press cost `pauses.spec.ts` three tests on
      // windows-latest and macos-latest while linux stayed green.
      await block(page, videoBefore[1]!.id).click({ button: 'right' })
      expect(await selectedLayerIds(page)).toEqual(
        [videoBefore[1]!.id, audioBefore[1]!.id].sort(),
      )

      // By accessible name, not by text: the row renders its accelerator beside
      // the label, and that span is `aria-hidden` — so the name is the label and
      // a `hasText` anchor would have to know the keystroke.
      const rippleRow = page.getByRole('menuitem', { name: 'Ripple delete', exact: true })
      // Exactly one, asserted before anything is read off it: every other menu
      // carrying this row is a Base UI popup that mounts on open, so a second
      // match would mean a stray menu is up and the attributes below would be
      // some other surface's.
      await expect(rippleRow).toHaveCount(1)
      await expect(rippleRow).toBeVisible()
      await expect(rippleRow).toHaveAttribute('aria-disabled', 'true')
      // The prediction, off the renderer's own mirror, in the curated wording the
      // status bar uses after the fact — naming the layer, which is the whole
      // reason the sentence is composed rather than looked up.
      await expect(rippleRow).toHaveAttribute(
        'title',
        /^Ripple delete blocked: Blocker starts inside the span being closed/,
      )

      await page.keyboard.press('Escape')
      await expect(rippleRow).toHaveCount(0)

      // Now send it anyway: the mirror can be two round trips behind, so the
      // ACTOR is the authority and its refusal has to land somewhere the user
      // can read it.
      await page.keyboard.press('Shift+Delete')
      // The status bar shows the LATEST row, and `logMutationFailure` carries the
      // refusal's own i18n key and args — so the sentence the greyed row promised
      // is the sentence that arrives, resolved names included. No toast, no
      // dialog (issue #18).
      const statusMessage = page.locator('.status-bar-message')
      await expect(statusMessage).toContainText('Ripple delete blocked', { timeout: 20_000 })
      await expect(statusMessage).toContainText('Blocker')

      // Nothing was written. The plan is computed off untouched state and thrown
      // before the first splice, so a refused ripple leaves the project
      // byte-identical and burns no history row.
      const after = await wire(page)
      expect(shapeOf(after)).toEqual(shapeBefore)
      expect(after.history.len).toBe(before.history.len)
      expect(clipsOfKind(after, 'VideoClip')).toHaveLength(3)
    } finally {
      await app.close()
    }
  })
})
