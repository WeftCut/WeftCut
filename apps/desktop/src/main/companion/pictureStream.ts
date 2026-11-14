// apps/desktop/src/main/companion/pictureStream.ts
//
// The companion picture as main hands it to pages: the editor's encoded frames
// framed for `GET /companion/video`, and what each viewer is sent. The editor
// encodes once; every viewer gets the same bytes, as fast as it takes them.
// Whether the editor encodes at all is `hub.ts`'s demand.
import {
  MIRROR_FRAME_CONFIG, MIRROR_FRAME_DELTA, MIRROR_FRAME_KEY, MIRROR_HEADER_BYTES, VIEWER_BUFFER_BYTES,
  type CompanionMirrorConfig,
} from '../../shared/companion.js'

/** One open `/companion/video` response. */
export interface PictureSink {
  write(chunk: Buffer): unknown
  /** Bytes written and not yet sent. */
  readonly writableLength: number
}

export function frame(kind: number, timestampUs: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(MIRROR_HEADER_BYTES)
  head.writeUInt8(kind, 0)
  head.writeDoubleLE(timestampUs, 1)
  head.writeUInt32LE(payload.length, 9)
  return Buffer.concat([head, payload])
}

export class PictureStream {
  /** Per viewer: whether it must wait for a keyframe, because it has not had
   *  every frame since the last one. */
  private readonly viewers = new Map<PictureSink, { needKey: boolean }>()
  private config: Buffer | null = null
  private lastKey: Buffer | null = null

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
    this.config = frame(MIRROR_FRAME_CONFIG, 0, Buffer.from(JSON.stringify(config)))
    this.lastKey = null
    for (const [sink, v] of this.viewers) {
      v.needKey = true
      sink.write(this.config)
    }
  }

  chunk(key: boolean, timestampUs: number, data: Buffer): void {
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

  /** The encoder stopped: the next one starts with a config of its own. The
   *  viewers stay, for when it does. */
  reset(): void {
    this.config = null
    this.lastKey = null
    for (const v of this.viewers.values()) v.needKey = true
  }
}
