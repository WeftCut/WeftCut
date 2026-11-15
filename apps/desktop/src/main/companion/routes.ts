// apps/desktop/src/main/companion/routes.ts
//
// The companion page's routes on the MCP host's loopback listener. The page and
// its files are keyless: they hold no project data, and the key travels in the
// link's fragment, which a browser never sends. Every data route needs the
// page key as a bearer; the MCP bearer is not it, and `/mcp` refuses the page
// key in turn. Behaviour lives in `hub.ts`; the page in `cli/companion/`.
import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { loopbackHosts } from '../mcp/bind.js'
import type { CompanionHub } from './hub.js'
import { PAGE_CSP, PAGE_HTML, UI_FILES, type PageFile } from './pageFiles.js'

/** The largest control body read. A control is a few dozen bytes of JSON; a
 *  body is parsed only once the key has been checked. */
export const CONTROL_BODY_LIMIT_BYTES = 1024
/** How often an event stream writes a comment, so a page that went without
 *  closing its socket is found by the write failing. */
export const EVENTS_HEARTBEAT_MS = 15_000
/** The most an event stream may have unsent. A page that stopped reading is
 *  dropped past it rather than kept in memory; once it reads again, it
 *  reconnects and reads the state afresh. */
export const EVENTS_BUFFER_BYTES = 256 * 1024

export interface CompanionRouteDeps {
  /** One row per refused request. Never carries the Authorization header. */
  rejected(details: { reason: 'host' | 'key'; method: string; path: string; user_agent: string | null }): void
}

export function mountCompanionRoutes(app: express.Express, hub: CompanionHub, key: string, deps: CompanionRouteDeps): void {
  const want = Buffer.from(`Bearer ${key}`)
  const reject = (req: Request, reason: 'host' | 'key'): void =>
    deps.rejected({ reason, method: req.method, path: req.originalUrl.split('?')[0]!, user_agent: req.headers['user-agent'] ?? null })

  // DNS-rebinding defense, as `/mcp` has it: the same Host list.
  app.use('/companion', (req, res, next) => {
    const port = req.socket.localPort
    if (port === undefined || !loopbackHosts(port).includes(req.headers.host ?? '')) {
      reject(req, 'host')
      res.status(403).end()
      return
    }
    next()
  })

  // LANDMINE: a host that frames the page with `sandbox="allow-scripts"` and no
  // `allow-same-origin` gives it an opaque origin. Its fetches then arrive with
  // `Origin: null`, and so do its module scripts (a module is always fetched in
  // CORS mode): without the allow header the page does not even load. Only
  // `null` is allowed; any other origin gets no header and the browser keeps
  // the answer from it. The key, not the origin, authorizes.
  app.use('/companion', (req, res, next) => {
    res.vary('Origin')
    const opaque = req.headers.origin === 'null'
    if (opaque) res.setHeader('Access-Control-Allow-Origin', 'null')
    if (req.method === 'OPTIONS') {
      if (opaque) {
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
      }
      res.status(204).end()
      return
    }
    next()
  })

  app.get('/companion', (_req, res) => {
    res.setHeader('Content-Security-Policy', PAGE_CSP)
    res.setHeader('Referrer-Policy', 'no-referrer')
    send(res, PAGE_HTML)
  })
  app.get('/companion/ui/:name', (req, res) => {
    const file = UI_FILES.get(String(req.params.name))
    if (file === undefined) { res.status(404).end(); return }
    send(res, file)
  })

  // LANDMINE: ahead of any body parser. The preflight above lets a sandboxed
  // frame on any site POST here, so a body read before this check is read for
  // anyone; `/control` parses its own, small, past it.
  app.use('/companion', (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(req.headers.authorization ?? '')
    if (got.length === want.length && timingSafeEqual(got, want)) { next(); return }
    reject(req, 'key')
    res.status(401).json({ reason: 'unauthorized' })
  })

  app.get('/companion/state', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(hub.state())
  })

  // Server-sent events, read by the page over fetch so the bearer rides along
  // (EventSource cannot send a header). A page watching is what makes the
  // editor push its transport at all (`CompanionHub.demand`).
  app.get('/companion/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    streamEvents(res, hub)
  })

  // The picture, framed as `shared/companion.ts` MIRROR_* says. An open
  // response is what makes the editor capture and encode its canvas at all.
  app.get('/companion/video', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.flushHeaders()
    const close = hub.showPicture(res)
    res.on('close', close)
  })

  app.post('/companion/control', express.json({ limit: CONTROL_BODY_LIMIT_BYTES }), (req, res) => {
    const outcome = hub.control(req.body)
    if (outcome === 'ok') res.status(204).end()
    else if (outcome === 'not_ready') res.status(409).json({ reason: 'editor_not_ready' })
    else res.status(400).json({ reason: 'unknown_action' })
  })
}

/** The part of an open `/companion/events` response the stream uses. */
export interface EventResponse {
  write(chunk: string): unknown
  /** Bytes written and not yet sent. */
  readonly writableLength: number
  readonly destroyed: boolean
  destroy(): unknown
  on(event: 'close', listener: () => void): unknown
}

/** Writes the hub's events to `res`, with a heartbeat, until it closes. */
export function streamEvents(res: EventResponse, hub: Pick<CompanionHub, 'watch'>): void {
  const write = (text: string): void => {
    if (res.destroyed) return
    if (res.writableLength > EVENTS_BUFFER_BYTES) { res.destroy(); return }
    res.write(text)
  }
  write(': open\n\n')
  const close = hub.watch({ send: (event, data) => { write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } })
  const heartbeat = setInterval(() => { write(': ping\n\n') }, EVENTS_HEARTBEAT_MS)
  res.on('close', () => {
    clearInterval(heartbeat)
    close()
  })
}

function send(res: Response, file: PageFile): void {
  res.setHeader('Content-Type', file.type)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(file.body)
}
