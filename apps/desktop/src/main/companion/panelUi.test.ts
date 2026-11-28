// The side-panel view's modules (`apps/desktop/cli/companion/panel/`), plain JS
// run here against a fake host: the MCP Apps handshake and tool calls, the
// tool-call transport, and the picture's peer connection. The UI they feed is
// `pageApp.test.ts`'s; the view in a real frame is e2e `companion-panel.spec.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frame } from '../../shared/companionPicture'
import { MIRROR_FRAME_CONFIG, MIRROR_FRAME_KEY } from '../../shared/companion'
import { companionPageModule, companionPanelModule } from '../../shared/testing/companionPage'

const { mcpAppsBridge, PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } = await companionPanelModule('mcpAppsBridge')
const { toolcallTransport, LAUNCH_TIMEOUT_MS } = await companionPanelModule('transportToolcall')
const { openPeerPicture, PICTURE_CONNECT_MS } = await companionPanelModule('picturePeer')
const { RETRY_FIRST_MS, RETRY_MAX_MS } = await companionPageModule('transportLoopback')

type Message = { jsonrpc: string; id?: number | string; method?: string; params?: any; result?: any; error?: any }

/** The host's side of postMessage: what the view sent, and a way to answer. */
function fakeHost() {
  const sent: Message[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    deps: {
      post: (m: Message) => { sent.push(m) },
      subscribe: (l: (m: unknown) => void) => { listener = l; return () => { listener = null } },
    },
    say: (m: Message) => listener?.(m),
    subscribed: () => listener !== null,
  }
}

async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !holds(); i++) await new Promise((r) => setImmediate(r))
  expect(holds()).toBe(true)
}

describe('mcpAppsBridge', () => {
  it('opens with ui/initialize, then says it is initialized, and hands back the host context', async () => {
    const host = fakeHost()
    const bridge = mcpAppsBridge(host.deps)
    const opened = bridge.initialize({ name: 'v', version: '1' })
    expect(host.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { appInfo: { name: 'v', version: '1' }, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION } }])
    host.say({ jsonrpc: '2.0', id: 1, result: { protocolVersion: PROTOCOL_VERSION, hostContext: { locale: 'zh-CN' } } })
    expect((await opened).hostContext).toEqual({ locale: 'zh-CN' })
    expect(host.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} })
  })

  it("calls this server's tools through the host, by id, and rejects what the host refuses or never answers", async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost()
      const bridge = mcpAppsBridge(host.deps)
      const a = bridge.callTool('side_preview_sync', { op: 'state' })
      const b = bridge.callTool('launch_weftcut', {})
      const c = bridge.callTool('side_preview_sync', { op: 'events' })
      expect(host.sent.map((m) => [m.id, m.method, m.params.name])).toEqual([[1, 'tools/call', 'side_preview_sync'], [2, 'tools/call', 'launch_weftcut'], [3, 'tools/call', 'side_preview_sync']])
      host.say({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'WeftCut is not running' } })
      host.say({ jsonrpc: '2.0', id: 1, result: { structuredContent: { project: null } } })
      expect(await a).toEqual({ structuredContent: { project: null } })
      await expect(b).rejects.toMatchObject({ code: -32603 })
      const timedOut = expect(c).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      await timedOut
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers the host's teardown with its handler, and any request it has none for as not found", async () => {
    const host = fakeHost()
    const bridge = mcpAppsBridge(host.deps)
    const teardown = vi.fn(() => ({}))
    bridge.onRequest('ui/resource-teardown', teardown)
    host.say({ jsonrpc: '2.0', id: 'h1', method: 'ui/resource-teardown', params: {} })
    host.say({ jsonrpc: '2.0', id: 'h2', method: 'ui/unknown', params: {} })
    await until(() => host.sent.length === 2)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(host.sent).toHaveLength(2)
    expect(host.sent).toContainEqual({ jsonrpc: '2.0', id: 'h1', result: {} })
    expect(host.sent).toContainEqual({ jsonrpc: '2.0', id: 'h2', error: expect.objectContaining({ code: -32601 }) })
  })
})

// ── the tool-call transport ────────────────────────────────────────────────

/** A bridge whose tools answer from a script; a tool without one rejects as
 *  the host does when the app is not running. */
function fakeBridge() {
  const calls: Array<{ name: string; args: any; timeoutMs?: number }> = []
  const scripts = new Map<string, Array<(args: any) => unknown>>()
  const answer = (name: string, make: (args: any) => unknown) => { scripts.set(name, [...(scripts.get(name) ?? []), make]) }
  const record = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v })
  return {
    calls,
    answer,
    /** The sync tool answers `op` with `make`. */
    sync: (op: string, make: (args: any) => unknown) => answer(`sync:${op}`, make),
    bridge: {
      async callTool(name: string, args: any, timeoutMs?: number) {
        calls.push({ name, args, timeoutMs })
        const key = name === 'side_preview_sync' ? `sync:${args.op}` : name
        const next = scripts.get(key)?.shift()
        if (next === undefined) throw Object.assign(new Error('WeftCut is not running'), { code: -32603 })
        const value = await next(args)
        return value instanceof Object && 'isError' in value ? value : record(value)
      },
    },
  }
}

function fakeClock() {
  const sleeps: Array<{ ms: number; wake: () => void }> = []
  return {
    clock: { sleep: (ms: number) => new Promise<void>((wake) => { sleeps.push({ ms, wake }) }) },
    sleeps,
  }
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

const STATE = { project: { name: 'Cut' }, editor: 'ready' }
/** A poll held by the app until the test lets it answer. */
function heldPoll() {
  let release!: (v: unknown) => void
  const answer = new Promise((r) => { release = r })
  return { make: () => answer, release }
}

describe('toolcallTransport', () => {
  it('marks its place, reads the state after it, and then polls from there: events as they came, the state again on project or editor', async () => {
    const app = fakeBridge()
    const { clock } = fakeClock()
    const h = handlersLog()
    app.sync('events', () => ({ stream: 's1', seq: 4, events: [], reset: true }))
    app.sync('state', () => STATE)
    app.sync('events', () => ({ stream: 's1', seq: 6, events: [{ name: 'transport', data: { t_us: 9, playing: true } }, { name: 'project', data: {} }] }))
    app.sync('state', () => ({ ...STATE, project: { name: 'Cut 2' } }))
    const held = heldPoll()
    app.sync('events', held.make)
    const stop = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock }).start(h.handlers)
    await until(() => h.states.length === 2)
    expect(h.log).toEqual(['connecting', 'state', 'online', 'state'])
    expect(h.events).toEqual([['transport', { t_us: 9, playing: true }]])
    const polls = app.calls.filter((c) => c.args?.op === 'events').map((c) => c.args)
    expect(polls).toEqual([{ op: 'events' }, { op: 'events', since: 4, stream: 's1' }, { op: 'events', since: 6, stream: 's1' }])
    stop()
    held.release({ stream: 's1', seq: 6, events: [] })
  })

  it('reads the state afresh when the app says the view lost its place', async () => {
    const app = fakeBridge()
    const { clock } = fakeClock()
    const h = handlersLog()
    app.sync('events', () => ({ stream: 's1', seq: 0, events: [], reset: true }))
    app.sync('state', () => STATE)
    app.sync('events', () => ({ stream: 's2', seq: 0, events: [], reset: true }))
    app.sync('state', () => STATE)
    const held = heldPoll()
    app.sync('events', held.make)
    const stop = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock }).start(h.handlers)
    await until(() => h.states.length === 2)
    expect(app.calls.at(-1)!.args).toEqual({ op: 'events', since: 0, stream: 's2' })
    stop()
    held.release({ stream: 's2', seq: 0, events: [] })
  })

  it('says the app is away when its tool fails, asks again less and less often, and resumes when it answers', async () => {
    const app = fakeBridge()
    const fake = fakeClock()
    const h = handlersLog()
    const stop = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock: fake.clock }).start(h.handlers)
    await until(() => fake.sleeps.length === 1)
    expect(h.log).toEqual(['connecting', 'offline'])
    fake.sleeps.shift()!.wake()
    await until(() => fake.sleeps.length === 1)
    fake.sleeps.shift()!.wake()
    await until(() => fake.sleeps.length === 1)
    for (let i = 0; i < 4; i++) {
      fake.sleeps.shift()!.wake()
      await until(() => fake.sleeps.length === 1)
    }
    expect(fake.sleeps[0]!.ms).toBe(RETRY_MAX_MS)
    app.sync('events', () => ({ stream: 's', seq: 0, events: [], reset: true }))
    app.sync('state', () => STATE)
    const held = heldPoll()
    app.sync('events', held.make)
    fake.sleeps.shift()!.wake()
    await until(() => h.log.at(-1) === 'online')
    stop()
    held.release({ stream: 's', seq: 0, events: [] })
  })

  it('starts the app on request and asks again at once, not at the next wait', async () => {
    const app = fakeBridge()
    const fake = fakeClock()
    const h = handlersLog()
    const transport = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock: fake.clock })
    const stop = transport.start(h.handlers)
    await until(() => fake.sleeps.length === 1)
    app.answer('launch_weftcut', () => ({ content: [{ type: 'text', text: 'WeftCut launched' }] }))
    app.sync('events', () => ({ stream: 's', seq: 0, events: [], reset: true }))
    app.sync('state', () => STATE)
    const held = heldPoll()
    app.sync('events', held.make)
    expect(await transport.launch()).toBe('ok')
    expect(app.calls.find((c) => c.name === 'launch_weftcut')).toMatchObject({ args: {}, timeoutMs: LAUNCH_TIMEOUT_MS })
    // The sleep it was in is still pending: the wake, not the clock, resumed it.
    await until(() => h.log.at(-1) === 'online')
    expect(fake.sleeps).toHaveLength(1)
    stop()
    held.release({ stream: 's', seq: 0, events: [] })
  })

  it('answers a control with the outcome the app gave, and offline when it could not ask', async () => {
    const app = fakeBridge()
    const transport = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock: fakeClock().clock })
    app.sync('control', () => ({ outcome: 'not_ready' }))
    expect(await transport.control({ action: 'seek', t_us: 5 })).toBe('not_ready')
    expect(app.calls.at(-1)!.args).toEqual({ op: 'control', action: 'seek', t_us: 5 })
    expect(await transport.control({ action: 'play' })).toBe('offline')
  })

  it("offers the app's most recent project and opens it through the model's own tools", async () => {
    const app = fakeBridge()
    const transport = toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock: fakeClock().clock })
    app.answer('read_project', () => ({ project: null, recent_projects: [{ name: 'Cut', path: '/home/u/Videos/Cut' }, { name: 'Old', path: '/home/u/Old' }] }))
    expect(await transport.recentProject()).toEqual({ name: 'Cut', path: '/home/u/Videos/Cut' })
    expect(app.calls.at(-1)).toMatchObject({ name: 'read_project', args: { view: 'session' } })
    app.answer('open_project', () => ({ name: 'Cut', dir: '/home/u/Videos/Cut' }))
    expect(await transport.openProject('/home/u/Videos/Cut')).toBe('ok')
    expect(app.calls.at(-1)).toMatchObject({ name: 'open_project', args: { path: '/home/u/Videos/Cut' } })
    app.answer('open_project', () => ({ isError: true, content: [{ type: 'text', text: 'missing' }] }))
    expect(await transport.openProject('/home/u/Gone')).toBe('failed')
    app.answer('read_project', () => ({ project: null, recent_projects: [] }))
    expect(await transport.recentProject()).toBeNull()
  })

  it('opens no picture where the frame has no WebCodecs or no WebRTC', () => {
    const app = fakeBridge()
    const view = { mount: { replaceChildren() {} }, shown() {}, failed() {}, blocked() {} }
    const clock = fakeClock().clock
    expect(toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock, codecs: null, Peer: class {} }).openPicture(view)).toBeNull()
    expect(toolcallTransport({ bridge: app.bridge, syncTool: 'side_preview_sync', clock, codecs: {}, Peer: null }).openPicture(view)).toBeNull()
  })
})

// ── the picture's peer connection ──────────────────────────────────────────

class ViewChannel {
  binaryType = ''
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  deliver(bytes: Uint8Array) { this.onmessage?.({ data: bytes.slice().buffer }) }
}

class ViewPeer {
  static made: ViewPeer[] = []
  connectionState = 'new'
  iceGatheringState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remote: { type: string; sdp: string } | null = null
  closed = false
  channel: ViewChannel | null = null
  channelInit: unknown = null
  onconnectionstatechange: (() => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  constructor(readonly config: unknown) { ViewPeer.made.push(this) }
  createDataChannel(_label: string, init: unknown) { this.channelInit = init; return (this.channel = new ViewChannel()) }
  async createOffer() { return { type: 'offer', sdp: `offer-${ViewPeer.made.length}` } }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d
    queueMicrotask(() => { this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.() })
  }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d }
  close() { this.closed = true }
  fail() { this.connectionState = 'failed'; this.onconnectionstatechange?.() }
}

function fakeDecoding() {
  const decoded: string[] = []
  class VideoDecoder {
    state = 'unconfigured'
    decodeQueueSize = 0
    constructor(private readonly init: { output(f: { close(): void }): void }) {}
    configure() { this.state = 'configured' }
    decode(c: { type: string }) { decoded.push(c.type); this.init.output({ close() {} }) }
    close() { this.state = 'closed' }
  }
  class EncodedVideoChunk {
    readonly type: string
    constructor(init: { type: string }) { this.type = init.type }
  }
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), remove() {} }
  return { decoded, codecs: { VideoDecoder, EncodedVideoChunk }, doc: { createElement: () => canvas } }
}

/** Runs what is queued without moving the fake clock, until `holds`. */
async function settle(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !holds(); i++) await vi.advanceTimersByTimeAsync(0)
  expect(holds()).toBe(true)
}

function pictureView() {
  const said: string[] = []
  return { said, view: { mount: { replaceChildren() {} }, shown: () => { said.push('shown') }, failed: () => { said.push('failed') }, blocked: () => { said.push('blocked') } } }
}

describe('openPeerPicture', () => {
  beforeEach(() => { ViewPeer.made = []; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('offers an ordered channel, asks again while the editor is not ready, and draws what the channel carries in any pieces', async () => {
    const d = fakeDecoding()
    const p = pictureView()
    const offers: string[] = []
    const replies = [{ outcome: 'not_ready' }, { outcome: 'not_ready' }, { outcome: 'ok', answer: 'answer-sdp' }]
    const sleeps: number[] = []
    const clock = { sleep: async (ms: number) => { sleeps.push(ms) } }
    const picture = openPeerPicture({ signal: async (offer: string) => { offers.push(offer); return replies.shift() }, codecs: d.codecs, Peer: ViewPeer, doc: d.doc, clock }, p.view)
    await vi.waitFor(() => expect(ViewPeer.made[0]?.remote).toEqual({ type: 'answer', sdp: 'answer-sdp' }))
    expect(ViewPeer.made[0]!.config).toEqual({ iceServers: [] })
    expect(ViewPeer.made[0]!.channelInit).toEqual({ ordered: true })
    expect(offers).toEqual(['offer-1', 'offer-1', 'offer-1'])
    expect(sleeps).toEqual([RETRY_FIRST_MS, RETRY_FIRST_MS * 2])

    const config = frame(MIRROR_FRAME_CONFIG, 0, new TextEncoder().encode(JSON.stringify({ codec: 'vp8', coded_width: 4, coded_height: 2 })))
    const key = frame(MIRROR_FRAME_KEY, 1, new Uint8Array(100))
    const stream = new Uint8Array(config.length + key.length)
    stream.set(config)
    stream.set(key, config.length)
    const channel = ViewPeer.made[0]!.channel!
    channel.deliver(stream.subarray(0, 7))
    channel.deliver(stream.subarray(7, 60))
    channel.deliver(stream.subarray(60))
    expect(d.decoded).toEqual(['key'])
    expect(p.said).toEqual(['shown'])
    // Drawn in time: no word of a blocked picture follows.
    await vi.advanceTimersByTimeAsync(PICTURE_CONNECT_MS)
    expect(p.said).toEqual(['shown'])
    picture.close()
    expect(ViewPeer.made[0]!.closed).toBe(true)
  })

  it('says the picture cannot reach the view when an answered connection draws nothing in time, and tries anew', async () => {
    const d = fakeDecoding()
    const p = pictureView()
    const clock = { sleep: async () => {} }
    const picture = openPeerPicture({ signal: async () => ({ outcome: 'ok', answer: 'a' }), codecs: d.codecs, Peer: ViewPeer, doc: d.doc, clock }, p.view)
    await settle(() => ViewPeer.made[0]?.remote != null)
    await vi.advanceTimersByTimeAsync(PICTURE_CONNECT_MS - 1)
    expect(p.said).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(p.said).toEqual(['blocked'])
    await settle(() => ViewPeer.made.length === 2)
    expect(ViewPeer.made[0]!.closed).toBe(true)
    picture.close()
  })

  it('says so at once when the connection fails before it drew, or the editor could not answer', async () => {
    const d = fakeDecoding()
    const p = pictureView()
    const replies = [{ outcome: 'ok', answer: 'a' }, { outcome: 'failed' }]
    // The wait after the first connection ends at once; every later one holds.
    let waits = 0
    const clock = { sleep: () => (++waits === 1 ? Promise.resolve() : new Promise<void>(() => {})) }
    const picture = openPeerPicture({ signal: async () => replies.shift(), codecs: d.codecs, Peer: ViewPeer, doc: d.doc, clock }, p.view)
    await settle(() => ViewPeer.made[0]?.remote != null)
    ViewPeer.made[0]!.fail()
    expect(p.said).toEqual(['blocked'])
    // The next connection's offer is refused outright: said again, at once.
    await settle(() => p.said.length === 2)
    expect(ViewPeer.made).toHaveLength(2)
    expect(p.said).toEqual(['blocked', 'blocked'])
    picture.close()
  })
})
