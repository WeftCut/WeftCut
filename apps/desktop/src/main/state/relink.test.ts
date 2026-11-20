import { describe, it, expect } from 'vitest'
import { relinkMissingMedia, type RelinkFs } from './relink'
import { blankProject, type MediaItem, type Project } from './model'
import { seededGen } from './ids'
import { parseProjectPath } from '../../shared/projectPath'
import type { PathPlatform } from './projectPathNative'

/** In-memory fs: path → contents string (hash = `b3:${contents}` via fakeHash).
 *  `exists` folds case when the volume is case-insensitive, as NTFS and APFS
 *  do by default. */
function memFs(seed: Record<string, string>, opts: { caseInsensitive?: boolean } = {}) {
  const files = new Map(Object.entries(seed))
  const fold = (p: string) => (opts.caseInsensitive ? p.toLowerCase() : p)
  const fs: RelinkFs & { files: Map<string, string>; renames: [string, string][] } = {
    files,
    renames: [],
    exists: (p) => [...files.keys()].some((f) => fold(f) === fold(p)),
    walk: (dir) => [...files.keys()]
      .filter((p) => p.startsWith(dir + '/') || p.startsWith(dir + '\\'))
      .map((p) => ({ segments: p.slice(dir.length + 1).split(/[\\/]/), abs: p, size: files.get(p)!.length })),
    statFile: (p) => (files.has(p) ? { size: files.get(p)!.length, mtimeSecs: 777 } : null),
    rename: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT ${from}`)
      files.set(to, files.get(from)!)
      files.delete(from)
      fs.renames.push([from, to])
    },
  }
  return fs
}

const fakeHash = (fs: { files: Map<string, string> }) => async (p: string) => {
  const t = fs.files.get(p)
  if (t === undefined) throw new Error(`ENOENT ${p}`)
  return `b3:${t}`
}

function mediaItem(over: Partial<MediaItem>): MediaItem {
  return {
    id: 'm1', label: null, path_abs: '/ws/Media/clip.mp4', path_rel: parseProjectPath('Media/clip.mp4'), kind: 'Video',
    metadata: { duration_us: 1_000_000 }, decode_route: { route: 'bypass' },
    waveform_path: null, conform_path: null, thumbnails_dir: null,
    file_hash_blake3: 'b3:AAAA', file_size: 4, file_mtime: 1, imported_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function withPool(items: MediaItem[]): Project {
  const p = blankProject(seededGen(), 'RL')
  p.media_pool = Object.fromEntries(items.map((m) => [m.id, m]))
  return p
}

async function run(project: Project, fs: ReturnType<typeof memFs>, platform: PathPlatform = 'linux') {
  return relinkMissingMedia(project, platform === 'win32' ? 'C:\\ws' : '/ws', { fs, hashFile: fakeHash(fs), platform })
}

describe('relinkMissingMedia', () => {
  it('no-ops (same project reference) when every managed file exists', async () => {
    const fs = memFs({ '/ws/Media/clip.mp4': 'AAAA' })
    const project = withPool([mediaItem({})])
    const { project: out, report } = await run(project, fs)
    expect(out).toBe(project)
    expect(report).toEqual({ healed: [], missing: [] })
  })

  it('heals a mangled filename by renaming it back to the recorded name', async () => {
    // The mojibake scenario: bytes intact, on-disk name garbled in transit.
    // "鐢靛瓙姒ㄨ彍" is the GENUINE artifact — "电子榨菜"'s UTF-8 bytes decoded
    // as GBK, exactly what a flag-less zip does on a zh-CN Windows.
    const fs = memFs({ '/ws/Media/鐢靛瓙姒ㄨ彍.mp4': 'AAAA' })
    const { project: out, report } = await run(withPool([mediaItem({ path_rel: parseProjectPath('Media/电子榨菜.mp4'), path_abs: '/ws/Media/电子榨菜.mp4' })]), fs)
    expect(fs.renames).toEqual([['/ws/Media/鐢靛瓙姒ㄨ彍.mp4', '/ws/Media/电子榨菜.mp4']])
    expect(out.media_pool['m1'].path_abs).toBe('/ws/Media/电子榨菜.mp4')
    expect(out.media_pool['m1'].path_rel).toBe('Media/电子榨菜.mp4')  // recorded name kept
    expect(out.media_pool['m1'].file_mtime).toBe(777)                // fingerprint refreshed
    expect(report.healed).toEqual([{ media: 'm1', from: 'Media/鐢靛瓙姒ㄨ彍.mp4', to: 'Media/电子榨菜.mp4' }])
  })

  it('heals a file renamed inside a subfolder back to its recorded path there', async () => {
    const fs = memFs({ '/ws/Media/sub/b.mp4': 'AAAA' })
    const item = mediaItem({ path_rel: parseProjectPath('Media/sub/a.mp4'), path_abs: '/ws/Media/sub/a.mp4' })
    const { project: out, report } = await run(withPool([item]), fs)
    expect(fs.renames).toEqual([['/ws/Media/sub/b.mp4', '/ws/Media/sub/a.mp4']])
    expect(out.media_pool['m1'].path_rel).toBe('Media/sub/a.mp4')
    expect(report.healed).toEqual([{ media: 'm1', from: 'Media/sub/b.mp4', to: 'Media/sub/a.mp4' }])
  })

  it('finds a file anywhere under Media/ and moves it to the recorded folder', async () => {
    const fs = memFs({ '/ws/Media/elsewhere/deep/clip.mp4': 'AAAA' })
    const item = mediaItem({ path_rel: parseProjectPath('Media/sub/clip.mp4'), path_abs: '/ws/Media/sub/clip.mp4' })
    const { project: out } = await run(withPool([item]), fs)
    expect(fs.renames).toEqual([['/ws/Media/elsewhere/deep/clip.mp4', '/ws/Media/sub/clip.mp4']])
    expect(out.media_pool['m1'].path_abs).toBe('/ws/Media/sub/clip.mp4')
  })

  // An upgrade to project paths renames one of two names that fold alike
  // (`Clip.mp4`, `clip.mp4`) to `clip-2.mp4`; the file itself keeps its old
  // name until the project opens.
  it('renames a file still under its pre-upgrade name to the path the upgrade gave it', async () => {
    const fs = memFs({ '/ws/Media/Clip.mp4': 'BBBB', '/ws/Media/clip.mp4': 'AAAA' })
    const kept = mediaItem({ id: 'm2', path_rel: parseProjectPath('Media/Clip.mp4'), path_abs: '/ws/Media/Clip.mp4', file_hash_blake3: 'b3:BBBB' })
    const renamed = mediaItem({ id: 'm1', path_rel: parseProjectPath('Media/clip-2.mp4'), path_abs: '/ws/Media/clip-2.mp4' })
    const { project: out, report } = await run(withPool([kept, renamed]), fs)
    expect(fs.renames).toEqual([['/ws/Media/clip.mp4', '/ws/Media/clip-2.mp4']])
    expect(out.media_pool['m1'].path_rel).toBe('Media/clip-2.mp4')
    expect(report.missing).toEqual([])
  })

  it('adopts the found path when the recorded one is claimed by another item', async () => {
    // A case-sensitive disk under Windows rules: `Media/Clip.mp4` is m2's file,
    // so m1's `Media/clip.mp4` names it too and is no place to move bytes to.
    const fs = memFs({ 'C:\\ws\\Media\\Clip.mp4': 'BBBB', 'C:\\ws\\Media\\stray.mp4': 'AAAA' })
    const m2 = mediaItem({ id: 'm2', path_rel: parseProjectPath('Media/Clip.mp4'), path_abs: 'C:\\ws\\Media\\Clip.mp4', file_hash_blake3: 'b3:BBBB' })
    const m1 = mediaItem({ id: 'm1', path_rel: parseProjectPath('Media/clip.mp4'), path_abs: 'C:\\ws\\Media\\clip.mp4' })
    const { project: out } = await run(withPool([m1, m2]), fs, 'win32')
    expect(fs.renames).toEqual([])
    expect(fs.files.get('C:\\ws\\Media\\Clip.mp4')).toBe('BBBB')
    expect(out.media_pool['m1'].path_rel).toBe('Media/stray.mp4')
  })

  it('never adopts a found name that is not portable, but renames it to the recorded path', async () => {
    const fs = memFs({ '/ws/Media/take?.mp4': 'AAAA' })
    const { project: out } = await run(withPool([mediaItem({})]), fs)
    expect(fs.renames).toEqual([['/ws/Media/take?.mp4', '/ws/Media/clip.mp4']])
    expect(out.media_pool['m1'].path_rel).toBe('Media/clip.mp4')
  })

  it('leaves the item missing when a non-portable find cannot be renamed', async () => {
    const fs = memFs({ '/ws/Media/take?.mp4': 'AAAA' })
    fs.rename = () => { throw new Error('EPERM') }
    const { project: out, report } = await run(withPool([mediaItem({})]), fs)
    expect(report.missing).toEqual(['m1'])
    expect(out.media_pool['m1'].path_rel).toBe('Media/clip.mp4')
  })

  it('keeps names that differ only in case apart on Linux', async () => {
    // m2 holds `Clip.mp4`; `clip.mp4` is another file, free to heal m1.
    const fs = memFs({ '/ws/Media/Clip.mp4': 'BBBB', '/ws/Media/clip.mp4': 'AAAA' })
    const m2 = mediaItem({ id: 'm2', path_rel: parseProjectPath('Media/Clip.mp4'), path_abs: '/ws/Media/Clip.mp4', file_hash_blake3: 'b3:BBBB' })
    const m1 = mediaItem({ id: 'm1', path_rel: parseProjectPath('Media/gone.mp4'), path_abs: '/ws/Media/gone.mp4' })
    const { report } = await run(withPool([m1, m2]), fs)
    expect(report.healed.map((h) => h.media)).toEqual(['m1'])
    expect(fs.files.get('/ws/Media/Clip.mp4')).toBe('BBBB')
    expect(fs.files.get('/ws/Media/gone.mp4')).toBe('AAAA')
  })

  it('treats names that differ only in case as one file on Windows', async () => {
    // The volume answers `Media/Clip.mp4` with `clip.mp4`: that file is m2's.
    const fs = memFs({ 'C:\\ws\\Media\\clip.mp4': 'AAAA' }, { caseInsensitive: true })
    const m2 = mediaItem({ id: 'm2', path_rel: parseProjectPath('Media/Clip.mp4'), path_abs: 'C:\\ws\\Media\\Clip.mp4' })
    const m1 = mediaItem({ id: 'm1', path_rel: parseProjectPath('Media/gone.mp4'), path_abs: 'C:\\ws\\Media\\gone.mp4' })
    const { report } = await run(withPool([m1, m2]), fs, 'win32')
    expect(report.missing).toEqual(['m1'])
    expect(fs.renames).toEqual([])
  })

  it('adopts the found name when the rename itself fails', async () => {
    const fs = memFs({ '/ws/Media/stray.mp3': 'AAAA' })
    fs.rename = () => { throw new Error('EPERM') }
    const { project: out } = await run(withPool([mediaItem({})]), fs)
    expect(out.media_pool['m1'].path_rel).toBe('Media/stray.mp3')
  })

  it('never steals a file claimed by a healthy pool item', async () => {
    // m2 resolves fine at shared.mp4; m1 (same size, and hashing shared.mp4
    // WOULD match) must not rebind m2's file out from under it.
    const fs = memFs({ '/ws/Media/shared.mp4': 'AAAA' })
    const m1 = mediaItem({ id: 'm1', path_rel: parseProjectPath('Media/gone.mp4'), path_abs: '/ws/Media/gone.mp4' })
    const m2 = mediaItem({ id: 'm2', path_rel: parseProjectPath('Media/shared.mp4'), path_abs: '/ws/Media/shared.mp4' })
    const { report } = await run(withPool([m1, m2]), fs)
    expect(report.missing).toEqual(['m1'])
    expect(fs.files.has('/ws/Media/shared.mp4')).toBe(true)
  })

  it('requires BOTH size and hash to match', async () => {
    const fs = memFs({
      '/ws/Media/same-size-wrong-bytes.bin': 'BBBB', // size 4, hash differs
      '/ws/Media/wrong-size.bin': 'AAAAAA',          // would hash-match a prefix… but size gates first
    })
    const { report } = await run(withPool([mediaItem({})]), fs)
    expect(report.missing).toEqual(['m1'])
  })

  it('skips provisional (pending-*) hashes and external (path_rel null) items', async () => {
    const fs = memFs({ '/ws/Media/stray.bin': 'AAAA' })
    const pending = mediaItem({ id: 'p1', file_hash_blake3: 'pending-p1' })
    const external = mediaItem({ id: 'x1', path_rel: null, path_abs: '/elsewhere/src.mov' })
    const { project: out, report } = await run(withPool([pending, external]), fs)
    expect(report.healed).toEqual([])
    expect(report.missing).toEqual(['p1'])            // external items are out of scope entirely
    expect(out.media_pool['x1'].path_abs).toBe('/elsewhere/src.mov')
  })

  it('binds a duplicate-content second item to the first heal instead of leaving it missing', async () => {
    const fs = memFs({ '/ws/Media/stray.mp3': 'AAAA' })
    const a = mediaItem({ id: 'a', path_rel: parseProjectPath('Media/one.mp3'), path_abs: '/ws/Media/one.mp3' })
    const b = mediaItem({ id: 'b', path_rel: parseProjectPath('Media/two.mp3'), path_abs: '/ws/Media/two.mp3' })
    const { project: out, report } = await run(withPool([a, b]), fs)
    expect(report.healed).toHaveLength(2)
    expect(report.missing).toEqual([])
    expect(out.media_pool['a'].path_abs).toBe('/ws/Media/one.mp3') // renamed to a's recorded name
    expect(out.media_pool['b'].path_abs).toBe('/ws/Media/one.mp3') // b shares the same bytes
  })

  it('survives an unreadable candidate (hash failure) and keeps scanning', async () => {
    const fs = memFs({ '/ws/Media/locked.bin': 'AAAA', '/ws/Media/stray.mp3': 'AAAA' })
    const baseHash = fakeHash(fs)
    const failingHash = async (p: string) => {
      if (p.endsWith('locked.bin')) throw new Error('EBUSY')
      return baseHash(p)
    }
    const { report } = await relinkMissingMedia(withPool([mediaItem({})]), '/ws', { fs, hashFile: failingHash, platform: 'linux' })
    expect(report.healed).toHaveLength(1)
    expect(report.healed[0].from).toBe('Media/stray.mp3')
  })
})
