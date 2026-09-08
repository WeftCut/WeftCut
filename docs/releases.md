# Desktop releases

The desktop version is a stable SemVer (`0.1.1`, not `0.1.001`). From the repo
root, run `npm run version:release -- 0.1.2` and commit the two package.json
files and package-lock.json together. Native crate versions are independent.

On a push to `main` in `WeftCut/WeftCut`, electron-ci compares that version with
published GitHub Releases. An unpublished, increasing version is a release
candidate. PRs, scheduled runs and manual CI runs cannot publish. Subsequent
main pushes retry an unpublished version if a previous build failed or was
cancelled; a published version is never overwritten. Version-only edits to one
package fail validation, so use the command above.

The packaging legs build NSIS (.exe) on Windows, AppImage and .deb on Linux,
and an Apple Silicon DMG on macOS, plus electron-builder's update manifests and
blockmaps. Release publishing waits for every E2E, unit/typecheck, Rust and
determinism comparison gate on all three OSes. No additional release build
bypasses these gates.

Assets are named by OS and architecture with no version: `WeftCut-win-x64.exe`,
`WeftCut-linux-x86_64.AppImage`, `WeftCut-linux-amd64.deb` and
`WeftCut-mac-arm64.dmg`. GitHub's
`https://github.com/WeftCut/WeftCut/releases/latest/download/<asset>` is
therefore a permanent link to the current build, fit for a download page that
never needs editing. A specific build stays addressable through its tag,
`releases/download/v<version>/<asset>`. electron-updater derives the previous
release's blockmap URL by swapping the version inside that tag segment, so
differential Windows updates do not depend on a version in the file name.

The macOS build is ad-hoc signed (`identity: "-"` in electron-builder.yml) and
not notarized: WeftCut has no Apple Developer ID. Ad-hoc rather than no
signature keeps the bundle's seal consistent after electron-builder rewrites
Electron's stock bundle, so Gatekeeper treats the app as an unidentified
developer's instead of reporting it damaged. Users open it once, then allow it
under System Settings → Privacy & Security → Open Anyway, or clear the
quarantine flag with `xattr -dr com.apple.quarantine`; every release's notes
carry both. Only arm64 ships: the runner, the bundled ffmpeg sidecar and the
from-source LGPL libraries are all Apple Silicon.

Only the final release job gets `contents: write`. The built-in GITHUB_TOKEN is
enough; no personal token or client-side GitHub credentials are needed. The
publisher validates all three platforms' manifests, versions, file sizes and
SHA-512 hashes, creates a draft `v<version>` at the tested commit with the
install steps prepended to the generated notes, uploads all assets, then
publishes it as Latest. Artifacts are retained in Actions for five days;
public release assets are the permanent update source.

A failed upload leaves a draft, invisible to update checks. Re-run the failed
job at the same commit to resume it. If a draft belongs to an older commit,
remove that draft before retrying a new commit (also remove its version tag if
GitHub created one). The workflow refuses existing tags without a matching
draft, and refuses lower versions. Publish a higher patch version to deliver a
fix; do not replace installers under an already published version.

Packaged Windows/Linux applications use electron-updater against the public
GitHub Release feed. They check 30 seconds after startup and every six hours,
download in the background, and install on normal exit after the editor's
existing autosave flush. They never force a restart. Help → Check for Updates
shows progress/readiness, retries errors and links to manual downloads. Dev,
E2E and macOS builds disable update checks. macOS cannot self-update without a
Developer ID: Squirrel.Mac installs only a build whose signature satisfies the
running app's designated requirement, and an ad-hoc signature pins that to the
running build's own code hash. Prereleases and downgrades are off.

On Windows the taskbar icon and window grouping come from the app's
AppUserModelID, which the installer stamps onto the Start Menu and Desktop
shortcuts. The runtime value (`src/main/appIdentity.ts`) must equal
electron-builder's `appId`; a unit test pins them together, and this value stays
stable across releases so pinned shortcuts and notifications survive updates.
electron-builder's stock installer only re-stamps a shortcut when it recreates or
renames one, so an in-place update that keeps a same-named shortcut could leave a
rewritten exe with a stale identity and a blank taskbar icon. `build/installer.nsh`
re-asserts the AppUserModelID on every install and update to prevent that. A
machine whose per-identity taskbar record was already corrupted by an earlier
update is only reliably cleared by uninstalling and reinstalling.

Before declaring updates verified, install the actual 0.1.1 Windows/Linux
packages, publish a higher patch, and exercise checking, downloading and normal
exit installation. Confirm the saved project reopens and the app reports the
new version. Include AppImage and .deb (which may prompt for system privileges),
network failure/retry and an export left running while an update downloads.
Unit tests and release-manifest checks do not replace this installed-app test.
