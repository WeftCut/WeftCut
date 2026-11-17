import fs from 'node:fs'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import type { UpdateDownloadResult, UpdateRestartResult, UpdateStatus } from '../shared/updates.js'

// No Electron runtime import: exercise the update lifecycle without launching
// the editor. The actual provider comes from the packaged app-update.yml.
type Updater = Pick<AppUpdater,
  'on' | 'checkForUpdates' | 'downloadUpdate' | 'autoDownload' | 'autoInstallOnAppQuit' | 'disableWebInstaller' |
  'allowPrerelease' | 'allowDowngrade' | 'logger' | 'quitAndInstall'>

/** Electron's own autoUpdater on macOS: Squirrel.Mac, behind electron-updater. */
type Squirrel = {
  on(event: 'update-downloaded', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  quitAndInstall(): void
}

/**
 * macOS differs only in when an install becomes final: Squirrel.Mac stages the
 * download, then installs it after any exit and cannot withdraw it, so a staged
 * update is `committed` (ADR 0170).
 */
export type MacInstall = {
  squirrel: Squirrel
  /** Why this copy cannot replace itself, or null when it can. */
  blocked: () => 'location' | null
}

/** Squirrel replaces the bundle in place: a copy running from the disk image,
 *  translocated by Gatekeeper (opened where it was downloaded instead of moved
 *  to Applications), or in a folder the user cannot write cannot update. */
export function macSelfUpdateBlocked(exe: string, access: (file: string) => void = file =>
  fs.accessSync(file, fs.constants.W_OK)): 'location' | null {
  // <bundle>.app/Contents/MacOS/<executable>; POSIX paths whatever the host,
  // so the unit tests read a macOS path the same on Windows CI.
  const bundle = path.posix.resolve(exe, '../../..')
  if (bundle.includes('/AppTranslocation/')) return 'location'
  try {
    access(bundle)
    access(path.posix.dirname(bundle))
  } catch {
    return 'location'
  }
  return null
}

/// How long the update restart waits for Squirrel to take the exit before
/// exiting itself; ShipIt still installs then, it only does not reopen the app.
export const SQUIRREL_HANDOFF_MS = 15_000

export function createUpdates(updater: Updater | null, lifecycle?: {
  installOnQuit: () => boolean
  skippedVersion?: () => string | undefined
  prepareRestart: (version: string) => Promise<void>
  quit: () => void
  /** Ends the process without another quit round (app.exit). */
  exit?: () => void
}, mac?: MacInstall) {
  let status: UpdateStatus = { phase: updater ? 'idle' : 'disabled' }
  let pending: Promise<void> | null = null
  let startup: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let restartPending: Promise<UpdateRestartResult> | null = null
  let downloadPending: Promise<boolean> | null = null
  let cancellationToken: CancellationToken | undefined
  let automaticDownload = false
  let installing = false
  // macOS: the download waiting for Squirrel to stage it, and whether the
  // update restart has handed the exit to Squirrel.
  let staging: { resolve: () => void, reject: (error: Error) => void } | null = null
  let handedOff = false
  const automatic = () => lifecycle?.installOnQuit() !== false
  // A skipped release is still offered to a manual check; only the unattended
  // download and install-on-exit step aside for it.
  const unattended = (version: string | undefined) =>
    automatic() && (!version || lifecycle?.skippedVersion?.() !== version)

  if (updater) {
    updater.logger = console
    // Checking only reads release metadata. We own the download decision so
    // opting out cannot write an installer to disk, even during a check.
    updater.autoDownload = false
    // Windows/Linux: our quit-event hook owns installation, after normal
    // shutdown has flushed. The library's hook cannot express the per-exit
    // restart intent and is only registered at download time, so toggling its
    // flag later is unreliable. macOS has no such hook: there the flag makes
    // electron-updater hand the zip to Squirrel as soon as it is downloaded,
    // which is the only point Squirrel can verify and stage it before an exit.
    updater.autoInstallOnAppQuit = !!mac
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
      // On macOS this fires when the zip is on disk, before Squirrel has
      // checked or staged it; Squirrel's own event below makes it ready.
      if (!mac) status = { phase: 'ready', version: info.version }
    })
    updater.on('update-cancelled', (info) => {
      status = { phase: 'available', version: info.version }
    })
    updater.on('error', (error) => {
      console.warn('[updates]', error)
      // A staged update installs at the next exit whatever fails after it.
      if (status.committed) return
      status = { phase: 'error', version: status.version }
    })
  }
  if (updater && mac) {
    mac.squirrel.on('update-downloaded', () => {
      if (status.version) status = { phase: 'ready', version: status.version, committed: true }
      staging?.resolve()
    })
    mac.squirrel.on('error', (error) => {
      staging?.reject(error)
      // Squirrel refused to take the exit: leave without reopening.
      if (handedOff) lifecycle?.exit?.()
    })
  }

  /** macOS: resolves once Squirrel has staged the download, rejects on its error. */
  function staged(): Promise<void> | null {
    if (!mac) return null
    return new Promise((resolve, reject) => { staging = { resolve, reject } })
  }

  function download(auto = false): Promise<boolean> {
    if (downloadPending) return downloadPending
    if (!updater || !status.version || !['available', 'error'].includes(status.phase)) return Promise.resolve(false)
    const version = status.version
    const reason = mac?.blocked() ?? null
    if (reason) {
      // Still offered, so the user learns of it; the copy says what to do.
      status = { phase: 'error', version, reason }
      return Promise.resolve(false)
    }
    const token = new CancellationToken()
    cancellationToken = token
    automaticDownload = auto
    status = { phase: 'downloading', version, percent: 0 }
    downloadPending = (async () => {
      // Armed before the download: Squirrel may stage before it settles.
      const stagedUpdate = staged()
      // Awaited only after a successful download; a failed one never reads it.
      stagedUpdate?.catch(() => {})
      try {
        await updater.downloadUpdate(token)
        // Squirrel reads the zip once it is downloaded, after cancellation can
        // no longer reach it; a cancel that lost this race ends staged.
        await stagedUpdate
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
      staging = null
      downloadPending = null
      automaticDownload = false
      // A cancelled token cannot be reused for a manual retry.
      cancellationToken = undefined
      if (token.cancelled && unattended(version)) void download(true)
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
        if (status.phase === 'available' && unattended(status.version)) await download(true)
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
      if (!unattended(status.version) && automaticDownload) cancellationToken?.cancel()
      else if (unattended(status.version) && status.phase === 'available') void download(true)
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
    /** Only call from Electron's final quit event, never from a UI button.
     *  Windows/Linux only: on macOS ShipIt installs after the process ends. */
    installOnQuit(exitCode: number) {
      if (!updater || mac || installing || exitCode !== 0) return
      const restart = status.phase === 'restarting'
      if (!restart && (status.phase !== 'ready' || !unattended(status.version))) return
      installing = true
      updater.quitAndInstall(true, restart)
    },
    /**
     * Only call from Electron's `will-quit`, which runs once the normal quit
     * has saved and closed every window. macOS only, and only for the update
     * restart: it keeps the process alive until Squirrel has recorded "reopen
     * after installing" and ends the process itself.
     *
     * LANDMINE: never hand over earlier, through Squirrel's quitAndInstall from
     * the restart button. Electron's version closes the windows first, and our
     * `window-all-closed` quit can then end the process before Squirrel has
     * recorded the relaunch: the update installs but the app stays closed.
     */
    handOffQuit(event: { preventDefault: () => void }) {
      if (!mac || handedOff || status.phase !== 'restarting' || !status.committed) return
      handedOff = true
      event.preventDefault()
      setTimeout(() => lifecycle?.exit?.(), SQUIRREL_HANDOFF_MS).unref()
      mac.squirrel.quitAndInstall()
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
