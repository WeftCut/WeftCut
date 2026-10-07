import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdates } from './updates.js'

function setup(lifecycle?: Parameters<typeof createUpdates>[1]) {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(), autoDownload: false, autoInstallOnAppQuit: false, disableWebInstaller: false,
    allowPrerelease: true, allowDowngrade: true, logger: null, quitAndInstall: vi.fn(),
  })
  const updates = createUpdates(engine as unknown as NonNullable<Parameters<typeof createUpdates>[0]>, lifecycle)
  return { engine, updates }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('application updates', () => {
  it('reads the preference at exit, including changes made after download', () => {
    let enabled = false
    const { engine, updates } = setup({ installOnQuit: () => enabled, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.emit('update-downloaded', { version: '0.2.0' })
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    enabled = true
    updates.installOnQuit(1)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    updates.installOnQuit(0)
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
  })

  it('saves before quitting, then installs and reopens once without changing the disabled preference', async () => {
    let saved!: () => void
    const lifecycle = { installOnQuit: vi.fn(() => false),
      prepareRestart: vi.fn(() => new Promise<void>(resolve => { saved = resolve })), quit: vi.fn() }
    const { engine, updates } = setup(lifecycle)
    engine.emit('update-downloaded', { version: '0.2.0' })
    const first = updates.restart()
    expect(updates.restart()).toBe(first)
    expect(updates.status().phase).toBe('restarting')
    expect(lifecycle.prepareRestart).toHaveBeenCalledWith('0.2.0')
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    saved()
    expect(await first).toBe('restarting')
    expect(lifecycle.quit).toHaveBeenCalledOnce()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    updates.installOnQuit(0)
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true)
    expect(lifecycle.installOnQuit()).toBe(false)
  })

  it('keeps the application open and allows retry when restart preparation fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lifecycle = { installOnQuit: () => false,
      prepareRestart: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined), quit: vi.fn() }
    const { engine, updates } = setup(lifecycle)
    expect(await updates.restart()).toBe('not-ready')
    engine.emit('update-downloaded', { version: '0.2.0' })
    expect(await updates.restart()).toBe('save-failed')
    expect(updates.status()).toEqual({ phase: 'ready', version: '0.2.0' })
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(await updates.restart()).toBe('restarting')
    expect(lifecycle.quit).toHaveBeenCalledOnce()
  })
  it('never checks in unsupported or development builds', async () => {
    const updates = createUpdates(null)
    updates.start()
    await updates.check()
    expect(updates.status()).toEqual({ phase: 'disabled' })
    updates.stop()
  })

  it('coalesces checks through download and keeps a ready update until normal exit', async () => {
    const { engine, updates } = setup()
    let finish!: (files: string[]) => void
    const downloadPromise = new Promise<string[]>(resolve => { finish = resolve })
    engine.checkForUpdates.mockImplementation(async () => {
      engine.emit('update-available', { version: '0.1.2' })
      return { downloadPromise }
    })
    const first = updates.check()
    expect(updates.check()).toBe(first)
    engine.emit('download-progress', { percent: 42.3 })
    expect(updates.status()).toEqual({ phase: 'downloading', version: '0.1.2', percent: 42 })
    engine.emit('update-downloaded', { version: '0.1.2' })
    finish(['installer.exe'])
    await first
    await updates.check()
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updates.status()).toEqual({ phase: 'ready', version: '0.1.2' })
    expect(engine.autoInstallOnAppQuit).toBe(false) // our final quit hook owns installation
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, false)
    expect(engine.disableWebInstaller).toBe(true)
    expect(engine.allowPrerelease).toBe(false)
    expect(engine.allowDowngrade).toBe(false)
  })

  it('observes download rejection and allows retry after a network failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { engine, updates } = setup()
    engine.checkForUpdates.mockResolvedValueOnce({ downloadPromise: Promise.reject(new Error('offline')) })
    await updates.check()
    expect(updates.status().phase).toBe('error')
    engine.checkForUpdates.mockImplementationOnce(async () => {
      engine.emit('update-not-available')
      return null
    })
    await updates.check()
    expect(updates.status().phase).toBe('current')
  })

  it('delays the startup check and stops recurring checks at shutdown', async () => {
    vi.useFakeTimers()
    const { engine, updates } = setup()
    engine.checkForUpdates.mockResolvedValue(null)
    updates.start()
    updates.start()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2)
    updates.stop()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
