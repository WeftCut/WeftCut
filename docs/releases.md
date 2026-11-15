# Desktop releases

## Versioning and publishing

The desktop version is plain SemVer. Bump it with
`npm run version:release -- <x.y.z>` and commit both package.json files and
package-lock.json together; a version edit in one package fails
`release.mjs validate`. Native crate versions are independent.

A version that breaks something (before 1.0, a minor bump) gets
`docs/release-notes/<x.y.z>.md` in the same commit: what a user must do or know
before updating. The release puts it ahead of the install steps and the
generated changelog; a version without one gets those alone.

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

Published Mac builds carry a Developer ID Application signature and a
notarization ticket stapled to the DMG. The `package-macos` job in
`electron-ci` makes them, after the e2e, checks and rust-test gates pass, with
`scripts/package-macos-release.mjs` in three steps:

1. **build** signs the app and the DMG (no notarization) and checks the app's
   signature, Developer ID authority and Team ID. The packaged-app checks the
   e2e leg ran on the unsigned build run again on the signed one.
2. **submit** hands the DMG to Apple's notary service and records the
   submission id.
3. **finish** waits up to 40 minutes for Apple's verdict, staples the ticket to
   the DMG, checks the ticket and Gatekeeper on the image and on the app inside
   it, then rewrites `latest-mac.yml`, because stapling changes the DMG's bytes.

The DMG is notarized rather than the app alone because it is what users
download: one submission covers the image and the code inside it.

A submission still in progress after the wait fails the job and leaves the
submitted DMG as the `macos-notary-pending` artifact. **Re-run failed jobs** on
that run: `package-macos` finds the artifact, skips the build and resumes the
wait for the same submission. "Re-run all jobs" discards it and submits a new
build. A refusal (`Invalid`) prints Apple's log and is not resumable; fix the
cause and ship it as a new commit.

Only arm64 ships: the runner, ffmpeg sidecar and from-source LGPL libraries
are Apple Silicon. macOS self-update remains disabled in main; adding it also
requires a ZIP target, release asset validation and installed-app upgrade tests.

Local and PR packages use the base config's ad-hoc signature (`identity: "-"`)
without notarization. Re-signing keeps Electron's rewritten bundle seal valid;
these test packages require a manual Gatekeeper exception and are not releases.

### Credentials

The credentials are secrets of the `macos-release` GitHub environment, whose
deployment branches are limited to `main`. Only `package-macos` and
`macos-notary-status` name that environment, and no job that runs tests holds
a secret. Within `package-macos` each secret is set on the one step that uses
it: the app build (bundler plugins, build-time dependencies) runs in a step of
its own and never sees the certificate.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 of the password-protected `.p12`: the Developer ID Application certificate and its private key, on one line |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_TEAM_ID` | Ten-character Team ID from the membership details |
| `APPLE_API_KEY` | Full text of the App Store Connect API key (`AuthKey_<id>.p8`) |
| `APPLE_API_KEY_ID` | That key's Key ID |
| `APPLE_API_ISSUER` | Issuer ID shown above the key list |

Notarization uses a team API key (App Store Connect → Users and Access →
Integrations → Team Keys, role **Developer**) rather than an Apple Account
password: it belongs to the team, not a person, and is revoked on its own. A
downloaded `.cer` alone cannot sign; the `.p12` must hold the private key from
the CSR. Keep both files outside the repository.

### Checking and testing

To sign without publishing, manually run `electron-ci` on `main` with
**Also sign and notarize the macOS package** on; select `macos-latest` and scope
E2E as needed. The run uploads `installer-macos-signed` and never publishes a
GitHub Release. Install that DMG on another Mac and check first launch, native
decode and FFmpeg operations.

`macos-notary-status` (manual, on `main`) lists the team's newest WeftCut
submissions, the latest one's status and, once Apple has a verdict, its log.
It submits nothing. A new team's first submissions can stay `In Progress` for
hours to days; later ones normally finish in minutes.

For a local signed package on a Mac, bootstrap the native dependencies, set the
six environment variables, then run from `apps/desktop`:

```sh
npm run build
node scripts/package-macos-release.mjs build
node scripts/package-macos-release.mjs submit
node scripts/package-macos-release.mjs finish
```

Reference: [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[notarizing before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

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
