// What check-packaged-cli.mjs knows about a packaged app, kept apart from the
// run so node:test can load it: where electron-builder leaves the unpacked
// app, how Electron stores its fuses, and how a client config written before
// the `weftcut` binary starts the app (ADR 0165).
import path from 'node:path'

/** The unpacked app electron-builder leaves under `releaseDir` for `platform`. */
export function packagedApp(platform, releaseDir) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'darwin') {
    const bundle = paths.join(releaseDir, 'mac-arm64', 'WeftCut.app')
    return {
      executable: paths.join(bundle, 'Contents', 'MacOS', 'WeftCut'),
      // The fuses of a bundle live in the framework every one of its processes loads.
      fuseFile: paths.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    }
  }
  if (platform === 'win32') {
    const executable = paths.join(releaseDir, 'win-unpacked', 'WeftCut.exe')
    return { executable, fuseFile: executable }
  }
  if (platform === 'linux') {
    const executable = paths.join(releaseDir, 'linux-unpacked', 'WeftCut')
    return { executable, fuseFile: executable }
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

// Electron's fuse wire (electron/docs/tutorial/fuses.md): this sentinel, one
// byte of wire version, one of length, then one byte per fuse.
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const FUSE_WIRE_VERSION = 1
/** RunAsNode is the first fuse of wire version 1. */
const RUN_AS_NODE = 0
const FUSE_STATES = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' }

/**
 * The state of the RunAsNode fuse in each fuse wire of an Electron binary:
 * 'off', 'on' or 'removed'. A universal macOS binary holds one wire per
 * architecture; a binary that is not Electron's holds none.
 */
export function runAsNodeFuse(binary) {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'latin1')
  const states = []
  for (let at = binary.indexOf(sentinel); at !== -1; at = binary.indexOf(sentinel, at + 1)) {
    const wire = at + sentinel.length
    const version = binary[wire]
    if (version !== FUSE_WIRE_VERSION) throw new Error(`fuse wire version ${version}, where this check reads version ${FUSE_WIRE_VERSION}`)
    if (binary[wire + 1] <= RUN_AS_NODE) throw new Error('the fuse wire holds no RunAsNode fuse')
    const state = binary[wire + 2 + RUN_AS_NODE]
    states.push(FUSE_STATES[state] ?? `unknown (0x${state.toString(16)})`)
  }
  return states
}

/** The name `weftcut mcp` answers `initialize` under. */
export const SERVER_NAME = 'weftcut-mcp'

/**
 * How a client config written by a release with the JS shim starts the app on
 * `profile`: the shim script as the one argument, and the two variables that
 * made the executable run it as Node.
 */
export function legacyInvocation(platform, profile) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  return {
    args: [paths.join(profile, 'cli', 'weftcut-mcp.cjs')],
    env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: profile },
  }
}

/** The DevTools endpoint a Chromium started with --remote-debugging-port announces on stderr. */
export function devToolsPort(stderr) {
  const match = stderr.match(/DevTools listening on ws:\/\/[^:\s]+:(\d+)\//)
  return match ? Number(match[1]) : null
}
