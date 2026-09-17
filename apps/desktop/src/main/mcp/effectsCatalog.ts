// apps/desktop/src/main/mcp/effectsCatalog.ts
// `effects://catalog` / `read_project { view: "effects" }`: every effect kind
// `add_effect` takes, with each param's default and range — the vocabulary the
// audit's testers had to learn from refusals (§3, effects: "blur/chromakey
// params unknown"). One projection of the two shared catalogs the parser
// refuses against, so what is advertised is exactly what is accepted.
import { EFFECT_KINDS, effectParamSpecs } from '../../shared/effects/params.js'
import { AUDIO_EFFECTS } from '../../shared/audioEffects/catalog.js'

export interface EffectsCatalogView {
  kinds: Array<{
    kind: string
    target: 'visual' | 'audio'
    params: Record<string, { default: number; range: [number, number]; unit?: string }>
    region?: { in_key: string; out_key: string; min_us: number }
  }>
  param_key: string
}

export function effectsCatalogView(): EffectsCatalogView {
  return {
    kinds: EFFECT_KINDS.map((kind) => {
      const audio = AUDIO_EFFECTS[kind]
      const specs = effectParamSpecs(kind) ?? {}
      const params: EffectsCatalogView['kinds'][number]['params'] = {}
      for (const [k, s] of Object.entries(specs)) {
        const unit = audio?.params[k]?.unit
        params[k] = { default: s.default, range: [s.range[0], s.range[1]], ...(unit ? { unit } : {}) }
      }
      return {
        kind, target: audio ? 'audio' : 'visual', params,
        ...(audio?.region ? { region: { in_key: audio.region.inKey, out_key: audio.region.outKey, min_us: audio.region.minUs } } : {}),
      }
    }),
    param_key: 'A param is keyframed as effects[<effect_id>].params[<key>]; update_effect writes it Static as { "<key>": { "mode": "Static", "value": v } }.',
  }
}
