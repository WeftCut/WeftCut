# Desktop releases

## Versioning and publishing

The desktop version is plain SemVer. Bump it with
`npm run version:release -- <x.y.z>` and commit both package.json files and
package-lock.json together; a version edit in one package fails
`release.mjs validate`. Native crate versions are independent.

On a push to `main` in `WeftCut/WeftCut`, electron-ci's `release-plan` job
compares the version with published GitHub Releases; an unpublished, higher
version is a release candidate. PRs, scheduled and manual runs never publish.
A later main push retries an unpublished version whose build failed; a
published version is never overwritten.

The packaging leg (`e2e-2`) builds NSIS (.exe) on Windows, AppImage + .deb on
Linux and an arm64 DMG on macOS, plus update manifests and blockmaps. The
`release` job waits for every E2E leg, `checks`, `rust-test` and the
determinism `compare`; it alone has `contents: write` and uses the built-in
`GITHUB_TOKEN`. Publish runs queue (never cancel), so two pushes cannot
interleave on one version. `release.mjs publish` validates all three
platforms' manifests, versions, sizes and SHA-512 hashes, creates a draft
`v<version>` at the tested commit with install steps prepended to the notes,
uploads, then publishes it as Latest. Installer artifacts are kept 5 days in
Actions; release assets are the permanent update source.

A failed upload leaves a draft, invisible to update checks; re-run the failed
job at the same commit to resume. If a draft belongs to an older commit, delete
it (and its tag, if GitHub created one) before retrying. The workflow refuses
existing tags without a matching draft and lower versions. Ship fixes as a
higher patch; never replace installers under a published version.

## Asset names

Assets carry OS and architecture, no version: `WeftCut-win-x64.exe`,
`WeftCut-linux-x86_64.AppImage`, `WeftCut-linux-amd64.deb`,
`WeftCut-mac-arm64.dmg`. So
`https://github.com/WeftCut/WeftCut/releases/latest/download/<asset>` is a
permanent link to the current build, and `releases/download/v<version>/<asset>`
addresses one build. electron-updater finds the previous blockmap by swapping
the version in the tag segment, so differential Windows updates still work.

## macOS signing

Published Mac builds use a Developer ID Application certificate and Apple
notarization. `scripts/package-macos-release.mjs` requires all signing and
notarization credentials before invoking electron-builder, then verifies the
app's full signature, Developer ID authority, Team ID, stapled notarization
ticket and Gatekeeper acceptance before the installer can be uploaded. This
explicit gate matters because electron-builder 26 can skip notarization when
credentials are missing. The ticket is stapled to the app inside the DMG.

Only arm64 ships: the runner, ffmpeg sidecar and from-source LGPL libraries
are Apple Silicon. macOS self-update remains disabled in main; adding it also
requires a ZIP target, release asset validation and installed-app upgrade tests.

Local and PR packages use the base config's ad-hoc signature (`identity: "-"`)
without notarization. Re-signing keeps Electron's rewritten bundle seal valid;
these test packages require a manual Gatekeeper exception and are not releases.
No Apple credentials are passed to PR packaging.

### Apple and GitHub setup

Use an active Apple Developer Program membership. Under Certificates, create a
**Developer ID Application** certificate with a CSR whose private key you retain.
Export the certificate and matching private key as a password-protected `.p12`;
include Apple's Developer ID G2 intermediate certificate. A downloaded `.cer`
alone cannot sign an app. Keep these files outside the repository.

Create an app-specific password at <https://account.apple.com/> for notarization.
In GitHub, open **Settings → Secrets and variables → Actions → New repository
secret** and configure:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 contents of the `.p12` file, on one line |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Ten-character Team ID from membership details |

The signing step receives these secrets only on `main` in `WeftCut/WeftCut`, for
an unpublished release candidate or a manual packaging run. Missing credentials,
failed signing, rejected notarization or failed verification stops publication;
there is no ad-hoc fallback for a release.

To validate without publishing, manually run `electron-ci` on `main`, select
`macos-latest`, keep packaging enabled and scope E2E as needed. Manual runs
upload an installer artifact but never publish a GitHub Release. Install that
DMG on another Mac and check first launch, native decode and FFmpeg operations.
First-time notarization can take longer than later submissions.

For a long-running submission, manually run `macos-notary-status` on `main`.
It queries Apple's history and the newest WeftCut submission, plus the diagnostic
log when a verdict is available. It never uploads software or submits another
notarization request. `In Progress` means Apple has recorded the upload and is
still processing it; no recorded submission means the build has not completed
that handoff.

For a local signed package on a Mac, bootstrap the native dependencies, set the
same five environment variables, then run from `apps/desktop`:

```sh
npm run build
node scripts/package-macos-release.mjs
```

Reference: [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[electron-builder signing and notarization](https://www.electron.build/v26/docs/notarization/).

## Auto-update (Windows and Linux)

Packaged Windows/Linux builds use electron-updater against the public GitHub
Release feed (`src/main/updates.ts`); dev, E2E and macOS builds do not check.
Prereleases and downgrades are off. Checks run 5 s after startup and every six
hours. An available update shows as a start-screen button and a row in the
editor's notification center (the status bar's bell); neither interrupts work,
and showing them only reads status. Both open the same dialog as Help → Check
for Updates, which is the explicit check.

- `auto_install_updates_on_quit` (General settings, default on): downloads in
  the background and installs on normal exit, after the autosave flush, without
  relaunching. Off: checks only fetch metadata. Turning it off cancels a
  running background download; turning it on downloads a known update.
- "Download and install" downloads explicitly, then saves and restarts.
  "Update and restart" blocks the UI while saving, exits normally, and the
  final quit event installs with relaunch. A failed save keeps the project open
  and the update available. A version-bound, one-use `update-resume.json`
  (`updateResume.ts`) restores the exact project or start screen without
  touching the reopen-on-launch preference.
- "Skip this version" stores `skipped_update_version`: the passive entries hide
  it and background download and exit install step aside. Help → Check for
  Updates still offers it, and downloading from there clears the skip. A newer
  release is never covered by an older skip. The notification center's update
  row offers the same skip as its dismissal, so the row and the bell's dot go
  for that version only; "Later" in the dialog only closes it.

Windows updates show the NSIS progress page without location or mode choices
and close on success; only update-and-restart relaunches. File replacement is
not atomic, and shortcuts keep targeting the installed exe.

## Windows AppUserModelID

Taskbar icon and grouping come from the AppUserModelID stamped onto the Start
Menu and Desktop shortcuts. The installed app's AUMID in
`src/main/appIdentity.ts` must equal electron-builder's `appId`
(`dev.weftcut.desktop`; a unit test pins them) and must stay stable across
releases. The stock installer re-stamps a shortcut only when it recreates or
renames it, so an in-place update could leave a stale identity and a blank
taskbar icon; `build/installer.nsh` re-asserts it on every install and update.
A machine already corrupted needs uninstall + reinstall.

The toast activator CLSID next to it is stable too: notifications already in
the notification center call it. The installer drops it from the Start Menu
shortcut on every update, and the app stamps it back at launch (ADR 0163).

## Manual release check

Unit tests and manifest checks do not cover the installed-app path. When the
updater changes, install the current Windows/Linux packages (AppImage and
.deb), publish a higher patch, and exercise check, download and exit install,
including network failure/retry and an export running during download; confirm
the project reopens and the new version reports.
