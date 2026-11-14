// The picture's bytes on their way to pages: what a new viewer starts from,
// and what a viewer too slow to take them is spared.
import { describe, expect, it } from 'vitest'
import { PictureStream, frame, type PictureSink } from './pictureStream'
import {
  MIRROR_FRAME_CONFIG, MIRROR_FRAME_DELTA, MIRROR_FRAME_KEY, MIRROR_HEADER_BYTES, VIEWER_BUFFER_BYTES,
} from '../../shared/companion'

/** A response whose unsent bytes the test controls: `drain()` sends them all. */
function viewer() {
  const frames: Array<{ kind: number; ts: number; bufferedBefore: number }> = []
  let buffered = 0
  const sink: PictureSink = {
    write: (b) => {
      frames.push({ kind: b.readUInt8(0), ts: b.readDoubleLE(1), bufferedBefore: buffered })
      buffered += b.length
    },
    get writableLength() { return buffered },
  }
  return { sink, frames, drain: () => { buffered = 0 } }
}

const CONFIG = { codec: 'vp8', coded_width: 640, coded_height: 360 }
const payload = (bytes: number) => Buffer.alloc(bytes, 7)

describe('frame', () => {
  it('lays out kind, timestamp and length ahead of the payload', () => {
    const b = frame(MIRROR_FRAME_KEY, 1_500_000, Buffer.from([9, 8, 7]))
    expect(b.length).toBe(MIRROR_HEADER_BYTES + 3)
    expect([b.readUInt8(0), b.readDoubleLE(1), b.readUInt32LE(9)]).toEqual([MIRROR_FRAME_KEY, 1_500_000, 3])
    expect([...b.subarray(MIRROR_HEADER_BYTES)]).toEqual([9, 8, 7])
  })
})

describe('PictureStream', () => {
  it('starts a new viewer from the config and the last keyframe, then the next keyframe', () => {
    const stream = new PictureStream()
    stream.configure(CONFIG)
    stream.chunk(true, 1, payload(10))
    stream.chunk(false, 2, payload(10))
    const late = viewer()
    stream.add(late.sink)
    expect(late.frames.map((f) => f.kind)).toEqual([MIRROR_FRAME_CONFIG, MIRROR_FRAME_KEY])
    // Deltas after the key it was given reference frames it never had.
    stream.chunk(false, 3, payload(10))
    stream.chunk(true, 4, payload(10))
    stream.chunk(false, 5, payload(10))
    expect(late.frames.map((f) => f.ts)).toEqual([0, 1, 4, 5])
  })

  it('makes a viewer too slow to take its frames wait for a keyframe, and never writes into a full buffer', () => {
    const stream = new PictureStream()
    const slow = viewer()
    const fast = viewer()
    stream.add(slow.sink)
    stream.add(fast.sink)
    stream.configure(CONFIG)
    const chunkBytes = Math.ceil(VIEWER_BUFFER_BYTES / 3)
    let ts = 0
    stream.chunk(true, ++ts, payload(chunkBytes))
    for (let i = 0; i < 6; i++) {
      stream.chunk(false, ++ts, payload(chunkBytes))
      fast.drain()
    }
    expect(slow.frames.every((f) => f.bufferedBefore <= VIEWER_BUFFER_BYTES)).toBe(true)
    const skipped = slow.frames.length
    expect(skipped).toBeLessThan(fast.frames.length)
    // Sent at last, the slow viewer still gets no delta before a keyframe.
    slow.drain()
    stream.chunk(false, ++ts, payload(10))
    expect(slow.frames).toHaveLength(skipped)
    stream.chunk(true, ++ts, payload(10))
    stream.chunk(false, ++ts, payload(10))
    expect(slow.frames.slice(skipped).map((f) => f.kind)).toEqual([MIRROR_FRAME_KEY, MIRROR_FRAME_DELTA])
    // The fast one missed nothing.
    expect(fast.frames).toHaveLength(1 + 1 + 6 + 3)
  })

  it('makes every viewer wait for a keyframe of the new encoder after a new config or a reset', () => {
    const stream = new PictureStream()
    const v = viewer()
    stream.add(v.sink)
    stream.configure(CONFIG)
    stream.chunk(true, 1, payload(10))
    stream.reset()
    stream.chunk(false, 2, payload(10))
    stream.configure(CONFIG)
    stream.chunk(false, 3, payload(10))
    stream.chunk(true, 4, payload(10))
    expect(v.frames.map((f) => [f.kind, f.ts])).toEqual([[MIRROR_FRAME_CONFIG, 0], [MIRROR_FRAME_KEY, 1], [MIRROR_FRAME_CONFIG, 0], [MIRROR_FRAME_KEY, 4]])
    // Nothing from before the reset is handed to a viewer that joins after it.
    stream.reset()
    const late = viewer()
    stream.add(late.sink)
    expect(late.frames).toEqual([])
  })
})
