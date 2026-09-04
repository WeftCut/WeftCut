// revealPathRobust's per-platform dispatch. showItemInFolder is void and
// swallows failures, so the contract under test is (a) the existence check
// that turns a missing file into a reportable error and (b) Linux never
// reaching showItemInFolder at all — it opens the parent folder through the
// detached xdg-open path instead (see the comment on revealPathRobust).
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { shell, stat, spawn } = vi.hoisted(() => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  stat: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('electron', () => ({ shell }))
vi.mock('node:fs/promises', () => ({ stat }))
vi.mock('node:child_process', () => ({ spawn }))

import { revealPathRobust } from './openPath'

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/// A child that exits cleanly on the next tick — what xdg-open does once the
/// real handler has re-parented itself.
function exitingChild(): EventEmitter & { unref: () => void } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  setImmediate(() => child.emit('exit', 0))
  return child
}

beforeEach(() => {
  shell.showItemInFolder.mockReset()
  shell.openPath.mockReset()
  stat.mockReset()
  spawn.mockReset()
})

afterEach(() => setPlatform(realPlatform))

describe('revealPathRobust', () => {
  it('selects an existing file in the file manager off Linux', async () => {
    setPlatform('win32')
    stat.mockResolvedValue({})

    const err = await revealPathRobust('C:/out/final.mp4')

    expect(err).toBe('')
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path.normalize('C:/out/final.mp4'))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a missing file instead of letting showItemInFolder no-op silently', async () => {
    setPlatform('darwin')
    stat.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }))

    const err = await revealPathRobust('/Users/me/out/gone.mp4')

    expect(err).toMatch(/ENOENT/)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('opens the containing folder via detached xdg-open on Linux, never showItemInFolder', async () => {
    setPlatform('linux')
    stat.mockResolvedValue({})
    spawn.mockImplementation(exitingChild)

    const target = '/home/me/out/final.mp4'
    const err = await revealPathRobust(target)

    expect(err).toBe('')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      'xdg-open',
      [path.dirname(path.normalize(target))],
      { detached: true, stdio: 'ignore' },
    )
  })
})
