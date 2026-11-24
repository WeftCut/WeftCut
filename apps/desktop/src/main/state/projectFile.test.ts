import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { projectPathOf } from '../../shared/projectPath'
import { blankProject, SCHEMA_VERSION, type MediaItem, type Project } from './model'
import { seededGen } from './ids'
import { loadProjectFromJson, serializeProjectToJson } from './persistence'

const HASH = 'ab'.repeat(32)
const ID = '00000000-0000-0000-0000-0000000000aa'

/** The v6 fixture with one item as a Windows build wrote it. */
function windowsV6(): string {
  const wire = JSON.parse(readFileSync('fixtures/projects/v6.json', 'utf8')) as { media_pool: Record<string, Record<string, unknown>> }
  const item = wire.media_pool[ID]!
  item.path_rel = 'Media\\clip.mp4'
  item.path_abs = 'C:\\Users\\u\\Film\\Media\\clip.mp4'
  return JSON.stringify(wire)
}

function runtimeItem(over: Partial<MediaItem>): MediaItem {
  return {
    id: ID, label: null, path_abs: '/home/u/Film/Media/clip.mp4', path_rel: projectPathOf('Media', 'clip.mp4'), kind: 'Video',
    metadata: { duration_us: 1_000_000 }, file_hash_blake3: HASH, file_size: 1, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z',
    decode_route: { route: 'proxied', quick_proxy: `/home/u/Film/Cache/proxies/${HASH}.quick-q4.mp4`,
      full_proxy: `/home/u/Film/Cache/proxies/${HASH}.full-p7.mp4` },
    conform_path: `/home/u/Film/Cache/conform/${HASH}.wav`, waveform_path: `/home/u/Film/Cache/waveforms/${HASH}.bin`,
    thumbnails_dir: `/home/u/Film/Cache/thumbnails/${HASH}`, ...over,
  }
}

function withMedia(items: MediaItem[]): Project {
  return { ...blankProject(seededGen(), 'Film'), media_pool: Object.fromEntries(items.map(i => [i.id, i])) }
}

/** Every string anywhere in `value`, with where it sits. */
function strings(value: unknown, at = '$'): [string, string][] {
  if (typeof value === 'string') return [[at, value]]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`))
}

describe('the project file across machines', () => {
  it('opens a project a Windows build wrote at its media on Linux', () => {
    const { project } = loadProjectFromJson(windowsV6(), { dir: '/home/u/Film', platform: 'linux' })
    expect(project.media_pool[ID]).toMatchObject({ path_rel: 'Media/clip.mp4', path_abs: '/home/u/Film/Media/clip.mp4' })
  })

  it('opens the same project at its media on Windows', () => {
    const { project } = loadProjectFromJson(windowsV6(), { dir: 'C:\\Users\\u\\Film', platform: 'win32' })
    expect(project.media_pool[ID]).toMatchObject({ path_rel: 'Media/clip.mp4', path_abs: 'C:\\Users\\u\\Film\\Media\\clip.mp4' })
  })

  it('holds no absolute path but an external item\'s', () => {
    const external = runtimeItem({ id: 'ext', path_rel: null, path_abs: 'C:\\Users\\u\\Videos\\take.mov', decode_route: { route: 'bypass' } })
    const disk = JSON.parse(serializeProjectToJson(withMedia([runtimeItem({}), external])))
    const absolute = strings(disk).filter(([, s]) => path.posix.isAbsolute(s) || path.win32.isAbsolute(s))
    expect(absolute).toEqual([['$.media_pool.ext.path_abs', 'C:\\Users\\u\\Videos\\take.mov']])
  })

  it('writes the route as its tag and opens it with nothing ready', () => {
    const text = serializeProjectToJson(withMedia([runtimeItem({})]))
    expect(JSON.parse(text).media_pool[ID].decode_route).toEqual({ route: 'proxied' })
    const { project } = loadProjectFromJson(text, { dir: '/home/u/Moved', platform: 'linux' })
    expect(project.media_pool[ID]).toMatchObject({
      path_abs: '/home/u/Moved/Media/clip.mp4',
      decode_route: { route: 'proxied', quick_proxy: null, full_proxy: null },
      conform_path: null, waveform_path: null, thumbnails_dir: null,
    })
  })

  it('saves what it opened byte for byte', () => {
    const external = runtimeItem({ id: 'ext', path_rel: null, path_abs: '/home/u/Videos/take.mov', decode_route: { route: 'direct-export', quick_proxy: null } })
    const first = serializeProjectToJson(withMedia([runtimeItem({}), external]))
    const second = serializeProjectToJson(loadProjectFromJson(first, { dir: '/home/u/Film', platform: 'linux' }).project)
    expect(second).toBe(first)
    expect(serializeProjectToJson(loadProjectFromJson(second, { dir: 'C:\\Users\\u\\Film', platform: 'win32' }).project)).toBe(first)
  })

  it('refuses a current file whose path_rel is not a project path, naming the item', () => {
    const wire = JSON.parse(readFileSync('fixtures/projects/v8.json', 'utf8'))
    expect(wire.schema_version).toBe(SCHEMA_VERSION)
    wire.media_pool[ID].path_rel = 'Media\\x.mp4'
    expect(() => loadProjectFromJson(JSON.stringify(wire), { dir: '/home/u/Film', platform: 'linux' }))
      .toThrow(new RegExp(`media ${ID} path_rel: .*backslash`))
  })

  it('refuses an external item without its path', () => {
    const wire = JSON.parse(readFileSync('fixtures/projects/v7.json', 'utf8'))
    wire.media_pool[ID].path_rel = null
    expect(() => loadProjectFromJson(JSON.stringify(wire), { dir: '/home/u/Film', platform: 'linux' }))
      .toThrow(new RegExp(`media ${ID} has neither path_rel nor path_abs`))
  })
})
