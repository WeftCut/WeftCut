// Recognising a client config written for the JS stdio shim of 0.7.x and
// earlier. Such a config starts `<app> <userData>/cli/weftcut-mcp.cjs` with
// ELECTRON_RUN_AS_NODE=1. A packaged app does not run as Node (its RunAsNode
// fuse is off), so it boots as itself with that path in argv; `entry.ts` then
// prints the refusal below and opens nothing. See ADR 0165.
//
// Electron-free, so the unit runner can load it.
import path from 'node:path'
import { LEGACY_SHIM_NAME, cliBinaryName } from './cliInstall.js'

/// The line a start from such a config is refused with, naming what the new
/// config runs; null when this start is not one.
export function legacyConfigRefusal(argv: readonly string[], platform: NodeJS.Platform): string | null {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const script = argv.slice(1).find((arg) => paths.basename(arg) === LEGACY_SHIM_NAME)
  if (script === undefined) return null
  // The profile's copy of the binary sits where the script was.
  const binary = paths.join(paths.dirname(script), cliBinaryName(platform))
  return `WeftCut 0.8 replaced this agent connection. Copy the new one from Settings → Agent (it starts ${binary} mcp).`
}
