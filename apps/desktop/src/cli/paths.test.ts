import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bridgeTimeouts,
  clientConfig,
  clientConfigJson,
  defaultUserDataDir,
  launchTarget,
  readAuth,
  resolveUserDataDir,
  type ShimEnv,
} from './paths.js'

const tmps: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shim-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function se(over: Partial<ShimEnv> = {}): ShimEnv {
  return {
    platform: 'win32',
    env: {},
    execPath: 'C:\\Program Files\\WeftCut\\WeftCut.exe',
    scriptPath: 'C:\\somewhere\\weftcut-mcp.cjs',
    homedir: 'C:\\Users\\u',
    ...over,
  }
}

describe('resolveUserDataDir', () => {
  it('WEFTCUT_USERDATA override wins over everything', () => {
    expect(resolveUserDataDir(se({ env: { WEFTCUT_USERDATA: 'D:\\custom' } }))).toBe('D:\\custom')
  })

  it('the installed shim finds userData as its own grandparent', () => {
    const userData = tmpDir()
    fs.mkdirSync(path.join(userData, 'cli'))
    fs.writeFileSync(path.join(userData, 'mcp_auth.json'), '{"token":"t","port":1}')
    const script = path.join(userData, 'cli', 'weftcut-mcp.cjs')
    expect(resolveUserDataDir(se({ scriptPath: script }))).toBe(userData)
  })

  it('falls back to the platform default when nothing is discoverable', () => {
    const appData = tmpDir()
    const resolved = resolveUserDataDir(se({ env: { APPDATA: appData } }))
    expect(resolved).toBe(path.join(appData, 'WeftCut'))
  })

  it('prefers whichever default candidate actually holds mcp_auth.json (dev nested name)', () => {
    const appData = tmpDir()
    const dev = path.join(appData, '@weftcut', 'desktop')
    fs.mkdirSync(dev, { recursive: true })
    fs.writeFileSync(path.join(dev, 'mcp_auth.json'), '{"token":"t","port":1}')
    expect(defaultUserDataDir(se({ env: { APPDATA: appData } }))).toBe(dev)
  })
})

describe('readAuth', () => {
  it('reads a valid auth file', () => {
    const d = tmpDir()
    fs.writeFileSync(path.join(d, 'mcp_auth.json'), '{"token":"abc","port":4711}')
    expect(readAuth(d)).toEqual({ token: 'abc', port: 4711 })
  })

  it('returns null for missing or malformed files', () => {
    const d = tmpDir()
    expect(readAuth(d)).toBeNull()
    fs.writeFileSync(path.join(d, 'mcp_auth.json'), 'not json')
    expect(readAuth(d)).toBeNull()
    fs.writeFileSync(path.join(d, 'mcp_auth.json'), '{"token":"","port":1}')
    expect(readAuth(d)).toBeNull()
  })
})

describe('launchTarget', () => {
  it('WEFTCUT_APP override wins', () => {
    const t = launchTarget(se({ env: { WEFTCUT_APP: 'C:\\dev\\WeftCut.exe' } }))
    expect(t).toEqual({ path: 'C:\\dev\\WeftCut.exe', launchable: true })
  })

  it('prefers $APPIMAGE over the (transient-mount) execPath', () => {
    const t = launchTarget(se({ env: { APPIMAGE: '/home/u/WeftCut.AppImage' } }))
    expect(t).toEqual({ path: '/home/u/WeftCut.AppImage', launchable: true })
  })

  it('the app binary itself is launchable; a plain node interpreter is not', () => {
    expect(launchTarget(se()).launchable).toBe(true)
    expect(launchTarget(se({ execPath: 'C:\\nodejs\\node.exe' })).launchable).toBe(false)
    expect(launchTarget(se({ execPath: '/usr/bin/node' })).launchable).toBe(false)
  })
})

describe('clientConfig', () => {
  it('emits the exe + shim path + env triple with no URL and no token', () => {
    const cfg = clientConfig(se(), 'C:\\ud')
    expect(cfg).toEqual({
      command: 'C:\\Program Files\\WeftCut\\WeftCut.exe',
      args: ['C:\\somewhere\\weftcut-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: 'C:\\ud' },
    })
  })

  it('uses the .AppImage file as the command when running from one', () => {
    const cfg = clientConfig(se({ env: { APPIMAGE: '/apps/WeftCut.AppImage' } }), '/ud')
    expect(cfg.command).toBe('/apps/WeftCut.AppImage')
  })

  it('round-trips through JSON with Windows backslashes intact', () => {
    const parsed = JSON.parse(clientConfigJson(se(), 'C:\\ud')) as {
      mcpServers: { weftcut: { command: string } }
    }
    expect(parsed.mcpServers.weftcut.command).toBe('C:\\Program Files\\WeftCut\\WeftCut.exe')
  })
})

describe('bridgeTimeouts', () => {
  it('defaults to a 5 min tool-call idle window, no total cap, 60 s for everything else', () => {
    expect(bridgeTimeouts(se())).toEqual({ toolIdleMs: 300_000, requestMs: 60_000 })
  })

  it('reads the tool-call idle window and the opt-in total cap from the env', () => {
    const t = bridgeTimeouts(se({ env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '900000', WEFTCUT_MCP_TOOL_MAX_TOTAL_MS: ' 3600000 ' } }))
    expect(t).toEqual({ toolIdleMs: 900_000, toolMaxTotalMs: 3_600_000, requestMs: 60_000 })
  })

  it('falls back to the default on anything but a positive integer', () => {
    for (const bad of ['', '0', '-5', '1.5', '10s', 'abc', '1e6']) {
      const t = bridgeTimeouts(se({ env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: bad, WEFTCUT_MCP_TOOL_MAX_TOTAL_MS: bad } }))
      expect(t).toEqual({ toolIdleMs: 300_000, requestMs: 60_000 })
    }
  })

  it('clamps to the timer ceiling instead of overflowing into an instant timeout', () => {
    expect(bridgeTimeouts(se({ env: { WEFTCUT_MCP_TOOL_TIMEOUT_MS: '99999999999' } })).toolIdleMs).toBe(2_147_483_647)
  })
})
