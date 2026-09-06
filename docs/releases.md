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

The existing Windows/Linux packaging legs build NSIS (.exe), AppImage and .deb
plus electron-builder's update manifests and blockmaps. macOS still runs its
tests but skips packaging and publishing until signing is available. Release
publishing waits for every E2E, unit/typecheck, Rust and determinism comparison
gate, including macOS tests. No additional release build bypasses these gates.

Only the final release job gets `contents: write`. The built-in GITHUB_TOKEN is
enough; no personal token or client-side GitHub credentials are needed. The
publisher validates both platforms' manifests, versions, file sizes and SHA-512
hashes, creates a draft `v<version>` at the tested commit, uploads all assets,
then publishes it as Latest. Artifacts are retained in Actions for five days;
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
E2E and macOS builds disable update checks. Prereleases and downgrades are off.

Before declaring updates verified, install the actual 0.1.1 Windows/Linux
packages, publish a higher patch, and exercise checking, downloading and normal
exit installation. Confirm the saved project reopens and the app reports the
new version. Include AppImage and .deb (which may prompt for system privileges),
network failure/retry and an export left running while an update downloads.
Unit tests and release-manifest checks do not replace this installed-app test.
