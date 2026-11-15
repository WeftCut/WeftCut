import { describe, expect, it } from 'vitest'
import { legacyConfigRefusal } from './legacyConfig.js'

describe('legacyConfigRefusal', () => {
  it('is null for a start that names no legacy shim', () => {
    expect(legacyConfigRefusal(['/opt/WeftCut/weftcut'], 'linux')).toBeNull()
    expect(legacyConfigRefusal(['/opt/WeftCut/weftcut', '--user-data-dir=/home/u/p', '/home/u/clip.mp4'], 'linux')).toBeNull()
    // The executable's own path is not an argument.
    expect(legacyConfigRefusal(['/home/u/weftcut-mcp.cjs'], 'linux')).toBeNull()
    // Another file whose name merely ends the same way.
    expect(legacyConfigRefusal(['/opt/WeftCut/weftcut', '/home/u/not-weftcut-mcp.cjs'], 'linux')).toBeNull()
  })

  it("is one line naming the profile's copy of the binary, where the script was, and the mcp subcommand", () => {
    const line = legacyConfigRefusal(['/opt/WeftCut/weftcut', '/home/u/.config/WeftCut/cli/weftcut-mcp.cjs'], 'linux')
    expect(line).toContain('Settings → Agent')
    expect(line).toContain('/home/u/.config/WeftCut/cli/weftcut mcp')
    expect(line).not.toMatch(/[\r\n]/)
  })

  it('finds the script behind the app path an unpackaged Electron is given', () => {
    const line = legacyConfigRefusal(
      ['/home/u/repo/node_modules/electron/dist/electron', '/home/u/repo/apps/desktop', '/home/u/scratch/cli/weftcut-mcp.cjs'],
      'linux',
    )
    expect(line).toContain('/home/u/scratch/cli/weftcut mcp')
  })

  it('on Windows reads backslash paths and names weftcut.exe', () => {
    const line = legacyConfigRefusal(
      ['C:\\Program Files\\WeftCut\\WeftCut.exe', 'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut-mcp.cjs'],
      'win32',
    )
    expect(line).toContain('C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut.exe mcp')
  })
})
