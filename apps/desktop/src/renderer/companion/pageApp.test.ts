// @vitest-environment jsdom
// The companion page's UI (`cli/companion/ui/app.js`) over a fake transport:
// what it draws from the state, and what it makes of the app's answers.
import { describe, expect, it } from 'vitest'

import { companionPageModule as pageModule } from '../../shared/testing/companionPage'
const { mountCompanion } = await pageModule('app')
const { STRINGS } = await pageModule('strings')

type Handlers = { state(s: unknown): void; event(name: string, data: unknown): void; link(status: string): void }

type PictureView = { mount: HTMLElement; shown(): void }

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

const state = (over: Record<string, unknown> = {}) => ({
  project: { name: 'Example cut' },
  composition: { duration_us: 10_000_000, width: 640, height: 360, fps: { num: 30, den: 1 } },
  tracks: [{ track_id: 't1', clips: [{ layer_id: 'L1', kind: 'Color', label: 'Red block', t_start_us: 0, t_end_us: 5_000_000 }] }],
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
  return { root, page, stage, button, ...fake }
}

describe('the companion page', () => {
  it('draws each layer of the state on the timeline, by its id', () => {
    const { root, h } = mount()
    h.link('online')
    h.state(state())
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
    expect(root.querySelector('.cw-notice')?.textContent).toBe(STRINGS.zh.state_no_project)
    h.link('offline')
    expect(root.dataset.state).toBe('offline')
    expect(root.querySelector('.cw-notice')?.textContent).toBe(STRINGS.zh.state_offline)
  })

  it('says the project is opening when the app refuses a control for want of an editor, until the state says otherwise', async () => {
    const { root, h } = mount('not_ready')
    h.link('online')
    h.state(state())
    root.querySelector<HTMLButtonElement>('.cw-play')!.click()
    await expect.poll(() => root.dataset.state).toBe('opening')
    h.state(state())
    expect(root.dataset.state).toBe('ready')
  })

  it('plays or pauses by what the transport last said', async () => {
    const { root, h, sent } = mount()
    h.link('online')
    h.state(state())
    root.querySelector<HTMLButtonElement>('.cw-play')!.click()
    h.event('transport', { t_us: 1_000_000, playing: true })
    root.querySelector<HTMLButtonElement>('.cw-play')!.click()
    await expect.poll(() => sent).toEqual([{ action: 'play' }, { action: 'pause' }])
  })

  it('offers no control while nothing can be driven', () => {
    const { root, h } = mount()
    h.link('online')
    h.state(state({ editor: 'opening' }))
    expect(root.querySelector<HTMLButtonElement>('.cw-play')!.disabled).toBe(true)
  })

  it('shows export progress only while an export runs', () => {
    const { root, h } = mount()
    h.link('online')
    h.state(state())
    const box = root.querySelector<HTMLElement>('.cw-export')!
    expect(box.hidden).toBe(true)
    h.event('export', { job_id: 'j', state: 'rendering', progress: 0.42, filename: 'cut.mp4' })
    expect(box.hidden).toBe(false)
    expect(box.textContent).toContain('42%')
    h.event('export', { job_id: 'j', state: 'completed', progress: 1, filename: 'cut.mp4' })
    expect(box.hidden).toBe(true)
  })
})

describe('the picture', () => {
  it('is not asked for until the user turns it on, and is live from its first frame', () => {
    const { h, stage, button, pictures } = mount()
    h.link('online')
    h.state(state())
    expect(stage().dataset.picture).toBe('off')
    expect(stage().textContent).toContain(STRINGS.en.picture_off)
    expect(pictures).toEqual([])
    button('.cw-show-picture').click()
    expect(pictures).toHaveLength(1)
    expect(stage().dataset.picture).toBe('starting')
    pictures[0]!.view.shown()
    expect(stage().dataset.picture).toBe('live')
  })

  it('says an export holds it, and starts over when the export ends', () => {
    const { h, stage, button, pictures } = mount()
    h.link('online')
    h.state(state())
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
    const { h, stage, button, pictures, sent } = mount()
    h.link('online')
    h.state(state())
    button('.cw-show-picture').click()
    pictures[0]!.view.shown()
    h.event('window', 'minimized')
    expect(stage().dataset.picture).toBe('minimized')
    button('.cw-stage-focus').click()
    expect(sent).toEqual([{ action: 'focus' }])
    h.event('window', 'normal')
    expect(stage().dataset.picture).toBe('live')
  })

  it('closes when the user hides it', () => {
    const { h, stage, button, pictures } = mount()
    h.link('online')
    h.state(state())
    button('.cw-show-picture').click()
    button('.cw-hide-picture').click()
    expect(pictures[0]!.closed).toBe(true)
    expect(stage().dataset.picture).toBe('off')
  })

  it('says so where the browser cannot show it', () => {
    const { h, stage, button } = mount(undefined, false)
    h.link('online')
    h.state(state())
    button('.cw-show-picture').click()
    expect(stage().dataset.picture).toBe('unsupported')
  })

  it('has no stage while the page is not ready', () => {
    const { h, stage } = mount()
    h.link('offline')
    expect(stage().hidden).toBe(true)
  })
})
