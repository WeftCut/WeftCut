import fs from 'node:fs'
import path from 'node:path'

/// Discovery + config plumbing for the weftcut-mcp shim. Everything here is
/// deliberately Electron-free: the shim runs under ELECTRON_RUN_AS_NODE (the
/// app binary acting as plain Node), so `app.getPath` does not exist and the
/// userData directory must be rediscovered from the outside.

export interface McpAuth {
  token: string
  port: number
}

export interface ShimEnv {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /// The running executable. Packaged: the WeftCut binary itself (that is the
  /// whole ELECTRON_RUN_AS_NODE trick). Dev: a plain node binary.
  execPath: string
  /// Absolute path of the shim script (process.argv[1] resolved).
  scriptPath: string
  homedir: string
}

export function shimEnvFromProcess(): ShimEnv {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    scriptPath: path.resolve(process.argv[1] ?? ''),
    homedir: process.env.HOME ?? process.env.USERPROFILE ?? '',
  }
}

/// Last-resort userData guess. Generated configs always carry an explicit
/// WEFTCUT_USERDATA and the installed shim finds userData as its own
/// grandparent, so this only serves a hand-invoked shim. Electron derives the
/// dir from the app name, which is package.json's `productName` ("WeftCut") in
/// dev AND packaged: electron-builder's own productName never reaches the
/// packaged package.json, so the two modes agree only because the key is set
/// there. The scoped-name candidate stays for profiles written before it was.
export function defaultUserDataDir(se: ShimEnv): string {
  const appData =
    se.platform === 'win32'
      ? (se.env.APPDATA ?? path.join(se.homedir, 'AppData', 'Roaming'))
      : se.platform === 'darwin'
        ? path.join(se.homedir, 'Library', 'Application Support')
        : (se.env.XDG_CONFIG_HOME ?? path.join(se.homedir, '.config'))
  const candidates = [path.join(appData, 'WeftCut'), path.join(appData, '@weftcut', 'desktop')]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'mcp_auth.json'))) return c
  }
  return candidates[0]!
}

/// userData resolution order:
///  1. WEFTCUT_USERDATA env override (dev, tests).
///  2. Installed location: the app copies the shim to <userData>/cli/, so when
///     mcp_auth.json exists two levels up from the script, that IS userData.
///     This keeps one code path valid on all three OSes — including AppImage,
///     where the install image mounts at a random path every run and only
///     userData is stable.
///  3. The platform default above.
export function resolveUserDataDir(se: ShimEnv): string {
  const override = se.env.WEFTCUT_USERDATA
  if (override) return override
  const grandparent = path.dirname(path.dirname(se.scriptPath))
  if (fs.existsSync(path.join(grandparent, 'mcp_auth.json'))) return grandparent
  return defaultUserDataDir(se)
}

export function authFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'mcp_auth.json')
}

/// Read the app's persisted MCP rendezvous (port + bearer). Re-read on every
/// bridge (re)connect, never cached: a Settings-panel token rotation or a port
/// re-pick must self-heal on the next attempt. `null` = the app has never run
/// on this machine (or userData was wiped).
export function readAuth(userDataDir: string): McpAuth | null {
  try {
    const raw = fs.readFileSync(authFilePath(userDataDir), 'utf8')
    const a = JSON.parse(raw) as McpAuth
    if (typeof a.token === 'string' && a.token && typeof a.port === 'number') return a
  } catch {
    /* fall through */
  }
  return null
}

export function endpointUrl(auth: McpAuth): string {
  return `http://127.0.0.1:${auth.port}/mcp`
}

/// How long the shim waits on the app. The agent's own client timeout cannot
/// rescue a call that this hop gave up on first, so a tool call — which can be
/// minutes of transcription or frame description — gets an IDLE window that
/// every progress notification from the app re-arms, not a flat deadline.
export interface BridgeTimeouts {
  /// tools/call: silence allowed between the request and the result, or
  /// between two progress notifications.
  toolIdleMs: number
  /// tools/call: hard cap no matter how much progress arrives. Absent: none —
  /// a call that keeps reporting progress may take as long as it takes.
  toolMaxTotalMs?: number
  /// Everything else (lists, resource reads, prompts): short and flat.
  requestMs: number
}

export const TOOL_TIMEOUT_ENV = 'WEFTCUT_MCP_TOOL_TIMEOUT_MS'
export const TOOL_MAX_TOTAL_ENV = 'WEFTCUT_MCP_TOOL_MAX_TOTAL_MS'

export const DEFAULT_BRIDGE_TIMEOUTS: BridgeTimeouts = { toolIdleMs: 300_000, requestMs: 60_000 }

/// setTimeout's ceiling: past 2^31-1 ms Node fires the timer at once instead.
const MAX_TIMER_MS = 2_147_483_647

/// A positive integer of milliseconds, else undefined. An env typo must fall
/// back to the default rather than take the shim down with it.
function envMs(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined
  const ms = Number(raw.trim())
  return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : undefined
}

/// The bridge timeouts this shim was configured with: WEFTCUT_MCP_TOOL_TIMEOUT_MS
/// sets the tool-call idle window, WEFTCUT_MCP_TOOL_MAX_TOTAL_MS opts into a
/// total cap.
export function bridgeTimeouts(se: ShimEnv): BridgeTimeouts {
  const toolIdleMs = envMs(se.env[TOOL_TIMEOUT_ENV]) ?? DEFAULT_BRIDGE_TIMEOUTS.toolIdleMs
  const toolMaxTotalMs = envMs(se.env[TOOL_MAX_TOTAL_ENV])
  return {
    ...DEFAULT_BRIDGE_TIMEOUTS,
    toolIdleMs,
    ...(toolMaxTotalMs !== undefined ? { toolMaxTotalMs } : {}),
  }
}

/// What `launch_weftcut` should spawn.
///  - WEFTCUT_APP env override first (dev: point at a packaged build or
///    `electron .`-style wrapper script).
///  - $APPIMAGE when set: execPath is the transient mount, the .AppImage file
///    is the stable relaunchable thing.
///  - Otherwise execPath — which is the app binary itself under
///    ELECTRON_RUN_AS_NODE. Under plain dev node there is nothing sensible to
///    spawn, so that case reports unlaunchable instead of forking node.
export function launchTarget(se: ShimEnv): { path: string; launchable: boolean } {
  const override = se.env.WEFTCUT_APP
  if (override) return { path: override, launchable: true }
  const appimage = se.env.APPIMAGE
  if (appimage) return { path: appimage, launchable: true }
  // Basename per se.platform, not the host's: POSIX finds no separator in a
  // win32 execPath and returns the whole string.
  const platformPath = se.platform === 'win32' ? path.win32 : path.posix
  const base = platformPath.basename(se.execPath).toLowerCase()
  const isPlainNode = base === 'node' || base === 'node.exe'
  return { path: se.execPath, launchable: !isPlainNode }
}

/// The client-config fragment `print-config` (and the Settings panel, via its
/// own IPC-fed copy of the same shape) emits. No URL, no token: the shim
/// resolves both from mcp_auth.json at connect time. WEFTCUT_USERDATA rides
/// along explicitly so discovery never depends on the name-guessing fallback.
export function clientConfig(
  se: ShimEnv,
  userDataDir: string,
): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  return {
    command: se.env.APPIMAGE ?? se.execPath,
    args: [se.scriptPath],
    env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: userDataDir },
  }
}

export function clientConfigJson(se: ShimEnv, userDataDir: string): string {
  return JSON.stringify({ mcpServers: { weftcut: clientConfig(se, userDataDir) } }, null, 2)
}
