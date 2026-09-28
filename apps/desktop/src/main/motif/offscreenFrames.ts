import type { OffscreenSharedTexture, WebContents } from 'electron'

/** Owns Electron's scarce capture surfaces. Unrequested paints are released
 * immediately; one requested surface is leased only until the GPU copy ends. */
export class OffscreenFrames {
  private pending: { width: number; height: number; resolve: (t: OffscreenSharedTexture) => void; reject: (e: Error) => void } | null = null
  constructor(private readonly contents: WebContents) {
    contents.on('paint', event => {
      const texture = event.texture
      if (!texture) return
      const request = this.pending
      const size = texture.textureInfo.codedSize
      if (!request || size.width !== request.width || size.height !== request.height) {
        texture.release()
        return
      }
      this.pending = null
      request.resolve(texture)
    })
  }

  capture(width: number, height: number): Promise<OffscreenSharedTexture> {
    if (this.pending) return Promise.reject(new Error('Overlapping Motif OSR capture'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null
        reject(new Error('Motif OSR paint timed out'))
      }, 1500)
      this.pending = {
        width, height,
        resolve: t => { clearTimeout(timeout); resolve(t) },
        reject: e => { clearTimeout(timeout); reject(e) },
      }
      // __motifRender has already settled. Restart the capturer for repeated /
      // static seeks: invalidate alone can emit a paint with NO shared texture.
      this.contents.stopPainting()
      this.contents.startPainting()
      this.contents.invalidate()
    })
  }

  prepare(): void { this.contents.stopPainting() }

  dispose(): void {
    this.pending?.reject(new Error('Motif capture host closed'))
    this.pending = null
  }
}
