// `electron` can't load under Vitest, so `session.fromPartition` hands back a
// recorder of the calls the capture partition is made with; the rules are then
// driven as the browser process would drive them.
import { describe, it, expect, vi } from 'vitest'

const made = vi.hoisted(() => ({
  partition: '',
  handlers: new Map<string, unknown>(),
  urls: [] as string[],
  onBeforeRequest: null as null | ((details: { url: string }, cb: (r: { cancel?: boolean }) => void) => void),
  permissionRequest: null as null | ((contents: unknown, permission: string, cb: (granted: boolean) => void) => void),
  permissionCheck: null as null | ((...args: unknown[]) => boolean),
  devicePermission: null as null | ((...args: unknown[]) => boolean),
  displayMedia: null as null | ((request: unknown, cb: (streams: object) => void) => void),
  download: null as null | ((event: { preventDefault(): void }) => void),
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      made.partition = partition
      return {
        protocol: { handle: (scheme: string, fn: unknown) => { made.handlers.set(scheme, fn) } },
        webRequest: {
          onBeforeRequest: (filter: { urls: string[] }, fn: typeof made.onBeforeRequest) => { made.urls = filter.urls; made.onBeforeRequest = fn },
        },
        setPermissionRequestHandler: (fn: typeof made.permissionRequest) => { made.permissionRequest = fn },
        setPermissionCheckHandler: (fn: typeof made.permissionCheck) => { made.permissionCheck = fn },
        setDevicePermissionHandler: (fn: typeof made.devicePermission) => { made.devicePermission = fn },
        setDisplayMediaRequestHandler: (fn: typeof made.displayMedia) => { made.displayMedia = fn },
        on: (event: string, fn: typeof made.download) => { if (event === 'will-download') made.download = fn },
      }
    },
  },
}))

import { installMotifCaptureSession } from './captureSession'

const handler = async () => new Response('motif')
installMotifCaptureSession(handler)

/** The scheme a webRequest URL pattern (`scheme://host/path`) names. */
const patternScheme = (pattern: string) => pattern.slice(0, pattern.indexOf('://'))
/** Whether `url` reaches the main-process listener. */
const filtered = (url: string) => made.urls.some((p) => patternScheme(p) === new URL(url).protocol.slice(0, -1))

describe('the Motif capture session', () => {
  it('is an in-memory partition of its own that serves motif: through the given handler', () => {
    expect(made.partition).not.toBe('')
    expect(made.partition).not.toMatch(/^persist:/)
    expect(made.handlers.get('motif')).toBe(handler)
  })

  it('refuses every scheme that leaves the app', () => {
    for (const url of ['http://example.com/lib.js', 'https://cdn.example.com/three.module.js', 'ws://example.com/', 'wss://example.com/', 'file:///etc/passwd']) {
      expect(filtered(url), url).toBe(true)
      let cancel: boolean | undefined
      made.onBeforeRequest!({ url }, (r) => { cancel = r.cancel })
      expect(cancel, url).toBe(true)
    }
  })

  it("never routes a Motif's own loads through the main-process listener", () => {
    for (const url of ['motif://countdown/index.html', 'data:image/png;base64,AA==', 'blob:motif://countdown/1234']) expect(filtered(url), url).toBe(false)
  })

  it('grants no permission and starts no download', () => {
    let granted: boolean | undefined
    made.permissionRequest!({}, 'media', (g) => { granted = g })
    expect(granted).toBe(false)
    expect(made.permissionCheck!({}, 'clipboard-read', 'motif://countdown', {})).toBe(false)
    expect(made.devicePermission!({ deviceType: 'usb', origin: 'motif://countdown' })).toBe(false)
    let streams: object | undefined
    made.displayMedia!({}, (s) => { streams = s })
    expect(streams).toEqual({})
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    made.download!(event)
    expect(event.prevented).toBe(true)
  })
})
