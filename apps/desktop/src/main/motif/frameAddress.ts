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

/** The native core's file-originated failures carry this prefix (ticket 05):
 * absent, truncated, bad header, unsupported codec, checksum mismatch, or a
 * scaled size that does not fit the texture pool. Such a frame is a miss; any
 * other failure is the lane's, never the file's. */
const FRAME_ERROR = 'motif-frame: '
export function isMotifFrameError(error: unknown): boolean {
  return String((error as Error | undefined)?.message ?? error).startsWith(FRAME_ERROR)
}
