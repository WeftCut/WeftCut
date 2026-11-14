// The companion page's modules (`apps/desktop/cli/companion/ui/`), plain JS
// run here as the browser runs them. `app.js`'s DOM is covered in
// `renderer/companion/pageApp.test.ts`, which has the DOM types; the page in
// a real browser by e2e `companion-page.spec.ts`.
import { describe, expect, it } from 'vitest'

/** The modules are plain JS with no declarations, so they load untyped. */
const pageModule = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../../cli/companion/ui/${file}`, import.meta.url).href)

const { pageState, exportRunning } = await pageModule('viewState.js')
const { STRINGS, stringsFor } = await pageModule('strings.js')
const { formatTime, timeAt, timelineRows } = await pageModule('timeline.js')
const { loopbackTransport, RETRY_FIRST_MS, RETRY_MAX_MS } = await pageModule('transportLoopback.js')

const strings = STRINGS.en
const KEY = 'a'.repeat(64)
const projectState = (over: Record<string, unknown> = {}) => ({ project: { name: 'Cut' }, editor: 'ready', ...over })

describe('pageState', () => {
  it('names the first state that holds, in order', () => {
    const offline = { link: 'offline', editorRefused: true, state: projectState({ project: null }) }
    expect(pageState({ ...offline, link: 'revoked' }, strings).state).toBe('revoked')
    expect(pageState(offline, strings).state).toBe('offline')
    expect(pageState({ link: 'connecting', editorRefused: false, state: null }, strings).state).toBe('connecting')
    // A refused control says the editor is opening even before the state does.
    expect(pageState({ link: 'online', editorRefused: true, state: projectState({ project: null }) }, strings).state).toBe('opening')
    expect(pageState({ link: 'online', editorRefused: false, state: projectState({ editor: 'opening' }) }, strings).state).toBe('opening')
    // No project: the editor is not mounted at all, which is not "opening".
    expect(pageState({ link: 'online', editorRefused: false, state: projectState({ project: null, editor: 'opening' }) }, strings).state).toBe('no_project')
    expect(pageState({ link: 'online', editorRefused: false, state: projectState() }, strings)).toEqual({ state: 'ready', message: null })
  })

  it('says each state in the strings it is given', () => {
    expect(pageState({ link: 'revoked', editorRefused: false, state: null }, STRINGS.zh).message).toBe(STRINGS.zh.state_revoked)
  })

  it('shows progress for a running export only', () => {
    for (const state of ['queued', 'preparing', 'rendering', 'finalizing']) expect(exportRunning({ state }), state).toBe(true)
    for (const state of ['awaiting_retry', 'completed', 'failed', 'cancelled']) expect(exportRunning({ state }), state).toBe(false)
    expect(exportRunning(null)).toBe(false)
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

  it('formats time as minutes, seconds and tenths, never rounding up into the next second', () => {
    expect(formatTime(59_999_999)).toBe('00:59.9')
    expect(formatTime(61_200_000)).toBe('01:01.2')
    expect(formatTime(3_600_000_000)).toBe('60:00.0')
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
