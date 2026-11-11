// Recognising a client config written by a release that shipped a JS stdio
// shim. Such a config starts `<app> <userData>/cli/weftcut-mcp.cjs` with
// ELECTRON_RUN_AS_NODE=1 and WEFTCUT_USERDATA set. A packaged app does not run
// as Node (its RunAsNode fuse is off), so it boots as itself with that path in
// argv; `entry.ts` then opens nothing and lets `weftcut mcp` speak on its stdio
// (`legacyShimHost.ts`).
//
// Kept because those configs live in files the app does not own: nothing else
// can move them to the binary. See ADR 0165.
//
// Electron-free, so the unit runner can load it.
import path from 'node:path'
import { LEGACY_SHIM_NAME, cliBinaryName } from './cliInstall.js'

/// The `weftcut` binaries that may take over this start, best first, or null
/// when this start is not an old config's. An empty list: it is one, and
/// there is no binary to hand it to.
export function legacyShimHandover(opts: {
  /// The process's argv, executable included.
  argv: readonly string[]
  platform: NodeJS.Platform
  /// Where this app ships its own copy of the binary (`shippedCliDir`).
  shippedDir: string
  isFile: (file: string) => boolean
}): string[] | null {
  const paths = opts.platform === 'win32' ? path.win32 : path.posix
  const script = opts.argv.slice(1).find((arg) => paths.basename(arg) === LEGACY_SHIM_NAME)
  if (script === undefined) return null
  const name = cliBinaryName(opts.platform)
  // The profile's copy sits where the script was. The shipped one is the same
  // program; the config's WEFTCUT_USERDATA tells either which profile to serve.
  return [paths.join(paths.dirname(script), name), paths.join(opts.shippedDir, name)].filter(opts.isFile)
}
