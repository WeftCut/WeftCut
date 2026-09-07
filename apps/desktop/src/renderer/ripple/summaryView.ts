/// The renderer mirror as the ripple planner's view — the twin of
/// `main/state/mutations/ripple.ts`'s `rippleViewOfComposition`, reading the wire
/// shape where that one reads the actor's model.
///
/// Two one-screen mappers rather than one shared layer model, for the boundary
/// `plan.ts` records: main may import a pure renderer module, the renderer may
/// never import `main/state`. What the two sides agree on is the STRUCTURE below,
/// so a field added to either layer model reaches the planner only if someone
/// maps it here as well — which is the drift this shape is meant to make visible.
///
/// ADR 0062.
import type { CompositionSummary } from '../ipc'
import type { RippleView } from './plan'

export function rippleViewOfSummary(c: CompositionSummary): RippleView {
  return {
    fps: { num: c.fps_num, den: c.fps_den },
    tracks: c.tracks.map((t) => ({
      id: t.id,
      locked: t.locked,
      // `l.kind` and not `l.params.kind`: the summary projects the params
      // discriminant onto the layer itself, and the two are the same string
      // (`main/state/summary.ts`'s `layerKind`). The planner's overlap class is
      // read off it exactly as the actor's is off `params.kind`.
      layers: t.layers.map((l) => ({
        id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us, locked: l.locked, kind: l.kind,
      })),
    })),
    // `layer_ids` on the wire, `members` in the actor's model — the one field
    // whose NAME differs between the two sides, which is the whole reason this
    // mapper exists rather than a cast.
    links: c.links.map((g) => ({ id: g.id, members: g.layer_ids })),
    transitions: c.transitions.map((tr) => ({
      from_layer: tr.from_layer, to_layer: tr.to_layer, duration_us: tr.duration_us,
    })),
  }
}
