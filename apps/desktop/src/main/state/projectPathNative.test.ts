import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProjectPath } from '../../shared/projectPath'
import { fromNative, toNative, type PathPlatform } from './projectPathNative'

const vectors = JSON.parse(readFileSync('fixtures/project-paths.json', 'utf8')) as { valid: string[] }

const PLATFORMS: { platform: PathPlatform; dir: string; lib: path.PlatformPath }[] = [
  { platform: 'win32', dir: 'C:\\Users\\u\\Project', lib: path.win32 },
  { platform: 'linux', dir: '/home/u/Project', lib: path.posix },
]

describe.each(PLATFORMS)('$platform', ({ platform, dir, lib }) => {
  it('toNative stays inside the project folder', () => {
    for (const s of vectors.valid) {
      const abs = toNative(dir, parseProjectPath(s), platform)
      const rel = lib.relative(dir, abs)
      expect(rel === '' || rel.split(lib.sep)[0] === '..' || lib.isAbsolute(rel), abs).toBe(false)
    }
  })

  it('fromNative inverts toNative', () => {
    for (const s of vectors.valid) {
      const p = parseProjectPath(s)
      expect(fromNative(dir, toNative(dir, p, platform), platform)).toBe(p)
    }
  })

  it('fromNative refuses the folder itself and paths outside it', () => {
    expect(fromNative(dir, dir, platform)).toBeNull()
    expect(fromNative(dir, lib.dirname(dir), platform)).toBeNull()
    expect(fromNative(dir, lib.join(lib.dirname(dir), 'Other', 'x.mp4'), platform)).toBeNull()
    expect(fromNative(dir, `${dir}Sibling${lib.sep}x.mp4`, platform)).toBeNull()
  })

  it('fromNative refuses dot segments instead of resolving them', () => {
    expect(fromNative(dir, [dir, 'Media', '..', 'Media', 'x.mp4'].join(lib.sep), platform)).toBeNull()
    expect(fromNative(dir, [dir, '.', 'Media', 'x.mp4'].join(lib.sep), platform)).toBeNull()
  })

  it('fromNative refuses a name that is not portable', () => {
    expect(fromNative(dir, lib.join(dir, 'Media', 'CON.mp4'), platform)).toBeNull()
    expect(fromNative(dir, lib.join(dir, 'Media', 'cafe\u0301.mp4'), platform)).toBeNull()
  })
})

describe('separators', () => {
  it('a posix name holding a backslash is not portable', () => {
    expect(fromNative('/home/u/Project', '/home/u/Project/Media/a\\b.mp4', 'linux')).toBeNull()
  })

  it('a win32 path written with either separator maps to the same project path', () => {
    expect(fromNative('C:\\Users\\u\\Project', 'C:/Users/u/Project/Media/x.mp4', 'win32')).toBe('Media/x.mp4')
  })

  it('a win32 path on another drive is outside', () => {
    expect(fromNative('C:\\Users\\u\\Project', 'D:\\Users\\u\\Project\\Media\\x.mp4', 'win32')).toBeNull()
  })
})
