// apps/desktop/src/main/state/mutations/groups.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Composition, type CompositionRefParams, type Layer, type Project, type Uuid, type VideoClipParams } from '../model'
import { applyAddLayer, applyAddTrack, colorParams, defaultTransform } from './add'
import { applyLinksCreate } from './links'
import { applyDeleteLayer } from './delete'
import { applyDuplicateLayer } from './duplicate'
import { applyCompositionsDelete, applyGroupsCreate, applyGroupsRename, applyGroupsUngroup, compositionRefCount } from './groups'
import { reconcileTransitions, validate } from '../validate'
import { isCommandFailure } from '../errors'
import { group, root, withGroup } from '../__tests__/fixtures/project'

const S = 1_000_000
const RED = { r: 255, g: 0, b: 0, a: 255 }
const color = () => colorParams(RED, 1920, 1080)
const MEDIA = '00000000-0000-7000-8000-0000000000aa'

function expectCmd(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}
function addMedia(p: Project, durationUs: number): void {
  p.media_pool[MEDIA] = { id: MEDIA, label: null, path_abs: '/x.mp4', path_rel: null, kind: 'Video', metadata: { duration_us: durationUs },
    file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null }
}
function videoParams(srcIn: number, srcOut: number): VideoClipParams {
  return { kind: 'VideoClip', media: MEDIA, src_in_us: srcIn, src_out_us: srcOut, transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
    blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 }
}
function layerOf(c: Composition, id: Uuid): Layer {
  for (const t of c.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`layer ${id} not in composition ${c.id}`)
}
function trackOf(c: Composition, id: Uuid): number {
  return c.tracks.findIndex((t) => t.layers.some((l) => l.id === id))
}
function refParams(c: Composition, id: Uuid): CompositionRefParams {
  const pa = layerOf(c, id).params
  if (pa.kind !== 'CompositionRef') throw new Error('not a Group layer')
  return pa
}
/** The only Group in `p` besides the root — the one the test just made. */
function groupIds(p: Project): Uuid[] { return Object.keys(p.compositions).filter((id) => id !== p.root_id) }

/** A composition modulo ids and track identity: the non-empty tracks in z order,
 *  each as its layers with the id dropped; links and transitions with their
 *  members renamed to `L<n>` in walk order. Empty lanes are ignored because
 *  ungroup lands members on fresh transient lanes rather than back on the
 *  reserved skeleton they came from — the skeleton's own lanes stay, empty. */
function normalise(c: Composition) {
  const tok = new Map<Uuid, string>()
  const tracks = c.tracks.filter((t) => t.layers.length > 0).map((t) => t.layers.map((l) => {
    tok.set(l.id, `L${tok.size}`)
    const { id: _id, ...rest } = l
    return rest
  }))
  const name = (id: Uuid) => tok.get(id) ?? `?${id}`
  return {
    duration_us: c.duration_us, tracks, markers: c.markers,
    links: c.links.map((g) => ({ label: g.label ?? null, members: g.members.map(name).sort() })).sort((a, b) => a.members.join().localeCompare(b.members.join())),
    transitions: c.transitions.map((t) => ({ from: name(t.from_layer), to: name(t.to_layer), duration_us: t.duration_us, kind: t.kind, extended_us: t.extended_us })),
  }
}

/** Two linked colour layers [2 s, 5 s): V on A roll, W on B roll. */
function pair(): { p: Project; gen: IdGen; v: Uuid; w: Uuid; link: Uuid } {
  const gen = seededGen()
  const p = blankProject(gen, 't')
  const v = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 2 * S, 5 * S)
  const w = applyAddLayer(p, gen, root(p).tracks[1].id, color(), 2 * S, 5 * S)
  const link = applyLinksCreate(p, gen, [v, w], null, false)
  return { p, gen, v, w, link }
}

describe('applyGroupsCreate', () => {
  it('moves the pair into a new composition with the parent settings, the skeleton and the link, and places one Group layer at t0', () => {
    const { p, gen, v, w, link } = pair()
    const r = applyGroupsCreate(p, gen, [v, w], 'Intro')
    const c = group(p, r.compositionId)
    expect(groupIds(p)).toEqual([r.compositionId])
    expect(c.label).toBe('Intro')
    expect(c.tracks.map((t) => t.role)).toEqual(['ARoll', 'BRoll'])
    expect(c.fps).toEqual(root(p).fps)
    expect(layerOf(c, v)).toMatchObject({ t_start_us: 0, t_end_us: 3 * S })
    expect(layerOf(c, w)).toMatchObject({ t_start_us: 0, t_end_us: 3 * S })
    expect(trackOf(c, v)).toBe(0)
    expect(trackOf(c, w)).toBe(1)
    expect(c.links).toEqual([{ id: link, members: [v, w].sort() }])
    expect(root(p).links).toEqual([])
    expect(c.duration_us).toBe(3 * S)
    // The Group layer: on the top-most former track (B roll), spanning the composition.
    const g = layerOf(root(p), r.layerId)
    expect(g).toMatchObject({ t_start_us: 2 * S, t_end_us: 5 * S, effects: [] })
    expect(refParams(root(p), r.layerId)).toMatchObject({ composition: r.compositionId, src_in_us: 0, src_out_us: 3 * S, blend_mode: 'Normal' })
    expect(trackOf(root(p), r.layerId)).toBe(1)
    expect(root(p).tracks).toHaveLength(2) // reserved lanes are never pruned
    expect(root(p).duration_us).toBe(5 * S)
    expect(() => validate(p)).not.toThrow()
  })

  it('create → ungroup is the original modulo ids and track identity', () => {
    const { p, gen, v, w } = pair()
    const before = normalise(root(p))
    const r = applyGroupsCreate(p, gen, [v, w], null)
    applyGroupsUngroup(p, gen, r.layerId)
    expect(normalise(root(p))).toEqual(before)
    expect(groupIds(p)).toEqual([]) // the last reference took the composition with it
    expect(() => validate(p)).not.toThrow()
  })

  it('a link fully inside the set moves with its id; a straddling link loses its inside members and dissolves below two', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const t3 = applyAddTrack(p, gen, null)
    const x = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 0, S)
    const y = applyAddLayer(p, gen, root(p).tracks[1].id, color(), 0, S)
    const z = applyAddLayer(p, gen, t3, color(), 0, S)
    const link = applyLinksCreate(p, gen, [x, y, z], null, false)
    const r = applyGroupsCreate(p, gen, [x, y], null)
    expect(group(p, r.compositionId).links).toEqual([])
    expect(root(p).links).toEqual([]) // {z} alone is below two
    expect(link).toBeTruthy()

    const q = blankProject(seededGen(), 't')
    const gen2 = seededGen(); gen2(); gen2(); gen2(); gen2()
    const a = applyAddLayer(q, gen2, root(q).tracks[0].id, color(), 0, S)
    const b = applyAddLayer(q, gen2, root(q).tracks[1].id, color(), 0, S)
    const inside = applyLinksCreate(q, gen2, [a, b], 'AB', false)
    const c = applyAddLayer(q, gen2, applyAddTrack(q, gen2, null), color(), 0, S)
    const r2 = applyGroupsCreate(q, gen2, [a, b, c], null)
    expect(group(q, r2.compositionId).links).toEqual([{ id: inside, label: 'AB', members: [a, b].sort() }])
    expect(root(q).links).toEqual([])
  })

  it('a transition between two members moves; a straddling one is left for reconcile, which drops it', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const a1 = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 0, 2 * S)
    const a2 = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 1_500_000, 3_500_000)
    const a3 = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 4 * S, 5 * S)
    const tr = gen()
    root(p).transitions.push({ id: tr, from_layer: a1, to_layer: a2, duration_us: 500_000, kind: { kind: 'Crossfade' }, extended_us: 0 })
    expect(() => validate(p)).not.toThrow()

    const both = structuredClone(p)
    const r = applyGroupsCreate(both, gen, [a1, a2], null)
    expect(group(both, r.compositionId).transitions).toEqual([{ id: tr, from_layer: a1, to_layer: a2, duration_us: 500_000, kind: { kind: 'Crossfade' }, extended_us: 0 }])
    expect(root(both).transitions).toEqual([])
    expect(reconcileTransitions(both)).toEqual([])
    expect(() => validate(both)).not.toThrow()

    const straddle = structuredClone(p)
    applyGroupsCreate(straddle, gen, [a2, a3], null)
    const dropped = reconcileTransitions(straddle)
    expect(dropped.map((d) => d.id)).toEqual([tr])
    expect(root(straddle).transitions).toEqual([])
    expect(() => validate(straddle)).not.toThrow()
  })

  it('refuses whole on a locked member or a locked track and leaves the project untouched', () => {
    const { p, gen, v, w } = pair()
    layerOf(root(p), w).locked = true
    const snapshot = structuredClone(p)
    expect(expectCmd(() => applyGroupsCreate(p, gen, [v, w], null))).toEqual({ error: 'GroupLockedMember', layer: w })
    expect(p).toEqual(snapshot)

    layerOf(root(p), w).locked = false
    root(p).tracks[0].locked = true
    const snapshot2 = structuredClone(p)
    expect(expectCmd(() => applyGroupsCreate(p, gen, [v, w], null))).toEqual({ error: 'TrackLocked', track: root(p).tracks[0].id })
    expect(p).toEqual(snapshot2)
    // No id was burned by either refusal: blankProject took 1–4, the two layers 5–6, the link 7.
    expect(gen()).toBe('00000000-0000-0000-0000-000000000008')
  })

  it('refuses an empty set, a missing member and a set spanning two compositions', () => {
    const { p, gen, v } = pair()
    expect(expectCmd(() => applyGroupsCreate(p, gen, [], null))).toMatchObject({ error: 'InvalidArgument', field: 'layers' })
    expect(expectCmd(() => applyGroupsCreate(p, gen, [v, 'ghost'], null))).toEqual({ error: 'LayerNotFound', layer: 'ghost' })
    const r = applyGroupsCreate(p, gen, [v], null)
    const inner = layerOf(group(p, r.compositionId), v)
    expect(expectCmd(() => applyGroupsCreate(p, gen, [r.layerId, inner.id], null))).toMatchObject({ error: 'CrossCompositionSet', layer: inner.id })
  })

  it('members on three tracks map onto A roll, B roll and a transient lane in z order', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const t3 = applyAddTrack(p, gen, null)
    const x = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 0, S)
    const y = applyAddLayer(p, gen, root(p).tracks[1].id, color(), S, 2 * S)
    const z = applyAddLayer(p, gen, t3, color(), 0, S)
    const r = applyGroupsCreate(p, gen, [z, x, y], null)
    const c = group(p, r.compositionId)
    expect(c.tracks.map((t) => [t.role, t.transient, t.layers.map((l) => l.id)])).toEqual([
      ['ARoll', false, [x]], ['BRoll', false, [y]], [null, true, [z]],
    ])
    // The Group layer took the top former lane (t3), which therefore survives.
    expect(root(p).tracks).toHaveLength(3)
    expect(trackOf(root(p), r.layerId)).toBe(2)
    expect(root(p).tracks[2].id).toBe(t3)
    expect(layerOf(root(p), r.layerId)).toMatchObject({ t_start_us: 0, t_end_us: 2 * S })
    expect(() => validate(p)).not.toThrow()
  })

  it('spawns a lane above when the Group span collides on the top former track, and prunes the emptied transient lane', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const x = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 0, S)
    const y = applyAddLayer(p, gen, root(p).tracks[1].id, color(), S, 2 * S)
    const n = applyAddLayer(p, gen, root(p).tracks[1].id, color(), 0, S) // non-member on the top former lane
    const r = applyGroupsCreate(p, gen, [x, y], null)
    expect(root(p).tracks).toHaveLength(3)
    expect(trackOf(root(p), r.layerId)).toBe(2)
    expect(root(p).tracks[2]).toMatchObject({ role: null, transient: true })
    expect(trackOf(root(p), n)).toBe(1)
    expect(() => validate(p)).not.toThrow()

    // A transient lane that only held members is emptied and goes.
    const q = blankProject(seededGen(), 't')
    const gen2 = seededGen(); gen2(); gen2(); gen2(); gen2()
    const lane = applyAddTrack(q, gen2, null)
    const m = applyAddLayer(q, gen2, lane, color(), 0, S)
    const other = applyAddLayer(q, gen2, root(q).tracks[0].id, color(), 0, S)
    // Group span [0, 1 s) collides with nothing on `lane` once m leaves — so it lands there, and the lane stays.
    const r2 = applyGroupsCreate(q, gen2, [m], null)
    expect(trackOf(root(q), r2.layerId)).toBe(2)
    expect(root(q).tracks).toHaveLength(3)
    // Whereas grouping `other` (on A roll) with m puts the Group on `lane` too; both former lanes hold something after.
    const r3 = applyGroupsCreate(q, gen2, [r2.layerId, other], null)
    expect(root(q).tracks).toHaveLength(3)
    expect(trackOf(root(q), r3.layerId)).toBe(2)
  })

  it('nests: a Group inside a Group validates, and a member that is itself a Group moves as one layer', () => {
    const { p, gen, v, w } = pair()
    const inner = applyGroupsCreate(p, gen, [v, w], 'inner')
    const outer = applyGroupsCreate(p, gen, [inner.layerId], 'outer')
    expect(groupIds(p).sort()).toEqual([inner.compositionId, outer.compositionId].sort())
    const oc = group(p, outer.compositionId)
    expect(layerOf(oc, inner.layerId)).toMatchObject({ t_start_us: 0, t_end_us: 3 * S })
    expect(refParams(oc, inner.layerId).composition).toBe(inner.compositionId)
    expect(layerOf(root(p), outer.layerId)).toMatchObject({ t_start_us: 2 * S, t_end_us: 5 * S })
    expect(() => validate(p)).not.toThrow()
    applyGroupsUngroup(p, gen, outer.layerId)
    expect(groupIds(p)).toEqual([inner.compositionId])
    const back = root(p).tracks.flatMap((t) => t.layers).find((l) => l.params.kind === 'CompositionRef')!
    expect(back).toMatchObject({ t_start_us: 2 * S, t_end_us: 5 * S })
    expect(() => validate(p)).not.toThrow()
  })

  it('a blank label stores null', () => {
    const { p, gen, v } = pair()
    const r = applyGroupsCreate(p, gen, [v], '   ')
    expect(group(p, r.compositionId).label).toBeNull()
  })
})

describe('applyGroupsUngroup', () => {
  it('refuses a non-plain Group layer, naming the first non-plain field', () => {
    const { p, gen, v, w } = pair()
    const r = applyGroupsCreate(p, gen, [v, w], null)

    const moved = structuredClone(p)
    ;(layerOf(root(moved), r.layerId).params as CompositionRefParams).transform.x = { mode: 'Static', value: 10 }
    expect(expectCmd(() => applyGroupsUngroup(moved, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'transform' })

    const unlinked = structuredClone(p)
    ;(layerOf(root(unlinked), r.layerId).params as CompositionRefParams).transform.scale_linked = false
    expect(expectCmd(() => applyGroupsUngroup(unlinked, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'transform' })

    const faded = structuredClone(p)
    ;(layerOf(root(faded), r.layerId).params as CompositionRefParams).opacity = { mode: 'Static', value: 0.5 }
    expect(expectCmd(() => applyGroupsUngroup(faded, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'opacity' })

    const keyed = structuredClone(p)
    ;(layerOf(root(keyed), r.layerId).params as CompositionRefParams).opacity = { mode: 'Keyframed', value: [{ id: 'k', t_us: 0, value: 1, interp: { kind: 'Linear' } }] }
    expect(expectCmd(() => applyGroupsUngroup(keyed, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'opacity' })

    const blurred = structuredClone(p)
    layerOf(root(blurred), r.layerId).effects.push({ id: 'e', kind: 'blur', enabled: true, params: {} })
    expect(expectCmd(() => applyGroupsUngroup(blurred, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'effects' })

    const multiplied = structuredClone(p)
    ;(layerOf(root(multiplied), r.layerId).params as CompositionRefParams).blend_mode = 'Multiply'
    expect(expectCmd(() => applyGroupsUngroup(multiplied, gen, r.layerId))).toEqual({ error: 'GroupNotPlain', layer: r.layerId, reason: 'blend_mode' })
    // Each refusal left its project untouched.
    expect(normalise(root(moved))).not.toEqual(normalise(root(p)))
    expect(groupIds(moved)).toEqual([r.compositionId])
  })

  it('a trimmed window drops the member outside it and trims the straddling one, source window and keyframes following', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    addMedia(p, 10 * S)
    const vid = applyAddLayer(p, gen, root(p).tracks[0].id, videoParams(0, 3 * S), 0, 3 * S)
    layerOf(root(p), vid).params = { ...videoParams(0, 3 * S), opacity: { mode: 'Keyframed', value: [
      { id: 'k1', t_us: 500_000, value: 0, interp: { kind: 'Linear' } }, { id: 'k2', t_us: 1_500_000, value: 1, interp: { kind: 'Linear' } }] } }
    const tail = applyAddLayer(p, gen, root(p).tracks[1].id, color(), 2_500_000, 3 * S)
    const r = applyGroupsCreate(p, gen, [vid, tail], null)
    // Trim the Group layer by hand to the window [1 s, 2 s), shown at t = 2 s.
    const g = layerOf(root(p), r.layerId)
    g.t_start_us = 2 * S; g.t_end_us = 3 * S
    Object.assign(g.params, { src_in_us: S, src_out_us: 2 * S })
    expect(() => validate(p)).not.toThrow()

    applyGroupsUngroup(p, gen, r.layerId)
    const layers = root(p).tracks.flatMap((t) => t.layers)
    expect(layers).toHaveLength(1)
    const only = layers[0]
    expect(only).toMatchObject({ t_start_us: 2 * S, t_end_us: 3 * S })
    expect(only.params).toMatchObject({ kind: 'VideoClip', src_in_us: S, src_out_us: 2 * S })
    // Keyframes are content-glued: the 1 s cut moves them by −1 s (the first is now before the in-point, which is tolerated).
    expect((only.params as { opacity: { value: Array<{ t_us: number }> } }).opacity.value.map((k) => k.t_us)).toEqual([-500_000, 500_000])
    expect(only.id).not.toBe(vid)
    expect(groupIds(p)).toEqual([])
    expect(() => validate(p)).not.toThrow()
  })

  it('keeps the composition while another Group layer still references it', () => {
    const { p, gen, v, w } = pair()
    const r = applyGroupsCreate(p, gen, [v, w], null)
    const twin = applyDuplicateLayer(p, gen, r.layerId, 3 * S)
    expect(compositionRefCount(p, r.compositionId)).toBe(2)
    applyGroupsUngroup(p, gen, r.layerId)
    expect(groupIds(p)).toEqual([r.compositionId])
    expect(compositionRefCount(p, r.compositionId)).toBe(1)
    expect(() => validate(p)).not.toThrow()
    applyGroupsUngroup(p, gen, twin)
    expect(groupIds(p)).toEqual([])
    expect(root(p).tracks.flatMap((t) => t.layers)).toHaveLength(4)
    expect(() => validate(p)).not.toThrow()
  })

  it('carries links and transitions inside over under fresh ids; the fresh lanes land at the ref track index', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const t3 = applyAddTrack(p, gen, null)
    const a1 = applyAddLayer(p, gen, t3, color(), 0, 2 * S)
    const a2 = applyAddLayer(p, gen, t3, color(), 1_500_000, 3_500_000)
    const b = applyAddLayer(p, gen, root(p).tracks[0].id, color(), 0, S)
    const tr = gen()
    root(p).transitions.push({ id: tr, from_layer: a1, to_layer: a2, duration_us: 500_000, kind: { kind: 'Crossfade' }, extended_us: 0 })
    const link = applyLinksCreate(p, gen, [a1, b], null, false)
    const r = applyGroupsCreate(p, gen, [a1, a2, b], null)
    // Group layer sits on t3 (the top former lane, index 2 — A roll and B roll below it).
    expect(trackOf(root(p), r.layerId)).toBe(2)
    applyGroupsUngroup(p, gen, r.layerId)
    // Fresh lanes at index 2 and 3; t3 was emptied of its Group layer and pruned.
    expect(root(p).tracks.map((t) => [t.role, t.layers.length])).toEqual([['ARoll', 0], ['BRoll', 0], [null, 1], [null, 2]])
    expect(root(p).tracks.some((t) => t.id === t3)).toBe(false)
    const [nb] = root(p).tracks[2].layers
    const [na1, na2] = root(p).tracks[3].layers
    expect(root(p).links).toEqual([{ id: expect.any(String), members: [na1.id, nb.id].sort() }])
    expect(root(p).links[0].id).not.toBe(link)
    expect(root(p).transitions).toEqual([{ id: expect.any(String), from_layer: na1.id, to_layer: na2.id, duration_us: 500_000, kind: { kind: 'Crossfade' }, extended_us: 0 }])
    expect(root(p).transitions[0].id).not.toBe(tr)
    expect(reconcileTransitions(p)).toEqual([])
    expect(() => validate(p)).not.toThrow()
  })

  it('refuses a locked ref track and a non-Group layer', () => {
    const { p, gen, v, w } = pair()
    const r = applyGroupsCreate(p, gen, [v, w], null)
    expect(expectCmd(() => applyGroupsUngroup(p, gen, v))).toEqual({ error: 'WrongLayerKind', layer: v, expected: 'CompositionRef' })
    root(p).tracks[1].locked = true
    expect(expectCmd(() => applyGroupsUngroup(p, gen, r.layerId))).toEqual({ error: 'TrackLocked', track: root(p).tracks[1].id })
  })
})

describe('applyGroupsRename / applyCompositionsDelete', () => {
  it('rename sets, trims and clears the label; the root and an unknown id refuse', () => {
    const { p, gen, v } = pair()
    const r = applyGroupsCreate(p, gen, [v], null)
    applyGroupsRename(p, r.compositionId, '  Title  ')
    expect(group(p, r.compositionId).label).toBe('Title')
    applyGroupsRename(p, r.compositionId, '')
    expect(group(p, r.compositionId).label).toBeNull()
    expect(expectCmd(() => applyGroupsRename(p, p.root_id, 'x'))).toEqual({ error: 'RootComposition', composition: p.root_id })
    expect(expectCmd(() => applyGroupsRename(p, 'ghost', 'x'))).toEqual({ error: 'CompositionNotFound', composition: 'ghost' })
  })

  it('delete refuses the root and a referenced composition, and removes an orphan', () => {
    const gen = seededGen()
    const { p, groupId, refLayerId } = withGroup(blankProject(gen, 't'), gen)
    expect(expectCmd(() => applyCompositionsDelete(p, p.root_id))).toEqual({ error: 'RootComposition', composition: p.root_id })
    expect(expectCmd(() => applyCompositionsDelete(p, groupId))).toEqual({ error: 'CompositionInUse', composition: groupId, ref_count: 1 })
    applyDeleteLayer(p, refLayerId) // orphans it — legal
    expect(() => validate(p)).not.toThrow()
    applyCompositionsDelete(p, groupId)
    expect(groupIds(p)).toEqual([])
    expect(() => validate(p)).not.toThrow()
  })
})
