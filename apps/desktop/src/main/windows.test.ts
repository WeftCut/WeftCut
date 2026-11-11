// rememberGeometry's capture discipline, driven through a stub BrowserWindow.
// Both arms exist for macOS. A window zoomed from birth has no pre-zoom rect,
// so getNormalBounds() reports the zoomed frame as "normal" bounds — persisting
// that overwrites a good restore-down size and made the stored rect differ
// between the first and later launches. And a zoom emits `resize` for every
// frame of its animation while the window still reads as not maximized, so the
// window is read a turn after its events rather than inside them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { markInternalWindow, quitIfLastUserWindowClosed, rememberGeometry, userFacingWindows } from './windows'
import type { Rect, WindowGeometry, WindowGeometryStore } from './windowGeometry'

// The window list and app.quit() are all the quit gate touches. vi.hoisted
// because the factory runs during the import phase, ahead of a plain `const`.
const { listed, quits } = vi.hoisted(() => ({
  listed: [] as unknown[],
  quits: [] as number[],
}))

vi.mock('electron', () => ({
  app: { quit: () => void quits.push(1) },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return listed
    }
  },
  screen: {},
  shell: {},
}))

function fakeWin(initial: Rect) {
  const handlers = new Map<string, () => void>()
  const state = { maximized: false, fullScreen: false, normalBounds: initial }
  const win = {
    on: (ev: string, cb: () => void) => void handlers.set(ev, cb),
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    getNormalBounds: () => state.normalBounds,
  }
  return { win: win as unknown as BrowserWindow, state, fire: (ev: string) => handlers.get(ev)?.() }
}

function fakeStore() {
  let current: WindowGeometry | null = null
  let flushed: WindowGeometry | null = null
  const store: WindowGeometryStore = {
    get: () => current,
    remember: (_label: string, geom: WindowGeometry) => void (current = geom),
    flush: () => void (flushed = current),
  }
  return { store, last: () => current, flushed: () => flushed }
}

/** Let the queued read run: the turn after the events that asked for it. */
const nextTurn = (): void => void vi.runAllTimers()

const NORMAL: Rect = { x: 100, y: 80, width: 1280, height: 800 }
const ZOOMED: Rect = { x: 0, y: -33, width: 1440, height: 900 }

describe('rememberGeometry — maximized capture', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the stored rect while maximized and refreshes only the flags', () => {
    const { win, state, fire } = fakeWin(NORMAL)
    const { store, last } = fakeStore()
    rememberGeometry(win, 'main', store)

    fire('move')
    nextTurn()
    expect(last()).toEqual({ bounds: NORMAL, maximized: false, fullScreen: false })

    // macOS zoom: getNormalBounds now reads the zoomed frame.
    state.maximized = true
    state.normalBounds = ZOOMED
    fire('maximize')
    nextTurn()
    expect(last()).toEqual({ bounds: NORMAL, maximized: true, fullScreen: false })

    // Un-maximize returns to truthful normal bounds — captured verbatim again.
    state.maximized = false
    state.normalBounds = { ...NORMAL, x: 120 }
    fire('unmaximize')
    nextTurn()
    expect(last()).toEqual({ bounds: { ...NORMAL, x: 120 }, maximized: false, fullScreen: false })
  })

  it('holds the first record steady across captures for a window zoomed from birth', () => {
    const { win, state, fire } = fakeWin(ZOOMED)
    const { store, last } = fakeStore()
    state.maximized = true
    rememberGeometry(win, 'main', store)

    // Nothing stored yet — the measurement is all there is.
    fire('maximize')
    nextTurn()
    expect(last()).toEqual({ bounds: ZOOMED, maximized: true, fullScreen: false })

    // Later maximized readbacks (however the frame settles) must not move it.
    state.normalBounds = { x: 0, y: 0, width: 1024, height: 677 }
    fire('move')
    nextTurn()
    expect(last()).toEqual({ bounds: ZOOMED, maximized: true, fullScreen: false })
  })

  it('never takes a frame of the zoom animation for the restore-down rect', () => {
    const { win, state, fire } = fakeWin(NORMAL)
    const { store, last } = fakeStore()
    rememberGeometry(win, 'main', store)
    fire('move')
    nextTurn()

    // The animation as macOS delivers it: every frame arrives inside one
    // blocking call, each reading as a normal window of that frame's size.
    for (const grow of [0.25, 0.5, 0.75, 0.99]) {
      state.normalBounds = {
        x: Math.round(NORMAL.x * (1 - grow)),
        y: Math.round(NORMAL.y * (1 - grow)),
        width: Math.round(NORMAL.width + (ZOOMED.width - NORMAL.width) * grow),
        height: Math.round(NORMAL.height + (ZOOMED.height - NORMAL.height) * grow),
      }
      fire('resize')
    }
    state.maximized = true
    state.normalBounds = ZOOMED
    fire('resize')
    fire('maximize')
    nextTurn()

    expect(last()).toEqual({ bounds: NORMAL, maximized: true, fullScreen: false })
  })

  it('saves a move at close even when its queued read has not run', () => {
    const { win, state, fire } = fakeWin(NORMAL)
    const { store, flushed } = fakeStore()
    rememberGeometry(win, 'main', store)

    const moved = { ...NORMAL, x: 340 }
    state.normalBounds = moved
    fire('move')
    fire('close')

    expect(flushed()).toEqual({ bounds: moved, maximized: false, fullScreen: false })
  })
})

// The offscreen Motif capture host is a listed BrowserWindow, so a quit decision
// made on the raw window count leaves the app running with nothing on screen.
describe('quitIfLastUserWindowClosed', () => {
  const win = (): BrowserWindow => ({ isDestroyed: () => false }) as unknown as BrowserWindow

  beforeEach(() => {
    listed.length = 0
    quits.length = 0
  })

  it('ignores an internal window when deciding who is left', () => {
    const editor = win()
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(editor, captureHost)

    expect(userFacingWindows()).toEqual([editor])
  })

  it('quits when only the offscreen capture host is still listed', () => {
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(captureHost) // the editor's `closed` already removed it from the list

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(1)
  })

  it('stays alive while any user-facing window remains', () => {
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(win(), captureHost) // e.g. the Performance Monitor outliving the editor

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(0)
  })

  it('skips a destroyed window still in the list', () => {
    listed.push({ isDestroyed: () => true } as unknown as BrowserWindow)

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(1)
  })
})
