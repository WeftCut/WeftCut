// @vitest-environment jsdom
// The companion page's UI (`cli/companion/ui/app.js`) over a fake transport:
// what it draws from the state, and what it makes of the app's answers.
import { describe, expect, it } from 'vitest'

import { formatTimecode } from '../frames'
import { companionPageModule as pageModule } from '../../shared/testing/companionPage'
const { mountCompanion } = await pageModule('app')
const { STRINGS } = await pageModule('strings')
const { timecode, frameStartUs } = await pageModule('timeline')

type Handlers = { state(s: unknown): void; event(name: string, data: unknown): void; link(status: string): void }

type PictureView = { mount: HTMLElement; shown(): void; failed(): void }

function fakeTransport(answer = 'ok', pictureSupported = true) {
  let handlers!: Handlers
  const sent: unknown[] = []
  /** Every picture the page opened, and whether it closed it. */
  const pictures: Array<{ view: PictureView; closed: boolean }> = []
  return {
    sent,
    pictures,
    get h() { return handlers },
    transport: {
      start(h: Handlers) { handlers = h; return () => {} },
      control: async (action: unknown) => { sent.push(action); return answer },
      openPicture(view: PictureView) {
        if (!pictureSupported) return null
        const picture = { view, closed: false }
        pictures.push(picture)
        return { close() { picture.closed = true } }
      },
    },
  }
}

const FPS = { num: 30, den: 1 }

const state = (over: Record<string, unknown> = {}) => ({
  project: { name: 'Example cut' },
  composition: { duration_us: 10_000_000, width: 640, height: 360, fps: FPS },
  tracks: [{ track_id: 't1', clips: [
    { layer_id: 'L1', kind: 'Color', label: 'Red block', t_start_us: 0, t_end_us: 5_000_000 },
    { layer_id: 'L2', kind: 'Text', label: 'Title', t_start_us: 6_000_000, t_end_us: 8_000_000 },
  ] }],
  transport: { t_us: 0, playing: false },
  export: null,
  activity: null,
  editor: 'ready',
  language: 'en-US',
  window: 'normal',
  ...over,
})

function mount(answer?: string, pictureSupported?: boolean) {
  const root = document.createElement('main')
  document.body.replaceChildren(root)
  const fake = fakeTransport(answer, pictureSupported)
  const page = mountCompanion(root, fake.transport, { now: () => 0, frame: () => {} })
  const stage = () => root.querySelector<HTMLElement>('.cw-stage')!
  const button = (name: string) => root.querySelector<HTMLButtonElement>(name)!
  const seeks = () => fake.sent.filter((a) => (a as { action: string }).action === 'seek')
  return { root, page, stage, button, seeks, ...fake }
}

function ready(answer?: string, over: Record<string, unknown> = {}) {
  const m = mount(answer)
  m.h.link('online')
  m.h.state(state(over))
  return m
}

const key = (k: string, init: KeyboardEventInit = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))

/** Gives one input and waits until its request reaches the transport. Seeks
 *  made while one is in flight collapse to the latest, which is what a drag
 *  wants; these tests look at each step, so each goes out before the next. */
async function sendOne(sent: unknown[], input: () => void) {
  const before = sent.length
  input()
  await expect.poll(() => sent.length).toBe(before + 1)
}

describe('the companion page', () => {
  it('draws each layer of the state on the timeline, by its id', () => {
    const { root } = ready()
    expect(root.dataset.state).toBe('ready')
    const clip = root.querySelector<HTMLElement>('.cw-clip[data-layer-id="L1"]')
    expect(clip?.textContent).toBe('Red block')
    expect(clip?.style.width).toBe('50%')
  })

  it('names the state it is in, in the app language', () => {
    const { root, h } = mount()
    h.link('online')
    h.state(state({ project: null, composition: null, tracks: [], language: 'zh-CN' }))
    expect(root.dataset.state).toBe('no_project')
    expect(root.querySelector('.cw-empty-title')?.textContent).toBe(STRINGS.zh.no_project_title)
    h.link('offline')
    expect(root.dataset.state).toBe('offline')
    expect(root.querySelector('.cw-empty-title')?.textContent).toBe(STRINGS.zh.offline_title)
  })

  it('shows no player while nothing can be played', () => {
    const { root, h } = mount()
    const body = root.querySelector<HTMLElement>('.cw-body')!
    h.link('online')
    h.state(state({ transport: { t_us: 4_000_000, playing: false } }))
    expect(body.hidden).toBe(false)
    h.state(state({ project: null, composition: null, tracks: [], transport: { t_us: 4_000_000, playing: false } }))
    expect(body.hidden).toBe(true)
    h.link('offline')
    expect(body.hidden).toBe(true)
    h.link('revoked')
    expect(body.hidden).toBe(true)
  })

  it('says the project is opening when the app refuses a control for want of an editor, until the state says otherwise', async () => {
    const { root, h, button } = ready('not_ready')
    button('.cw-play').click()
    await expect.poll(() => root.dataset.state).toBe('opening')
    h.state(state())
    expect(root.dataset.state).toBe('ready')
  })

  it('plays or pauses by what the transport last said', async () => {
    const { h, sent, button } = ready()
    button('.cw-play').click()
    h.event('transport', { t_us: 1_000_000, playing: true })
    button('.cw-play').click()
    await expect.poll(() => sent).toEqual([{ action: 'play' }, { action: 'pause' }])
  })

  it('offers no control while nothing can be driven', () => {
    const { button } = ready(undefined, { editor: 'opening' })
    for (const b of ['.cw-play', '.cw-prev', '.cw-next', '.cw-to-start', '.cw-to-end']) expect(button(b).disabled, b).toBe(true)
  })

  it('shows the time as the editor shows it', () => {
    const { root, h } = ready()
    h.event('transport', { t_us: 2_500_000, playing: false })
    expect(root.querySelector('.cw-time-now')?.textContent).toBe(formatTimecode(2_500_000, FPS.num, FPS.den))
    expect(root.querySelector('.cw-time-end')?.textContent).toBe(formatTimecode(10_000_000, FPS.num, FPS.den))
  })

  it('shows export progress while it runs, and the outcome once it ends', () => {
    const { root, h } = ready()
    const box = root.querySelector<HTMLElement>('.cw-export')!
    expect(box.hidden).toBe(true)
    h.event('export', { job_id: 'j', state: 'rendering', progress: 0.42, filename: 'cut.mp4' })
    expect(box.hidden).toBe(false)
    expect(box.textContent).toContain('42%')
    h.event('export', { job_id: 'j', state: 'completed', progress: 1, filename: 'cut.mp4' })
    expect(box.textContent).toContain(STRINGS.en.export_done)
    h.event('export', { job_id: 'k', state: 'cancelled', progress: 0.3, filename: 'cut.mp4' })
    expect(box.hidden).toBe(true)
  })

  it('lists the agent calls it saw, newest first, a finished call in place of its running row', () => {
    const { root, h } = ready(undefined, { activity: { client: 'Agent', tool: 'read_project', state: 'done' } })
    h.event('activity', { client: 'Agent', tool: 'split_layer', state: 'running' })
    h.event('activity', { client: 'Agent', tool: 'split_layer', state: 'done' })
    const rows = [...root.querySelectorAll<HTMLElement>('.cw-call')]
    expect(rows.map((r) => [r.dataset.state, r.querySelector('.cw-call-text')?.textContent])).toEqual([
      ['done', 'split layer'],
      ['done', 'read project'],
    ])
  })
})

describe('seeking', () => {
  it('steps one frame either way from the frame on screen', async () => {
    const { h, button, seeks, sent } = ready()
    h.event('transport', { t_us: frameStartUs(10, FPS), playing: false })
    for (const b of ['.cw-next', '.cw-prev', '.cw-prev']) await sendOne(sent, () => button(b).click())
    expect(seeks()).toEqual([
      { action: 'seek', t_us: frameStartUs(11, FPS) },
      { action: 'seek', t_us: frameStartUs(10, FPS) },
      { action: 'seek', t_us: frameStartUs(9, FPS) },
    ])
  })

  it('goes to either end, and never past one', async () => {
    const { button, seeks, sent } = ready()
    for (const b of ['.cw-to-end', '.cw-next', '.cw-to-start', '.cw-prev']) await sendOne(sent, () => button(b).click())
    expect(seeks()).toEqual([
      { action: 'seek', t_us: 10_000_000 },
      { action: 'seek', t_us: 10_000_000 },
      { action: 'seek', t_us: 0 },
      { action: 'seek', t_us: 0 },
    ])
  })

  it('answers the keys the editor uses for the player', async () => {
    const { sent: actions } = ready()
    key(' ')
    await expect.poll(() => actions).toEqual([{ action: 'play' }])
    const presses: Array<[string, KeyboardEventInit?]> = [['End'], ['ArrowLeft'], ['ArrowLeft', { shiftKey: true }], ['Home'], ['ArrowRight']]
    for (const [k, init] of presses) await sendOne(actions, () => key(k, init))
    expect(actions.slice(1)).toEqual([
      { action: 'seek', t_us: 10_000_000 },
      { action: 'seek', t_us: frameStartUs(299, FPS) },
      { action: 'seek', t_us: frameStartUs(299, FPS) - 1_000_000 },
      { action: 'seek', t_us: 0 },
      { action: 'seek', t_us: frameStartUs(1, FPS) },
    ])
  })

  it('leaves the keys alone once the page is gone', () => {
    const { page, sent: actions } = ready()
    page.stop()
    key(' ')
    expect(actions).toEqual([])
  })

  it('goes to a clip\'s start on a double click', async () => {
    const { root, seeks } = ready()
    root.querySelector('.cw-clip[data-layer-id="L2"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await expect.poll(seeks).toEqual([{ action: 'seek', t_us: 6_000_000 }])
  })
})

describe('the picture', () => {
  it('is not asked for until the user turns it on, and is live from its first frame', () => {
    const { stage, button, pictures } = ready()
    expect(stage().dataset.picture).toBe('off')
    expect(stage().textContent).toContain(STRINGS.en.picture_off_title)
    expect(pictures).toEqual([])
    button('.cw-show-picture').click()
    expect(pictures).toHaveLength(1)
    expect(stage().dataset.picture).toBe('starting')
    pictures[0]!.view.shown()
    expect(stage().dataset.picture).toBe('live')
  })

  it('says an export holds it, and starts over when the export ends', () => {
    const { h, stage, button, pictures } = ready()
    button('.cw-show-picture').click()
    pictures[0]!.view.shown()
    h.event('export', { job_id: 'j', state: 'rendering', progress: 0.1, filename: 'cut.mp4' })
    expect(stage().dataset.picture).toBe('export')
    h.event('export', { job_id: 'j', state: 'completed', progress: 1, filename: 'cut.mp4' })
    // The page kept its stream; no frame has come since the export.
    expect(pictures).toHaveLength(1)
    expect(stage().dataset.picture).toBe('starting')
  })

  it('says a minimized WeftCut updates it slowly, and offers to bring WeftCut forward', () => {
    const { h, stage, button, pictures, sent } = ready()
    button('.cw-show-picture').click()
    pictures[0]!.view.shown()
    h.event('window', 'minimized')
    expect(stage().dataset.picture).toBe('minimized')
    button('.cw-stage-focus').click()
    expect(sent).toEqual([{ action: 'focus' }])
    h.event('window', 'normal')
    expect(stage().dataset.picture).toBe('live')
  })

  it('offers to copy it only while a frame is on screen', () => {
    const { button, pictures } = ready()
    button('.cw-show-picture').click()
    expect(button('.cw-copy-picture').hidden).toBe(true)
    pictures[0]!.view.shown()
    expect(button('.cw-copy-picture').hidden).toBe(false)
  })

  it('closes when the user hides it', () => {
    const { stage, button, pictures } = ready()
    button('.cw-show-picture').click()
    button('.cw-hide-picture').click()
    expect(pictures[0]!.closed).toBe(true)
    expect(stage().dataset.picture).toBe('off')
  })

  it('says when the picture failed, lets go of it so the app stops encoding, and asks again only on Try again', async () => {
    const { stage, button, pictures } = ready()
    button('.cw-show-picture').click()
    pictures[0]!.view.shown()
    pictures[0]!.view.failed()
    expect(stage().dataset.picture).toBe('failed')
    expect(stage().textContent).toContain(STRINGS.en.picture_failed)
    // The page lets go once the decoder that reported it has returned.
    await Promise.resolve()
    expect(pictures[0]!.closed).toBe(true)
    // Coming back to the tab is not asking again.
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pictures).toHaveLength(1)
    expect(stage().dataset.picture).toBe('failed')
    button('.cw-stage-retry').click()
    expect(pictures).toHaveLength(2)
    expect(stage().dataset.picture).toBe('starting')
    pictures[1]!.view.shown()
    expect(stage().dataset.picture).toBe('live')
  })

  it('lets go of it while the tab is hidden, unless popped out, and asks again once shown', () => {
    const tab = { hidden: false, pip: null as Element | null }
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => tab.hidden })
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => tab.pip })
    const turn = (hidden: boolean) => { tab.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')) }
    try {
      const { button, pictures } = ready()
      // Hidden before the user asked: nothing to let go of, nothing asked for.
      turn(true)
      turn(false)
      expect(pictures).toEqual([])
      button('.cw-show-picture').click()
      turn(true)
      expect(pictures.map((p) => p.closed)).toEqual([true])
      turn(false)
      expect(pictures.map((p) => p.closed)).toEqual([true, false])

      tab.pip = document.createElement('video')
      turn(true)
      expect(pictures.map((p) => p.closed)).toEqual([true, false])
      turn(false)
      button('.cw-hide-picture').click()
      turn(true)
      turn(false)
      expect(pictures).toHaveLength(2)
    } finally {
      delete (document as { hidden?: boolean }).hidden
      delete (document as { pictureInPictureElement?: Element | null }).pictureInPictureElement
    }
  })

  it('says so where the browser cannot show it', () => {
    const { h, stage, button } = mount(undefined, false)
    h.link('online')
    h.state(state())
    button('.cw-show-picture').click()
    expect(stage().dataset.picture).toBe('unsupported')
  })
})

// LANDMINE twin: the page's timecode cannot load the editor's wasm frame grid,
// so it is held equal to `formatTimecode` here.
describe('the page timecode', () => {
  it('reads as the editor\'s at every rate it offers', () => {
    const rates: Array<[number, number]> = [[24_000, 1001], [24, 1], [25, 1], [30_000, 1001], [30, 1], [50, 1], [60_000, 1001], [60, 1]]
    const times = [0, 1, 16_666, 16_667, 33_333, 33_367, 999_999, 1_000_000, 59_999_999, 3_599_999_999, 3_600_000_000, 86_399_000_000]
    for (const [num, den] of rates) {
      for (const us of times) expect(timecode(us, { num, den }), `${us} @ ${num}/${den}`).toBe(formatTimecode(us, num, den))
    }
  })
})
