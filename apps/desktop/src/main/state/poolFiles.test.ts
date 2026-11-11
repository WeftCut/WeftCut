import { describe, expect, it, vi } from 'vitest'
import { createPoolFiles, type FileStat } from './poolFiles'
import { mediaItemTemplate } from './mutations/media'
import type { MediaItem } from './model'

const HASH = 'a'.repeat(64)
const SRC = '/p/Media/x.mp4'
const QUICK = '/p/Cache/proxies/x.quick.mp4'
const FULL = '/p/Cache/proxies/x.full.mp4'
const CONFORM = '/p/Cache/audio/x.conform'
const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  ...mediaItemTemplate('00000000-0000-0000-0000-0000000000aa', 'Video', 1_000_000),
  path_abs: SRC, file_hash_blake3: HASH, file_size: 100, file_mtime: 50, ...over,
})
const proxied = (over: Partial<MediaItem> = {}): MediaItem => item({
  decode_route: { route: 'proxied', quick_proxy: QUICK, full_proxy: FULL, format_version: 1 }, conform_path: CONFORM, ...over,
})
const pool = (...items: MediaItem[]): Record<string, MediaItem> => Object.fromEntries(items.map((m) => [m.id, m]))

/** A disk of regular files, counting every stat. `hold` parks async stats
 *  until `release`. */
function fixture(files: Record<string, FileStat> = { [SRC]: { size: 100, mtimeSecs: 50 } }, bytes = HASH) {
  const disk = new Map(Object.entries(files))
  let held: Array<() => void> | null = null
  const deps = {
    stat: vi.fn((p: string) => disk.get(p) ?? null),
    statAsync: vi.fn((p: string) => {
      const answer = () => disk.get(p) ?? null
      if (held === null) return Promise.resolve(answer())
      const queue = held
      return new Promise<FileStat | null>((resolve) => queue.push(() => resolve(answer())))
    }),
    hash: vi.fn(async () => bytes),
    confirmed: vi.fn(),
    changed: vi.fn(),
  }
  const statCalls = () => deps.stat.mock.calls.length + deps.statAsync.mock.calls.length
  const hold = () => { held = [] }
  const release = () => { const queue = held ?? []; held = null; queue.forEach((go) => go()) }
  return { deps, disk, statCalls, hold, release, files: createPoolFiles(deps) }
}
const sourceOf = (f: ReturnType<typeof fixture>, m: MediaItem) => f.files.read(pool(m))(m).source

describe('source file state', () => {
  it('is present when size and mtime are as recorded, without reading the bytes', async () => {
    const f = fixture()
    expect(sourceOf(f, item())).toBe('present')
    expect(await f.files.settle(item())).toBe('present')
    expect(f.deps.hash).not.toHaveBeenCalled()
  })

  it('is missing when nothing is there', () => {
    expect(sourceOf(fixture({}), item())).toBe('missing')
  })

  it('is changed at once when the size differs', () => {
    const f = fixture({ [SRC]: { size: 101, mtimeSecs: 50 } })
    expect(sourceOf(f, item())).toBe('changed')
    expect(f.deps.hash).not.toHaveBeenCalled()
  })

  it('does not judge an item still importing', () => {
    expect(sourceOf(fixture({ [SRC]: { size: 7, mtimeSecs: 1 } }), item({ file_hash_blake3: 'pending-x' }))).toBe('present')
  })

  // A project folder copied without its times: every mtime differs, the
  // bytes do not. Read once, recorded, and never flagged.
  it('reads the bytes once when only the mtime differs, and records the new mtime', async () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 99 } })
    expect(sourceOf(f, item())).toBe('present')
    expect(await f.files.settle(item())).toBe('present')
    expect(f.deps.hash).toHaveBeenCalledOnce()
    expect(f.deps.confirmed).toHaveBeenCalledWith(item(), 99)
    // What the summary said meanwhile was right: nothing to republish.
    expect(f.deps.changed).not.toHaveBeenCalled()
  })

  it('is changed once the read finds other bytes of the same size, and says so', async () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 99 } }, 'b'.repeat(64))
    const m = item()
    expect(sourceOf(f, m)).toBe('present')
    expect(await f.files.settle(m)).toBe('changed')
    expect(f.deps.changed).toHaveBeenCalledOnce()
    expect(sourceOf(f, m)).toBe('changed')
    expect(f.deps.confirmed).not.toHaveBeenCalled()
    expect(f.deps.hash).toHaveBeenCalledOnce()
  })

  it('reads one file at a time', async () => {
    let release!: () => void
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 99 }, '/p/Media/y.mp4': { size: 100, mtimeSecs: 99 } })
    f.deps.hash.mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve(HASH) }))
    const first = f.files.settle(item())
    const second = f.files.settle(item({ id: '00000000-0000-0000-0000-0000000000bb', path_abs: '/p/Media/y.mp4' }))
    await Promise.resolve()
    expect(f.deps.hash).toHaveBeenCalledOnce()
    release()
    expect(await first).toBe('present')
    expect(await second).toBe('present')
    expect(f.deps.hash).toHaveBeenCalledTimes(2)
  })

  it('settles from a fresh stat, and a cached fact it finds stale is republished', async () => {
    const f = fixture()
    const m = item()
    expect(sourceOf(f, m)).toBe('present')
    f.disk.delete(SRC)
    expect(await f.files.settle(m)).toBe('missing')
    expect(f.deps.changed).toHaveBeenCalledOnce()
    expect(sourceOf(f, m)).toBe('missing')
  })
})

describe('derivative files', () => {
  it('says which slots name a file that is there', () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [QUICK]: { size: 1, mtimeSecs: 1 }, [CONFORM]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    expect(f.files.read(pool(m))(m)).toEqual({ source: 'present', quick_proxy: true, full_proxy: false, conform: true })
  })

  it('an empty slot is not there and costs no stat', () => {
    const f = fixture()
    const m = item({ decode_route: { route: 'direct-export', quick_proxy: null }, conform_path: null })
    expect(f.files.read(pool(m))(m)).toEqual({ source: 'present', quick_proxy: false, full_proxy: false, conform: false })
    expect(f.deps.stat.mock.calls.map(([p]) => p)).toEqual([SRC])
  })
})

describe('when the files are read', () => {
  it('once per item object: reading the same pool again touches no disk', () => {
    const f = fixture()
    const m = proxied()
    f.files.read(pool(m))
    const after = f.statCalls()
    expect(after).toBeGreaterThan(0)
    for (let i = 0; i < 5; i++) f.files.read(pool(m))
    expect(f.statCalls()).toBe(after)
  })

  it('again for an item the model replaced, even at the same paths', () => {
    // A job's write-back replaces the item; the file it wrote may be at a
    // path the item already named, read missing before.
    const f = fixture()
    const before = proxied()
    expect(f.files.read(pool(before))(before).quick_proxy).toBe(false)
    f.disk.set(QUICK, { size: 1, mtimeSecs: 1 })
    const after = { ...before }
    expect(f.files.read(pool(after))(after).quick_proxy).toBe(true)
    expect(f.deps.changed).not.toHaveBeenCalled()
  })

  it('all again when fresh, republishing what had changed', () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [QUICK]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    f.files.read(pool(m))
    f.files.read(pool(m), true)
    expect(f.deps.changed).not.toHaveBeenCalled()
    f.disk.delete(QUICK)
    expect(f.files.read(pool(m), true)(m).quick_proxy).toBe(false)
    expect(f.deps.changed).toHaveBeenCalledOnce()
  })

  it('anew after clear', () => {
    const f = fixture()
    const m = item()
    f.files.read(pool(m))
    f.files.clear()
    f.disk.delete(SRC)
    expect(sourceOf(f, m)).toBe('missing')
    expect(f.deps.changed).not.toHaveBeenCalled()
  })

  it('for one item on recheck, republishing only a change', () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [CONFORM]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    f.files.read(pool(m))
    f.files.recheck(m.id)
    expect(f.deps.changed).not.toHaveBeenCalled()
    f.disk.delete(CONFORM)
    f.files.recheck(m.id)
    expect(f.deps.changed).toHaveBeenCalledOnce()
    expect(f.files.read(pool(m))(m).conform).toBe(false)
  })
})

describe('refresh', () => {
  it('reads every known path off the main thread and republishes a change', async () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [QUICK]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    f.files.read(pool(m))
    f.disk.delete(QUICK)
    f.disk.set(FULL, { size: 1, mtimeSecs: 1 })
    const syncBefore = f.deps.stat.mock.calls.length
    await f.files.refresh()
    expect(f.deps.stat.mock.calls.length).toBe(syncBefore)
    expect(f.deps.statAsync.mock.calls.map(([p]) => p).sort()).toEqual([CONFORM, FULL, QUICK, SRC].sort())
    expect(f.deps.changed).toHaveBeenCalledOnce()
    expect(f.files.read(pool(m))(m)).toMatchObject({ quick_proxy: false, full_proxy: true })
  })

  it('says nothing when nothing changed', async () => {
    const f = fixture()
    f.files.read(pool(proxied()))
    await f.files.refresh()
    expect(f.deps.changed).not.toHaveBeenCalled()
  })

  it('keeps an item no longer in the pool known: undo can bring it back', async () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [QUICK]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    f.files.read(pool(m))
    f.files.read(pool())
    f.disk.delete(QUICK)
    await f.files.refresh()
    expect(f.files.read(pool(m))(m).quick_proxy).toBe(false)
  })

  it('runs one at a time, and a call during a run queues exactly one more', async () => {
    const f = fixture()
    f.files.read(pool(item()))
    f.hold()
    const first = f.files.refresh()
    const second = f.files.refresh()
    const third = f.files.refresh()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(f.deps.statAsync).toHaveBeenCalledTimes(1)
    f.release()
    await first
    // The queued run read again: one per run, never one per call.
    expect(f.deps.statAsync).toHaveBeenCalledTimes(2)
  })

  it('drops a result for an item read again meanwhile, or forgotten by a clear', async () => {
    const f = fixture({ [SRC]: { size: 100, mtimeSecs: 50 }, [QUICK]: { size: 1, mtimeSecs: 1 } })
    const m = proxied()
    f.files.read(pool(m))
    f.hold()
    const running = f.files.refresh()
    // Read while the refresh is in flight: the job brought the proxy back.
    f.disk.delete(QUICK)
    f.release()
    f.disk.set(QUICK, { size: 1, mtimeSecs: 1 })
    const replaced = { ...m }
    f.files.read(pool(replaced))
    await running
    expect(f.files.read(pool(replaced))(replaced).quick_proxy).toBe(true)

    f.hold()
    const again = f.files.refresh()
    f.files.clear()
    f.disk.delete(QUICK)
    f.release()
    await again
    expect(f.deps.changed).not.toHaveBeenCalled()
  })
})
