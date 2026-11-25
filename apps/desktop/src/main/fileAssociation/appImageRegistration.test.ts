import { describe, expect, it } from 'vitest'
import {
  APPIMAGE_DESKTOP_FILE,
  desktopEntry,
  desktopExecArgument,
  mimePackage,
  registerAppImageFileTypes,
  xdgDataHome,
  type AppImageRegistrationIo,
} from './appImageRegistration.js'
import { OWNED_FILE_TYPES } from './fileTypes.js'

describe('desktopExecArgument', () => {
  // The desktop entry spec's Exec key: quoting escapes `"`, `` ` ``, `$` and
  // `\`, the string rule then doubles every `\`, and `%` is doubled as a
  // literal rather than a field code.
  it.each([
    ['a space, kept inside the quotes', '/home/u/My Apps/WeftCut.AppImage', '"/home/u/My Apps/WeftCut.AppImage"'],
    ['a dollar sign', '/home/u/a$b.AppImage', '"/home/u/a\\\\$b.AppImage"'],
    ['a double quote', '/home/u/a"b.AppImage', '"/home/u/a\\\\"b.AppImage"'],
    ['a backtick', '/home/u/a`b.AppImage', '"/home/u/a\\\\`b.AppImage"'],
    ['a backslash', '/home/u/a\\b.AppImage', '"/home/u/a\\\\\\\\b.AppImage"'],
    ['a percent sign', '/home/u/100%.AppImage', '"/home/u/100%%.AppImage"'],
    ['every repeat of a character', '/home/u/a$b$c\\d\\e 50%%.AppImage', '"/home/u/a\\\\$b\\\\$c\\\\\\\\d\\\\\\\\e 50%%%%.AppImage"'],
  ])('escapes %s', (_label, file, expected) => {
    expect(desktopExecArgument(file)).toBe(expected)
  })
})

describe('desktopEntry', () => {
  const lines = (text: string) => text.split('\n')

  it('runs the AppImage with the opened files as URLs', () => {
    const appImage = '/home/u/My Apps/WeftCut.AppImage'
    expect(lines(desktopEntry(appImage, null))).toContain(`Exec=${desktopExecArgument(appImage)} %U`)
  })

  it('lists every owned MIME type, each closed by a semicolon', () => {
    const expected = `MimeType=${OWNED_FILE_TYPES.map((type) => `${type.mime};`).join('')}`
    expect(lines(desktopEntry('/home/u/WeftCut.AppImage', null))).toContain(expected)
  })

  it('is a handler, hidden from the application menu', () => {
    expect(lines(desktopEntry('/home/u/WeftCut.AppImage', null))).toContain('NoDisplay=true')
  })

  it('names an icon only when one is given', () => {
    expect(lines(desktopEntry('/home/u/WeftCut.AppImage', null)).some((line) => line.startsWith('Icon='))).toBe(false)
    expect(lines(desktopEntry('/home/u/WeftCut.AppImage', '/home/u/.config/WeftCut/appimage-icon.png')))
      .toContain('Icon=/home/u/.config/WeftCut/appimage-icon.png')
  })
})

describe('mimePackage', () => {
  it('declares each owned type with the glob of its own extension', () => {
    const blocks = mimePackage().split('</mime-type>').slice(0, -1)
    expect(blocks).toHaveLength(OWNED_FILE_TYPES.length)
    for (const type of OWNED_FILE_TYPES) {
      const block = blocks.find((text) => text.includes(`<mime-type type="${type.mime}">`))
      expect(block, type.mime).toBeDefined()
      expect(block).toContain(`<glob pattern="*.${type.ext}"/>`)
      expect(block).toContain(`<comment>${type.description}</comment>`)
    }
  })
})

describe('xdgDataHome', () => {
  it('uses an absolute XDG_DATA_HOME', () => {
    expect(xdgDataHome({ XDG_DATA_HOME: '/home/u/data' }, '/home/u')).toBe('/home/u/data')
  })

  it.each([
    ['unset', {}],
    ['empty', { XDG_DATA_HOME: '' }],
    ['relative', { XDG_DATA_HOME: 'data' }],
  ])('falls back to ~/.local/share when XDG_DATA_HOME is %s', (_label, env) => {
    expect(xdgDataHome(env, '/home/u')).toBe('/home/u/.local/share')
  })
})

describe('registerAppImageFileTypes', () => {
  const DATA_HOME = '/home/u/.local/share'
  const DESKTOP_FILE = `${DATA_HOME}/applications/${APPIMAGE_DESKTOP_FILE}`
  const MIME_DATABASE = ['update-mime-database', `${DATA_HOME}/mime`]
  const DESKTOP_DATABASE = ['update-desktop-database', `${DATA_HOME}/applications`]

  /** Each write, and each refresh that succeeds, stamps its file one tick
   *  later than the last: a refresh writes the cache it owns. */
  const CACHE_OF: Record<string, string> = { 'update-mime-database': 'mime.cache', 'update-desktop-database': 'mimeinfo.cache' }
  function memoryIo(run: AppImageRegistrationIo['run'] = async () => {}) {
    const files = new Map<string, string>()
    const stamps = new Map<string, number>()
    let clock = 0
    const writes: string[] = []
    const runs: string[][] = []
    const io: AppImageRegistrationIo = {
      readText: (file) => files.get(file) ?? null,
      writeText: (file, text) => { files.set(file, text); stamps.set(file, ++clock); writes.push(file) },
      modifiedMs: (file) => stamps.get(file) ?? null,
      run: async (command, args) => {
        runs.push([command, ...args])
        await run(command, args)
        stamps.set(`${args[0]}/${CACHE_OF[command]}`, ++clock)
      },
    }
    const reset = () => { writes.length = 0; runs.length = 0 }
    return { io, files, writes, runs, reset }
  }

  const target = (appImage = '/home/u/Apps/WeftCut.AppImage') => ({ appImage, dataHome: DATA_HOME, icon: null })

  it('writes the MIME package and desktop entry, then refreshes both caches', async () => {
    const { io, files, writes, runs } = memoryIo()
    expect(await registerAppImageFileTypes(target(), io)).toBe(true)
    expect(writes).toHaveLength(2)
    expect(files.get(DESKTOP_FILE)).toBe(desktopEntry('/home/u/Apps/WeftCut.AppImage', null))
    const packages = writes.filter((file) => file.startsWith(`${DATA_HOME}/mime/packages/`))
    expect(packages).toHaveLength(1)
    expect(files.get(packages[0])).toBe(mimePackage())
    expect(runs).toEqual(expect.arrayContaining([MIME_DATABASE, DESKTOP_DATABASE]))
    expect(runs).toHaveLength(2)
  })

  it('touches nothing when the registration is already current', async () => {
    const { io, writes, runs, reset } = memoryIo()
    await registerAppImageFileTypes(target(), io)
    reset()
    expect(await registerAppImageFileTypes(target(), io)).toBe(false)
    expect(writes).toEqual([])
    expect(runs).toEqual([])
  })

  it('rewrites only the desktop entry when the AppImage moved', async () => {
    const { io, files, writes, runs, reset } = memoryIo()
    await registerAppImageFileTypes(target(), io)
    reset()
    expect(await registerAppImageFileTypes(target('/home/u/Downloads/WeftCut.AppImage'), io)).toBe(true)
    expect(writes).toEqual([DESKTOP_FILE])
    expect(files.get(DESKTOP_FILE)).toBe(desktopEntry('/home/u/Downloads/WeftCut.AppImage', null))
    expect(runs).toEqual([DESKTOP_DATABASE])
  })

  it('keeps the written files when a cache tool fails, and refreshes again on the next start', async () => {
    let failing = true
    const { io, writes, runs, reset } = memoryIo(async (command) => { if (failing) throw new Error(`${command}: not found`) })
    await expect(registerAppImageFileTypes(target(), io)).resolves.toBe(true)
    expect(writes).toHaveLength(2)
    failing = false
    reset()
    expect(await registerAppImageFileTypes(target(), io)).toBe(false)
    expect(writes).toEqual([])
    expect(runs, 'the failed refreshes were not retried').toEqual(expect.arrayContaining([MIME_DATABASE, DESKTOP_DATABASE]))
  })

  it('registers nothing for a path a desktop entry cannot hold', async () => {
    const { io, writes, runs } = memoryIo()
    expect(await registerAppImageFileTypes(target('/home/u/Apps\nExec=/bin/sh.AppImage'), io)).toBe(false)
    expect(writes).toEqual([])
    expect(runs).toEqual([])
  })
})
