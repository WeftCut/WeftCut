// The preload's one reader of shared-texture slots, for GPU preview sessions
// and Motif pools alike. Main sends each texture once, tagged with the slot it
// is (main/frameCarrier/sharedTextureImport.ts); this keeps it by that tag,
// reads a slot into an `ImageBitmap` on request, and releases a producer's
// textures when the producer goes. It lives in the preload because only the
// isolated world receives shared textures.
//
// A read is not finished when its bitmap resolves: Chromium's copy out of the
// shared texture may still be running on the GPU, so the producer may reuse the
// slot only once the reader proves the copy ran (the page's slot fence for
// video, `MotifReadBarrier` for Motif; docs/preview.md § The Standard engine).

import type { SharedTextureImported } from 'electron'
import type { SlotTag } from '../shared/frameCarrier/wire'

/** One slot read into a bitmap, and what `getVideoFrame` and
 * `createImageBitmap` cost in milliseconds. */
export interface SlotRead {
  bitmap: ImageBitmap
  gvfMs: number
  cibMs: number
}

export interface SlotReader {
  /** Keeps a texture main sent, by its tag. Releases one it cannot keep: a
   * malformed tag, a producer already dropped, a document going away. */
  receive(texture: SharedTextureImported, tag: unknown): void
  /** Reads slot `slot` of producer `key`. Rejects when the slot holds no
   * texture or the read fails. */
  read(key: string, slot: number): Promise<SlotRead>
  /** Releases `key`'s textures. One of `key`'s arriving later is released on
   * arrival. */
  drop(key: string): void
  /** Releases every texture and keeps none from now on: the document is going.
   * A document reload destroys the preload without closing its WebContents,
   * and Electron frees a shared texture only once every import of it is
   * released. */
  close(): void
}

/// How many dropped producers the reader remembers, to release a texture that
/// arrives after its producer was dropped (a close racing the open that sends
/// it). Keys are never reused, and a texture is in flight for at most its
/// send's timeout of about a second, so only the latest drops can still have
/// one coming.
const REMEMBERED_DROPS = 256

export function createSlotReader(): SlotReader {
  const textures = new Map<string, Map<number, SharedTextureImported>>()
  const dropped = new Set<string>()
  let closed = false
  const release = (texture: SharedTextureImported) => {
    try { texture.release() } catch { /* the GPU process is already gone */ }
  }
  return {
    receive(texture, tag) {
      const { key, slot } = (tag ?? {}) as Partial<SlotTag>
      if (closed || typeof key !== 'string' || !Number.isInteger(slot) || dropped.has(key)) {
        release(texture)
        return
      }
      let slots = textures.get(key)
      if (!slots) textures.set(key, slots = new Map())
      const previous = slots.get(slot!)
      if (previous) release(previous)
      slots.set(slot!, texture)
    },
    async read(key, slot) {
      const texture = textures.get(key)?.get(slot)
      if (!texture) throw new Error(`No texture for slot ${slot} of '${key}'`)
      let frame: VideoFrame | undefined
      try {
        const start = performance.now()
        frame = texture.getVideoFrame()
        const framed = performance.now()
        const bitmap = await createImageBitmap(frame)
        return { bitmap, gvfMs: framed - start, cibMs: performance.now() - framed }
      } finally {
        frame?.close()
      }
    },
    drop(key) {
      for (const texture of textures.get(key)?.values() ?? []) release(texture)
      textures.delete(key)
      dropped.add(key)
      if (dropped.size > REMEMBERED_DROPS) dropped.delete(dropped.values().next().value!)
    },
    close() {
      closed = true
      for (const slots of textures.values()) for (const texture of slots.values()) release(texture)
      textures.clear()
    },
  }
}
