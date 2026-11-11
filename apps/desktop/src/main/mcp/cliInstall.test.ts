import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_SHIM_NAME, cliBinaryName, installCli, launchRecord, stdioConnectConfig, type LaunchRecord } from './cliInstall.js'

const tmps: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-cli-install-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const LAUNCH: LaunchRecord = { exec: '/opt/WeftCut/weftcut', args: [], version: '1.2.3' }

/// A shipped binary holding `bytes`, and a profile to install it into.
function fixture(platform: NodeJS.Platform, bytes = 'binary v1') {
  const userDataDir = tmpDir()
  const source = path.join(tmpDir(), cliBinaryName(platform))
  fs.writeFileSync(source, bytes, { mode: 0o644 })
  const cli = path.join(userDataDir, 'cli')
  return { source, userDataDir, cli, dest: path.join(cli, cliBinaryName(platform)), opts: { source, userDataDir, platform, launch: LAUNCH } }
}

describe.each(['linux', 'darwin', 'win32'] as const)('installCli on %s', (platform) => {
  it('copies the shipped binary into <userData>/cli and returns the copy', () => {
    const { opts, dest } = fixture(platform)
    expect(installCli(opts)).toBe(dest)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary v1')
  })

  it('replaces the copy at every start and leaves nothing else beside it', () => {
    const { opts, source, dest, cli } = fixture(platform)
    installCli(opts)
    fs.writeFileSync(source, 'binary v2')
    installCli(opts)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary v2')
    expect(fs.readdirSync(cli).sort()).toEqual([cliBinaryName(platform), 'launch.json'].sort())
  })

  it('replaces the copy by rename: a file a session still holds keeps its bytes', () => {
    const { opts, source, dest } = fixture(platform)
    installCli(opts)
    // What a running session has: the file it started, whatever its name is now.
    const held = fs.openSync(dest, 'r')
    try {
      fs.writeFileSync(source, 'binary v2')
      installCli(opts)
      expect(fs.readFileSync(held, 'utf8')).toBe('binary v1')
      expect(fs.readFileSync(dest, 'utf8')).toBe('binary v2')
    } finally {
      fs.closeSync(held)
    }
  })

  it('removes what an earlier start or release left behind, and nothing else', () => {
    const { opts, cli } = fixture(platform)
    const name = cliBinaryName(platform)
    fs.mkdirSync(cli, { recursive: true })
    const leftovers = [LEGACY_SHIM_NAME, `${name}.old-41-abc`, `${name}.new-41-abc`, 'launch.json.new-41-abc']
    for (const file of [...leftovers, 'notes.txt']) fs.writeFileSync(path.join(cli, file), 'x')
    installCli(opts)
    expect(fs.readdirSync(cli).sort()).toEqual([name, 'launch.json', 'notes.txt'].sort())
  })

  it('writes the launch record whole, replacing the one before it', () => {
    const { opts, cli } = fixture(platform)
    installCli(opts)
    const next: LaunchRecord = { exec: '/Applications/WeftCut.app/Contents/MacOS/WeftCut', args: ['--user-data-dir=/home/u/p'], version: '1.2.4', bundle: '/Applications/WeftCut.app' }
    installCli({ ...opts, launch: next })
    expect(JSON.parse(fs.readFileSync(path.join(cli, 'launch.json'), 'utf8'))).toEqual(next)
  })

  it('with no shipped binary: keeps a copy an earlier start left, else reports none, and still records the launch', () => {
    const { opts, dest, cli } = fixture(platform)
    const missing = { ...opts, source: path.join(tmpDir(), 'nope') }
    expect(installCli(missing)).toBeNull()
    expect(JSON.parse(fs.readFileSync(path.join(cli, 'launch.json'), 'utf8'))).toEqual(LAUNCH)
    fs.writeFileSync(dest, 'an earlier copy')
    expect(installCli(missing)).toBe(dest)
    expect(fs.readFileSync(dest, 'utf8')).toBe('an earlier copy')
  })
})

describe('installCli', () => {
  it.skipIf(process.platform === 'win32')('makes the copy executable whatever the shipped file was', () => {
    const { opts, dest } = fixture('linux')
    installCli(opts)
    expect(fs.statSync(dest).mode & 0o777).toBe(0o755)
  })
})

describe('launchRecord', () => {
  const base = {
    execPath: '/opt/WeftCut/weftcut',
    appImage: undefined,
    platform: 'linux' as NodeJS.Platform,
    isPackaged: true,
    appPath: '/opt/WeftCut/resources/app.asar',
    userDataDir: '/home/u/.config/WeftCut',
    userDataSwitch: false,
    version: '1.2.3',
  }

  it('a packaged app on its default profile starts again with no arguments', () => {
    expect(launchRecord(base)).toEqual({ exec: '/opt/WeftCut/weftcut', args: [], version: '1.2.3' })
  })

  it('names the AppImage file, not the executable inside its mount', () => {
    const record = launchRecord({ ...base, execPath: '/tmp/.mount_WeftCuAbCdEf/weftcut', appImage: '/home/u/Apps/WeftCut.AppImage' })
    expect(record.exec).toBe('/home/u/Apps/WeftCut.AppImage')
  })

  it('carries --user-data-dir only when the app was started with it', () => {
    expect(launchRecord({ ...base, userDataDir: '/home/u/second', userDataSwitch: true }).args).toEqual(['--user-data-dir=/home/u/second'])
  })

  it('an unpackaged run gives Electron its app path first', () => {
    const record = launchRecord({
      ...base,
      execPath: '/home/u/repo/node_modules/electron/dist/electron',
      isPackaged: false,
      appPath: '/home/u/repo/apps/desktop',
      userDataDir: '/home/u/scratch',
      userDataSwitch: true,
    })
    expect(record).toEqual({
      exec: '/home/u/repo/node_modules/electron/dist/electron',
      args: ['/home/u/repo/apps/desktop', '--user-data-dir=/home/u/scratch'],
      version: '1.2.3',
    })
  })

  it('a packaged macOS app records its bundle; an unpackaged one and other platforms record none', () => {
    const mac = { ...base, platform: 'darwin' as NodeJS.Platform, execPath: '/Applications/WeftCut.app/Contents/MacOS/WeftCut' }
    expect(launchRecord(mac).bundle).toBe('/Applications/WeftCut.app')
    const dev = { ...mac, isPackaged: false, execPath: '/Users/u/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' }
    expect('bundle' in launchRecord(dev)).toBe(false)
    expect('bundle' in launchRecord(base)).toBe(false)
  })
})

describe('stdioConnectConfig', () => {
  it('is the installed binary and the mcp subcommand, with no environment', () => {
    expect(stdioConnectConfig('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe')).toEqual({
      command: 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe',
      args: ['mcp'],
    })
  })
})
