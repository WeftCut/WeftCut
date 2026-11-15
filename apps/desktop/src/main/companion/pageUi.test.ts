// The companion page's modules (`apps/desktop/cli/companion/ui/`), plain JS
// run here as the browser runs them. `app.js`'s DOM is covered in
// `renderer/companion/pageApp.test.ts`, which has the DOM types; the page in
// a real browser by e2e `companion-page.spec.ts`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { frame } from './pictureStream'
import { UI_FILES } from './pageFiles'
import {
  MIRROR_FRAME_CONFIG, MIRROR_FRAME_DELTA, MIRROR_FRAME_FAILED, MIRROR_FRAME_KEY, MIRROR_HEADER_BYTES,
} from '../../shared/companion'

import { companionPageModule as pageModule } from '../../shared/testing/companionPage'

const { pageState, pictureState, exportRunning, exportShown, recordCall, CALLS_KEPT } = await pageModule('viewState')
const chunks = await pageModule('pictureChunks')
const { STRINGS, stringsFor } = await pageModule('strings')
const { frameAt, frameStartUs, rulerLabel, timeAt, timecode, timelineRows } = await pageModule('timeline')
const { loopbackTransport, RETRY_FIRST_MS, RETRY_MAX_MS } = await pageModule('transportLoopback')

const KEY = 'a'.repeat(64)
const projectState = (over: Record<string, unknown> = {}) => ({ project: { name: 'Cut' }, editor: 'ready', ...over })

describe('pageState', () => {
  it('names the first state that holds, in order', () => {
    const offline = { link: 'offline', editorRefused: true, state: projectState({ project: null }) }
    expect(pageState({ ...offline, link: 'revoked' })).toBe('revoked')
    expect(pageState(offline)).toBe('offline')
    expect(pageState({ link: 'connecting', editorRefused: false, state: null })).toBe('connecting')
    // A refused control says the editor is opening even before the state does.
    expect(pageState({ link: 'online', editorRefused: true, state: projectState({ project: null }) })).toBe('opening')
    expect(pageState({ link: 'online', editorRefused: false, state: projectState({ editor: 'opening' }) })).toBe('opening')
    // No project: the editor is not mounted at all, which is not "opening".
    expect(pageState({ link: 'online', editorRefused: false, state: projectState({ project: null, editor: 'opening' }) })).toBe('no_project')
    expect(pageState({ link: 'online', editorRefused: false, state: projectState() })).toBe('ready')
  })

  it('shows progress for a running export only', () => {
    for (const state of ['queued', 'preparing', 'rendering', 'finalizing']) expect(exportRunning({ state }), state).toBe(true)
    for (const state of ['awaiting_retry', 'completed', 'failed', 'cancelled']) expect(exportRunning({ state }), state).toBe(false)
    expect(exportRunning(null)).toBe(false)
  })

  it('keeps showing an export once it completed or failed, not once cancelled or waiting on the user', () => {
    for (const state of ['rendering', 'completed', 'failed']) expect(exportShown({ state }), state).toBe(true)
    for (const state of ['awaiting_retry', 'cancelled']) expect(exportShown({ state }), state).toBe(false)
    expect(exportShown(null)).toBe(false)
  })
})

describe('pictureState', () => {
  const live = { exporting: false, wanted: true, supported: true, failed: false, minimized: false, shown: true }

  it('names the first state that holds, in order', () => {
    expect(pictureState({ ...live, exporting: true, wanted: false, supported: false, failed: true, minimized: true, shown: false })).toBe('export')
    expect(pictureState({ ...live, wanted: false, supported: false, failed: true, minimized: true })).toBe('off')
    expect(pictureState({ ...live, supported: false, failed: true, minimized: true })).toBe('unsupported')
    expect(pictureState({ ...live, failed: true, minimized: true, shown: false })).toBe('failed')
    expect(pictureState({ ...live, minimized: true, shown: false })).toBe('minimized')
    expect(pictureState({ ...live, shown: false })).toBe('starting')
    expect(pictureState(live)).toBe('live')
  })
})

describe('recordCall', () => {
  const call = (tool: string, state: string) => ({ client: 'Agent', tool, state })

  it('puts the newest call first, and keeps a bounded few', () => {
    let calls: unknown[] = []
    for (let i = 0; i < CALLS_KEPT + 2; i++) calls = recordCall(calls, call(`t${i}`, 'done'), i)
    expect(calls).toHaveLength(CALLS_KEPT)
    expect((calls[0] as { tool: string }).tool).toBe(`t${CALLS_KEPT + 1}`)
  })

  it('lets a call that ends replace its own running row', () => {
    let calls = recordCall([], call('split_layer', 'running'), 1)
    calls = recordCall(calls, call('split_layer', 'done'), 2)
    expect(calls).toEqual([{ ...call('split_layer', 'done'), at: 2 }])
    // A different call does not replace it.
    calls = recordCall(recordCall([], call('a', 'running'), 1), call('b', 'running'), 2)
    expect(calls.map((c: { tool: string }) => c.tool)).toEqual(['b', 'a'])
  })

  it('takes nothing from a state with no call', () => {
    const calls = recordCall([], call('a', 'done'), 1)
    expect(recordCall(calls, null, 2)).toBe(calls)
  })
})

describe('strings', () => {
  it('carry the same keys in every language', () => {
    expect(Object.keys(STRINGS.zh).sort()).toEqual(Object.keys(STRINGS.en).sort())
  })

  it('follow the app language, English for anything but Chinese', () => {
    expect(stringsFor('zh-CN')).toBe(STRINGS.zh)
    expect(stringsFor('en-US')).toBe(STRINGS.en)
    expect(stringsFor('fr-FR')).toBe(STRINGS.en)
    expect(stringsFor(undefined)).toBe(STRINGS.en)
  })
})

describe('timeline', () => {
  const clip = (layer_id: string, kind = 'Color') => ({ layer_id, kind, label: layer_id, t_start_us: 0, t_end_us: 1 })

  it('draws the last track on top and skips empty tracks', () => {
    const rows = timelineRows([
      { track_id: 'a', clips: [clip('a1', 'VideoClip')] },
      { track_id: 'b', clips: [clip('b1', 'Audio')] },
      { track_id: 'empty', clips: [] },
      { track_id: 'c', clips: [clip('c1', 'Text')] },
    ])
    expect(rows.map((r: { key: string; label: string }) => [r.key, r.label])).toEqual([['c', 'V4'], ['b', 'A2'], ['a', 'V1']])
  })

  it('maps a pointer to a whole microsecond inside the composition', () => {
    expect(timeAt(150, 100, 200, 10_000_001)).toBe(Math.round(10_000_001 / 4))
    expect(timeAt(50, 100, 200, 10_000_000)).toBe(0)
    expect(timeAt(400, 100, 200, 10_000_000)).toBe(10_000_000)
    expect(timeAt(150, 100, 0, 10_000_000)).toBe(0)
  })

  it('labels the ruler in minutes and seconds, minutes past 59 included', () => {
    expect(rulerLabel(59_999_999)).toBe('00:59')
    expect(rulerLabel(3_600_000_000)).toBe('60:00')
  })

  // The editor's own formatter is the reference: `pageApp.test.ts` holds the
  // two equal across rates. These pin the shape.
  it('reads a timecode as the editor does, non-drop-frame', () => {
    expect(timecode(0, { num: 30, den: 1 })).toBe('00:00:00:00')
    expect(timecode(3_600_000_000, { num: 30, den: 1 })).toBe('01:00:00:00')
    expect(timecode(30 * 33_367, { num: 30_000, den: 1001 })).toBe('00:00:01:00')
  })

  it('steps a frame from where a frame starts to where the next one starts', () => {
    for (const fps of [{ num: 24, den: 1 }, { num: 30_000, den: 1001 }, { num: 60, den: 1 }]) {
      for (const index of [0, 1, 29, 1799, 107_892]) {
        expect(frameAt(frameStartUs(index, fps), fps), `${fps.num}/${fps.den} #${index}`).toBe(index)
      }
    }
  })
})

describe('page files', () => {
  it('serve the same icon the editor shows', () => {
    const editorIcon = readFileSync(new URL('../../renderer/public/icons/icon.svg', import.meta.url), 'utf8')
    expect(UI_FILES.get('icon.svg')?.body).toBe(editorIcon)
  })
})

// ── the loopback transport ──────────────────────────────────────────────────

/** A stream the test feeds and ends, as the app's event stream. */
function eventStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const encoder = new TextEncoder()
  return {
    body,
    send: (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
  }
}

/** Fake app: each request takes the next scripted answer for its path. A
 *  missing answer is an app that is not running. */
function fakeApp() {
  const answers = new Map<string, Array<() => Response>>()
  const requests: Array<{ path: string; auth: string | null; body: string | null }> = []
  const answer = (path: string, make: () => Response) => { answers.set(path, [...(answers.get(path) ?? []), make]) }
  const fetch = async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^.*?(\/companion)/, '$1')
    requests.push({ path, auth: new Headers(init.headers).get('Authorization'), body: typeof init.body === 'string' ? init.body : null })
    const next = answers.get(path)?.shift()
    if (next === undefined) throw new TypeError('fetch failed')
    return next()
  }
  return { fetch, answer, requests }
}

/** A clock whose sleeps resolve only when the test says. */
function fakeClock() {
  const sleeps: Array<{ ms: number; wake: () => void }> = []
  return {
    clock: { sleep: (ms: number) => new Promise<void>((wake) => { sleeps.push({ ms, wake }) }) },
    sleeps,
    /** Wake the oldest sleeper once it exists. */
    async wake() {
      await until(() => sleeps.length > 0)
      sleeps.shift()!.wake()
    },
  }
}

async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !holds(); i++) await new Promise((r) => setImmediate(r))
  expect(holds()).toBe(true)
}

function handlersLog() {
  const log: string[] = []
  const states: unknown[] = []
  const events: Array<[string, unknown]> = []
  return {
    log, states, events,
    handlers: {
      state: (s: unknown) => { states.push(s); log.push('state') },
      event: (name: string, data: unknown) => { events.push([name, data]) },
      link: (status: string) => { if (log.at(-1) !== status) log.push(status) },
    },
  }
}

describe('loopbackTransport', () => {
  it('sends the page key, never anything else, as the bearer', async () => {
    const app = fakeApp()
    const stream = eventStream()
    app.answer('/companion/events', () => new Response(stream.body))
    app.answer('/companion/state', () => Response.json(projectState()))
    const h = handlersLog()
    loopbackTransport({ fetch: app.fetch, key: KEY, clock: fakeClock().clock }).start(h.handlers)
    await until(() => h.log.includes('online'))
    expect(app.requests.map((r) => r.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`])
  })

  it('reconnects after the app goes away, waiting longer each time it stays away, and reads the state again', async () => {
    const app = fakeApp()
    const first = eventStream()
    app.answer('/companion/events', () => new Response(first.body))
    app.answer('/companion/state', () => Response.json(projectState()))
    const { clock, sleeps, wake } = fakeClock()
    const h = handlersLog()
    loopbackTransport({ fetch: app.fetch, key: KEY, clock }).start(h.handlers)
    await until(() => h.log.includes('online'))

    // The app quits: its stream ends. Then it stays closed for a while.
    first.end()
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      await until(() => sleeps.length > 0)
      waits.push(sleeps[0]!.ms)
      await wake()
    }
    expect(waits[0]).toBe(RETRY_FIRST_MS)
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]!)
    expect(Math.max(...waits)).toBe(RETRY_MAX_MS)

    // It opens again: the page is back online on a fresh state read.
    const second = eventStream()
    app.answer('/companion/events', () => new Response(second.body))
    app.answer('/companion/state', () => Response.json(projectState({ project: { name: 'Reopened' } })))
    await until(() => sleeps.length > 0)
    await wake()
    await until(() => h.log.at(-1) === 'online')
    expect(h.log).toEqual(['connecting', 'state', 'online', 'offline', 'state', 'online'])
    expect(h.states.at(-1)).toMatchObject({ project: { name: 'Reopened' } })

    // Once reached, a later loss starts again from the first wait.
    second.end()
    await until(() => sleeps.length > 0)
    expect(sleeps[0]!.ms).toBe(RETRY_FIRST_MS)
  })

  it('says the link is turned off on a 401, and stops asking', async () => {
    const app = fakeApp()
    app.answer('/companion/events', () => new Response(null, { status: 401 }))
    const { clock, sleeps } = fakeClock()
    const h = handlersLog()
    loopbackTransport({ fetch: app.fetch, key: KEY, clock }).start(h.handlers)
    await until(() => h.log.at(-1) === 'revoked')
    expect(sleeps).toHaveLength(0)
    expect(app.requests).toHaveLength(1)
  })

  it('says the link is turned off when it carries no key, without asking the app', () => {
    const app = fakeApp()
    const h = handlersLog()
    loopbackTransport({ fetch: app.fetch, key: null, clock: fakeClock().clock }).start(h.handlers)
    expect(h.log).toEqual(['revoked'])
    expect(app.requests).toHaveLength(0)
  })

  it('reads the state again on a project or editor event, and hands the rest over as they came', async () => {
    const app = fakeApp()
    const stream = eventStream()
    app.answer('/companion/events', () => new Response(stream.body))
    app.answer('/companion/state', () => Response.json(projectState()))
    app.answer('/companion/state', () => Response.json(projectState({ project: { name: 'Edited' } })))
    const h = handlersLog()
    loopbackTransport({ fetch: app.fetch, key: KEY, clock: fakeClock().clock }).start(h.handlers)
    await until(() => h.log.includes('online'))
    stream.send('transport', { t_us: 5, playing: true })
    stream.send('project', {})
    await until(() => h.states.length === 2)
    expect(h.states[1]).toMatchObject({ project: { name: 'Edited' } })
    expect(h.events).toEqual([['transport', { t_us: 5, playing: true }]])
  })

  it('answers a control with what the app made of it', async () => {
    const app = fakeApp()
    app.answer('/companion/control', () => new Response(null, { status: 204 }))
    app.answer('/companion/control', () => Response.json({ reason: 'editor_not_ready' }, { status: 409 }))
    app.answer('/companion/control', () => new Response(null, { status: 401 }))
    const transport = loopbackTransport({ fetch: app.fetch, key: KEY, clock: fakeClock().clock })
    const h = handlersLog()
    transport.start(h.handlers)
    expect(await transport.control({ action: 'seek', t_us: 7 })).toBe('ok')
    expect(app.requests.find((r) => r.path === '/companion/control')?.body).toBe(JSON.stringify({ action: 'seek', t_us: 7 }))
    expect(await transport.control({ action: 'play' })).toBe('not_ready')
    expect(await transport.control({ action: 'play' })).toBe('revoked')
    expect(h.log.at(-1)).toBe('revoked')
    expect(await transport.control({ action: 'play' })).toBe('offline')
  })
})

// ── the picture over loopback ───────────────────────────────────────────────

const config = { codec: 'vp8', coded_width: 640, coded_height: 360 }
const configFrame = () => frame(MIRROR_FRAME_CONFIG, 0, Buffer.from(JSON.stringify(config)))
const keyFrame = (ts: number) => frame(MIRROR_FRAME_KEY, ts, Buffer.from([1]))
const deltaFrame = (ts: number) => frame(MIRROR_FRAME_DELTA, ts, Buffer.from([2]))

/** A VideoDecoder that records what it was given; the test sets its queue. */
function fakeDecoders() {
  const made: Array<{ configured: unknown; decoded: Array<{ type: string; timestamp: number }>; decodeQueueSize: number; state: string; fail(): void; draw(): void }> = []
  class VideoDecoder {
    configured: unknown = null
    decoded: Array<{ type: string; timestamp: number }> = []
    decodeQueueSize = 0
    state = 'unconfigured'
    constructor(private readonly init: { output(f: { close(): void }): void; error(e: unknown): void }) { made.push(this) }
    configure(c: unknown) { this.configured = c; this.state = 'configured' }
    decode(c: { type: string; timestamp: number }) { this.decoded.push({ type: c.type, timestamp: c.timestamp }) }
    close() { this.state = 'closed' }
    fail() { this.state = 'closed'; this.init.error(new Error('decode failed')) }
    draw() { this.init.output({ close() {} }) }
  }
  class EncodedVideoChunk {
    readonly type: string
    readonly timestamp: number
    constructor(init: { type: string; timestamp: number }) { this.type = init.type; this.timestamp = init.timestamp }
  }
  return { made, codecs: { VideoDecoder, EncodedVideoChunk } }
}

function fakeCanvas() {
  const drawn: unknown[] = []
  return { drawn, canvas: { width: 0, height: 0, getContext: () => ({ drawImage: (f: unknown) => { drawn.push(f) } }), remove() {} } }
}

describe('the picture stream', () => {
  it('reads the frame layout main writes', () => {
    expect([chunks.HEADER_BYTES, chunks.FRAME_CONFIG, chunks.FRAME_KEY, chunks.FRAME_DELTA, chunks.FRAME_FAILED])
      .toEqual([MIRROR_HEADER_BYTES, MIRROR_FRAME_CONFIG, MIRROR_FRAME_KEY, MIRROR_FRAME_DELTA, MIRROR_FRAME_FAILED])
  })

  it('splits frames however the bytes arrive', () => {
    const bytes = new Uint8Array(Buffer.concat([configFrame(), keyFrame(1_000), deltaFrame(2_000)]))
    const split = chunks.frameSplitter()
    const got = [...split(bytes.subarray(0, 5)), ...split(bytes.subarray(5, 40)), ...split(bytes.subarray(40))]
    expect(got.map((f: { kind: number; timestamp: number }) => [f.kind, f.timestamp])).toEqual([[MIRROR_FRAME_CONFIG, 0], [MIRROR_FRAME_KEY, 1_000], [MIRROR_FRAME_DELTA, 2_000]])
    expect(JSON.parse(new TextDecoder().decode(got[0].payload))).toEqual(config)
  })
})

describe('pictureDecoder', () => {
  const take = (decoder: { take(f: unknown): void }, buf: Buffer) => {
    for (const f of chunks.frameSplitter()(new Uint8Array(buf))) decoder.take(f)
  }

  it('configures from the stream, without a description, and starts at a keyframe', () => {
    const { made, codecs } = fakeDecoders()
    const { canvas } = fakeCanvas()
    const decoder = chunks.pictureDecoder({ canvas, codecs, shown: () => {} })
    take(decoder, deltaFrame(1))
    take(decoder, configFrame())
    take(decoder, deltaFrame(2))
    take(decoder, keyFrame(3))
    take(decoder, deltaFrame(4))
    expect([canvas.width, canvas.height]).toEqual([640, 360])
    expect(made).toHaveLength(1)
    expect(made[0]!.configured).toEqual({ codec: 'vp8', codedWidth: 640, codedHeight: 360, optimizeForLatency: true })
    expect(made[0]!.decoded.map((c) => c.timestamp)).toEqual([3, 4])
  })

  it('drops a delta when the decoder falls behind, and then waits for a keyframe', () => {
    const { made, codecs } = fakeDecoders()
    const decoder = chunks.pictureDecoder({ canvas: fakeCanvas().canvas, codecs, shown: () => {} })
    take(decoder, configFrame())
    take(decoder, keyFrame(1))
    made[0]!.decodeQueueSize = chunks.DECODE_QUEUE_MAX + 1
    take(decoder, deltaFrame(2))
    made[0]!.decodeQueueSize = 0
    take(decoder, deltaFrame(3))
    take(decoder, keyFrame(4))
    expect(made[0]!.decoded.map((c) => c.timestamp)).toEqual([1, 4])
  })

  it('starts a new decoder at the next keyframe after one fails', () => {
    const { made, codecs } = fakeDecoders()
    const decoder = chunks.pictureDecoder({ canvas: fakeCanvas().canvas, codecs, shown: () => {} })
    take(decoder, configFrame())
    take(decoder, keyFrame(1))
    made[0]!.fail()
    take(decoder, deltaFrame(2))
    take(decoder, keyFrame(3))
    expect(made).toHaveLength(2)
    expect(made[1]!.decoded.map((c) => c.timestamp)).toEqual([3])
  })

  it('says when the app gave up, and decodes again only from a new config', () => {
    const { made, codecs } = fakeDecoders()
    let failed = 0
    const decoder = chunks.pictureDecoder({ canvas: fakeCanvas().canvas, codecs, shown: () => {}, failed: () => { failed++ } })
    take(decoder, configFrame())
    take(decoder, keyFrame(1))
    take(decoder, frame(MIRROR_FRAME_FAILED, 0, Buffer.alloc(0)))
    expect(failed).toBe(1)
    take(decoder, keyFrame(2))
    take(decoder, configFrame())
    take(decoder, keyFrame(3))
    expect(made.map((d) => d.decoded.map((c) => c.timestamp))).toEqual([[1], [3]])
  })

  it('draws each decoded frame and says so', () => {
    const { made, codecs } = fakeDecoders()
    const { canvas, drawn } = fakeCanvas()
    let shown = 0
    const decoder = chunks.pictureDecoder({ canvas, codecs, shown: () => { shown++ } })
    take(decoder, configFrame())
    take(decoder, keyFrame(1))
    made[0]!.draw()
    expect([drawn.length, shown]).toEqual([1, 1])
  })
})

describe('loopbackTransport.openPicture', () => {
  const pictureDoc = () => ({ createElement: () => fakeCanvas().canvas })
  const view = () => ({ mount: { replaceChildren() {} }, shown() {} })

  it('opens nothing where the browser has no WebCodecs', () => {
    const app = fakeApp()
    const transport = loopbackTransport({ fetch: app.fetch, key: KEY, clock: fakeClock().clock, codecs: null, doc: pictureDoc() })
    transport.start(handlersLog().handlers)
    expect(transport.openPicture(view())).toBeNull()
    expect(app.requests.filter((r) => r.path === '/companion/video')).toEqual([])
  })

  it('asks for the picture with the page key, and again after the app went away', async () => {
    const app = fakeApp()
    const first = eventStream()
    app.answer('/companion/video', () => new Response(first.body))
    const { clock, wake } = fakeClock()
    const { made, codecs } = fakeDecoders()
    const transport = loopbackTransport({ fetch: app.fetch, key: KEY, clock, codecs, doc: pictureDoc() })
    const picture = transport.openPicture(view())
    await until(() => app.requests.some((r) => r.path === '/companion/video'))
    expect(app.requests.find((r) => r.path === '/companion/video')?.auth).toBe(`Bearer ${KEY}`)
    first.end()
    const second = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(Buffer.concat([configFrame(), keyFrame(1)]))) } })
    app.answer('/companion/video', () => new Response(second))
    await wake()
    await until(() => made.length === 1 && made[0]!.decoded.length === 1)
    picture.close()
  })

  it('says the link is turned off on a 401', async () => {
    const app = fakeApp()
    app.answer('/companion/video', () => new Response(null, { status: 401 }))
    const { codecs } = fakeDecoders()
    const transport = loopbackTransport({ fetch: app.fetch, key: KEY, clock: fakeClock().clock, codecs, doc: pictureDoc() })
    const h = handlersLog()
    transport.start(h.handlers)
    transport.openPicture(view())
    await until(() => h.log.at(-1) === 'revoked')
  })
})
