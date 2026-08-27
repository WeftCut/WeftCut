// Test-side fixtures for the composition container. `blankProject` is the
// de-facto fixture everywhere; these are the few shapes it cannot hand out
// directly now that the timeline lives under `compositions[root_id]`.
import type { IdGen } from '../../ids'
import { seededGen } from '../../ids'
import { blankProject, defaultCompositionSettings, newComposition, rootComposition, type Composition, type Project, type Uuid } from '../../model'
import { applyAddLayer, applyAddTrack, defaultTransform } from '../../mutations/add'
import { applyDurationAutofit } from '../../mutations/helpers'

/** `rootComposition`, short: tests write `root(p).tracks[0]`. */
export const root = rootComposition

/** `blankProject` plus patches on the project and/or its root. */
export function mkProject(over: { project?: Partial<Project>; root?: Partial<Composition>; idGen?: IdGen; name?: string } = {}): Project {
  const p = blankProject(over.idGen ?? seededGen(), over.name ?? 'test')
  if (over.root) Object.assign(rootComposition(p), over.root)
  return { ...p, ...over.project }
}

/** Immutable spread with the root patched — for history-style snapshot objects
 *  that must not be mutated in place. */
export function withRoot(p: Project, patch: Partial<Composition>): Project {
  const r = rootComposition(p)
  return { ...p, compositions: { ...p.compositions, [r.id]: { ...r, ...patch } } }
}

/** A skeleton composition that copies the default settings. */
export function mkComposition(idGen: IdGen, over: Partial<Composition> = {}): Composition {
  const id = idGen()
  return { ...newComposition(id, idGen, null, defaultCompositionSettings()), ...over, id: over.id ?? id }
}

/** A view of `p` whose root is `c` — the mutations address the root, so this is
 *  how a test drives one (`applyAddLayer(asRoot(p, g), …)`) against a Group.
 *  `c` is shared, not copied: the mutation lands in the caller's object. */
export function asRoot(p: Project, c: Composition): Project {
  return { ...p, compositions: { ...p.compositions, [c.id]: c }, root_id: c.id }
}

/** Add a Group: a second composition (copying the root's settings; `build` may
 *  fill it, e.g. `(g, view) => applyAddLayer(view, …)`) plus a `CompositionRef`
 *  layer in the root on a fresh lane, windowed `[0, max(duration, 1 s))` — an
 *  empty Group therefore demonstrates the tolerated overhang (ADR 0052 §6).
 *  Works on a structuredClone of `p`. */
export function withGroup(p: Project, idGen: IdGen, build?: (g: Composition, view: Project) => void): { p: Project; groupId: Uuid; refLayerId: Uuid } {
  const next = structuredClone(p)
  const r = rootComposition(next)
  const { width, height, fps, sample_rate, channels, color_space, background } = r
  const g = newComposition(idGen(), idGen, null, { width, height, fps, sample_rate, channels, color_space, background })
  build?.(g, asRoot(next, g))
  applyDurationAutofit(g)
  next.compositions[g.id] = g
  const trackId = applyAddTrack(next, idGen, null)
  const srcOut = Math.max(g.duration_us, 1_000_000)
  const refLayerId = applyAddLayer(next, idGen, trackId, {
    kind: 'CompositionRef', composition: g.id, src_in_us: 0, src_out_us: srcOut,
    transform: defaultTransform(), opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal',
  }, 0, srcOut)
  return { p: next, groupId: g.id, refLayerId }
}
