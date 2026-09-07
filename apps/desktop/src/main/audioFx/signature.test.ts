// The hash half. The canonical STRING's grammar is pinned next to it, in
// src/shared/audioEffects/signature.test.ts.
import { describe, it, expect } from 'vitest'
import { chainSig, chainSignature, sig16 } from './signature'
import { canonicalChain } from '../../shared/audioEffects/signature'
import { CONFORM_FORMAT_VERSION } from '../../shared/audioEffects/conform'
import { effectiveChain, staticParams, type AudioEffectEntry, type ChainEntry, type EffectiveChain } from '../../shared/audioEffects/catalog'
import { DENOISE } from '../../shared/audioEffects/denoise'

const MEDIA = { duration_us: 10_000_000 }
const HASH = 'abc123'
const REGION = { profile_in_us: 200_000, profile_out_us: 1_800_000 }
const sp = (value: number) => ({ mode: 'Static' as const, value })

function fx(id: string, values: Record<string, number>, enabled = true): AudioEffectEntry {
  return { id, kind: 'audio.denoise', enabled, params: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, sp(v)])) }
}
function chainOf(...effects: AudioEffectEntry[]): EffectiveChain {
  return effectiveChain({ effects }, MEDIA)
}

describe('chainSig / sig16', () => {
  it('is sha256 hex of the canonical string', () => {
    // sha256("") — pins the algorithm, not just the shape.
    expect(chainSig('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(chainSig('weftcut')).toHaveLength(64)
  })

  it('sig16 is the first 16 hex chars', () => {
    const sig = chainSig('weftcut')
    expect(sig16(sig)).toBe(sig.slice(0, 16))
    expect(sig16(sig)).toHaveLength(16)
  })
})

describe('chainSignature', () => {
  it('agrees with the parts it is built from', () => {
    const chain = chainOf(fx('e1', { ...REGION, strength: 12 }))
    const out = chainSignature(HASH, CONFORM_FORMAT_VERSION, chain)
    expect(out).not.toBeNull()
    expect(out?.canonical).toBe(canonicalChain(HASH, CONFORM_FORMAT_VERSION, chain))
    expect(out?.sig).toBe(chainSig(out?.canonical ?? ''))
    expect(out?.sig16).toBe(sig16(out?.sig ?? ''))
  })

  it('is null for an empty effective chain — nothing to bake, no artifact to name', () => {
    expect(chainSignature(HASH, CONFORM_FORMAT_VERSION, chainOf())).toBeNull()
    expect(chainSignature(HASH, CONFORM_FORMAT_VERSION, chainOf(fx('e1', REGION, false)))).toBeNull()
  })

  it('two layers configured alike get one sig; a param edit gets another', () => {
    const a = chainSignature(HASH, CONFORM_FORMAT_VERSION, chainOf(fx('e1', { ...REGION, strength: 12 })))
    const same = chainSignature(HASH, CONFORM_FORMAT_VERSION, chainOf(fx('e2', { ...REGION, strength: 12 })))
    const edited = chainSignature(HASH, CONFORM_FORMAT_VERSION, chainOf(fx('e1', { ...REGION, strength: 13 })))
    expect(same?.sig).toBe(a?.sig)
    expect(edited?.sig).not.toBe(a?.sig)
  })

  // The catalog's invalidation lever, through the hash this time: same params,
  // different graph, so every artifact baked from the old entry must re-render.
  it('changes when the descriptor version bumps', () => {
    const effect = fx('e1', { ...REGION, strength: 12 })
    const v1: ChainEntry = { effect, descriptor: DENOISE, params: staticParams(effect, DENOISE) }
    const v2: ChainEntry = { ...v1, descriptor: { ...DENOISE, version: 2 } }
    const a = chainSignature(HASH, CONFORM_FORMAT_VERSION, [v1])
    const b = chainSignature(HASH, CONFORM_FORMAT_VERSION, [v2])
    expect(a?.sig).not.toBe(b?.sig)
    expect(a?.sig16).not.toBe(b?.sig16)
  })
})
