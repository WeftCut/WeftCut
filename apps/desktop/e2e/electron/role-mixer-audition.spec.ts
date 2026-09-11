import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook, rootSummary,
} from './helpers/driver'

// Role Gain audition — renders the REAL preview Role-gain fold
// (`auditionedRoleGainLinear` → GainNode) in an OfflineAudioContext and checks
// that a renderer-local audition override folds in place of the committed Role
// gain (audible immediately), then that clearing it returns the committed gain.
// A constant-1.0 source makes the output RMS equal the folded linear gain, so
// each case is analytic. Covers the audition WIRING that the headless override
// and fold goldens cannot reach — the real Web Audio path preview playback runs.
// Role Mixer behavior and gain semantics are documented in docs/audio.md.
test.describe('Role Gain audition (Electron preview audio)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    ;({ app, page } = await launchApp())
    // The hook surface mounts async (main.tsx dynamic-imports e2eHook after
    // React mounts); evaluating before it lands races → undefined __weftcutTest.
    await waitForHook(page, 'roleGainAuditionProbe')
  })
  test.afterAll(async () => { await app?.close() })

  const dbToLinear = (db: number): number => 10 ** (db / 20)
  const FRAMES = 48_000
  const COMMITTED_DB = 6.0206 // ≈ 2.0×
  const OVERRIDE_DB = -6.0206 // ≈ 0.5×

  const probe = (overrideDb: number | null) =>
    page.evaluate(
      (a) => (window as any).__weftcutTest.roleGainAuditionProbe(a),
      { role: 'dialogue', committedDb: COMMITTED_DB, overrideDb, frames: FRAMES },
    ) as Promise<{ rms: number; folded: number }>

  test('an active override folds its gain in place of the committed Role gain', async () => {
    const audition = await probe(OVERRIDE_DB)
    console.log('[e2e] role audition override', JSON.stringify(audition))
    expect(audition.folded).toBeCloseTo(dbToLinear(OVERRIDE_DB), 2)
    expect(audition.rms).toBeCloseTo(dbToLinear(OVERRIDE_DB), 2)
  })

  test('clearing the override returns the committed Role gain', async () => {
    const committed = await probe(null)
    console.log('[e2e] role audition committed', JSON.stringify(committed))
    expect(committed.folded).toBeCloseTo(dbToLinear(COMMITTED_DB), 2)
    expect(committed.rms).toBeCloseTo(dbToLinear(COMMITTED_DB), 2)
  })

  test('audition changes the audible level relative to the committed gain', async () => {
    const audition = await probe(OVERRIDE_DB)
    const committed = await probe(null)
    // The override (−6 dB) must be audibly quieter than the committed +6 dB.
    expect(audition.rms).toBeLessThan(committed.rms)
    expect(committed.rms / audition.rms).toBeCloseTo(dbToLinear(COMMITTED_DB - OVERRIDE_DB), 1)
  })
})

// Drive the REAL Role Mixer Panel in the editor: open it from the View menu,
// confirm the master meter renders, then drag the Dialogue fader and prove the
// gesture records exactly one recorded Role gain (a single undo reverts it),
// while Escape mid-gesture records nothing — the one-commit + cancellation flow
// through the real actor.
//
// This block is also the only seam in the repo that SEES LAYOUT. jsdom reports
// zero for every rect and lays nothing out, so a fader of zero width passes
// every unit test in the tree; the Panel's width-driven layout switch, the card
// fader's track length and the console's fader travel have no meaning there.
// Every geometric assertion below is load-bearing for that reason, and reads a
// real `getBoundingClientRect()` rather than a class or a style.

// The Panel root, as the ResizeObserver behind the layout switch measures it.
//
// The `.weft-dock-panel` prefix is not optional: `data-panel-kind` also sits on
// each Panel's TAB renderer, which comes first in document order — a bare
// attribute selector silently measures a 28px tab strip.
const MIXER_ROOT = '.weft-dock-panel[data-panel-kind="role-mixer"] .mixer-panel'

type MixerLayout = 'cards' | 'console'

/// What the Panel's own layout switch reads: its root width, and the modifier
/// that width selected. `none` means neither modifier is on the root at all.
interface MixerGeometry {
  rootWidth: number
  layout: MixerLayout | 'none'
}

// The dock's right-hand column is a fixed share of the workspace, so the
// window's width IS the Panel's width — the one knob that moves the measured
// root width without a pointer gesture on a Dockview splitter (whose locators
// are the fragile ones). Height is pinned only so a resize changes one axis.
const WINDOW_HEIGHT_PX = 800
// The app's own declared minimum window width, which makes the right column the
// narrowest dock the Panel is legally shown at. Asserted against
// `getMinimumSize()` rather than trusted.
const NARROW_WINDOW_PX = 960
// A card-list width and two console widths. The right column is roughly a
// quarter of the window, so the console needs a window well over 1600px — and
// the two console widths are far enough apart to show that the fader's travel
// does not follow the dock.
const CARDS_WINDOW_PX = 1280
const CONSOLE_WINDOW_PX = 1700
const WIDEST_WINDOW_PX = 1900
// There is deliberately NO console-floor window width here. See
// `narrowestConsole()`: the floor is hysteretic, the hysteresis is a
// scrollbar's, and a scrollbar's width belongs to the platform.
//
// How far INSIDE that measured floor to stand. The dock column is a fraction of
// the window, so the narrowest console window is within about a quarter of a
// column pixel of the cliff, and anything that re-measures the Panel mid-test
// can tip it back into a card list — soloing a Role adds a badge to every
// strip, and that is exactly how `silencedStripFit()` came back empty on
// macos-latest. Sixteen window pixels is roughly four column pixels, which is
// squarely inside the floor test's own definition of the floor — it asserts
// `rootWidth < CONSOLE_LAYOUT_MIN_WIDTH + 8`, so eight is the tolerance this
// spec already declares. Two column pixels was measured as too few: it puts the
// root one pixel off the threshold, and one pixel is what the badge moves.
const FLOOR_MARGIN_WINDOW_PX = 16

// Mirrors `CONSOLE_LAYOUT_MIN_WIDTH` in `MixerPanel.tsx`. There it is
// arithmetic over the console's pinned column widths; here it meets a layout
// engine, which is the only place that arithmetic can be confirmed. A crossover
// measured anywhere else is a finding about the Panel, not about this number.
const CONSOLE_LAYOUT_MIN_WIDTH = 392
// The console's declared travel, and the legal-value count it has to address:
// 50 dB at a 0.5 dB step, so 104px of track is 1.04px per value.
const CONSOLE_TRAVEL_PX = 104
const GAIN_STEP_COUNT = 100
// A floor, not a measurement. The card fader's track is the Panel's width less
// its inset and the card's padding, so an exact number would pin the insets
// instead of the property: that the track has a real length at all. The fader
// this guards was 0px wide at every width the Panel is normally docked at, and
// the thumb's own fixed 12px box is what hid it.
const CARD_TRACK_FLOOR_PX = 150
// A floor on the Role name's own box on a card, for the same reason and against
// the same trap: a layout assertion protects exactly the box it measures, and a
// fader with a width says nothing about what is left on the line above it. The
// name measures ~102px at the narrowest legal dock, near double the longest
// translated Role name; furniture creeping back onto the identity line takes it
// to ~30px, where the name ellipsizes.
const ROLE_NAME_FLOOR_PX = 95

test.describe('Role Mixer panel flow (Electron UI)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  let workspace: string

  test.beforeAll(async () => {
    // This block reopens the normally-closed Role Mixer Panel, which the app
    // autosaves — the bare launchApp()'s per-launch throwaway userData keeps
    // that layout mutation from leaking into the dock-workspace baseline specs
    // that assert the default six-Panel set.
    ;({ app, page } = await launchApp())
    // The dock layout is built for whatever viewport is current, so pin the
    // window before the project opens: the default size tracks the runner's
    // display, and the Panel's layout is a function of its width.
    await setWindowWidth(CARDS_WINDOW_PX)
    workspace = tmpDir('weftcut-mixer-')
    await newProject(page, {
      parentFolder: workspace,
      name: 'role-mixer',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    // Role Mixer is closed in the built-in Editing workspace — reopen it from
    // the View menu (index 2, matching dock-workspace.spec.ts).
    await page.locator('.menu-trigger').nth(2).click()
    await page.locator('.app-menu-item').filter({ hasText: /^Role Mixer$/ }).click()
    await expect(dockPanel(page, 'role-mixer')).toHaveCount(1)
  })
  test.afterAll(async () => {
    await app?.close()
  })

  const panel = () => dockPanel(page, 'role-mixer')
  const dialogueGain = async (): Promise<number> => {
    const s = await rootSummary<{ audio_roles?: Array<{ role: string; gain_db: number }> }>(page)
    return s.audio_roles?.find((r) => r.role === 'dialogue')?.gain_db ?? 0
  }
  // Pointer-drag the Dialogue fader thumb by (dx, dy) px and release. Which
  // delta moves the value is the layout's business, not this helper's: the
  // card's fader is horizontal and the console's vertical.
  const dragDialogueFader = async (dx: number, dy = 0): Promise<void> => {
    const thumb = panel().getByLabel('Dialogue gain fader')
    const box = await thumb.boundingBox()
    if (!box) throw new Error('Dialogue fader has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy + dy, { steps: 8 })
    await page.mouse.up()
  }

  // Return Dialogue to unity through the Panel's own reset, so a test that
  // needs a known thumb position does not inherit the previous drag's value.
  const resetDialogueGain = async (): Promise<void> => {
    if ((await dialogueGain()) === 0) return
    await panel().getByLabel('Reset Dialogue gain to 0 dB').click()
    await expect.poll(dialogueGain).toBe(0)
  }

  // Resize the window and hand back the content width the renderer will see, so
  // the caller can wait for the viewport rather than guess at a settle time.
  async function setWindowWidth(width: number): Promise<number> {
    if (!app) throw new Error('the Electron app is not launched')
    return app.evaluate(async ({ BrowserWindow }, bounds) => {
      const win = BrowserWindow.getAllWindows()[0]!
      if (win.isMaximized()) win.unmaximize()
      win.setBounds({ x: 0, y: 0, ...bounds })
      // Read back rather than echo: Windows clamps a request below the window's
      // own minimum, and the caller has to wait for what it will actually get.
      return win.getContentBounds().width
    }, { width, height: WINDOW_HEIGHT_PX })
  }

  const mixerGeometry = (): Promise<MixerGeometry> =>
    page.evaluate((selector) => {
      const root = document.querySelector(selector)
      if (!(root instanceof HTMLElement)) throw new Error('the Role Mixer Panel is not mounted')
      return {
        // Rounded the way the Panel rounds its own ResizeObserver read, so this
        // is the number its layout threshold is compared against.
        rootWidth: Math.round(root.getBoundingClientRect().width),
        layout: root.classList.contains('mixer-panel--console')
          ? ('console' as const)
          : root.classList.contains('mixer-panel--cards')
            ? ('cards' as const)
            : ('none' as const),
      }
    }, MIXER_ROOT)

  // The card fader's TRACK, never its thumb: the thumb is a fixed 12px box and
  // reports a real width over a track of zero, which is the exact shape of the
  // bug the narrow-dock guard exists for.
  const cardFaderTrackWidth = (): Promise<number> =>
    page.evaluate((selector) => {
      const track = document.querySelector(`${selector} .mixer-fader .app-slider-track`)
      if (!(track instanceof HTMLElement)) throw new Error('the card fader has no track')
      return track.getBoundingClientRect().width
    }, MIXER_ROOT)

  // Every Role card's name box, in list order, with the two numbers that say
  // whether its text fits: an ellipsized name reports a scroll width past its
  // client width. Read for all four cards because only the longest translated
  // name runs out of room, and which one that is moves with the locale.
  const roleNameFit = (): Promise<
    Array<{ role: string; clientWidth: number; scrollWidth: number }>
  > =>
    page.evaluate(
      (selector) =>
        Array.from(document.querySelectorAll(`${selector} .mixer-card`)).map((card) => {
          const name = card.querySelector('.mixer-role-name')
          if (!(name instanceof HTMLElement)) throw new Error('a Role card carries no name')
          return {
            role: name.textContent ?? '',
            clientWidth: name.clientWidth,
            scrollWidth: name.scrollWidth,
          }
        }),
      MIXER_ROOT,
    )

  // Every card silenced by another Role's solo, with what it takes to say the
  // badge stayed inside it: the scroll/client pair on the card and on its
  // controls line, and the reset gutter's own right edge against the card's —
  // an overflowing badge pushes the gutter out, which is a rect relation and
  // not a scroll width.
  const silencedCardFit = (): Promise<
    Array<{
      role: string
      badge: string
      badgeWidth: number
      cardClient: number
      cardScroll: number
      controlsClient: number
      controlsScroll: number
      cardRight: number
      resetRight: number
    }>
  > =>
    page.evaluate(
      (selector) =>
        Array.from(
          document.querySelectorAll(`${selector} .mixer-card[data-silenced="true"]`),
        ).map((card) => {
          const find = (suffix: string): HTMLElement => {
            const el = card.querySelector(suffix)
            if (!(el instanceof HTMLElement)) throw new Error(`a silenced card has no ${suffix}`)
            return el
          }
          const controls = find('.mixer-card-controls')
          const badge = find('.mixer-implied-badge')
          return {
            role: find('.mixer-role-name').textContent ?? '',
            badge: badge.textContent ?? '',
            badgeWidth: badge.getBoundingClientRect().width,
            cardClient: (card as HTMLElement).clientWidth,
            cardScroll: (card as HTMLElement).scrollWidth,
            controlsClient: controls.clientWidth,
            controlsScroll: controls.scrollWidth,
            cardRight: card.getBoundingClientRect().right,
            resetRight: find('.mixer-actions').getBoundingClientRect().right,
          }
        }),
      MIXER_ROOT,
    )

  // The same question on a console strip, where the badge has no truncation
  // rule of its own and the strip is a pinned width: does uppercase micro text
  // whose width moves with the translation still fit the slack?
  const silencedStripFit = (): Promise<
    Array<{
      role: string
      badge: string
      badgeWidth: number
      stripWidth: number
      stripClient: number
      stripScroll: number
      contentSlack: number
      overhangLeft: number
      overhangRight: number
    }>
  > =>
    page.evaluate(
      (selector) =>
        Array.from(
          document.querySelectorAll(`${selector} .mixer-strip[data-silenced="true"]`),
        ).map((strip) => {
          const find = (suffix: string): HTMLElement => {
            const el = strip.querySelector(suffix)
            if (!(el instanceof HTMLElement)) throw new Error(`a silenced strip has no ${suffix}`)
            return el
          }
          const badge = find('.mixer-implied-badge').getBoundingClientRect()
          const box = strip.getBoundingClientRect()
          const style = getComputedStyle(strip)
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
          return {
            role: find('.mixer-role-name').textContent ?? '',
            badge: find('.mixer-implied-badge').textContent ?? '',
            badgeWidth: badge.width,
            stripWidth: box.width,
            stripClient: (strip as HTMLElement).clientWidth,
            stripScroll: (strip as HTMLElement).scrollWidth,
            // What the slack `editor.css` leaves for this string is actually
            // worth, in fractional pixels. `scrollWidth` is integer-snapped, so
            // a sub-pixel overrun does not show up there at all.
            contentSlack: box.width - padding - badge.width,
            overhangLeft: box.left - badge.left,
            overhangRight: badge.right - box.right,
          }
        }),
      MIXER_ROOT,
    )

  // Computed opacity once its transition has run out. Read straight after a
  // hover, this returns the animation's start value.
  const settledOpacity = async (suffix: string): Promise<string> => {
    const read = (): Promise<string> =>
      page.evaluate((target) => {
        const el = document.querySelector(`${target.root} ${target.suffix}`)
        if (!(el instanceof HTMLElement)) throw new Error(`no ${target.suffix} to read`)
        return getComputedStyle(el).opacity
      }, { root: MIXER_ROOT, suffix })
    let previous = ''
    let stable = 0
    await expect
      .poll(
        async () => {
          const opacity = await read()
          stable = opacity === previous ? stable + 1 : 0
          previous = opacity
          return stable
        },
        { intervals: new Array(40).fill(60) },
      )
      .toBeGreaterThanOrEqual(2)
    return read()
  }

  // Solo Dialogue for the duration of `body`, so the other three Roles render
  // the implied-mute badge, then put the flag back. Solo is unrecorded, so no
  // undo would clear it for whatever runs next.
  const withDialogueSoloed = async (body: () => Promise<void>): Promise<void> => {
    const solo = () => panel().getByLabel('Solo Dialogue (mutes the others)')
    await solo().click()
    try {
      await expect(panel().locator('.mixer-implied-badge')).toHaveCount(3)
      await body()
    } finally {
      await solo().click()
      await expect(panel().locator('.mixer-implied-badge')).toHaveCount(0)
    }
  }

  // The console's shared geometry, read off the first Role strip: its fader
  // travel, and the two boxes the dB scale's truthfulness rests on — the 0 dB
  // tick in the gutter and the thumb that should sit on it at 0 dB.
  const consoleGeometry = (): Promise<{
    travel: number
    unityTickCentreY: number
    thumbCentreY: number
  }> =>
    page.evaluate((selector) => {
      const find = (suffix: string): HTMLElement => {
        const el = document.querySelector(`${selector} ${suffix}`)
        if (!(el instanceof HTMLElement)) throw new Error(`the console is missing ${suffix}`)
        return el
      }
      const centreY = (el: HTMLElement): number => {
        const box = el.getBoundingClientRect()
        return box.y + box.height / 2
      }
      // First fader in document order is the first canonical Role's — the dB
      // gutter that precedes it carries no fader, and the master strip follows.
      return {
        travel: find('.mixer-console-fader .app-slider-track').getBoundingClientRect().height,
        unityTickCentreY: centreY(find('.mixer-db-tick[data-unity="true"]')),
        thumbCentreY: centreY(find('.mixer-console-fader .app-slider-thumb')),
      }
    }, MIXER_ROOT)

  // Resize, then wait for the Panel to have caught up. `setBounds` returns
  // before the renderer is resized, and the Panel's own ResizeObserver runs a
  // frame behind Dockview's relayout — so wait for the viewport to be the size
  // that was asked for, then for the measured root width to stop moving.
  const resizeAndSettle = async (windowWidth: number): Promise<MixerGeometry> => {
    const contentWidth = await setWindowWidth(windowWidth)
    await expect
      .poll(async () => {
        const viewport = await page.evaluate(() => window.innerWidth)
        return Math.abs(viewport - contentWidth)
      })
      .toBeLessThanOrEqual(1)
    let previous = -1
    let stable = 0
    await expect
      .poll(
        async () => {
          const { rootWidth } = await mixerGeometry()
          stable = rootWidth === previous ? stable + 1 : 0
          previous = rootWidth
          return stable
        },
        { intervals: new Array(100).fill(50), timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2)
    return mixerGeometry()
  }

  // Put the Panel in one layout at a known window width. Asserting the layout
  // here keeps a width that stops selecting the branch it used to from turning
  // into a puzzling failure three assertions later.
  const useLayout = async (
    layout: MixerLayout,
    windowWidth = layout === 'console' ? CONSOLE_WINDOW_PX : CARDS_WINDOW_PX,
  ): Promise<MixerGeometry> => {
    const geometry = await resizeAndSettle(windowWidth)
    expect(geometry.layout).toBe(layout)
    return geometry
  }

  // The narrowest window at which the Panel is STILL a console, measured by
  // narrowing rather than assumed. A fixed window width cannot do this job on
  // every box: the crossover is hysteretic, and the hysteresis is the
  // SCROLLBAR's. The card list scrolls and the console does not, so where the
  // scrollbar takes width from the content box (Windows, most Linux) the card
  // list measures ~10px under its dock column and the console holds ~10px below
  // the width that first produced it; with macOS overlay scrollbars that gap is
  // zero and both directions cross at the same width. Measured on one CI run of
  // the same commit: Windows crossed at a 1666px window (root 391 -> 402),
  // macOS at 1672px (root 391 -> 392). A window width tuned on the first lands
  // the second in a card list, which is how this arrived as a macOS-only
  // failure rather than as the platform fact it is.
  const narrowestConsole = async (): Promise<MixerGeometry> => {
    let current = await useLayout('console', CONSOLE_WINDOW_PX)
    // Every probe is REACHED BY NARROWING: one that follows a card list has to
    // climb back into the console first, or it reports the rising crossover —
    // the one width the caller's claim is explicitly not about.
    const probe = async (windowWidth: number): Promise<MixerGeometry> => {
      if (current.layout !== 'console') current = await useLayout('console', CONSOLE_WINDOW_PX)
      current = await resizeAndSettle(windowWidth)
      return current
    }
    let narrow = NARROW_WINDOW_PX
    let wide = CONSOLE_WINDOW_PX
    expect((await probe(narrow)).layout).toBe('cards')
    while (wide - narrow > 1) {
      const middle = Math.floor((narrow + wide) / 2)
      if ((await probe(middle)).layout === 'console') wide = middle
      else narrow = middle
    }
    // Left just INSIDE the floor, because the caller measures the strips while
    // standing there and a measurement balanced on the cliff does not survive
    // the re-render its own assertions cause (`FLOOR_MARGIN_WINDOW_PX`).
    return probe(wide + FLOOR_MARGIN_WINDOW_PX)
  }

  test('the master output meter stands once beside one level meter per Role', async () => {
    await useLayout('cards')
    await expect(panel().getByRole('group', { name: 'Master output meter' })).toHaveCount(1)
    // The four Role taps are readouts beside the one master reading, not four
    // more masters — the master meter is still the Panel's single output level.
    await expect(panel().getByRole('group', { name: /level meter$/ })).toHaveCount(4)
  })

  test('a fader drag records exactly one Role gain command (one undo reverts it)', async () => {
    await useLayout('cards')
    const before = await dialogueGain()
    await dragDialogueFader(48)
    const after = await dialogueGain()
    expect(after).not.toBe(before)

    // Exactly one recorded command ⇒ a single undo lands back on the original.
    await invokeCmd(page, 'project_undo')
    expect(await dialogueGain()).toBe(before)
  })

  test('Escape mid-drag restores the value and records nothing', async () => {
    await useLayout('cards')
    const before = await dialogueGain()
    const thumb = panel().getByLabel('Dialogue gain fader')
    const box = await thumb.boundingBox()
    if (!box) throw new Error('Dialogue fader has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 48, cy, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    // No recorded command: the committed gain is unchanged by the cancelled
    // gesture (the audition override reverted the sound too).
    expect(await dialogueGain()).toBe(before)
  })

  test('the gain fader has real width and still drags at the narrowest legal dock', async () => {
    const minimumSize = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getMinimumSize(),
    )
    // Pinning this is what makes the case below the NARROWEST legal dock rather
    // than merely a narrow one.
    expect(minimumSize?.[0]).toBe(NARROW_WINDOW_PX)

    const geometry = await useLayout('cards', NARROW_WINDOW_PX)
    const trackWidth = await cardFaderTrackWidth()
    console.log(
      '[e2e] mixer narrow dock',
      JSON.stringify({ rootWidth: geometry.rootWidth, trackWidth }),
    )
    expect(trackWidth).toBeGreaterThan(CARD_TRACK_FLOOR_PX)

    // A track with a width is not yet a fader: prove the pointer still reaches
    // it and that the gesture commits, at the width where it used to be 0px.
    await resetDialogueGain()
    await dragDialogueFader(32)
    await expect.poll(dialogueGain).toBeGreaterThan(0)
    await invokeCmd(page, 'project_undo')
    await expect.poll(dialogueGain).toBe(0)
  })

  test('widening the Panel produces the console and narrowing returns the card list', async () => {
    // Both directions: the modifier is the layout contract, and a Panel that
    // only ever grew would leave the return trip unchecked.
    expect((await resizeAndSettle(CARDS_WINDOW_PX)).layout).toBe('cards')
    expect((await resizeAndSettle(CONSOLE_WINDOW_PX)).layout).toBe('console')
    expect((await resizeAndSettle(CARDS_WINDOW_PX)).layout).toBe('cards')
  })

  test('the console takes over at the root width the layout threshold declares', async () => {
    // Approach every probe from the card list. The two layouts do NOT measure
    // the same root width at the same dock column: the card list is tall enough
    // to scroll and the console is not, so the scroller's own width sits
    // between them — and a console already on screen therefore holds on well
    // below the width at which it first appeared. Parking at the card list
    // first is what makes this the cards → console crossover and nothing else.
    const probeFromCards = async (windowWidth: number): Promise<MixerGeometry> => {
      await useLayout('cards')
      return resizeAndSettle(windowWidth)
    }

    // Bracket the switch by window width, then read the Panel's own measured
    // root width on either side of it. The threshold is arithmetic over the
    // console's pinned column widths, and this is the only place a real layout
    // engine gets a say in whether that arithmetic holds.
    let narrow = NARROW_WINDOW_PX
    let wide = WIDEST_WINDOW_PX
    let asCards = await probeFromCards(narrow)
    let asConsole = await probeFromCards(wide)
    expect(asCards.layout).toBe('cards')
    expect(asConsole.layout).toBe('console')
    while (wide - narrow > 1) {
      const middle = Math.floor((narrow + wide) / 2)
      const geometry = await probeFromCards(middle)
      if (geometry.layout === 'console') {
        wide = middle
        asConsole = geometry
      } else {
        narrow = middle
        asCards = geometry
      }
    }
    console.log(
      '[e2e] mixer console crossover',
      JSON.stringify({
        cards: { windowWidth: narrow, rootWidth: asCards.rootWidth },
        console: { windowWidth: wide, rootWidth: asConsole.rootWidth },
      }),
    )
    // The widest card list stands just under the threshold, and one window
    // pixel more is a console. The tolerance absorbs the dock's own rounding —
    // its column width is a proportion, so consecutive window widths do not
    // step the root width by a clean pixel — and nothing more: a console whose
    // real floor were elsewhere would leave the last card list far from this
    // number, which is the finding the whole assertion exists to surface.
    expect(asCards.rootWidth).toBeLessThan(CONSOLE_LAYOUT_MIN_WIDTH)
    expect(asCards.rootWidth).toBeGreaterThanOrEqual(CONSOLE_LAYOUT_MIN_WIDTH - 2)
    expect(asConsole.rootWidth).toBeGreaterThanOrEqual(CONSOLE_LAYOUT_MIN_WIDTH)
  })

  test('the console draws one dB scale whose unity tick lands on the fader at 0 dB', async () => {
    await useLayout('console')
    // Drawn once in a gutter the four faders share — four copies of one legend
    // would be the loudest thing on the Panel.
    await expect(panel().getByRole('img', { name: 'dB scale' })).toHaveCount(1)
    await expect(panel().locator('.mixer-db-tick')).toHaveCount(6)
    await expect(panel().locator('.mixer-db-tick[data-unity="true"]')).toHaveCount(1)

    await resetDialogueGain()
    const { unityTickCentreY, thumbCentreY } = await consoleGeometry()
    console.log(
      '[e2e] mixer console unity alignment',
      JSON.stringify({ unityTickCentreY, thumbCentreY }),
    )
    // The tick and the thumb are placed from the same fraction against boxes
    // the console's shared row template is supposed to keep identical, so at
    // 0 dB they land on one line. A scale reading a systematic offset is worse
    // than no scale, and nothing but a layout engine can tell the difference.
    expect(Math.abs(thumbCentreY - unityTickCentreY)).toBeLessThanOrEqual(1)
  })

  test('console fader travel is a fixed length that gives every legal gain value a pixel', async () => {
    const narrower = await useLayout('console', CONSOLE_WINDOW_PX)
    const narrowerTravel = (await consoleGeometry()).travel
    const wider = await useLayout('console', WIDEST_WINDOW_PX)
    const widerTravel = (await consoleGeometry()).travel
    console.log(
      '[e2e] mixer console travel',
      JSON.stringify({
        narrower: { rootWidth: narrower.rootWidth, travel: narrowerTravel },
        wider: { rootWidth: wider.rootWidth, travel: widerTravel },
      }),
    )
    expect(narrowerTravel).toBeCloseTo(CONSOLE_TRAVEL_PX, 0)
    // Width-independent precision is the whole reason the wide layout is
    // vertical: a horizontal fader's travel is a function of the dock width,
    // and at this Panel's own threshold that was under one pixel per value.
    expect(widerTravel).toBe(narrowerTravel)
    expect(narrowerTravel / GAIN_STEP_COUNT).toBeGreaterThanOrEqual(1)
  })

  test('a console fader drag upward raises the gain and downward lowers it', async () => {
    await useLayout('console')
    await resetDialogueGain()

    // The classic vertical-slider bug is an inverted axis, and it is invisible
    // to anything that cannot lay the fader out: up must raise.
    await dragDialogueFader(0, -32)
    await expect.poll(dialogueGain).toBeGreaterThan(0)
    const raised = await dialogueGain()

    await dragDialogueFader(0, 32)
    await expect.poll(dialogueGain).toBeLessThan(raised)
  })

  test('no Role name is truncated on a card at the narrowest legal dock', async () => {
    const geometry = await useLayout('cards', NARROW_WINDOW_PX)
    const trackWidth = await cardFaderTrackWidth()
    const names = await roleNameFit()
    console.log(
      '[e2e] mixer card name fit',
      JSON.stringify({ rootWidth: geometry.rootWidth, trackWidth, names }),
    )
    expect(names).toHaveLength(4)
    for (const name of names) {
      // The fader having a width says nothing about the line above it: a
      // layout assertion protects exactly the box it measures, and the
      // identity line's fixed boxes are what the name is left over from.
      expect(name.scrollWidth, `${name.role} is ellipsized`).toBe(name.clientWidth)
      expect(name.clientWidth, `${name.role} has no room`).toBeGreaterThanOrEqual(
        ROLE_NAME_FLOOR_PX,
      )
    }
  })

  test('a card silenced by another Role solo keeps its badge and controls inside the card', async () => {
    await useLayout('cards', NARROW_WINDOW_PX)
    await withDialogueSoloed(async () => {
      const silenced = await silencedCardFit()
      console.log('[e2e] mixer silenced card fit', JSON.stringify(silenced))
      expect(silenced).toHaveLength(3)
      for (const card of silenced) {
        expect(card.cardScroll, `${card.role} card overflows`).toBe(card.cardClient)
        expect(card.controlsScroll, `${card.role} controls line overflows`).toBe(
          card.controlsClient,
        )
        // The badge appears exactly in the state it exists to explain, so a
        // badge that pushes the reset gutter past the card's edge breaks the
        // card only when a user is reading it.
        expect(
          card.resetRight,
          `${card.role} reset gutter sits outside the card`,
        ).toBeLessThanOrEqual(card.cardRight + 0.5)
      }
    })
  })

  test('a console strip holds the implied-mute badge at the console floor', async () => {
    // Coming UP to this width the Panel is still a card list — the two layouts
    // measure about a scrollbar apart at one dock column, because the card list
    // scrolls and the console does not — so the narrowest console anyone can be
    // looking at is reached by narrowing a wider one.
    //
    // A bisection over window widths, not one width: how far the console holds
    // past its own threshold is the scrollbar's width, so the window that puts
    // a strip at the floor differs per platform (`narrowestConsole()`).
    test.setTimeout(120_000)
    const floor = await narrowestConsole()
    expect(floor.layout).toBe('console')
    expect(floor.rootWidth).toBeLessThan(CONSOLE_LAYOUT_MIN_WIDTH + 8)
    await withDialogueSoloed(async () => {
      // Re-read the layout with the badges up. Soloing re-renders every strip,
      // and a Panel that fell back to cards under that re-render answers
      // `silencedStripFit()` with an empty list — a count nobody can read as
      // "the console is gone".
      expect((await mixerGeometry()).layout, 'the badges pushed the Panel out of the console').toBe(
        'console',
      )
      const strips = await silencedStripFit()
      console.log(
        '[e2e] mixer console strip fit',
        JSON.stringify({ rootWidth: floor.rootWidth, strips }),
      )
      expect(strips).toHaveLength(3)
      for (const strip of strips) {
        // The badge is the one thing either layout adds whose width a
        // translation moves, and a strip is a pinned width — so this is the
        // column arithmetic's only genuinely marginal claim.
        expect(strip.stripScroll, `${strip.role} strip overflows`).toBe(strip.stripClient)
        expect(strip.overhangRight, `${strip.role} badge runs past the strip`).toBeLessThanOrEqual(
          0.5,
        )
        expect(strip.overhangLeft, `${strip.role} badge runs past the strip`).toBeLessThanOrEqual(
          0.5,
        )
      }
    })
  })

  test('mute and solo stand at rest while the reset gutter waits for a pointer', async () => {
    await useLayout('cards')
    // At rest means no pointer on the card and nothing in it focused — the
    // gutter answers to both.
    await page.mouse.move(0, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await settledOpacity('.mixer-actions')).toBe('0')
    // State, not actions: these never hide, so the column of Roles reads as
    // four mixes rather than four rows of buttons.
    await expect(panel().getByLabel('Mute Dialogue everywhere')).toBeVisible()
    await expect(panel().getByLabel('Solo Dialogue (mutes the others)')).toBeVisible()

    await panel().locator('.mixer-card').first().hover()
    expect(await settledOpacity('.mixer-actions')).toBe('1')
  })
})
