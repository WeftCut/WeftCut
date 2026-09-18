// apps/desktop/src/shared/effects/catalogView.ts
// `effects://catalog` / `read_project { view: "effects" }`: every effect kind
// `add_effect` takes, with each param's default and range — the vocabulary an
// agent would otherwise learn from refusals. One projection of the two shared
// catalogs the parser refuses against, so what is advertised is exactly what
// is accepted.
import { EFFECT_KINDS, effectParamSpecs } from './params'
import { AUDIO_EFFECTS } from '../audioEffects/catalog'

export interface EffectsCatalogView {
  kinds: Array<{
    kind: string
    target: 'visual' | 'audio'
    params: Record<string, { default?: number; range: [number, number]; unit?: string }>
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
        // A region bound has no default ON PURPOSE (`staticParams`): "no region
        // yet" is what the effect's completeness check refuses on, and a
        // default here would read as one already chosen.
        const isRegionBound = audio?.region !== undefined && (k === audio.region.inKey || k === audio.region.outKey)
        params[k] = { ...(isRegionBound ? {} : { default: s.default }), range: [s.range[0], s.range[1]], ...(unit ? { unit } : {}) }
      }
      return {
        kind, target: audio ? 'audio' : 'visual', params,
        ...(audio?.region ? { region: { in_key: audio.region.inKey, out_key: audio.region.outKey, min_us: audio.region.minUs } } : {}),
      }
    }),
    param_key: 'update_effect writes a param Static as { "<key>": { "mode": "Static", "value": v } }; a VISUAL param is then keyframed as effects[<effect_id>].params[<key>]. Audio params are static only. A region bound has no default: the effect does nothing until both are written.',
  }
}
