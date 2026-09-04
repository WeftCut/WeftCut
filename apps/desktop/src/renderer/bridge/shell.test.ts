import { afterEach, describe, expect, it, vi } from 'vitest'
import { open, reveal } from './shell'

afterEach(() => vi.unstubAllGlobals())

describe('shell bridge', () => {
  it('opens a target via the native shell capability, not the Rust dispatcher', async () => {
    const shellOpen = vi.fn().mockResolvedValue(undefined)
    const invoke = vi.fn()
    vi.stubGlobal('window', { api: { shell: { open: shellOpen }, backend: { invoke } } })

    await open('C:/logs')

    expect(shellOpen).toHaveBeenCalledWith('C:/logs')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reveals a file through the dedicated reveal capability, not open()', async () => {
    const shellOpen = vi.fn().mockResolvedValue(undefined)
    const shellReveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { shell: { open: shellOpen, reveal: shellReveal } } })

    await reveal('C:/out/final.mp4')

    expect(shellReveal).toHaveBeenCalledWith('C:/out/final.mp4')
    expect(shellOpen).not.toHaveBeenCalled()
  })

  it('propagates a main-side reveal failure (file gone) to the caller', async () => {
    const shellReveal = vi.fn().mockRejectedValue(new Error('cannot reveal C:/out/gone.mp4: ENOENT'))
    vi.stubGlobal('window', { api: { shell: { open: vi.fn(), reveal: shellReveal } } })

    await expect(reveal('C:/out/gone.mp4')).rejects.toThrow(/ENOENT/)
  })
})
