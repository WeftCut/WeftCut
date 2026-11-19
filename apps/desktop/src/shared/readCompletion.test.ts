import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadCompletionProof } from './readCompletion'

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap
afterEach(() => { vi.unstubAllGlobals() })

describe('shared-texture read completion proof', () => {
  // A CPU canvas (the hint true or unset) reads the whole frame back; a draw of
  // the whole bitmap scaled to one pixel samples all of it.
  it('reads one source pixel back from a canvas kept on the GPU', () => {
    const options: unknown[] = []
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn() }
    vi.stubGlobal('OffscreenCanvas', class { getContext(_: string, o: unknown) { options.push(o); return ctx } })
    const prove = createReadCompletionProof()
    const frame = bitmap()

    expect(prove(frame)).not.toBeNull()
    prove(frame)

    expect(options).toEqual([{ willReadFrequently: false }])
    expect(ctx.drawImage).toHaveBeenNthCalledWith(1, frame, 0, 0, 1, 1, 0, 0, 1, 1)
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 1, 1)
    expect(ctx.getImageData.mock.invocationCallOrder[0]).toBeGreaterThan(ctx.drawImage.mock.invocationCallOrder[0]!)
  })

  it('proves nothing without a 2D context', () => {
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return null } })
    expect(createReadCompletionProof()(bitmap())).toBeNull()
  })

  it('proves nothing where no offscreen canvas exists', () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    expect(createReadCompletionProof()(bitmap())).toBeNull()
  })
})
