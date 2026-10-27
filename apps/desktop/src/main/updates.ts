import type { AppUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import type { UpdateDownloadResult, UpdateRestartResult, UpdateStatus } from '../shared/updates.js'

// No Electron runtime import: exercise the update lifecycle without launching
// the editor. The actual provider comes from the packaged app-update.yml.
type Updater = Pick<AppUpdater,
  'on' | 'checkForUpdates' | 'downloadUpdate' | 'autoDownload' | 'autoInstallOnAppQuit' | 'disableWebInstaller' |
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
  let downloadPending: Promise<boolean> | null = null
  let cancellationToken: CancellationToken | undefined
  let automaticDownload = false
  let installing = false
  const automatic = () => lifecycle?.installOnQuit() !== false

  if (updater) {
    updater.logger = console
    // Checking only reads release metadata. We own the download decision so
    // opting out cannot write an installer to disk, even during a check.
    updater.autoDownload = false
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
      status = { phase: 'available', version: info.version }
    })
    updater.on('download-progress', (progress) => {
      status = { ...status, phase: 'downloading', percent: Math.round(progress.percent) }
    })
    updater.on('update-downloaded', (info) => {
      status = { phase: 'ready', version: info.version }
    })
    updater.on('update-cancelled', (info) => {
      status = { phase: 'available', version: info.version }
    })
    updater.on('error', (error) => {
      console.warn('[updates]', error)
      status = { phase: 'error', version: status.version }
    })
  }

  function download(auto = false): Promise<boolean> {
    if (downloadPending) return downloadPending
    if (!updater || !status.version || !['available', 'error'].includes(status.phase)) return Promise.resolve(false)
    const version = status.version
    const token = new CancellationToken()
    cancellationToken = token
    automaticDownload = auto
    status = { phase: 'downloading', version, percent: 0 }
    downloadPending = (async () => {
      try {
        await updater.downloadUpdate(token)
        return status.phase === 'ready'
      } catch (error) {
        if (token.cancelled) status = { phase: 'available', version }
        else {
          console.warn('[updates]', error)
          status = { phase: 'error', version }
        }
        return false
      }
    })().finally(() => {
      downloadPending = null
      automaticDownload = false
      // A cancelled token cannot be reused for a manual retry.
      cancellationToken = undefined
      if (token.cancelled && automatic()) void download(true)
    })
    return downloadPending
  }

  function check(): Promise<void> {
    if (!updater || ['downloading', 'ready', 'restarting'].includes(status.phase)) return pending ?? Promise.resolve()
    if (pending) return pending
    status = { phase: 'checking' }
    pending = (async () => {
      try {
        await updater.checkForUpdates()
        if (status.phase === 'available' && automatic()) await download(true)
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
    preferenceChanged() {
      if (!automatic() && automaticDownload) cancellationToken?.cancel()
      else if (automatic() && status.phase === 'available') void download(true)
    },
    async download(): Promise<UpdateDownloadResult> {
      if (!updater || !status.version || !['available', 'error', 'downloading', 'ready'].includes(status.phase)) {
        return 'not-ready'
      }
      automaticDownload = false
      return status.phase === 'ready' || await download() ? 'ready' : 'download-failed'
    },
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
      startup = setTimeout(() => { void check() }, 5_000)
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
