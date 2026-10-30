import path from 'node:path'

// Shared by `MotifFrameStore` in main and the Motif reader utility process
// (ADR 0154). Keep this module free of Electron and main-only imports: the
// utility entry loads it directly.

/** A cache address names a Motif content hash and a frame, never a path. */
export function isMotifFrameAddress(hash: unknown, frame: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{32}$/.test(hash)
    && typeof frame === 'number' && Number.isSafeInteger(frame) && frame >= 0
}

/** `<root>/Cache/raster/<hash>/<frame>`; callers append the extension. */
export function motifFrameStem(root: string, hash: string, frame: number): string {
  return path.join(root, 'Cache', 'raster', hash, String(frame))
}
