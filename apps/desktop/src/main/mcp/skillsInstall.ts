import fs from 'node:fs'
import path from 'node:path'

/// Why the skill folder the Settings panel advertises is not the one this app
/// version ships.
///
/// - `not_built` — dev tree before `npm run build:skills`. The only benign
///   member, and the reason the others need their own names: a packaged build
///   reaching any of these is a defect, and the panel says so differently.
/// - `bundle_missing` — packaged, but no bundle rode along in `<resources>`.
/// - `incomplete` — a bundle exists without the `weftcut` skill inside it.
/// - `copy_failed` — the refresh into userData threw (permissions, full disk).
export type SkillsFault = 'not_built' | 'bundle_missing' | 'incomplete' | 'copy_failed'

/// What the user can be offered right now. It describes the app's own copy
/// under <userData>/skills only: the copies agent clients read live in their
/// own skills directories, out of the app's sight, so no state claims those are
/// installed or current.
///
/// `current` — the folder holds exactly what this app version ships.
/// `stale` is deliberately distinct from it: the folder is there and worth
/// handing out, but it was left by an earlier launch and its version is
/// whatever that launch shipped — which is exactly the drift the every-startup
/// refresh exists to prevent, so the panel warns rather than staying silent.
export type SkillsInstall =
  | { state: 'current'; dir: string }
  | { state: 'stale'; dir: string; fault: SkillsFault }
  | { state: 'unavailable'; dir: null; fault: SkillsFault }

/// The skill folder every layer above this one names literally: the panel
/// concatenates it onto `dir`, and `scripts/build-skills-lib.mjs` asserts the
/// build staged it under the same name.
const REQUIRED_SKILL = 'weftcut'

/// A destination that holds the required skill is one a user can install from;
/// an empty or half-written `skills/` is not, however successfully it was
/// copied.
function usable(dest: string): boolean {
  return fs.existsSync(path.join(dest, REQUIRED_SKILL, 'SKILL.md'))
}

/// Install the bundled agent skill folder into <userData>/skills/ at app
/// startup. That directory is what the Settings panel tells the user (or their
/// agent) to copy into the client's own skills directory: userData is the only
/// path stable across version upgrades on all three OSes — on AppImage the
/// install image mounts at a random point every run. The refresh runs on every
/// start, which is what keeps the copy from drifting from the app that ships
/// it; a start that cannot refresh reports `stale` rather than pretending.
///
/// The refresh mirrors: <userData>/skills/ is the app's, and after it holds
/// exactly the bundle, so a file a release removed does not linger for the
/// next copy to pick up. The new tree is staged beside it and swapped in, so a
/// copy that fails halfway leaves the previous launch's folder whole.
///
/// Reports a fault instead of degrading silently. A packaged build has already
/// passed two gates that make every fault but `copy_failed` impossible
/// (`build:skills` over out/skills, afterPack over the packed copy), so one
/// reaching a user means something on that machine broke and the app has to be
/// able to say which part.
///
/// Electron-free on purpose (paths ride in as arguments) so Vitest can cover
/// it — `electron` cannot load under the unit runner.
export function installSkills(opts: {
  /// Packaged source: <resources>/skills (extraResources).
  resourcesSkills: string
  /// Dev source: <appRoot>/out/skills (present after build:skills).
  devSkills: string
  isPackaged: boolean
  userDataDir: string
}): SkillsInstall {
  const source = opts.isPackaged ? opts.resourcesSkills : opts.devSkills
  const dest = path.join(opts.userDataDir, 'skills')
  const fallback = (fault: SkillsFault): SkillsInstall =>
    usable(dest) ? { state: 'stale', dir: dest, fault } : { state: 'unavailable', dir: null, fault }

  if (!fs.existsSync(source)) {
    return fallback(opts.isPackaged ? 'bundle_missing' : 'not_built')
  }
  // Judge the source, not the result: copying an empty tree over a previous
  // launch's good copy succeeds and leaves a usable destination, which would
  // otherwise read as a healthy install of a bundle that shipped nothing.
  if (!usable(source)) return fallback('incomplete')
  const staging = `${dest}.new`
  const retired = `${dest}.old`
  try {
    // Leftovers of a start that died mid-swap go first.
    fs.rmSync(staging, { recursive: true, force: true })
    fs.rmSync(retired, { recursive: true, force: true })
    fs.cpSync(source, staging, { recursive: true })
    if (fs.existsSync(dest)) fs.renameSync(dest, retired)
    try {
      fs.renameSync(staging, dest)
    } catch (e) {
      if (fs.existsSync(retired)) fs.renameSync(retired, dest)
      throw e
    }
  } catch {
    // A previous launch's copy still beats none, so this is not fatal — but it
    // is no longer the version this app ships, which `stale` records.
    removeQuietly(staging)
    return fallback('copy_failed')
  }
  // The swap already happened; a retired tree a file handle still pins is
  // cleared at the next start.
  removeQuietly(retired)
  return usable(dest) ? { state: 'current', dir: dest } : fallback('copy_failed')
}

function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best effort: the next start retries.
  }
}
