import { describe, expect, it } from 'vitest'
import { OWNED_FILE_TYPES } from './fileTypes.js'
import { isOpenTarget, openHandoff, openTargetFromArgv, openTargetFromHandoff } from './openTarget.js'

const DEV_ARGV = ['/home/u/weftcut/node_modules/electron/dist/electron', '--user-data-dir=/home/u/x', '--no-sandbox', '/home/u/weftcut/out/main/index.js']

describe('openTargetFromArgv', () => {
  it('reads the file a packaged Windows launch was given', () => {
    const argv = ['C:\\Program Files\\WeftCut\\WeftCut.exe', 'C:\\Users\\u\\Videos\\Trip\\project.wcpr']
    expect(openTargetFromArgv(argv, 'C:\\Program Files\\WeftCut', 'win32')).toBe('C:\\Users\\u\\Videos\\Trip\\project.wcpr')
  })

  it('finds no target in an unpackaged run: the executable, switches and app entry are not files to open', () => {
    expect(openTargetFromArgv(DEV_ARGV, '/home/u/weftcut', 'linux')).toBeNull()
  })

  it('reads a pack given after an unpackaged run\'s app entry', () => {
    expect(openTargetFromArgv([...DEV_ARGV, '/home/u/Videos/trip.wcpk'], '/home/u/weftcut', 'linux')).toBe('/home/u/Videos/trip.wcpk')
  })

  it('never takes a switch as a target, even when its value names an owned file', () => {
    const argv = ['/opt/WeftCut/weftcut', '--user-data-dir=/home/u/x.wcpr', '--log-file=/home/u/Trip/project.wcpr']
    expect(openTargetFromArgv(argv, '/home/u', 'linux')).toBeNull()
  })

  it('turns a file:// URL (a Linux %U) into its path, decoding escaped spaces', () => {
    const argv = ['/opt/WeftCut/weftcut', 'file:///home/u/My%20Videos/Trip/project.wcpr']
    expect(openTargetFromArgv(argv, '/home/u', 'linux')).toBe('/home/u/My Videos/Trip/project.wcpr')
  })

  it('turns a Windows file:// URL into a drive path', () => {
    const argv = ['C:\\Program Files\\WeftCut\\WeftCut.exe', 'file:///C:/Users/u/My%20Videos/trip.wcpk']
    expect(openTargetFromArgv(argv, 'C:\\Users\\u', 'win32')).toBe('C:\\Users\\u\\My Videos\\trip.wcpk')
  })

  it('resolves a relative path against the launch folder', () => {
    expect(openTargetFromArgv(['/opt/WeftCut/weftcut', 'Trip/project.wcpr'], '/home/u/Videos', 'linux')).toBe('/home/u/Videos/Trip/project.wcpr')
    expect(openTargetFromArgv(['C:\\Program Files\\WeftCut\\WeftCut.exe', 'Trip\\project.wcpr'], 'C:\\Users\\u\\Videos', 'win32'))
      .toBe('C:\\Users\\u\\Videos\\Trip\\project.wcpr')
  })

  it('matches the extension in any case and answers the path as given', () => {
    const argv = ['C:\\Program Files\\WeftCut\\WeftCut.exe', 'C:\\Users\\u\\Videos\\TRIP.WCPK']
    expect(openTargetFromArgv(argv, 'C:\\Users\\u', 'win32')).toBe('C:\\Users\\u\\Videos\\TRIP.WCPK')
  })

  it('skips files of a type WeftCut does not own and takes the first owned one', () => {
    const argv = ['/opt/WeftCut/weftcut', '/home/u/clip.mp4', '/home/u/project.json', '/home/u/a.wcpr', '/home/u/b.wcpk']
    expect(openTargetFromArgv(argv, '/home/u', 'linux')).toBe('/home/u/a.wcpr')
  })
})

describe('isOpenTarget', () => {
  it.each(OWNED_FILE_TYPES.map((type) => type.ext))('accepts an absolute .%s path', (ext) => {
    expect(isOpenTarget(`/home/u/Trip/file.${ext}`, 'linux')).toBe(true)
    expect(isOpenTarget(`/Users/u/Trip/file.${ext}`, 'darwin')).toBe(true)
    expect(isOpenTarget(`C:\\Users\\u\\Trip\\file.${ext}`, 'win32')).toBe(true)
  })

  it('rejects a path that is relative on its platform', () => {
    expect(isOpenTarget('Trip/project.wcpr', 'linux')).toBe(false)
    expect(isOpenTarget('Trip\\project.wcpr', 'win32')).toBe(false)
    expect(isOpenTarget('C:project.wcpr', 'win32')).toBe(false)
    // A root without a drive names whichever drive its reader is on.
    expect(isOpenTarget('\\Users\\u\\project.wcpr', 'win32')).toBe(false)
    expect(isOpenTarget('/home/u/project.wcpr', 'win32')).toBe(false)
    expect(isOpenTarget('\\\\server\\share\\Trip\\project.wcpr', 'win32')).toBe(true)
    // A drive path is no absolute path off Windows.
    expect(isOpenTarget('C:\\Users\\u\\project.wcpr', 'linux')).toBe(false)
    expect(isOpenTarget('C:\\Users\\u\\project.wcpr', 'darwin')).toBe(false)
  })

  it('rejects a type WeftCut does not own, including the legacy project.json', () => {
    expect(isOpenTarget('/home/u/Trip/project.json', 'linux')).toBe(false)
    expect(isOpenTarget('/home/u/Trip/project.wcpr.bak', 'linux')).toBe(false)
    expect(isOpenTarget('C:\\Users\\u\\clip.mp4', 'win32')).toBe(false)
  })
})

describe('second-launch handoff', () => {
  it('carries a target to the running app unchanged', () => {
    for (const [target, platform] of [['/home/u/Trip/project.wcpr', 'linux'], ['C:\\Users\\u\\trip.wcpk', 'win32']] as const) {
      expect(openTargetFromHandoff(openHandoff(target), platform)).toBe(target)
    }
  })

  it('carries nothing when the second launch asked for nothing', () => {
    expect(openHandoff(null)).toBeUndefined()
    expect(openTargetFromHandoff(openHandoff(null), 'linux')).toBeNull()
  })

  it.each([
    ['a non-object', 'C:\\Users\\u\\project.wcpr'],
    ['null', null],
    ['a non-string open', { open: 42 }],
    ['an object without open', {}],
    ['a relative path', { open: 'Trip\\project.wcpr' }],
    ['an extension WeftCut does not own', { open: 'C:\\Users\\u\\Trip\\project.json' }],
  ])('rejects %s', (_label, data) => {
    expect(openTargetFromHandoff(data, 'win32')).toBeNull()
  })
})
