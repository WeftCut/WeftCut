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

The Mac build is ad-hoc signed (`identity: "-"`), not notarized: there is no
Apple Developer ID. Ad-hoc rather than unsigned keeps the seal consistent after
electron-builder rewrites Electron's bundle, so Gatekeeper reports an
unidentified developer instead of "damaged". Users allow it once under System
Settings → Privacy & Security → Open Anyway, or run
`xattr -dr com.apple.quarantine`; release notes carry both. Only arm64 ships:
the runner, the ffmpeg sidecar and the from-source LGPL libraries are Apple
Silicon.

macOS cannot self-update: Squirrel.Mac installs only a build satisfying the
running app's designated requirement, and an ad-hoc requirement is that build's
own code hash. Main passes no updater on darwin.

## Auto-update (Windows and Linux)

Packaged Windows/Linux builds use electron-updater against the public GitHub
Release feed (`src/main/updates.ts`); dev, E2E and macOS builds do not check.
Prereleases and downgrades are off. Checks run 5 s after startup and every six
hours. An available update shows as a start-screen button and an "Update
available" status-bar pill; neither interrupts work, and showing them only
reads status. Clicking either opens the same dialog as Help → Check for
Updates, which is the explicit check.

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
- "Skip this version" stores `skipped_update_version`: both indicators hide it
  and background download and exit install step aside. Help → Check for
  Updates still offers it, and downloading from there clears the skip. A newer
  release is never covered by an older skip. "Later" only closes the dialog.

Windows updates show the NSIS progress page without location or mode choices
and close on success; only update-and-restart relaunches. File replacement is
not atomic, and shortcuts keep targeting the installed exe.

## Windows AppUserModelID

Taskbar icon and grouping come from the AppUserModelID stamped onto the Start
Menu and Desktop shortcuts. `src/main/appIdentity.ts` must equal
electron-builder's `appId` (`dev.weftcut.desktop`; a unit test pins them) and
must stay stable across releases. The stock installer re-stamps a shortcut only
when it recreates or renames it, so an in-place update could leave a stale
identity and a blank taskbar icon; `build/installer.nsh` re-asserts it on every
install and update. A machine already corrupted needs uninstall + reinstall.

## Manual release check

Unit tests and manifest checks do not cover the installed-app path. When the
updater changes, install the current Windows/Linux packages (AppImage and
.deb), publish a higher patch, and exercise check, download and exit install,
including network failure/retry and an export running during download; confirm
the project reopens and the new version reports.
