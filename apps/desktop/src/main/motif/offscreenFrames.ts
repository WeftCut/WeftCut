import type { OffscreenSharedTexture, WebContents } from 'electron'

/** Owns Electron's scarce capture surfaces. Unrequested paints are released
 * immediately; one requested surface is leased only until the GPU copy ends.
 *
 * It also owns surface provenance: a shared texture is leased only from a
 * **proven** surface. A new document and a new size each give the compositor
 * a new surface, and its first paint can still hold the previous or the
 * uninitialised content even after the page's own frames settled — a full
 * readback (the caller's `fence`) is the one step known to synchronise it
 * (ADR 0078). The lease pays that readback once per surface, never
 * per frame, and the caller cannot forget it: the invariant lives here. */
export class OffscreenFrames {
  private pending: { width: number; height: number; resolve: (t: OffscreenSharedTexture) => void; reject: (e: Error) => void } | null = null
  /// The size the current surface was fenced at; null until fenced, and reset
  /// by anything that gives the compositor a new surface.
  private proven: { width: number; height: number } | null = null
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
    // Navigation is observed here rather than reported by the caller, so a
    // host that forgets to tell us still cannot lease a stale surface.
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) this.proven = null
    })
  }

  /** The compositor's surface was recreated behind our back (a GPU process
   * restart); the next lease fences again. */
  surfaceChanged(): void { this.proven = null }

  async capture(width: number, height: number, fence: () => Promise<unknown>): Promise<OffscreenSharedTexture> {
    if (this.pending) throw new Error('Overlapping Motif OSR capture')
    if (this.proven?.width !== width || this.proven?.height !== height) {
      this.proven = null
      await fence()
      this.proven = { width, height }
    }
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
