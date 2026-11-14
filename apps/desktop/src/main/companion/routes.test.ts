// The companion page's routes on a real loopback listener: who may read what.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CompanionHub } from './hub'
import { mountCompanionRoutes, type CompanionRouteDeps } from './routes'
import { PAGE_CSP, UI_FILES } from './pageFiles'
import { createActor } from '../state/actor'
import { blankProject } from '../state/model'
import { uuidV7Gen } from '../state/ids'
import { COMPANION_ATTACH, COMPANION_MIRROR_CONFIG, MIRROR_FRAME_CONFIG } from '../../shared/companion'

const PAGE_KEY = 'a'.repeat(64)
/** What an MCP client holds: a valid bearer for `/mcp`, and nothing here. */
const MCP_BEARER = 'b'.repeat(64)
const PROJECT_NAME = 'Example cut'

const idGen = uuidV7Gen()
const actor = createActor({ initial: blankProject(idGen, PROJECT_NAME), idGen, clock: () => '<TS>' })
const hub = new CompanionHub({
  getTsHost: () => ({ actor, openedProject: () => ({ dir: '/home/u/Projects/Example cut' }) }) as never,
  sendToEditor: () => {},
  focusEditor: () => {},
  language: () => null,
  windowState: () => 'normal',
  pictureRunning: () => {},
})
const rejected: Array<Parameters<CompanionRouteDeps['rejected']>[0]> = []
let server: http.Server
let port: number

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  mountCompanionRoutes(app, hub, PAGE_KEY, { rejected: (d) => { rejected.push(d) } })
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.closeAllConnections(); server.close() })
beforeEach(() => { rejected.length = 0 })

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = http.request({
      host: '127.0.0.1', port, path, method: opts.method ?? 'GET',
      headers: { Host: `127.0.0.1:${port}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Opens the event stream and reads it until `seen` holds. */
function openEvents(): Promise<{ status: number; text: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/companion/events', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${PAGE_KEY}` } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      resolve({ status: res.statusCode!, text: () => text, close: () => req.destroy() })
    })
    req.on('error', reject)
  })
}

/** Opens the picture and collects its bytes. */
function openVideo(): Promise<{ status: number; type: string | undefined; bytes: () => Buffer; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/companion/video', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${PAGE_KEY}` } }, (res) => {
      const got: Buffer[] = []
      res.on('data', (c: Buffer) => { got.push(c) })
      resolve({ status: res.statusCode!, type: res.headers['content-type'], bytes: () => Buffer.concat(got), close: () => req.destroy() })
    })
    req.on('error', reject)
  })
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })
const DATA_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/companion/state' },
  { method: 'GET', path: '/companion/events' },
  { method: 'GET', path: '/companion/video' },
  { method: 'POST', path: '/companion/control', body: { action: 'play' } },
]

describe('the data routes', () => {
  it('refuse a missing key, a wrong key and the MCP bearer, logging each without the header', async () => {
    for (const route of DATA_ROUTES) {
      for (const headers of [{}, bearer('c'.repeat(64)), bearer(MCP_BEARER), { Authorization: PAGE_KEY }]) {
        const answer = await request(route.path, { method: route.method, headers, body: route.body })
        expect(answer.status, `${route.method} ${route.path} ${JSON.stringify(headers)}`).toBe(401)
      }
    }
    expect(rejected).toHaveLength(DATA_ROUTES.length * 4)
    expect(rejected.every((r) => r.reason === 'key')).toBe(true)
    expect(JSON.stringify(rejected)).not.toContain(MCP_BEARER)
    expect(JSON.stringify(rejected)).not.toContain(PAGE_KEY)
  })

  it('answer the page key', async () => {
    const state = await request('/companion/state', { headers: bearer(PAGE_KEY) })
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toMatchObject({ project: { name: PROJECT_NAME } })
    const events = await openEvents()
    expect(events.status).toBe(200)
    events.close()
  })

  it('tell a control apart: no editor yet, done, and no such action', async () => {
    expect((await request('/companion/control', { method: 'POST', headers: bearer(PAGE_KEY), body: { action: 'play' } })).status).toBe(409)
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T' })
    expect((await request('/companion/control', { method: 'POST', headers: bearer(PAGE_KEY), body: { action: 'play' } })).status).toBe(204)
    expect((await request('/companion/control', { method: 'POST', headers: bearer(PAGE_KEY), body: { action: 'delete_layers' } })).status).toBe(400)
    hub.detach('T')
  })

  it('ask the editor for the picture while a page has it open, and stream the frames to it', async () => {
    hub.attach('T')
    expect(hub.demand().picture).toBe(false)
    const video = await openVideo()
    expect(video.status).toBe(200)
    expect(video.type).toBe('application/octet-stream')
    await expect.poll(() => hub.demand().picture).toBe(true)
    hub.handleInvoke(COMPANION_MIRROR_CONFIG, { token: 'T', codec: 'vp8', coded_width: 640, coded_height: 360 })
    await expect.poll(() => video.bytes().length).toBeGreaterThan(0)
    expect(video.bytes().readUInt8(0)).toBe(MIRROR_FRAME_CONFIG)
    video.close()
    await expect.poll(() => hub.demand().picture).toBe(false)
    hub.detach('T')
  })

  it('stream what the hub hears to a watching page', async () => {
    const events = await openEvents()
    await expect.poll(() => events.text()).toContain(': open')
    hub.observe('project:changed', {})
    await expect.poll(() => events.text()).toContain('event: project\ndata: {}\n\n')
    events.close()
  })
})

describe('the page', () => {
  it('serves the page and its files with no key, and no project data in the page', async () => {
    const page = await request('/companion')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toBe(PAGE_CSP)
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.body).not.toContain(PROJECT_NAME)
    for (const name of UI_FILES.keys()) {
      const file = await request(`/companion/ui/${name}`)
      expect(file.status, name).toBe(200)
      expect(file.headers['content-type'], name).toBe(UI_FILES.get(name)!.type)
    }
    expect((await request('/companion/ui/missing.js')).status).toBe(404)
  })

  it('refuses a request whose Host is not the loopback bind, on every route', async () => {
    for (const path of ['/companion', '/companion/ui/app.js', '/companion/state']) {
      const answer = await request(path, { headers: { Host: `rebound.example:${port}`, ...bearer(PAGE_KEY) } })
      expect(answer.status, path).toBe(403)
    }
    expect(rejected.map((r) => r.reason)).toEqual(['host', 'host', 'host'])
    expect((await request('/companion', { headers: { Host: `localhost:${port}` } })).status).toBe(200)
  })
})

describe('cross-origin reads', () => {
  it('allow the opaque origin of a sandboxed frame, on the page files and the data alike', async () => {
    for (const path of ['/companion', '/companion/ui/page.js', '/companion/state']) {
      const answer = await request(path, { headers: { Origin: 'null', ...bearer(PAGE_KEY) } })
      expect(answer.status, path).toBe(200)
      expect(answer.headers['access-control-allow-origin'], path).toBe('null')
    }
    const preflight = await request('/companion/control', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe('null')
    expect(preflight.headers['access-control-allow-headers']).toMatch(/Authorization/)
  })

  it('give any other origin no allow header, so its browser keeps the answer from it', async () => {
    for (const origin of ['https://site.example', `http://127.0.0.1:${port + 1}`]) {
      const answer = await request('/companion/state', { headers: { Origin: origin, ...bearer(PAGE_KEY) } })
      expect(answer.headers['access-control-allow-origin'], origin).toBeUndefined()
      const preflight = await request('/companion/state', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } })
      expect(preflight.headers['access-control-allow-origin'], origin).toBeUndefined()
    }
  })
})
