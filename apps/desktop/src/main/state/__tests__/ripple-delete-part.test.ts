// `ripple_delete_part` — Delete start to playhead / Delete end from playhead
// (docs/features.md#delete-start-or-end): a split at a time and a ripple delete
// of one side, as one recorded edit. What it must hold beyond the split and the
// ripple it is made of: one undo, the surviving part keeps the clip's identity,
// and a refusal records nothing. The per-rate arithmetic of the closing is
// `ripple-fractional-rates.test.ts`'s.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { markerHibernating } from '../summary'
import { root } from './fixtures/project'

const AV = '00000000-0000-0000-0000-0000000000ab'
const S = 1_000_000

function setup() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'part'), idGen: gen, clock: () => '<TS>' })
  a.dispatch('add_media', { id: AV, kind: 'Video', duration_us: 60 * S, with_audio: true })
  const [tA, tB] = root(a.snapshot()).tracks.map((t) => t.id)
  return { a, tA, tB }
}
const val = (r: ReturnType<ActorHandle['dispatch']>): unknown => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value }
const idOf = (r: ReturnType<ActorHandle['dispatch']>): string => val(r) as string
const color = (a: ActorHandle, track: string, s: number, e: number) => idOf(a.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e }))
const video = (a: ActorHandle, track: string, s: number, e: number, srcIn = 0) => idOf(a.dispatch('add_layer', { track, kind: 'video', media: AV, src_in_us: srcIn, src_out_us: srcIn + e - s, t_start_us: s, t_end_us: e }))
const audio = (a: ActorHandle, track: string, s: number, e: number, srcIn = 0) => idOf(a.dispatch('add_layer', { track, kind: 'audio', media: AV, src_in_us: srcIn, src_out_us: srcIn + e - s, t_start_us: s, t_end_us: e }))
const deletePart = (a: ActorHandle, layers: string[], at: number, part: 'start' | 'end') =>
  a.dispatch('ripple_delete_part', { layers, at_t_us: at, part })

const layersOf = (p: Project) => root(p).tracks.flatMap((t) => t.layers)
const spanOf = (p: Project, id: string): [number, number] | null => {
  const l = layersOf(p).find((x) => x.id === id)
  return l === undefined ? null : [l.t_start_us, l.t_end_us]
}

describe('ripple_delete_part removes one side of the cut and closes it', () => {
  it('deleting the start leaves the part after the cut where the clip began, and everything after moves up by the part', () => {
    const { a, tA, tB } = setup()
    const before = color(a, tA, 0, 2 * S)
    const clip = color(a, tA, 2 * S, 6 * S)
    const after = color(a, tA, 6 * S, 8 * S)
    const other = color(a, tB, 7 * S, 9 * S)
    expect(val(deletePart(a, [clip], 3 * S, 'start'))).toEqual({ at_t_us: 2 * S })
    const p = a.snapshot()
    expect(spanOf(p, before)).toEqual([0, 2 * S])
    expect(spanOf(p, clip)).toEqual([2 * S, 5 * S])
    expect(spanOf(p, after)).toEqual([5 * S, 7 * S])
    expect(spanOf(p, other)).toEqual([6 * S, 8 * S])
  })

  it('deleting the end keeps the part before the cut, and what followed starts at the cut', () => {
    const { a, tA } = setup()
    const clip = color(a, tA, 0, 4 * S)
    const after = color(a, tA, 4 * S, 6 * S)
    expect(val(deletePart(a, [clip], 3 * S, 'end'))).toEqual({ at_t_us: 3 * S })
    const p = a.snapshot()
    expect(spanOf(p, clip)).toEqual([0, 3 * S])
    expect(spanOf(p, after)).toEqual([3 * S, 5 * S])
  })

  it('is one history entry, and one undo puts every layer back where it was', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 4 * S)
    const au = audio(a, tA, 0, 4 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    color(a, tA, 4 * S, 6 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    val(deletePart(a, [v], S, 'start'))
    expect(a.historyStatus().len).toBe(len + 1)
    val(a.dispatch('undo', {}))
    expect(root(a.snapshot()).tracks).toEqual(root(before).tracks)
    expect(root(a.snapshot()).links).toEqual(root(before).links)
  })

  it('cuts a linked pair together from one named member, and the pair stays linked', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 4 * S)
    const au = audio(a, tA, 0, 4 * S)
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    val(deletePart(a, [v], S, 'start'))
    const p = a.snapshot()
    expect(layersOf(p).map((l) => l.id).sort()).toEqual([v, au].sort())
    expect(spanOf(p, v)).toEqual([0, 3 * S])
    expect(spanOf(p, au)).toEqual([0, 3 * S])
    expect(root(p).links.map((g) => [...g.members].sort())).toEqual([[v, au].sort()])
  })

  it('takes a linked member lying wholly inside the deleted part along with it', () => {
    const { a, tA, tB } = setup()
    const v = video(a, tA, 0, 4 * S)
    const title = color(a, tB, 0, S)
    idOf(a.dispatch('links_create', { layers: [v, title] }))
    val(deletePart(a, [v], 2 * S, 'start'))
    expect(spanOf(a.snapshot(), title)).toBeNull()
    expect(spanOf(a.snapshot(), v)).toEqual([0, 2 * S])
  })

  it('arrives from the renderer channel with the renderer’s argument names', () => {
    const { a, tA } = setup()
    const clip = color(a, tA, 0, 4 * S)
    const r = a.command('ripple_delete_part', { layerIds: [clip], atTUs: S, part: 'start', escapeLink: false })
    expect(val(r)).toEqual({ at_t_us: 0 })
    expect(spanOf(a.snapshot(), clip)).toEqual([0, 3 * S])
  })

  it('handed an underlay that started earlier, its start goes too, and the edit refuses over the clips that span held', () => {
    // What a press with nothing selected sends over a bed running under the
    // cut: Split at playhead's targets, so the bed is cut as well and its hole
    // reaches back to its own start. The clip at 0 stays (the origin rule), and
    // the cut clip's survivor would land on it.
    const { a, tA, tB } = setup()
    color(a, tA, 0, 2 * S)
    const clip = color(a, tA, 2 * S, 6 * S)
    const bed = color(a, tB, 0, 10 * S)
    const r = deletePart(a, [clip, bed], 3 * S, 'start')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('RippleCollision')
  })

  it('cuts every clip it is handed in the one edit, closing their holes together', () => {
    const { a, tA, tB } = setup()
    const low = color(a, tA, 0, 4 * S)
    const high = color(a, tB, S, 5 * S)
    const len = a.historyStatus().len
    expect(val(deletePart(a, [low, high], 3 * S, 'start'))).toEqual({ at_t_us: 0 })
    expect(a.historyStatus().len).toBe(len + 1)
    expect(spanOf(a.snapshot(), low)).toEqual([0, S])
    expect(spanOf(a.snapshot(), high)).toEqual([0, 2 * S])
  })
})

describe('ripple_delete_part keeps the surviving part the same clip', () => {
  it('after deleting the start, a marker anchored in the kept part stays awake on it', () => {
    const { a, tA } = setup()
    const v = video(a, tA, 0, 10 * S)
    const mk = idOf(a.dispatch('add_marker', { t_us: 7 * S, label: 'keep', anchor: { layer: v, src_us: 7 * S } }))
    val(deletePart(a, [v], 5 * S, 'start'))
    const c = root(a.snapshot())
    const marker = c.markers.find((m) => m.id === mk)
    expect(marker?.anchor?.layer).toBe(v)
    expect(markerHibernating(c, marker!)).toBe(false)
    expect(marker?.t_us).toBe(2 * S) // its source moment, now 5 s earlier
  })

  it('after deleting the start, an outgoing transition stays on the kept part — the edit a plain split of that clip refuses', () => {
    const { a, tA } = setup()
    const out = color(a, tA, 0, 2 * S)
    const next = color(a, tA, 2 * S, 4 * S)
    const tid = idOf(a.dispatch('add_transition', { from: out, to: next, duration_us: S, placement: 'extend' }))
    expect(a.dispatch('split_layer', { layer: out, at_t_us: S / 2 }).ok).toBe(false)
    val(deletePart(a, [out], S / 2, 'start'))
    const transitions = root(a.snapshot()).transitions
    expect(transitions.map((t) => [t.id, t.from_layer, t.to_layer])).toEqual([[tid, out, next]])
  })

  it('after deleting the end, the outgoing transition goes with the end it crossed into', () => {
    const { a, tA } = setup()
    const out = color(a, tA, 0, 2 * S)
    const next = color(a, tA, 2 * S, 4 * S)
    idOf(a.dispatch('add_transition', { from: out, to: next, duration_us: S, placement: 'extend' }))
    val(deletePart(a, [out], S / 2, 'end'))
    const p = a.snapshot()
    expect(root(p).transitions).toEqual([])
    expect(spanOf(p, out)).toEqual([0, S / 2])
    expect(spanOf(p, next)![0]).toBe(S / 2)
  })
})

describe('ripple_delete_part refuses without recording', () => {
  const expectUntouched = (a: ActorHandle, r: ReturnType<ActorHandle['dispatch']>, error: string, before: Project, len: number) => {
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe(error)
    expect(a.snapshot()).toBe(before)
    expect(a.historyStatus().len).toBe(len)
  }

  it('a cut on the clip edge is SplitOutsideLayer', () => {
    const { a, tA } = setup()
    const clip = color(a, tA, S, 3 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    expectUntouched(a, deletePart(a, [clip], S, 'start'), 'SplitOutsideLayer', before, len)
    expectUntouched(a, deletePart(a, [clip], 3 * S, 'end'), 'SplitOutsideLayer', before, len)
  })

  it('a ripple that cannot close leaves the split undone too', () => {
    // A clip on another lane starting inside the deleted start has nowhere to go.
    const { a, tA, tB } = setup()
    const clip = color(a, tA, 0, 4 * S)
    color(a, tB, S, 2 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    expectUntouched(a, deletePart(a, [clip], 3 * S, 'start'), 'RippleInsideHole', before, len)
  })

  it('names a bad part or an empty set as InvalidArgument', () => {
    const { a, tA } = setup()
    const clip = color(a, tA, 0, 4 * S)
    const before = a.snapshot()
    const len = a.historyStatus().len
    expectUntouched(a, a.dispatch('ripple_delete_part', { layers: [clip], at_t_us: S, part: 'middle' }), 'InvalidArgument', before, len)
    expectUntouched(a, deletePart(a, [], S, 'start'), 'InvalidArgument', before, len)
  })
})
