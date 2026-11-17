import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdates, macSelfUpdateBlocked, SQUIRREL_HANDOFF_MS } from './updates.js'

function setup(lifecycle?: Parameters<typeof createUpdates>[1]) {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), autoDownload: true, autoInstallOnAppQuit: false, disableWebInstaller: false,
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
      return { cancellationToken: undefined }
    })
    engine.downloadUpdate.mockReturnValue(downloadPromise)
    const first = updates.check()
    expect(updates.check()).toBe(first)
    await Promise.resolve()
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
    expect(engine.autoDownload).toBe(false)
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('observes download rejection and allows retry after a network failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { engine, updates } = setup()
    engine.checkForUpdates.mockImplementationOnce(async () => {
      engine.emit('update-available', { version: '0.2.0' })
      return {}
    })
    engine.downloadUpdate.mockRejectedValueOnce(new Error('offline'))
    await updates.check()
    expect(updates.status().phase).toBe('error')
    engine.checkForUpdates.mockImplementationOnce(async () => {
      engine.emit('update-not-available')
      return null
    })
    await updates.check()
    expect(updates.status().phase).toBe('current')
  })

  it('checks on startup and from Help without downloading when automatic updates are off', async () => {
    vi.useFakeTimers()
    const { engine, updates } = setup({ installOnQuit: () => false, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.checkForUpdates.mockImplementation(async () => {
      engine.emit('update-available', { version: '0.2.0' })
      return {}
    })
    updates.start()
    await vi.advanceTimersByTimeAsync(5_000)
    await updates.check()
    expect(updates.status()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(await updates.restart()).toBe('not-ready')
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    updates.stop()
  })

  it('downloads once on explicit request, then saves, quits and installs despite opt-out', async () => {
    const lifecycle = { installOnQuit: () => false, prepareRestart: vi.fn(), quit: vi.fn() }
    const { engine, updates } = setup(lifecycle)
    engine.emit('update-available', { version: '0.2.0' })
    let finish!: () => void
    engine.downloadUpdate.mockImplementation(() => new Promise<string[]>(resolve => {
      finish = () => { engine.emit('update-downloaded', { version: '0.2.0' }); resolve(['installer']) }
    }))
    const first = updates.download()
    const second = updates.download()
    await updates.check()
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    expect(lifecycle.prepareRestart).not.toHaveBeenCalled()
    finish()
    expect(await first).toBe('ready')
    expect(await second).toBe('ready')
    expect(await updates.restart()).toBe('restarting')
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
    expect(lifecycle.prepareRestart).toHaveBeenCalledWith('0.2.0')
    expect(lifecycle.quit).toHaveBeenCalledOnce()
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('retains the available version for manual retry after download failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lifecycle = { installOnQuit: () => false, prepareRestart: vi.fn(), quit: vi.fn() }
    const { engine, updates } = setup(lifecycle)
    engine.emit('update-available', { version: '0.2.0' })
    engine.downloadUpdate.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => {
      engine.emit('update-downloaded', { version: '0.2.0' })
      return ['installer']
    })
    expect(await updates.download()).toBe('download-failed')
    expect(updates.status()).toEqual({ phase: 'error', version: '0.2.0' })
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(await updates.download()).toBe('ready')
  })

  it('starts downloading a known update when the automatic preference is enabled', async () => {
    let enabled = false
    const { engine, updates } = setup({ installOnQuit: () => enabled, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.emit('update-available', { version: '0.2.0' })
    engine.downloadUpdate.mockImplementation(async () => {
      engine.emit('update-downloaded', { version: '0.2.0' })
      return ['installer']
    })
    updates.preferenceChanged()
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    enabled = true
    updates.preferenceChanged()
    await Promise.resolve()
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
    expect(updates.status().phase).toBe('ready')
  })

  it('cancels a background download when opted out and allows a manual retry', async () => {
    let enabled = true
    const { engine, updates } = setup({ installOnQuit: () => enabled, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.checkForUpdates.mockImplementation(async () => {
      engine.emit('update-available', { version: '0.2.0' })
      return {}
    })
    engine.downloadUpdate.mockImplementationOnce(token => new Promise((_resolve, reject) => {
      token.once('cancel', () => reject(new Error('cancelled')))
    })).mockImplementationOnce(async () => {
      engine.emit('update-downloaded', { version: '0.2.0' })
      return ['installer']
    })
    const check = updates.check()
    await Promise.resolve()
    const token = engine.downloadUpdate.mock.calls[0][0]
    enabled = false
    updates.preferenceChanged()
    await check
    expect(token.cancelled).toBe(true)
    expect(updates.status()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(await updates.download()).toBe('ready')
    expect(engine.downloadUpdate.mock.calls[1][0].cancelled).toBe(false)
    expect(engine.downloadUpdate.mock.calls[1][0]).not.toBe(token)
  })

  it('rechecks the preference after the metadata request completes', async () => {
    let enabled = true
    const { engine, updates } = setup({ installOnQuit: () => enabled, prepareRestart: vi.fn(), quit: vi.fn() })
    let finish!: () => void
    engine.checkForUpdates.mockImplementation(() => new Promise(resolve => {
      finish = () => { engine.emit('update-available', { version: '0.2.0' }); resolve({}) }
    }))
    const check = updates.check()
    enabled = false
    updates.preferenceChanged()
    finish()
    await check
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(updates.status().phase).toBe('available')
  })

  it('does not cancel an explicitly requested download when the preference changes', async () => {
    let enabled = true
    const { engine, updates } = setup({ installOnQuit: () => enabled, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.emit('update-available', { version: '0.2.0' })
    let finish!: () => void
    engine.downloadUpdate.mockImplementation(() => new Promise<string[]>(resolve => {
      finish = () => { engine.emit('update-downloaded', { version: '0.2.0' }); resolve(['installer']) }
    }))
    const request = updates.download()
    enabled = false
    updates.preferenceChanged()
    expect(engine.downloadUpdate.mock.calls[0][0].cancelled).toBe(false)
    finish()
    expect(await request).toBe('ready')
  })

  it('offers a skipped version without downloading or installing it unattended', async () => {
    let skipped: string | undefined = '0.2.0'
    const { engine, updates } = setup({ installOnQuit: () => true, skippedVersion: () => skipped, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.checkForUpdates.mockImplementation(async () => {
      engine.emit('update-available', { version: '0.2.0' })
      return {}
    })
    await updates.check()
    expect(updates.status()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    // Un-skipping hands the version back to the automatic preference.
    engine.downloadUpdate.mockImplementation(async () => {
      engine.emit('update-downloaded', { version: '0.2.0' })
      return ['installer']
    })
    skipped = undefined
    updates.preferenceChanged()
    await vi.waitFor(() => expect(updates.status().phase).toBe('ready'))
    expect(engine.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('stops a background download and the exit install when its version is skipped', async () => {
    let skipped: string | undefined
    const { engine, updates } = setup({ installOnQuit: () => true, skippedVersion: () => skipped, prepareRestart: vi.fn(), quit: vi.fn() })
    engine.checkForUpdates.mockImplementation(async () => {
      engine.emit('update-available', { version: '0.2.0' })
      return {}
    })
    engine.downloadUpdate.mockImplementation(token => new Promise((_resolve, reject) => {
      token.once('cancel', () => reject(new Error('cancelled')))
    }))
    const check = updates.check()
    await Promise.resolve()
    const token = engine.downloadUpdate.mock.calls[0][0]
    skipped = '0.2.0'
    updates.preferenceChanged()
    await check
    expect(token.cancelled).toBe(true)
    expect(engine.downloadUpdate).toHaveBeenCalledOnce() // a cancelled skip is not restarted
    expect(updates.status()).toEqual({ phase: 'available', version: '0.2.0' })

    engine.emit('update-downloaded', { version: '0.2.0' })
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    // A newer release is not covered by the skip.
    engine.emit('update-downloaded', { version: '0.3.0' })
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
  })

  it('delays the startup check and stops recurring checks at shutdown', async () => {
    vi.useFakeTimers()
    const { engine, updates } = setup()
    engine.checkForUpdates.mockResolvedValue(null)
    updates.start()
    updates.start()
    await vi.advanceTimersByTimeAsync(4_999)
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

function setupMac(lifecycle: Parameters<typeof createUpdates>[1], blocked: () => 'location' | null = () => null) {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), autoDownload: true, autoInstallOnAppQuit: false, disableWebInstaller: false,
    allowPrerelease: true, allowDowngrade: true, logger: null, quitAndInstall: vi.fn(),
  })
  const squirrel = Object.assign(new EventEmitter(), { quitAndInstall: vi.fn() })
  const updates = createUpdates(engine as unknown as NonNullable<Parameters<typeof createUpdates>[0]>, lifecycle, { squirrel, blocked })
  // electron-updater's MacUpdater: its download settles once Squirrel has read
  // the zip, and announces the download before Squirrel has checked it.
  engine.checkForUpdates.mockImplementation(async () => {
    engine.emit('update-available', { version: '0.2.0' })
    return {}
  })
  engine.downloadUpdate.mockImplementation(async () => {
    engine.emit('update-downloaded', { version: '0.2.0' })
    return ['update.zip']
  })
  return { engine, squirrel, updates }
}
const lifecycleOf = (overrides: Partial<NonNullable<Parameters<typeof createUpdates>[1]>> = {}) =>
  ({ installOnQuit: () => true, prepareRestart: vi.fn(async () => {}), quit: vi.fn(), exit: vi.fn(), ...overrides })

describe('macOS updates (Squirrel stages the install)', () => {
  it('is ready only once Squirrel has staged the download, and then committed', async () => {
    const { engine, squirrel, updates } = setupMac(lifecycleOf())
    expect(engine.autoInstallOnAppQuit).toBe(true) // hand the zip to Squirrel right after download
    const check = updates.check()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(updates.status().phase).toBe('downloading')
    squirrel.emit('update-downloaded')
    await check
    expect(updates.status()).toEqual({ phase: 'ready', version: '0.2.0', committed: true })
  })

  it('leaves the install to the exit: no installer call, and later preferences cannot withdraw it', async () => {
    let enabled = true
    let skipped: string | undefined
    const { engine, squirrel, updates } = setupMac(lifecycleOf({ installOnQuit: () => enabled, skippedVersion: () => skipped }))
    const check = updates.check()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce())
    squirrel.emit('update-downloaded')
    await check
    enabled = false
    skipped = '0.2.0'
    updates.preferenceChanged()
    engine.emit('error', new Error('late'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    updates.installOnQuit(0)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(updates.status()).toEqual({ phase: 'ready', version: '0.2.0', committed: true })
  })

  it('hands the restart\'s final exit to Squirrel once, after the normal quit has run', async () => {
    const lifecycle = lifecycleOf()
    const { engine, squirrel, updates } = setupMac(lifecycle)
    const normalQuit = { preventDefault: vi.fn() }
    updates.handOffQuit(normalQuit)
    expect(normalQuit.preventDefault).not.toHaveBeenCalled()
    engine.emit('update-available', { version: '0.2.0' })
    const download = updates.download()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce())
    squirrel.emit('update-downloaded')
    expect(await download).toBe('ready')
    expect(await updates.restart()).toBe('restarting')
    expect(lifecycle.quit).toHaveBeenCalledOnce()
    expect(squirrel.quitAndInstall).not.toHaveBeenCalled()
    const willQuit = { preventDefault: vi.fn() }
    updates.handOffQuit(willQuit)
    expect(willQuit.preventDefault).toHaveBeenCalledOnce()
    expect(squirrel.quitAndInstall).toHaveBeenCalledOnce()
    // Squirrel ends the process through another quit round, which must pass.
    const again = { preventDefault: vi.fn() }
    updates.handOffQuit(again)
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(squirrel.quitAndInstall).toHaveBeenCalledOnce()
    expect(lifecycle.exit).not.toHaveBeenCalled()
  })

  it('exits without reopening when Squirrel refuses or stalls the handoff', async () => {
    vi.useFakeTimers()
    for (const ending of ['refuses', 'stalls'] as const) {
      const lifecycle = lifecycleOf()
      const { engine, squirrel, updates } = setupMac(lifecycle)
      engine.emit('update-available', { version: '0.2.0' })
      const download = updates.download()
      await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce())
      squirrel.emit('update-downloaded')
      await download
      await updates.restart()
      updates.handOffQuit({ preventDefault: vi.fn() })
      if (ending === 'refuses') squirrel.emit('error', new Error('relaunch failed'))
      else await vi.advanceTimersByTimeAsync(SQUIRREL_HANDOFF_MS)
      expect(lifecycle.exit, ending).toHaveBeenCalled()
    }
  })

  it('fails the download when Squirrel refuses the update, and allows a retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { engine, squirrel, updates } = setupMac(lifecycleOf({ installOnQuit: () => false }))
    engine.emit('update-available', { version: '0.2.0' })
    const first = updates.download()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledOnce())
    squirrel.emit('error', new Error('code signature does not satisfy the designated requirement'))
    expect(await first).toBe('download-failed')
    expect(updates.status()).toEqual({ phase: 'error', version: '0.2.0' })
    const second = updates.download()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalledTimes(2))
    squirrel.emit('update-downloaded')
    expect(await second).toBe('ready')
  })

  it('offers an update it cannot install where it runs, and never downloads it', async () => {
    const { engine, updates } = setupMac(lifecycleOf(), () => 'location')
    await updates.check()
    expect(updates.status()).toEqual({ phase: 'error', version: '0.2.0', reason: 'location' })
    expect(await updates.download()).toBe('download-failed')
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('macSelfUpdateBlocked', () => {
  const exe = '/Applications/WeftCut.app/Contents/MacOS/WeftCut'
  it('accepts a bundle it can replace in a folder it can write', () => {
    const access = vi.fn()
    expect(macSelfUpdateBlocked(exe, access)).toBeNull()
    expect(access.mock.calls.map(([file]) => file)).toEqual(['/Applications/WeftCut.app', '/Applications'])
  })
  it('refuses a translocated copy, a read-only volume and a folder it cannot write', () => {
    expect(macSelfUpdateBlocked('/private/var/folders/x/T/AppTranslocation/ABC/d/WeftCut.app/Contents/MacOS/WeftCut', () => {})).toBe('location')
    const readOnly = () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }) }
    expect(macSelfUpdateBlocked('/Volumes/WeftCut/WeftCut.app/Contents/MacOS/WeftCut', readOnly)).toBe('location')
    const parentDenied = (file: string) => { if (file === '/Applications') throw new Error('EACCES') }
    expect(macSelfUpdateBlocked(exe, parentDenied)).toBe('location')
  })
})
