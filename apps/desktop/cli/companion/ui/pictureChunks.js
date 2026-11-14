// The companion picture over loopback: the app's `/companion/video` stream
// split into frames and decoded onto a canvas. `transportLoopback.js` opens
// the stream; `app.js` only hands it the place to draw.

// LANDMINE: the layout of `MIRROR_*` in `src/shared/companion.ts`: u8 kind,
// f64 timestamp in microseconds, u32 payload length, little-endian. Change
// both (`pageUi.test.ts` holds them equal).
export const HEADER_BYTES = 13
export const FRAME_CONFIG = 0
export const FRAME_KEY = 1
export const FRAME_DELTA = 2

/** Frames waiting in the decoder past which a delta is dropped. The deltas
 *  after a dropped one reference it, so the decoder then waits for the next
 *  keyframe; a page that cannot keep up shows fewer frames, never broken ones. */
export const DECODE_QUEUE_MAX = 3

/** Returns a splitter: given the stream's next bytes, it answers the whole
 *  frames they complete, `{ kind, timestamp, payload }`, and keeps the rest. */
export function frameSplitter() {
  let buffer = new Uint8Array(0)
  return (bytes) => {
    const joined = new Uint8Array(buffer.length + bytes.length)
    joined.set(buffer)
    joined.set(bytes, buffer.length)
    buffer = joined
    const frames = []
    let at = 0
    while (buffer.length - at >= HEADER_BYTES) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + at, HEADER_BYTES)
      const length = view.getUint32(9, true)
      if (buffer.length - at < HEADER_BYTES + length) break
      frames.push({
        kind: view.getUint8(0),
        timestamp: view.getFloat64(1, true),
        payload: buffer.slice(at + HEADER_BYTES, at + HEADER_BYTES + length),
      })
      at += HEADER_BYTES + length
    }
    buffer = buffer.slice(at)
    return frames
  }
}

/**
 * Decodes frames onto `canvas`.
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   codecs: { VideoDecoder: typeof VideoDecoder, EncodedVideoChunk: typeof EncodedVideoChunk },
 *   shown(): void,
 * }} deps `shown` is called on every frame drawn.
 */
export function pictureDecoder({ canvas, codecs, shown }) {
  const context = canvas.getContext('2d')
  let config = null
  let decoder = null
  let waitingKey = true

  function open() {
    const d = new codecs.VideoDecoder({
      output: (frame) => {
        context?.drawImage(frame, 0, 0, canvas.width, canvas.height)
        frame.close()
        shown()
      },
      error: () => {
        // A closed decoder takes nothing more: a new one starts at the next keyframe.
        if (decoder === d) decoder = null
        waitingKey = true
      },
    })
    // No `description`: H.264 comes as Annex B, which the decoder reads as is.
    d.configure({ codec: config.codec, codedWidth: config.coded_width, codedHeight: config.coded_height, optimizeForLatency: true })
    return d
  }

  function closeDecoder() {
    if (decoder !== null && decoder.state !== 'closed') decoder.close()
    decoder = null
  }

  return {
    take(frame) {
      if (frame.kind === FRAME_CONFIG) {
        config = JSON.parse(new TextDecoder().decode(frame.payload))
        canvas.width = config.coded_width
        canvas.height = config.coded_height
        closeDecoder()
        waitingKey = true
        return
      }
      const key = frame.kind === FRAME_KEY
      if (config === null || (waitingKey && !key)) return
      if (decoder === null) decoder = open()
      if (!key && decoder.decodeQueueSize > DECODE_QUEUE_MAX) {
        waitingKey = true
        return
      }
      waitingKey = false
      decoder.decode(new codecs.EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.payload }))
    },
    close: closeDecoder,
  }
}

/** Reads `body` into `decoder` until the stream ends. */
export async function readPicture(body, decoder) {
  const reader = body.getReader()
  const split = frameSplitter()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    for (const frame of split(value)) decoder.take(frame)
  }
}
