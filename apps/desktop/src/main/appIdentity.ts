/// The Windows AppUserModelID (AUMID) — this app's taskbar / Alt-Tab identity.
///
/// This value MUST equal `appId` in electron-builder.yml. The NSIS installer
/// stamps `appId` onto the Start Menu and Desktop shortcuts (via
/// WinShell::SetLnkAUMI, and re-asserted on every update by build/installer.nsh),
/// and Windows only links a running window to that shortcut — its icon and its
/// taskbar grouping — when the AUMID the process sets at runtime matches the
/// shortcut's stamp. If the two drift apart, the taskbar silently falls back to a
/// blank/generic icon and the window stops grouping under the app. `app-
/// identity.test.ts` reads the yml and asserts the equality so the two literals
/// cannot diverge.
///
/// Kept STABLE across releases on purpose: changing it orphans pinned shortcuts
/// and breaks notification continuity. See the taskbar-icon notes in
/// docs/releases.md.
export const WINDOWS_APP_USER_MODEL_ID = 'dev.weftcut.desktop'
