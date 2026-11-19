import type { PreviewSwFrameMsg } from '../shared/ipc'

/** Routes `previewSw:frame` to the one subscriber of the frame's stream.
 *
 * LANDMINE: a subscriber's callback lives in the page, and each call copies the
 * frame's bytes across `contextBridge`. Calling every subscriber and letting
 * each filter by `streamId` copies a frame once per open stream. */
export function createPreviewSwFrames(): {
  subscribe(streamId: string, cb: (frame: PreviewSwFrameMsg) => void): () => void
  dispatch(frame: PreviewSwFrameMsg): void
} {
  const subscribers = new Map<string, (frame: PreviewSwFrameMsg) => void>()
  return {
    subscribe(streamId, cb) {
      subscribers.set(streamId, cb)
      // A reopened stream id must not lose its subscriber to the old one's unsubscribe.
      return () => { if (subscribers.get(streamId) === cb) subscribers.delete(streamId) }
    },
    dispatch(frame) { subscribers.get(frame.streamId)?.(frame) },
  }
}
