// The companion UI's transport inside a host's side panel, which cannot reach
// loopback: every read and control is a tool call the host forwards to this
// MCP server (`side_preview_sync`, hidden from the model), and the picture is
// a peer connection signaled the same way (`picturePeer.js`). The seam is the
// one `../ui/transportLoopback.js` fills: `start`, `control`, `openPicture`.
// Two more the page has no use for: starting the app, and opening its most
// recent project, through the tools the model has too.
import { RETRY_FIRST_MS, RETRY_MAX_MS } from '../ui/transportLoopback.js'
import { openPeerPicture } from './picturePeer.js'

/** `launch_weftcut` waits for the app's endpoint itself, up to 45 s. */
export const LAUNCH_TIMEOUT_MS = 60_000

/**
 * @param {{
 *   bridge: { callTool(name: string, args?: object, timeoutMs?: number): Promise<any> },
 *   syncTool: string,
 *   clock: { sleep(ms: number): Promise<void> },
 *   codecs?: { VideoDecoder: typeof VideoDecoder, EncodedVideoChunk: typeof EncodedVideoChunk } | null,
 *   Peer?: typeof RTCPeerConnection | null,
 *   doc?: Document,
 * }} deps `codecs` and `Peer` are null where the frame has no WebCodecs or no
 *   WebRTC: the picture needs both here.
 */
export function toolcallTransport({ bridge, syncTool, clock, codecs = null, Peer = null, doc = globalThis.document }) {
  let handlers = null
  let stopped = false
  /** Ends the wait between attempts early: the app was just started. */
  let wake = () => {}

  /** A tool's record: its structured content, else its first text as JSON.
   *  Throws on a failed call, which is how a closed app answers. */
  function record(result) {
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'the tool failed')
    if (result?.structuredContent !== undefined) return result.structuredContent
    return JSON.parse(result?.content?.[0]?.text ?? 'null')
  }

  const sync = async (args) => record(await bridge.callTool(syncTool, args))

  async function readState() {
    handlers.state(await sync({ op: 'state' }))
  }

  /** One connection: a first `events` call marks where the view starts, the
   *  state is read after it, so no change between the two is missed. Throws
   *  once the app cannot be reached. */
  async function session(reached) {
    let cursor = await sync({ op: 'events' })
    await readState()
    reached()
    handlers.link('online')
    while (!stopped) {
      const answer = await sync({ op: 'events', since: cursor.seq, stream: cursor.stream })
      cursor = answer
      if (stopped) return
      // A stream the view did not start on, or events it missed: what it
      // shows may be stale, so it reads the state afresh.
      if (answer.reset) { await readState(); continue }
      let reread = false
      for (const { name, data } of answer.events) {
        if (name === 'project' || name === 'editor') reread = true
        else handlers.event(name, data)
      }
      if (reread) await readState()
    }
  }

  function pause(ms) {
    return new Promise((resolve) => {
      wake = resolve
      void clock.sleep(ms).then(resolve)
    })
  }

  async function run() {
    let wait = RETRY_FIRST_MS
    while (!stopped) {
      try {
        await session(() => { wait = RETRY_FIRST_MS })
      } catch { /* not reachable: wait and ask again */ }
      if (stopped) return
      handlers.link('offline')
      await pause(wait)
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
  }

  async function call(name, args, timeoutMs) {
    try {
      return { ok: true, value: record(await bridge.callTool(name, args, timeoutMs)) }
    } catch {
      return { ok: false, value: null }
    }
  }

  return {
    /** Starts reading; returns the stop. */
    start(h) {
      handlers = h
      handlers.link('connecting')
      void run()
      return () => {
        stopped = true
        wake()
      }
    },

    /** The picture, as `transportLoopback.js` opens it, plus `view.blocked()`
     *  when it cannot reach this view. Null where it cannot be shown. */
    openPicture(view) {
      if (codecs === null || Peer === null || stopped) return null
      return openPeerPicture({
        signal: (offer) => sync({ op: 'signal', offer }),
        codecs,
        Peer,
        doc,
        clock,
      }, view)
    },

    /** A player control or `focus`: `ok`, `not_ready`, `invalid`, or
     *  `offline` when the app could not be asked. */
    async control(action) {
      const { ok, value } = await call(syncTool, { op: 'control', ...action })
      return ok ? value.outcome : 'offline'
    },

    /** Starts WeftCut and resumes at once once it is up: `ok` or `failed`. */
    async launch() {
      const { ok } = await call('launch_weftcut', {}, LAUNCH_TIMEOUT_MS)
      wake()
      return ok ? 'ok' : 'failed'
    },

    /** The project the app lists first among its recent ones, `{ name, path }`,
     *  or null. */
    async recentProject() {
      const { ok, value } = await call('read_project', { view: 'session' })
      const recent = ok ? value?.recent_projects?.[0] : undefined
      return recent && typeof recent.path === 'string' ? { name: String(recent.name ?? ''), path: recent.path } : null
    },

    /** Opens `path` in the app: `ok` or `failed`. The state that follows
     *  arrives as for any other change. */
    async openProject(path) {
      const { ok } = await call('open_project', { path })
      return ok ? 'ok' : 'failed'
    },
  }
}
