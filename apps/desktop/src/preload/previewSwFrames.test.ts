import { describe, expect, it, vi } from 'vitest'
import { createPreviewSwFrames } from './previewSwFrames'
import type { PreviewSwFrameMsg } from '../shared/ipc'

function frame(streamId: string): PreviewSwFrameMsg {
  return { streamId, ptsUs: 0, durUs: 1, width: 2, height: 2, format: 'NV12', data: new Uint8Array(6) }
}

describe('preview SW frame routing', () => {
  it("hands a frame to its own stream's subscriber and to no other", () => {
    const frames = createPreviewSwFrames()
    const a = vi.fn()
    const b = vi.fn()
    frames.subscribe('a', a)
    frames.subscribe('b', b)

    const sent = frame('a')
    frames.dispatch(sent)

    expect(a.mock.calls).toEqual([[sent]])
    expect(b).not.toHaveBeenCalled()
  })

  it('drops a frame whose stream has no subscriber', () => {
    const frames = createPreviewSwFrames()
    const a = vi.fn()
    const unsubscribe = frames.subscribe('a', a)
    unsubscribe()
    frames.dispatch(frame('a'))
    expect(a).not.toHaveBeenCalled()
  })

  it("keeps a reopened stream's subscriber when the earlier one unsubscribes late", () => {
    const frames = createPreviewSwFrames()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = frames.subscribe('a', first)
    frames.subscribe('a', second)
    unsubscribeFirst()

    frames.dispatch(frame('a'))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
