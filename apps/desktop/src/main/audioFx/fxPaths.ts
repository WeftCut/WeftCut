// Where a baked effect-chain artifact lives, and whether the copy on disk can
// be trusted. Two facts the Rust cache owns, restated for the one TS caller
// that has to name a file Rust never told it about: the baker holds the chain
// signature, so only the baker can build the path (ADR 0063).
//
// LANDMINE: every shape below is a TWIN of `native/src/cache/mod.rs`
// (`set_workspace`, `audio_conform_dir`, `audio_fx_conform`, `waveforms_dir`,
// `waveform_fx`, `cached_ok`, `touch_if_stale`) and `native/src/jobs/conform.rs`
// (`MAGIC`, `HEADER_LEN`, `read_header`). No test spans the boundary: drift here
// bakes an artifact Rust will not find, or trusts one Rust would reject.
//
// Bake state is a DERIVATION and disk existence is the truth (spec Decision 8),
// which is why the predicates live beside the paths rather than in the baker's
// state machine. See ADR 0063 and docs/audio.md § Clip effects.

import nodeFs from 'node:fs'
import { CONFORM_FORMAT_VERSION } from '../../shared/audioEffects/conform'

/** VCONF header: 8-byte magic, then version / sample_rate / channels as u32 LE
 *  and frame_count as u64 LE. */
const VCONF_MAGIC = 'VCONF\0\0\0'
export const VCONF_HEADER_LEN = 28

/** Widest channel count a conform is ever written with (`read_header` bails
 *  outside it, so a file claiming more is corrupt rather than exotic). */
const VCONF_MAX_CHANNELS = 2

/** How stale the mtime of a swept-cache file may be before a read refreshes
 *  it. mtime IS the disk-LRU clock, so a reader that short-circuits on a cache
 *  hit has to bump it or a live artifact ages out as if unused. Relatime
 *  semantics: a hot path stays at one metadata read. */
export const FX_TOUCH_THROTTLE_MS = 60 * 60 * 1000

/** The filesystem surface the fx predicates need, injected so the baker's state
 *  machine is testable without a real cache directory. `statFile` answers null
 *  for anything that is not a regular file. */
export interface AudioFxFs {
  statFile(path: string): { size: number; mtimeMs: number } | null
  /** First `VCONF_HEADER_LEN` bytes, or null when the file is missing or short. */
  readHeader(path: string): Uint8Array | null
  /** Best-effort mtime bump. Errors are ignored — worst case the file evicts
   *  and regenerates. */
  touch(path: string, whenMs: number): void
}

/** The two artifact paths one `(media, chain signature)` pair names. Resolves
 *  the cache root per call: it moves with the workspace, so a layout captured
 *  at boot would name files in the previous project's cache. */
export interface FxCacheLayout {
  audioFxConform(mediaHash: string, sig16: string): string
  waveformFx(mediaHash: string, sig16: string): string
}

/** The cache root in force for a workspace. `<workspace>/Cache` once a project
 *  is open; the app-level cache dir before that (the boot fallback the Backend
 *  is constructed with). */
export function fxCacheRoot(
  workspaceDir: string | null,
  bootCacheDir: string,
  join: (...parts: string[]) => string,
): string {
  return workspaceDir === null ? bootCacheDir : join(workspaceDir, 'Cache')
}

export function createFxCacheLayout(deps: {
  cacheRoot: () => string
  join: (...parts: string[]) => string
}): FxCacheLayout {
  const { cacheRoot, join } = deps
  return {
    audioFxConform(mediaHash, sig16) {
      return join(cacheRoot(), 'audio', `${mediaHash}.fx-${sig16}.conform`)
    },
    waveformFx(mediaHash, sig16) {
      return join(cacheRoot(), 'waveforms', `${mediaHash}.fx-${sig16}.v4.peaks`)
    },
  }
}

/** Exists, is a regular file, and is non-empty. `exists()` alone would accept
 *  an interrupted ffmpeg's zero-byte file, which a reader would then trust. */
export function cachedOk(fs: AudioFxFs, path: string): boolean {
  const stat = fs.statFile(path)
  return stat !== null && stat.size > 0
}

/** `cachedOk` plus a header a conform reader will accept — the full gate for
 *  reusing a baked sibling. A file that fails it is regenerated rather than
 *  played: half a VCONF is "not what you heard" (spec Decision 9). */
export function conformCachedOk(fs: AudioFxFs, path: string): boolean {
  if (!cachedOk(fs, path)) return false
  const head = fs.readHeader(path)
  if (head === null || head.length < VCONF_HEADER_LEN) return false
  for (let i = 0; i < VCONF_MAGIC.length; i++) {
    if (head[i] !== VCONF_MAGIC.charCodeAt(i)) return false
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (view.getUint32(8, true) !== CONFORM_FORMAT_VERSION) return false
  const channels = view.getUint32(16, true)
  return channels >= 1 && channels <= VCONF_MAX_CHANNELS
}

/** Whether `path` exists and its mtime has aged past the throttle. A future
 *  mtime (clock skew) counts as stale so it normalizes back to now. Split out
 *  so a caller can ASK before deciding to do any other work for the same file
 *  — the answer is one metadata read either way. */
export function touchDue(fs: AudioFxFs, path: string, nowMs: number): boolean {
  const stat = fs.statFile(path)
  if (stat === null) return false
  const age = nowMs - stat.mtimeMs
  return age < 0 || age > FX_TOUCH_THROTTLE_MS
}

/** Bump `path`'s mtime when `touchDue` says it has aged out. */
export function touchIfStale(fs: AudioFxFs, path: string, nowMs: number): void {
  if (touchDue(fs, path, nowMs)) fs.touch(path, nowMs)
}

/** Production `AudioFxFs` over `node:fs`. Every method swallows — a cache probe
 *  answering "no" is always a safe answer (the artifact is re-derived), while a
 *  throw would take down whichever project change triggered the probe. */
export function createNodeAudioFxFs(): AudioFxFs {
  return {
    statFile(path) {
      try {
        const s = nodeFs.statSync(path)
        return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null
      } catch { return null }
    },
    readHeader(path) {
      let fd: number | null = null
      try {
        fd = nodeFs.openSync(path, 'r')
        const buf = new Uint8Array(VCONF_HEADER_LEN)
        const read = nodeFs.readSync(fd, buf, 0, VCONF_HEADER_LEN, 0)
        return read === VCONF_HEADER_LEN ? buf : null
      } catch { return null } finally {
        if (fd !== null) { try { nodeFs.closeSync(fd) } catch { /* already gone */ } }
      }
    },
    touch(path, whenMs) {
      try { nodeFs.utimesSync(path, new Date(whenMs), new Date(whenMs)) } catch { /* best-effort */ }
    },
  }
}
