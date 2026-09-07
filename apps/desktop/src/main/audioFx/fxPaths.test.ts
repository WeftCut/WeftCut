// The TS side of the cache-layout twin. What these pin is the SHAPE Rust
// builds (native/src/cache/mod.rs) and the trust gate Rust applies
// (`cached_ok` + `read_header`) — nothing enforces the match across the
// boundary, so a change here without one there is the failure mode.
import { describe, it, expect } from 'vitest'
import {
  FX_TOUCH_THROTTLE_MS, VCONF_HEADER_LEN,
  cachedOk, conformCachedOk, createFxCacheLayout, fxCacheRoot, touchIfStale,
  type AudioFxFs,
} from './fxPaths'
import { CONFORM_FORMAT_VERSION } from '../../shared/audioEffects/conform'

const join = (...parts: string[]): string => parts.join('/')
const HASH = 'abc123'
const SIG16 = '0123456789abcdef'

/** A VCONF header, with the fields the trust gate reads. */
function header(opts: { magic?: string; version?: number; channels?: number } = {}): Uint8Array {
  const buf = new Uint8Array(VCONF_HEADER_LEN)
  const view = new DataView(buf.buffer)
  const magic = opts.magic ?? 'VCONF\0\0\0'
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i)
  view.setUint32(8, opts.version ?? CONFORM_FORMAT_VERSION, true)
  view.setUint32(12, 48_000, true)
  view.setUint32(16, opts.channels ?? 2, true)
  return buf
}

/** In-memory `AudioFxFs`; `touched` records the mtime bumps. */
function fakeFs(files: Record<string, { size: number; mtimeMs: number; head?: Uint8Array }>) {
  const touched: Array<{ path: string; whenMs: number }> = []
  const fs: AudioFxFs = {
    statFile: (p) => {
      const f = files[p]
      return f ? { size: f.size, mtimeMs: f.mtimeMs } : null
    },
    readHeader: (p) => files[p]?.head ?? null,
    touch: (p, whenMs) => { touched.push({ path: p, whenMs }) },
  }
  return { fs, touched }
}

describe('fxCacheRoot', () => {
  it('is <workspace>/Cache once a project is open', () => {
    expect(fxCacheRoot('/proj', '/boot/cache', join)).toBe('/proj/Cache')
  })
  it('falls back to the app cache dir before any workspace exists', () => {
    expect(fxCacheRoot(null, '/boot/cache', join)).toBe('/boot/cache')
  })
})

describe('createFxCacheLayout', () => {
  it('names both siblings exactly as the Rust layout does', () => {
    const layout = createFxCacheLayout({ cacheRoot: () => '/proj/Cache', join })
    expect(layout.audioFxConform(HASH, SIG16)).toBe('/proj/Cache/audio/abc123.fx-0123456789abcdef.conform')
    expect(layout.waveformFx(HASH, SIG16)).toBe('/proj/Cache/waveforms/abc123.fx-0123456789abcdef.v4.peaks')
  })

  // The root moves with the workspace, so the layout has to ask every time.
  it('re-reads the cache root per call', () => {
    let root = '/a/Cache'
    const layout = createFxCacheLayout({ cacheRoot: () => root, join })
    expect(layout.audioFxConform(HASH, SIG16)).toContain('/a/Cache/')
    root = '/b/Cache'
    expect(layout.audioFxConform(HASH, SIG16)).toContain('/b/Cache/')
  })
})

describe('cachedOk', () => {
  it('accepts a non-empty file and rejects a missing or zero-byte one', () => {
    const { fs } = fakeFs({ '/good': { size: 12, mtimeMs: 0 }, '/empty': { size: 0, mtimeMs: 0 } })
    expect(cachedOk(fs, '/good')).toBe(true)
    expect(cachedOk(fs, '/empty')).toBe(false)
    expect(cachedOk(fs, '/gone')).toBe(false)
  })
})

describe('conformCachedOk', () => {
  it('accepts a well-formed VCONF', () => {
    const { fs } = fakeFs({ '/a.conform': { size: 4096, mtimeMs: 0, head: header() } })
    expect(conformCachedOk(fs, '/a.conform')).toBe(true)
  })

  it('rejects bad magic, a stale format version, and an impossible channel count', () => {
    const { fs } = fakeFs({
      '/magic': { size: 4096, mtimeMs: 0, head: header({ magic: 'VPEAKS\0\0' }) },
      '/version': { size: 4096, mtimeMs: 0, head: header({ version: CONFORM_FORMAT_VERSION + 1 }) },
      '/channels': { size: 4096, mtimeMs: 0, head: header({ channels: 0 }) },
      '/wide': { size: 4096, mtimeMs: 0, head: header({ channels: 6 }) },
    })
    expect(conformCachedOk(fs, '/magic')).toBe(false)
    expect(conformCachedOk(fs, '/version')).toBe(false)
    expect(conformCachedOk(fs, '/channels')).toBe(false)
    expect(conformCachedOk(fs, '/wide')).toBe(false)
  })

  it('rejects a file too short to hold a header', () => {
    const { fs } = fakeFs({ '/short': { size: 8, mtimeMs: 0, head: new Uint8Array(8) } })
    expect(conformCachedOk(fs, '/short')).toBe(false)
  })
})

describe('touchIfStale', () => {
  const NOW = 10 * FX_TOUCH_THROTTLE_MS

  it('bumps a file older than the throttle', () => {
    const { fs, touched } = fakeFs({ '/a': { size: 1, mtimeMs: NOW - FX_TOUCH_THROTTLE_MS - 1 } })
    touchIfStale(fs, '/a', NOW)
    expect(touched).toEqual([{ path: '/a', whenMs: NOW }])
  })

  it('leaves a recently used file alone (one metadata read on the hot path)', () => {
    const { fs, touched } = fakeFs({ '/a': { size: 1, mtimeMs: NOW - 1_000 } })
    touchIfStale(fs, '/a', NOW)
    expect(touched).toEqual([])
  })

  // Clock skew: a future mtime is normalized back rather than trusted forever.
  it('bumps a file whose mtime is in the future', () => {
    const { fs, touched } = fakeFs({ '/a': { size: 1, mtimeMs: NOW + 60_000 } })
    touchIfStale(fs, '/a', NOW)
    expect(touched).toEqual([{ path: '/a', whenMs: NOW }])
  })

  it('does nothing for a file that is not there', () => {
    const { fs, touched } = fakeFs({})
    touchIfStale(fs, '/gone', NOW)
    expect(touched).toEqual([])
  })
})
