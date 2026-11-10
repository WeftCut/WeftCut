---
status: accepted
---

# One WeftCut per profile, and a notification click raises it

Date: 2026-11-10

## Context

WeftCut sends Windows notifications (export finished, compute job notices)
through Electron's `Notification`. Electron shows them through its built-in
COM toast activator. On the first notification of a run it writes
`<Programs>\<productName>.lnk` with the AUMID and a toast activator CLSID, and
registers that CLSID under `HKCU\Software\Classes\CLSID\…\LocalServer32`
→ the running exe with no arguments. The CLSID is random unless the app sets
one, and Electron adopts whatever CLSID the existing shortcut carries.

Measured on per-user installs of 0.6.0 and 0.7.0:

- The first notification rewrote the installer's Start Menu shortcut
  (`WeftCut.lnk`, the same path), giving it a random CLSID and replacing its
  description and icon fields.
- A click while the app ran reached the process, which had no handler: the
  window stayed in the background.
- A click while the app was closed started `WeftCut.exe -Embedding`. Electron
  registers the activator only when it first shows a notification, so the new
  process never did; after 120 s DCOM logged event 10010 and terminated it.
- An update recreated the shortcut without a CLSID; the next run wrote a new
  random one and left the old registry entry behind.

An unpackaged run shared the installed app's AUMID, but Electron gives it its
own shortcut, `Electron.lnk` → a bare `electron.exe`. A cold-start click in
dev opened Electron's empty default window, and on a machine with both, two
shortcuts claimed one AUMID.

Nothing stopped a second launch from opening a second editor on the same
profile, with its own backend and MCP host. WeftCut never offered that, and
video editors normally don't.

## Decision

- **One instance per profile.** `entry.ts` takes `requestSingleInstanceLock`
  after the calibration branch and before diagnostics; a second launch quits.
  The running instance restores, shows and focuses its main window on
  `second-instance`. Electron keys the lock on the userData directory, so runs
  with their own `--user-data-dir` stay independent.
- **Fixed identities** (`appIdentity.ts`). The installed app keeps AUMID
  `dev.weftcut.desktop` (equal to electron-builder's `appId`) and gets a fixed
  toast activator CLSID. An unpackaged run gets its own AUMID and CLSID.
- **The app stamps its CLSID onto the installer's shortcut** at startup,
  before Electron reads it, with `shell.writeShortcutLink(…, 'update', …)`,
  which leaves every other field alone. Electron then finds the shortcut
  valid and no longer rewrites it. A missing shortcut is not created.
- **The activator is registered at startup** (`Notification.isSupported()`
  builds the presenter that registers it), so a process started by a click
  answers COM and keeps running.
- **One activation callback** (`Notification.handleActivation`) raises the
  main window, the same way `second-instance` does. No per-notification
  `click` handlers.

The installer does not stamp the CLSID: NSIS has no plugin call for that
property, and the app's stamp covers the same shortcut on every launch.

## Consequences

- Between an update and the first launch after it, the shortcut carries no
  CLSID, so a click on an older notification has no activator to call.
- An all-users install keeps its shortcut under ProgramData, which the
  unelevated app cannot write; Electron writes its own per-user shortcut with
  the fixed CLSID.
- A click on a notification while an unpackaged run is closed still opens
  Electron's empty default window: Electron registers the bare `electron.exe`,
  without the app path, as the COM server.
- A second launch hands nothing over (no file to open, no argument); it only
  raises the window.
