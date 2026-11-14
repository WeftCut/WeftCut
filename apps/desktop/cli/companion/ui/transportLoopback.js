// The companion page's transport when it runs in a browser on this machine:
// plain fetch to the app's loopback listener, the page key as a bearer on
// every request. No cookie and no storage, so a sandboxed frame with an opaque
// origin works as a tab does. `app.js` sees only the three handlers and
// `control`, which is the seam a second transport fills.

/** How long the page waits before asking an app that went away again: the
 *  first wait, doubling while the app stays away, up to the longest. A
 *  restarted app is found within `RETRY_MAX_MS`; one that stays closed is
 *  asked about that often and no more. */
export const RETRY_FIRST_MS = 1000
export const RETRY_MAX_MS = 5000

/**
 * @param {{
 *   fetch: typeof fetch,
 *   key: string | null,
 *   clock: { sleep(ms: number): Promise<void> },
 * }} deps
 */
export function loopbackTransport({ fetch, key, clock }) {
  const abort = new AbortController()
  let handlers = null
  let stopped = false

  const call = (path, init = {}) => fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    signal: abort.signal,
  })

  function revoked() {
    if (stopped) return
    stopped = true
    abort.abort()
    handlers.link('revoked')
  }

  // One state read at a time; a request while one is running asks for one more
  // after it, so the last change is always read.
  let reading = null
  let again = false
  function readState() {
    if (reading !== null) { again = true; return reading }
    reading = (async () => {
      do {
        again = false
        const r = await call('/companion/state')
        if (r.status === 401) return revoked()
        if (r.ok) handlers.state(await r.json())
      } while (again && !stopped)
    })().catch(() => { /* the event stream reports a lost app */ }).finally(() => { reading = null })
    return reading
  }

  /** One connection: the event stream first, so no change between the state
   *  read and the stream opening is missed. Resolves when the app ends it;
   *  throws when it cannot be reached. */
  async function session() {
    const events = await call('/companion/events')
    if (events.status === 401) return 'revoked'
    if (!events.ok || events.body === null) throw new Error(`events answered ${events.status}`)
    try {
      const state = await call('/companion/state')
      if (state.status === 401) return 'revoked'
      if (!state.ok) throw new Error(`state answered ${state.status}`)
      handlers.state(await state.json())
    } catch (error) {
      // An open stream counts as a page watching; close it with the session.
      void events.body.cancel().catch(() => {})
      throw error
    }
    handlers.link('online')
    await readEvents(events.body)
    return 'ended'
  }

  async function readEvents(body) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += value
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const name = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (name === undefined || data === undefined) continue
        if (name === 'project' || name === 'editor') void readState()
        else handlers.event(name, JSON.parse(data))
      }
    }
  }

  async function run() {
    let wait = RETRY_FIRST_MS
    while (!stopped) {
      let outcome = null
      try { outcome = await session() } catch { /* not reachable: wait and ask again */ }
      if (outcome === 'revoked') return revoked()
      if (stopped) return
      // An app that was reached and then went away is asked again soon; one
      // that cannot be reached is asked less and less often.
      if (outcome === 'ended') wait = RETRY_FIRST_MS
      handlers.link('offline')
      await clock.sleep(wait)
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
  }

  return {
    /** Starts reading; returns the stop. */
    start(h) {
      handlers = h
      if (key === null) { revoked(); return () => {} }
      handlers.link('connecting')
      void run()
      return () => { stopped = true; abort.abort() }
    },

    /** A player control or `focus`. `not_ready`: the app has no editor to
     *  drive yet; `offline` and `revoked` are also told to `link`. */
    async control(action) {
      let r
      try {
        r = await call('/companion/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        })
      } catch {
        return 'offline'
      }
      if (r.status === 401) { revoked(); return 'revoked' }
      if (r.status === 409) return 'not_ready'
      return r.ok ? 'ok' : 'invalid'
    },
  }
}
