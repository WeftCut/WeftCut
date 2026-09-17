// What the VISUAL effect catalog looks like from the outside: each kind's
// params with their defaults and guidance ranges, and nothing that needs a GPU.
//
// The realtime registry (`renderer/render/effects/effectRegistry.ts`) is the
// authority on how a filter is built and applied, but it imports pixi.js and so
// cannot be read from the main process. The MCP boundary needs exactly the
// part below — to refuse an unknown kind, an unknown param key, a value
// outside the range — before a write reaches the actor, so an agent learns the
// vocabulary from the refusal instead of storing `audio.compressor` or
// `strength: 500` and reading success. `effectRegistry.test.ts` pins this table
// to the registry: a kind or param added to one without the other fails there.
//
// Ranges here are the same GUIDANCE the inspector draws its sliders from. The
// mutation layer deliberately enforces no range on stored effect params (a
// project written by a newer build stays openable, ADR 0027); the MCP parser is
// the one place that refuses, because an agent has no slider to see the bound.
// Audio kinds live in `../audioEffects/catalog.ts` and are merged by
// `effectParamSpecs` below.

import { AUDIO_EFFECTS } from '../audioEffects/catalog'

export interface EffectParamRange {
  default: number
  range: [number, number]
}

export const VISUAL_EFFECT_PARAMS: Readonly<Record<string, Readonly<Record<string, EffectParamRange>>>> = {
  blur: { strength: { default: 8, range: [0, 100] } },
  chromakey: {
    keyR: { default: 0, range: [0, 1] },
    keyG: { default: 1, range: [0, 1] },
    keyB: { default: 0, range: [0, 1] },
    balance: { default: 0.5, range: [0, 1] },
    clipBlack: { default: 0, range: [0, 1] },
    clipWhite: { default: 1, range: [0, 1] },
    despill: { default: 1, range: [0, 1] },
    feather: { default: 0, range: [0, 10] },
    shrink: { default: 0, range: [-5, 5] },
    viewMatte: { default: 0, range: [0, 1] },
  },
  brightness: { amount: { default: 0, range: [-100, 100] } },
  contrast: { amount: { default: 0, range: [-100, 100] } },
  saturation: { amount: { default: 0, range: [-100, 100] } },
  sharpen: { amount: { default: 0, range: [0, 100] } },
}

/** Every kind `add_effect` accepts: the visual catalog, then the `audio.*`
 *  catalog. Order is the advertised enum's order. */
export const EFFECT_KINDS: readonly string[] = [...Object.keys(VISUAL_EFFECT_PARAMS), ...Object.keys(AUDIO_EFFECTS)]

/** The params a KNOWN kind takes, with ranges, or null for a kind neither
 *  catalog describes — which stays permissive, because the project may have
 *  come from a build that knows more kinds than this one. */
export function effectParamSpecs(kind: string): Readonly<Record<string, EffectParamRange>> | null {
  const visual = VISUAL_EFFECT_PARAMS[kind]
  if (visual) return visual
  const audio = AUDIO_EFFECTS[kind]
  if (audio) {
    const out: Record<string, EffectParamRange> = {}
    for (const [k, spec] of Object.entries(audio.params)) out[k] = { default: spec.default, range: spec.range }
    return out
  }
  return null
}
