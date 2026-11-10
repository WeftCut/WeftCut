/// The Windows identity of a WeftCut process: the AppUserModelID (taskbar icon,
/// window grouping, notification settings) and the toast activator CLSID (the
/// COM class Windows calls when a notification is clicked). See ADR 0163.
export interface WindowsAppIdentity {
  appUserModelId: string
  toastActivatorClsid: string
}

/// The installed app's identity. Both values are STABLE across releases:
/// changing the AUMID orphans pinned shortcuts and the user's notification
/// settings; changing the CLSID strands notifications already in the
/// notification center.
///
/// `appUserModelId` MUST equal `appId` in electron-builder.yml: the NSIS
/// installer stamps `appId` onto the Start Menu and Desktop shortcuts, and
/// Windows links a window to its shortcut only when the two match (otherwise a
/// blank taskbar icon). appIdentity.test.ts pins them.
export const PACKAGED_WINDOWS_IDENTITY: WindowsAppIdentity = {
  appUserModelId: 'dev.weftcut.desktop',
  toastActivatorClsid: '{F11EC90E-A84C-4AF9-B399-DE90E30282A2}',
}

/// An unpackaged run's identity. It differs from the installed app's in both
/// fields: Electron gives an unpackaged run its own Start Menu shortcut to a
/// bare electron.exe, and two shortcuts claiming one AUMID let Windows route
/// the installed app's notification clicks through the dev one.
export const DEV_WINDOWS_IDENTITY: WindowsAppIdentity = {
  appUserModelId: 'dev.weftcut.desktop.dev',
  toastActivatorClsid: '{D0AB06A7-435F-4AB3-8FAE-4E9C6FA99FF3}',
}

export function windowsAppIdentity(packaged: boolean): WindowsAppIdentity {
  return packaged ? PACKAGED_WINDOWS_IDENTITY : DEV_WINDOWS_IDENTITY
}
