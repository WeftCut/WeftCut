// apps/desktop/src/main/state/mutations/split.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Marker, type Project } from '../model'
import { applySplitLayer } from './split'
import { videoClipParams } from './media'
import { markerHibernating } from '../summary'
import { applyLinksCreate } from './links'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project {
  const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [color('a', 0, 1_000_000)]; return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('applySplitLayer', () => {
  it('splits a layer into left[0,t) + right[t,end); right gets a fresh id; left keeps id', () => {
    const p = one()
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    expect(r.left).toBe('a')
    const layers = root(p).tracks[0].layers
    expect(layers.length).toBe(2)
    expect(layers[0].id).toBe('a'); expect(layers[0].t_start_us).toBe(0)
    expect(layers[1].id).toBe(r.right)
    expect(layers[1].t_start_us).toBe(layers[0].t_end_us) // contiguous at the split point
    expect(layers[1].t_end_us).toBe(1_000_000)
  })
  it('rejects a split at/outside the layer bounds', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 0, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 1_000_000, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 2_000_000, false), 'SplitOutsideLayer')
  })
  it('rejects a missing layer and a locked track', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'ghost', 100, false), 'LayerNotFound')
    const p = one(); root(p).tracks[0].locked = true
    expectCmd(() => applySplitLayer(p, seededGen(), 'a', 400_000, false), 'TrackLocked')
  })
  it('partitions src_in/src_out for media kinds', () => {
    const p = blankProject(seededGen(), 't')
    const vid: Layer = { id: 'v', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {},
      params: { kind: 'VideoClip', media: 'm', src_in_us: 500_000, src_out_us: 1_500_000, transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor_x: { mode: 'Static', value: 0 }, anchor_y: { mode: 'Static', value: 0 } } as any, opacity: { mode: 'Static', value: 1 }, crop: null } as any, effects: [] }
    root(p).tracks[0].layers = [vid]
    applySplitLayer(p, seededGen(), 'v', 400_000, false) // offset 400_000
    const [l, rr] = root(p).tracks[0].layers as any
    expect(l.params.src_out_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_in_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_out_us).toBe(1_500_000)
  })
  it('a mark whose source lands in the RIGHT half falls asleep: the anchor rides the left half, which no longer shows it', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    root(p).tracks[0].layers = [{ id: 'v', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false,
      metadata: {}, params: videoClipParams('m', 500_000, 1_500_000), effects: [] }]
    const mk: Marker = { id: 'mk', t_us: 700_000, end_t_us: null, label: 'cut', note: '',
      color: { r: 0, g: 0, b: 0, a: 255 }, anchor: { layer: 'v', src_us: 1_200_000 } }
    root(p).markers.push(mk)
    expect(markerHibernating(root(p), mk)).toBe(false)
    applySplitLayer(p, gen, 'v', 400_000, false)
    expect(root(p).tracks[0].layers[0].id).toBe('v')     // the left half keeps the id the anchor names
    expect(markerHibernating(root(p), mk)).toBe(true)    // …and its window is now [500 k, 900 k)
  })

  it('link spanning split: both halves stay in the link; non-spanning members untouched', () => {
    const p = blankProject(seededGen(), 't')
    // a:[0,1s] and b:[0,1s] on track B linked; both span t=400k
    root(p).tracks[0].layers = [color('a', 0, 1_000_000)]
    root(p).tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    const link = root(p).links.find((g) => g.id === gid)!
    // a's right-half + b's right-half both joined the link → 4 members
    expect(link.members.length).toBe(4)
    expect(link.members).toContain(r.right)
    expect(root(p).tracks[1].layers.length).toBe(2) // b was spanning → split too
  })
  it('escape_link splits only the target (sibling not split), but the target stays linked so its right-half joins', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 0, 1_000_000)]
    root(p).tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, true)
    expect(root(p).tracks[1].layers.length).toBe(1) // sibling b NOT split (escape → no spanning fan-out)
    const link = root(p).links.find((g) => g.id === gid)!
    expect(link.members.length).toBe(3) // target stays linked; its right-half joins
    expect(link.members).toContain(r.right)
    expect(link.members).toContain('b')
  })
  it('splitTrackHalf retains left keyframes and collapses an emptied right half to Static at the boundary value', () => {
    const p = blankProject(seededGen(), 't')
    const c: Layer = {
      id: 'c', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {},
      params: { kind: 'Color', width: 1, height: 1, color: { mode: 'Keyframed', value: [
        { id: 'k0', t_us: 0, value: { r: 10, g: 0, b: 0, a: 255 }, interp: { kind: 'Linear' } },
        { id: 'k1', t_us: 100_000, value: { r: 20, g: 0, b: 0, a: 255 }, interp: { kind: 'Linear' } },
      ] } }, effects: [],
    }
    root(p).tracks[0].layers = [c]
    applySplitLayer(p, seededGen(), 'c', 400_000, false) // offset = 400_000
    const left = root(p).tracks[0].layers[0].params
    const right = root(p).tracks[0].layers[1].params
    // LEFT keeps keyframes with t <= 400_000 → both retained, still Keyframed.
    expect(left.kind === 'Color' && left.color.mode).toBe('Keyframed')
    expect(left.kind === 'Color' && (left.color.mode === 'Keyframed' ? left.color.value.length : -1)).toBe(2)
    // RIGHT keeps t > 400_000 → none → collapses to Static at the LAST keyframe value (r:20).
    expect(right.kind === 'Color' && JSON.stringify(right.color)).toBe(JSON.stringify({ mode: 'Static', value: { r: 20, g: 0, b: 0, a: 255 } }))
  })
})

describe('applySplitLayer inside a Group, and of the Group layer itself', () => {
  it("splits the Group's layer in place; the root is untouched", () => {
    const { p, idGen, groupId, innerId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    const r = applySplitLayer(p, idGen, innerId, 400_000, false)
    expect(group(p, groupId).tracks[0].layers.map((l) => l.id)).toEqual([r.left, r.right])
    expect(root(p)).toEqual(rootBefore)
  })
  it("splitting a CompositionRef divides its source window like a clip's (ADR 0052 §4)", () => {
    const { p, idGen, refLayerId } = groupedProject() // ref: t [0, 1 s), src [0, 1 s)
    const r = applySplitLayer(p, idGen, refLayerId, 400_000, false)
    const [left, right] = root(p).tracks[2].layers.map((l) => l.params as Extract<LayerParams, { kind: 'CompositionRef' }>)
    expect([left.src_in_us, left.src_out_us]).toEqual([0, 400_000])
    expect([right.src_in_us, right.src_out_us]).toEqual([400_000, 1_000_000])
    expect(root(p).tracks[2].layers.map((l) => [l.t_start_us, l.t_end_us])).toEqual([[0, 400_000], [400_000, 1_000_000]])
    expect(r.left).toBe(refLayerId)
  })
})
