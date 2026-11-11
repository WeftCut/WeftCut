import { describe, expect, it } from 'vitest'
import { legacyShimHandover } from './legacyShim.js'

const only = (...files: string[]) => (file: string): boolean => files.includes(file)

describe('legacyShimHandover', () => {
  it('is null for a start that names no legacy shim', () => {
    const none = { platform: 'linux' as const, shippedDir: '/opt/WeftCut/resources/cli', isFile: () => true }
    expect(legacyShimHandover({ ...none, argv: ['/opt/WeftCut/weftcut'] })).toBeNull()
    expect(legacyShimHandover({ ...none, argv: ['/opt/WeftCut/weftcut', '--user-data-dir=/home/u/p', '/home/u/clip.mp4'] })).toBeNull()
    // The executable's own path is not an argument.
    expect(legacyShimHandover({ ...none, argv: ['/home/u/weftcut-mcp.cjs'] })).toBeNull()
    // Another file whose name merely ends the same way.
    expect(legacyShimHandover({ ...none, argv: ['/opt/WeftCut/weftcut', '/home/u/not-weftcut-mcp.cjs'] })).toBeNull()
  })

  it("prefers the profile's copy, beside where the script was, then the shipped one", () => {
    const installed = '/home/u/.config/WeftCut/cli/weftcut'
    const shipped = '/opt/WeftCut/resources/cli/weftcut'
    const start = {
      argv: ['/opt/WeftCut/weftcut', '/home/u/.config/WeftCut/cli/weftcut-mcp.cjs'],
      platform: 'linux' as const,
      shippedDir: '/opt/WeftCut/resources/cli',
    }
    expect(legacyShimHandover({ ...start, isFile: only(installed, shipped) })).toEqual([installed, shipped])
    expect(legacyShimHandover({ ...start, isFile: only(shipped) })).toEqual([shipped])
  })

  it('is an empty list, not null, when the start is an old config and no binary exists', () => {
    expect(
      legacyShimHandover({
        argv: ['/opt/WeftCut/weftcut', '/home/u/.config/WeftCut/cli/weftcut-mcp.cjs'],
        platform: 'linux',
        shippedDir: '/opt/WeftCut/resources/cli',
        isFile: () => false,
      }),
    ).toEqual([])
  })

  it('finds the script behind the app path an unpackaged Electron is given', () => {
    const installed = '/home/u/scratch/cli/weftcut'
    expect(
      legacyShimHandover({
        argv: ['/home/u/repo/node_modules/electron/dist/electron', '/home/u/repo/apps/desktop', '/home/u/scratch/cli/weftcut-mcp.cjs'],
        platform: 'linux',
        shippedDir: '/home/u/repo/apps/desktop/out/cli',
        isFile: only(installed),
      }),
    ).toEqual([installed])
  })

  it('on Windows reads backslash paths and looks for weftcut.exe', () => {
    const installed = 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe'
    const shipped = 'C:\\Program Files\\WeftCut\\resources\\cli\\weftcut.exe'
    expect(
      legacyShimHandover({
        argv: ['C:\\Program Files\\WeftCut\\WeftCut.exe', 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut-mcp.cjs'],
        platform: 'win32',
        shippedDir: 'C:\\Program Files\\WeftCut\\resources\\cli',
        isFile: only(installed, shipped),
      }),
    ).toEqual([installed, shipped])
  })
})
