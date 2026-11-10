// Windows notification identity and click activation (ADR 0163). Owns the
// AUMID, the toast activator CLSID, the installer shortcut's CLSID stamp and
// the activation callback. Does not own showing notifications: that is the
// `notification:send` IPC in index.ts.

import type { ShortcutDetails } from 'electron'
import type { WindowsAppIdentity } from './appIdentity.js'

/// The Electron calls this module makes, injected so their order is testable
/// without Windows (Vitest cannot load `electron`).
export interface WindowsNotificationHost {
  setAppUserModelId(id: string): void
  setToastActivatorCLSID(id: string): void
  shortcutExists(lnk: string): boolean
  readShortcutLink(lnk: string): ShortcutDetails
  updateShortcutLink(lnk: string, details: ShortcutDetails): boolean
  handleActivation(callback: () => void): void
  /// Notification.isSupported(): its first call builds Electron's notification
  /// presenter, which registers the toast activator for this process.
  registerActivator(): void
}

export type InstallerShortcutStamp = 'none' | 'absent' | 'current' | 'stamped' | 'failed'

export function installWindowsNotifications(
  host: WindowsNotificationHost,
  opts: {
    identity: WindowsAppIdentity
    /// The installer's Start Menu shortcut, the one Electron also manages for
    /// toasts. Null for an unpackaged run, whose shortcut Electron creates.
    installerShortcut: string | null
    onActivation: () => void
  },
): InstallerShortcutStamp {
  const { identity } = opts
  host.setAppUserModelId(identity.appUserModelId)
  host.setToastActivatorCLSID(identity.toastActivatorClsid)
  // Before registerActivator: Electron then reads this shortcut, adopts the
  // CLSID it carries and rewrites the shortcut (description and icon included)
  // unless that CLSID is the app's own. The installer recreates the shortcut
  // without one on every update.
  const stamp = stampInstallerShortcut(host, opts.installerShortcut, identity.toastActivatorClsid)
  host.handleActivation(opts.onActivation)
  // At startup, not on the first notification: a click on a notification
  // while WeftCut is closed starts it with -Embedding, and Windows terminates
  // that process if it has not registered the activator within 120 s.
  host.registerActivator()
  return stamp
}

function stampInstallerShortcut(host: WindowsNotificationHost, lnk: string | null, clsid: string): InstallerShortcutStamp {
  if (lnk === null) return 'none'
  // An all-users install keeps its shortcut under ProgramData, which this
  // unelevated process cannot write; a user may also have deleted it. Either
  // way the installer owns the shortcut's existence, so none is created here.
  if (!host.shortcutExists(lnk)) return 'absent'
  try {
    const current = host.readShortcutLink(lnk)
    if (current.toastActivatorClsid?.toUpperCase() === clsid.toUpperCase()) return 'current'
    return host.updateShortcutLink(lnk, { target: current.target, toastActivatorClsid: clsid }) ? 'stamped' : 'failed'
  } catch {
    return 'failed'
  }
}
