import type { AppUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/updates.js'

// No Electron runtime import: exercise the update lifecycle without launching
// the editor. The actual provider comes from the packaged app-update.yml.
type Updater = Pick<AppUpdater,
  'on' | 'checkForUpdates' | 'autoDownload' | 'autoInstallOnAppQuit' |
  'allowPrerelease' | 'allowDowngrade' | 'logger'>

export function createUpdates(updater: Updater | null) {
  let status: UpdateStatus = { phase: updater ? 'idle' : 'disabled' }
  let pending: Promise<void> | null = null
  let startup: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  if (updater) {
    updater.logger = console
    updater.autoDownload = true
    // Uses Electron's quit event, AFTER the existing async before-quit autosave.
    // Never call quitAndInstall: that bypasses the editor's normal exit flow.
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('checking-for-update', () => { status = { phase: 'checking' } })
    updater.on('update-not-available', () => { status = { phase: 'current' } })
    updater.on('update-available', (info) => {
      status = { phase: 'downloading', version: info.version, percent: 0 }
    })
    updater.on('download-progress', (progress) => {
      status = { ...status, phase: 'downloading', percent: Math.round(progress.percent) }
    })
    updater.on('update-downloaded', (info) => {
      status = { phase: 'ready', version: info.version }
    })
    updater.on('error', (error) => {
      console.warn('[updates]', error)
      status = { phase: 'error' }
    })
  }

  function check(): Promise<void> {
    if (!updater || status.phase === 'ready') return Promise.resolve()
    if (pending) return pending
    status = { phase: 'checking' }
    pending = (async () => {
      try {
        const result = await updater.checkForUpdates()
        // Checking resolves before the background download. Observe both promises
        // so an interrupted download never becomes an unhandled rejection.
        await result?.downloadPromise
      } catch (error) {
        console.warn('[updates]', error)
        status = { phase: 'error' }
      }
    })().finally(() => { pending = null })
    return pending
  }

  return {
    status: (): UpdateStatus => ({ ...status }),
    check,
    start() {
      if (!updater || startup || interval) return
      startup = setTimeout(() => { void check() }, 30_000)
      interval = setInterval(() => { void check() }, 6 * 60 * 60 * 1000)
      startup.unref()
      interval.unref()
    },
    stop() {
      clearTimeout(startup)
      clearInterval(interval)
      startup = undefined
      interval = undefined
    },
  }
}
