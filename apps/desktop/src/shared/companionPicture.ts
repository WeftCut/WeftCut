// The companion picture as it is handed to viewers: the editor's encoded
// frames framed as `companion.ts` MIRROR_* says, and what each viewer is sent.
// Main hands them to pages over `GET /companion/video`; the editor window
// hands them to side-panel views over data channels
// (`renderer/companion/picturePeers.ts`). The editor encodes once; every viewer
// gets the same bytes, as fast as it takes them. Whether the editor encodes at
// all is `main/companion/hub.ts`'s demand.
import {
  MIRROR_FRAME_CONFIG, MIRROR_FRAME_DELTA, MIRROR_FRAME_FAILED, MIRROR_FRAME_KEY, MIRROR_HEADER_BYTES, VIEWER_BUFFER_BYTES,
  type CompanionMirrorConfig,
} from './companion'

/** One viewer: an open `/companion/video` response, or a data channel. */
export interface PictureSink {
  write(chunk: Uint8Array<ArrayBuffer>): unknown
  /** Bytes written and not yet sent. */
  readonly writableLength: number
}

export function frame(kind: number, timestampUs: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(MIRROR_HEADER_BYTES + payload.length)
  const head = new DataView(out.buffer, 0, MIRROR_HEADER_BYTES)
  head.setUint8(0, kind)
  head.setFloat64(1, timestampUs, true)
  head.setUint32(9, payload.length, true)
  out.set(payload, MIRROR_HEADER_BYTES)
  return out
}

export class PictureStream {
  /** Per viewer: whether it must wait for a keyframe, because it has not had
   *  every frame since the last one. */
  private readonly viewers = new Map<PictureSink, { needKey: boolean }>()
  private config: Uint8Array<ArrayBuffer> | null = null
  private lastKey: Uint8Array<ArrayBuffer> | null = null

  get size(): number { return this.viewers.size }

  /** A new viewer gets the config and the last keyframe at once, so it shows
   *  a picture before the next keyframe; it continues from that next one. */
  add(sink: PictureSink): () => void {
    this.viewers.set(sink, { needKey: true })
    if (this.config !== null) sink.write(this.config)
    if (this.lastKey !== null) sink.write(this.lastKey)
    return () => { this.viewers.delete(sink) }
  }

  /** A new encoder: what came before it cannot be decoded with its config. */
  configure(config: CompanionMirrorConfig): void {
    this.config = frame(MIRROR_FRAME_CONFIG, 0, new TextEncoder().encode(JSON.stringify(config)))
    this.lastKey = null
    for (const [sink, v] of this.viewers) {
      v.needKey = true
      sink.write(this.config)
    }
  }

  chunk(key: boolean, timestampUs: number, data: Uint8Array): void {
    const buf = frame(key ? MIRROR_FRAME_KEY : MIRROR_FRAME_DELTA, timestampUs, data)
    if (key) this.lastKey = buf
    for (const [sink, v] of this.viewers) {
      if (sink.writableLength > VIEWER_BUFFER_BYTES) {
        // Dropped: the deltas after it reference it, so this viewer waits.
        v.needKey = true
        continue
      }
      if (!key && v.needKey) continue
      v.needKey = false
      sink.write(buf)
    }
  }

  /** No encoder takes the picture: every viewer is told so, past its buffer
   *  bound too (the frame is a header). Call after `reset`. */
  fail(): void {
    const failed = frame(MIRROR_FRAME_FAILED, 0, new Uint8Array(0))
    for (const sink of this.viewers.keys()) sink.write(failed)
  }

  /** The encoder stopped: the next one starts with a config of its own. The
   *  viewers stay, for when it does. */
  reset(): void {
    this.config = null
    this.lastKey = null
    for (const v of this.viewers.values()) v.needKey = true
  }
}
