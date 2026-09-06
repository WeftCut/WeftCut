import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdates } from './updates.js'

function setup() {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(), autoDownload: false, autoInstallOnAppQuit: false, disableWebInstaller: false,
    allowPrerelease: true, allowDowngrade: true, logger: null,
  })
  const updates = createUpdates(engine as unknown as NonNullable<Parameters<typeof createUpdates>[0]>)
  return { engine, updates }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('application updates', () => {
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
    expect(engine.autoInstallOnAppQuit).toBe(true)
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
