import type { AppUpdater } from 'electron-updater'
import type { UpdateRestartResult, UpdateStatus } from '../shared/updates.js'

// No Electron runtime import: exercise the update lifecycle without launching
// the editor. The actual provider comes from the packaged app-update.yml.
type Updater = Pick<AppUpdater,
  'on' | 'checkForUpdates' | 'autoDownload' | 'autoInstallOnAppQuit' | 'disableWebInstaller' |
  'allowPrerelease' | 'allowDowngrade' | 'logger' | 'quitAndInstall'>

export function createUpdates(updater: Updater | null, lifecycle?: {
  installOnQuit: () => boolean
  prepareRestart: (version: string) => Promise<void>
  quit: () => void
}) {
  let status: UpdateStatus = { phase: updater ? 'idle' : 'disabled' }
  let pending: Promise<void> | null = null
  let startup: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let restartPending: Promise<UpdateRestartResult> | null = null
  let installing = false

  if (updater) {
    updater.logger = console
    updater.autoDownload = true
    // Our quit-event hook owns installation, after normal shutdown has flushed.
    // The library's hook cannot express the per-exit restart intent and is only
    // registered at download time, so toggling its flag later is unreliable.
    updater.autoInstallOnAppQuit = false
    // Releases ship the full NSIS installer, never electron-builder's web
    // installer stub; saying so keeps electron-updater from warning about it and
    // from changing behaviour when its default flips.
    updater.disableWebInstaller = true
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
    if (!updater || status.phase === 'ready' || status.phase === 'restarting') return Promise.resolve()
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
    restart(): Promise<UpdateRestartResult> {
      if (restartPending) return restartPending
      if (!updater || !lifecycle || status.phase !== 'ready' || !status.version) return Promise.resolve('not-ready')
      const ready = status
      status = { ...ready, phase: 'restarting' }
      restartPending = (async (): Promise<UpdateRestartResult> => {
        try {
          await lifecycle.prepareRestart(ready.version!)
          lifecycle.quit()
          return 'restarting'
        } catch (error) {
          console.warn('[updates] restart preparation failed', error)
          status = ready
          return 'save-failed'
        } finally {
          restartPending = null
        }
      })()
      return restartPending
    },
    /** Only call from Electron's final quit event, never from a UI button. */
    installOnQuit(exitCode: number) {
      if (!updater || installing || exitCode !== 0) return
      const restart = status.phase === 'restarting'
      if (!restart && (status.phase !== 'ready' || lifecycle?.installOnQuit() === false)) return
      installing = true
      updater.quitAndInstall(true, restart)
    },
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
