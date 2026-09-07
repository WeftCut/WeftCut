// The hash half of an audio-effect chain signature. Main-side because it is
// the one part that needs Node: `src/shared/audioEffects/` is compiled without
// @types/node so the renderer cannot pick up a Node dependency by accident, and
// nothing renderer-side computes a signature anyway — it reads the paths the
// baker publishes (`shared/audioEffects/status.ts`).
//
// The canonical STRING — the thing actually being hashed, and the only part
// with a grammar worth reviewing — stays shared
// (`shared/audioEffects/signature.ts`). See ADR 0063 and docs/audio.md.

import { createHash } from 'node:crypto'
import { canonicalChain } from '../../shared/audioEffects/signature'
import type { EffectiveChain } from '../../shared/audioEffects/catalog'

/** sha256 hex of the canonical chain string. Not blake3 (which the Rust cache
 *  keys use): there is no blake3 in the TS dependency set, and this digest
 *  never has to be reproduced on the Rust side — the signature is computed only
 *  here (spec Decision 7). */
export function chainSig(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** The short form that names files and waveform keys. 16 hex chars = 64 bits of
 *  the digest: the namespace is one user's cache directory, so collision risk is
 *  negligible and the filenames stay readable. */
export function sig16(sig: string): string {
  return sig.slice(0, 16)
}

/** Everything the baker needs to identify one artifact, or `null` when the
 *  layer has no effective chain (nothing to bake — the layer plays the raw
 *  conform). `canonical` is kept alongside the hash because it is the only
 *  readable form when two sigs disagree unexpectedly. */
export function chainSignature(
  mediaHash: string,
  conformVersion: number,
  chain: EffectiveChain,
): { canonical: string; sig: string; sig16: string } | null {
  const canonical = canonicalChain(mediaHash, conformVersion, chain)
  if (canonical === null) return null
  const sig = chainSig(canonical)
  return { canonical, sig, sig16: sig16(sig) }
}
