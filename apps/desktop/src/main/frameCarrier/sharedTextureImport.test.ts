import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedTexture, type WebFrameMain } from 'electron'
import { importAndSend } from './sharedTextureImport'

vi.mock('electron', () => ({ sharedTexture: { importSharedTexture: vi.fn(), sendSharedTexture: vi.fn() } }))

const frame = { frame: 'main' } as unknown as WebFrameMain
const texture = { handle: Buffer.alloc(8), width: 64, height: 32, format: 'bgra' as const }
let release: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  release = vi.fn()
  vi.mocked(sharedTexture.importSharedTexture).mockReturnValue({ release } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>)
  vi.mocked(sharedTexture.sendSharedTexture).mockResolvedValue()
})

describe('importAndSend', () => {
  it('sends the import to the frame with its tag, and resolves with the import', async () => {
    const onAllReleased = vi.fn()
    const imported = await importAndSend(frame, texture, { key: 'k', slot: 2 }, onAllReleased)
    const [[options, tag]] = vi.mocked(sharedTexture.sendSharedTexture).mock.calls
    expect(options).toEqual({ frame, importedSharedTexture: imported })
    expect(tag).toEqual({ key: 'k', slot: 2 })
    expect(release).not.toHaveBeenCalled()
    expect(vi.mocked(sharedTexture.importSharedTexture).mock.calls[0]![0].allReferencesReleased).toBe(onAllReleased)
  })

  it('imports with the byte order it is given, sRGB passthrough, over the whole texture', async () => {
    await importAndSend(frame, texture, { key: 'k', slot: 0 }, () => {})
    const [[{ textureInfo }]] = vi.mocked(sharedTexture.importSharedTexture).mock.calls
    expect(textureInfo).toMatchObject({
      codedSize: { width: 64, height: 32 },
      visibleRect: { x: 0, y: 0, width: 64, height: 32 },
      pixelFormat: 'bgra',
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
    })
  })

  it('runs onAllReleased itself, once, when the import fails, and sends nothing', async () => {
    vi.mocked(sharedTexture.importSharedTexture).mockImplementation(() => { throw new Error('import refused') })
    const onAllReleased = vi.fn()
    await expect(importAndSend(frame, texture, { key: 'k', slot: 0 }, onAllReleased)).rejects.toThrow('import refused')
    expect(onAllReleased).toHaveBeenCalledOnce()
    expect(sharedTexture.sendSharedTexture).not.toHaveBeenCalled()
  })

  it('releases its import once when the send fails, leaving onAllReleased to Electron', async () => {
    vi.mocked(sharedTexture.sendSharedTexture).mockRejectedValue(new Error('send timed out'))
    const onAllReleased = vi.fn()
    await expect(importAndSend(frame, texture, { key: 'k', slot: 0 }, onAllReleased)).rejects.toThrow('send timed out')
    expect(release).toHaveBeenCalledOnce()
    expect(onAllReleased).not.toHaveBeenCalled()
  })
})
