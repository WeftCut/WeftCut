---
status: accepted
---

# One update module, two points where an install becomes final

Date: 2026-11-17

## Context

Windows and Linux builds self-update through electron-updater
(`src/main/updates.ts`): checks, the automatic-install preference, a skipped
version, the update restart and the project resume after it are one state
machine with one UI. macOS shipped without self-update, first because ad-hoc
signed builds cannot pass Squirrel.Mac's signature check, then because there was
no zip to update from. From 0.8.0 releases carry a Developer ID signature, so a
later release of the same team satisfies the running app's designated
requirement.

The platforms do not install the same way. On Windows and Linux the downloaded
installer runs from the final quit event, and that event decides: normal exit,
preference on, version not skipped. On macOS electron-updater hands the
downloaded zip to Squirrel.Mac, which verifies and unpacks it ("stages" it);
its ShipIt helper then replaces the app after any exit, crash included, and
there is no call that withdraws a staged update. electron-updater also only
stages at download time when `autoInstallOnAppQuit` is set; left unset, staging
waits for its `quitAndInstall`, which our quit-event hook would only call while
the process is already ending.

## Decision

- **One module, one state machine, one UI.** Checks, download decisions,
  restart, resume and release validation stay shared. Three per-platform
  modules would duplicate the policy that must not drift; one identical install
  step would hide the difference that does exist.
- **The difference is when an install becomes final, and the module names it.**
  `createUpdates` takes an optional `MacInstall` (Squirrel and a location
  check). Without it the install is decided at exit, as before. With it an
  update is ready only once Squirrel has staged it, and the status says
  `committed`: it installs at the next exit whatever the preferences say, so the
  dialog says so and offers no skip.
- **macOS stages right after download**, and downloads only when the existing
  rules allow (automatic install on and not skipped, or the user's explicit
  download). That keeps every exit fast and puts the one irrevocable step where
  the user's choice was made.
- **The update restart hands only the process's last step to Squirrel.** The
  normal quit runs first (save, confirm, window close, teardown); at
  `will-quit` the module keeps the process alive and calls Squirrel's
  `quitAndInstall`, which records "reopen after installing" and terminates. A
  refusal, or no exit within 15 s, ends the process without reopening; ShipIt
  still installs. Calling Squirrel's `quitAndInstall` from the restart button
  instead would let our `window-all-closed` quit end the process before
  Squirrel recorded the relaunch.
- **A copy that cannot replace itself is told so before downloading.** A
  bundle on the read-only disk image, translocated by Gatekeeper, or in a
  folder the user cannot write reports `reason: 'location'`: the update is still
  offered, and the copy says to move WeftCut to Applications or download it.
- **Releases ship a zip beside the DMG.** It is built in the same run from the
  same signed app; the DMG's notarization covers it (Gatekeeper accepts the
  extracted app online), so no second submission is made.

## Consequences

- 0.8.0 cannot update itself on macOS. Every Mac user installs the first release
  with this module from its DMG once; that release's upgrade notes say so.
- Ad-hoc local and PR packages still check, and Squirrel refuses their updates;
  they show the generic update error.
- macOS installs after a crash too, and a staged update ignores a later
  preference change or skip. Windows and Linux keep their exit-time decision.
- Differential macOS downloads range over the zip's blockmap, which the release
  validator requires like the NSIS one.
