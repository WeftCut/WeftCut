// The app's side of the `weftcut` binary's contract (apps/desktop/cli, ADR
// 0165): at every start it puts the binary in <userData>/cli/ and writes
// launch.json beside it, and it tells a client how to run that copy.
//
// Electron-free (paths ride in as arguments): `electron` cannot load under the
// unit runner.
import fs from 'node:fs'
import path from 'node:path'

/// The binary's file name on `platform`.
export function cliBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'weftcut.exe' : 'weftcut'
}

/// Where this app ships the binary: `<resources>/cli/` when packaged
/// (electron-builder.yml extraResources), else `out/cli/` beside the main
/// bundle, which exists once `npm run build:cli` has run.
export function shippedCliDir(opts: { isPackaged: boolean; resourcesPath: string; mainDir: string }): string {
  return opts.isPackaged ? path.join(opts.resourcesPath, 'cli') : path.join(opts.mainDir, '..', 'cli')
}

/// The stdio shim earlier releases installed in the same folder. A config that
/// still names it is served by `legacyShim.ts`.
export const LEGACY_SHIM_NAME = 'weftcut-mcp.cjs'

const LAUNCH_RECORD_NAME = 'launch.json'

/// What starts this app again on this profile: `<userData>/cli/launch.json`,
/// read by the binary's `launch_weftcut` (`parseLaunchRecord` in
/// apps/desktop/cli/launch.go, which refuses any other shape).
export interface LaunchRecord {
  exec: string
  args: string[]
  version: string
  /// The macOS .app `exec` belongs to. The binary starts a bundle through
  /// LaunchServices rather than by `exec`.
  bundle?: string
}

export function launchRecord(opts: {
  execPath: string
  /// $APPIMAGE: the file a user runs. `execPath` is inside its mount, which is
  /// gone when the app quits.
  appImage: string | undefined
  platform: NodeJS.Platform
  isPackaged: boolean
  /// What an unpackaged Electron runs as this app (`app.getAppPath()`).
  appPath: string
  userDataDir: string
  /// The app was started with `--user-data-dir`.
  userDataSwitch: boolean
  version: string
}): LaunchRecord {
  const args: string[] = []
  if (!opts.isPackaged) args.push(opts.appPath)
  // Only when given: the app otherwise finds its profile by itself.
  if (opts.userDataSwitch) args.push(`--user-data-dir=${opts.userDataDir}`)
  const record: LaunchRecord = { exec: opts.appImage ?? opts.execPath, args, version: opts.version }
  if (opts.isPackaged && opts.platform === 'darwin') {
    const inBundle = opts.execPath.lastIndexOf('.app/Contents/MacOS/')
    if (inBundle >= 0) record.bundle = opts.execPath.slice(0, inBundle + '.app'.length)
  }
  return record
}

/// Whether `entry` is a file `installCli` left beside `name` on its way to
/// replacing it.
const isScratchOf = (name: string, entry: string): boolean =>
  entry.startsWith(`${name}.new-`) || entry.startsWith(`${name}.old-`)

function writeLaunchRecord(dest: string, record: LaunchRecord, tag: string): void {
  // Renamed into place: the binary reads the old record or the new one, never
  // a part of either.
  const temp = `${dest}.new-${tag}`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
    fs.renameSync(temp, dest)
  } catch (e) {
    fs.rmSync(temp, { force: true })
    throw e
  }
}

/// LANDMINE: never write into `dest`. An agent session may be running it:
/// Linux and macOS refuse to open a running executable for writing (ETXTBSY),
/// and Windows refuses to overwrite or delete one. A rename is allowed on all
/// three, and the running session keeps the file it started.
function replaceBinary(source: string, dest: string, platform: NodeJS.Platform, tag: string): void {
  const temp = `${dest}.new-${tag}`
  try {
    fs.copyFileSync(source, temp)
    fs.chmodSync(temp, 0o755)
    if (platform !== 'win32' || !fs.existsSync(dest)) {
      fs.renameSync(temp, dest)
      return
    }
    // Windows cannot rename onto a running executable either, so the old one
    // steps aside first.
    const aside = `${dest}.old-${tag}`
    fs.renameSync(dest, aside)
    try {
      fs.renameSync(temp, dest)
    } catch (e) {
      fs.renameSync(aside, dest)
      throw e
    }
    // Fails while a session still runs it; the next start's sweep retries.
    try {
      fs.rmSync(aside, { force: true })
    } catch {
      /* in use */
    }
  } catch (e) {
    fs.rmSync(temp, { force: true })
    throw e
  }
}

/// Refreshes `<userData>/cli/`: the binary, the launch record, and nothing an
/// earlier start or release left behind. Returns the binary's path there, or
/// null when the profile has none (an unpackaged run before `npm run
/// build:cli`). The copy in the profile is what a client config names: the
/// one path that survives an upgrade on every OS, and the only stable one for
/// an AppImage, whose own files mount somewhere else every run.
export function installCli(opts: {
  /// The binary this app ships: `<resources>/cli/`, or `out/cli/` unpackaged.
  source: string
  userDataDir: string
  platform: NodeJS.Platform
  launch: LaunchRecord
}): string | null {
  const dir = path.join(opts.userDataDir, 'cli')
  const name = cliBinaryName(opts.platform)
  const dest = path.join(dir, name)
  const tag = `${process.pid}-${Date.now().toString(36)}`
  // Each step stands alone: a failed one leaves what an earlier start put
  // there, which still serves, and the next start tries again.
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const entry of fs.readdirSync(dir)) {
      if (entry !== LEGACY_SHIM_NAME && !isScratchOf(name, entry) && !isScratchOf(LAUNCH_RECORD_NAME, entry)) continue
      try {
        fs.rmSync(path.join(dir, entry), { force: true })
      } catch {
        /* a set-aside binary a session still runs */
      }
    }
  } catch {
    /* an unwritable profile */
  }
  try {
    writeLaunchRecord(path.join(dir, LAUNCH_RECORD_NAME), opts.launch, tag)
  } catch {
    /* the record of an earlier start stays */
  }
  try {
    if (fs.existsSync(opts.source)) replaceBinary(opts.source, dest, opts.platform, tag)
  } catch {
    /* the copy of an earlier start stays */
  }
  return fs.existsSync(dest) ? dest : null
}

/// What a client config runs: the profile's copy of the binary and the `mcp`
/// subcommand. No URL, token or environment: the binary finds the profile from
/// where it sits and reads the endpoint there at every connect.
export function stdioConnectConfig(cliPath: string): { command: string; args: string[] } {
  return { command: cliPath, args: ['mcp'] }
}
