import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyDeleteLayer } from './delete'
import { applyDuplicateLayer, applyPasteLayer, applyPasteLayers } from './duplicate'
import { CommandFailure, isCommandFailure } from '../errors'
import { validate } from '../validate'
import { AUDIO_GRID, frameGrid, gridIndex, isCanonicalOnGrid, snapOnGrid, timeUsAtGridIndex } from '../snap'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

describe('delete + duplicate', () => {
  it('deletes a layer and autofits', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 2_000_000)
    expect(applyDeleteLayer(p, a)).toBeNull() // A-roll not removable
    expect(root(p).tracks[0].layers).toHaveLength(0)
    expect(root(p).duration_us).toBe(0)
  })
  it('auto-deletes an emptied removable track and reports its id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const tx = applyAddTrack(p, g, 'X')
    const a = applyAddLayer(p, g, tx, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expect(applyDeleteLayer(p, a)).toBe(tx)
    expect(root(p).tracks.find((t) => t.id === tx)).toBeUndefined()
  })
  it('rejects deleting a missing layer / locked track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyDeleteLayer(p, 'ghost'); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
  it('duplicates with a fresh id, offset, sorted insert, and no link join', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    const dup = applyDuplicateLayer(p, g, a, 2_000_000)
    expect(dup).not.toBe(a)
    const copy = root(p).tracks[0].layers.find((l) => l.id === dup)!
    expect(copy.t_start_us).toBe(2_000_000); expect(copy.t_end_us).toBe(3_000_000)
    expect(root(p).links).toHaveLength(0)
  })
  it('snaps the duplicate onto the frame grid at a fractional rate', () => {
    // Both edges land on the grid via the snap-start-then-carry-the-delta model (duplicate.ts).
    const g = seededGen(); const p = blankProject(g, 't')
    root(p).fps = { num: 30000, den: 1001 }
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 100_100)
    const dup = applyDuplicateLayer(p, g, a, 500_000) // 500_000 µs is NOT a boundary at 29.97
    const copy = root(p).tracks[0].layers.find((l) => l.id === dup)!
    expect(copy.t_start_us).toBe(500_500) // frame 15
    expect(copy.t_end_us).toBe(600_600)   // frame 18 — the source's 3-frame span, preserved
    expect(() => validate(p)).not.toThrow()
  })
})

// applyPasteLayers — the whole-link duplicate. The single-clone geometry is
// `applyPasteLayer`'s (above); what is tested here is what the BATCH adds: the
// clones' link, the seed-only lane change, per-member lattice snapping, and the
// all-or-nothing refusal.
describe('applyPasteLayers', () => {
  const BLACK = { r: 0, g: 0, b: 0, a: 255 }
  function three() {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams(BLACK, 1, 1), 0, 1_000_000)
    const b = applyAddLayer(p, g, root(p).tracks[0].id, colorParams(BLACK, 1, 1), 1_000_000, 2_000_000)
    const c = applyAddLayer(p, g, root(p).tracks[1].id, colorParams(BLACK, 1, 1), 500_000, 1_500_000)
    return { g, p, a, b, c }
  }
  const layersOf = (p: Project): Layer[] => root(p).tracks.flatMap((t) => t.layers)
  const find = (p: Project, id: string): Layer => layersOf(p).find((l) => l.id === id)!

  it('clones a batch of 3 and links exactly the clones — never the sources', () => {
    const { g, p, a, b, c } = three()
    const sources = structuredClone([a, b, c].map((id) => find(p, id)))
    const map = applyPasteLayers(p, g, [a, b, c], 5_000_000, null)
    expect([...map.keys()]).toEqual([a, b, c])
    const clones = [...map.values()]
    expect(new Set(clones).size).toBe(3)
    expect(layersOf(p)).toHaveLength(6)
    // Every clone keeps its source's span and track, shifted by the shared delta.
    for (const [src, clone] of map) {
      const s = find(p, src); const k = find(p, clone)
      expect(k.t_start_us - s.t_start_us).toBe(5_000_000)
      expect(k.t_end_us - k.t_start_us).toBe(s.t_end_us - s.t_start_us)
      expect(root(p).tracks.find((t) => t.layers.includes(k))!.id).toBe(root(p).tracks.find((t) => t.layers.includes(s))!.id)
    }
    expect(root(p).links).toHaveLength(1)
    expect([...root(p).links[0].members].sort()).toEqual([...clones].sort())
    expect([a, b, c].map((id) => find(p, id))).toEqual(sources) // sources untouched
    expect(() => validate(p)).not.toThrow()
  })

  it('a batch of one makes one clone and no link', () => {
    const { g, p, a } = three()
    const map = applyPasteLayers(p, g, [a], 5_000_000, null)
    expect(map.size).toBe(1)
    expect(root(p).links).toHaveLength(0)
    expect(layersOf(p)).toHaveLength(4)
  })

  it('re-lanes the SEED clone only; the other clones stay on their source tracks', () => {
    const { g, p, a, b } = three()
    const x = applyAddTrack(p, g, 'X')
    const map = applyPasteLayers(p, g, [a, b], 5_000_000, x)
    expect(root(p).tracks.find((t) => t.id === x)!.layers.map((l) => l.id)).toEqual([map.get(a)])
    expect(root(p).tracks[0].layers.map((l) => l.id)).toContain(map.get(b))
  })

  // Atomicity at the mutation level: `b`'s clone would land on `a`'s source,
  // and `a`'s clone was planned first — so a partial apply would have inserted
  // one clone before the refusal.
  it('refuses the WHOLE batch on a collision at any destination, leaving the project untouched', () => {
    const { g, p, a, b } = three()
    const before = structuredClone(p)
    let err: unknown
    try { applyPasteLayers(p, g, [a, b], -1_000_000, null) } catch (e) { err = e }
    expect(err).toBeInstanceOf(CommandFailure)
    const e = (err as CommandFailure).err
    expect(e.error).toBe('ValidationFailed')
    if (e.error === 'ValidationFailed') expect(e.detail).toMatchObject({ rule: 'LayerOverlap', b: b })
    expect(p).toEqual(before)
  })

  it('refuses the WHOLE batch when any destination lane is locked, burning no id', () => {
    const { g, p, a, c } = three()
    root(p).tracks[1].locked = true // `c` lives here — and would be pasted back here
    const before = structuredClone(p)
    const fresh = seededGen()
    try { applyPasteLayers(p, g, [a, c], 5_000_000, null); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
    expect(p).toEqual(before)
    // `g` has minted exactly the seven ids `three()` did (two tracks, project,
    // root composition, three layers): its next id is a fresh stream's eighth.
    for (let i = 0; i < 7; i++) fresh()
    expect(g()).toBe(fresh())
  })

  it('rejects an unknown member before touching anything', () => {
    const { g, p, a } = three()
    const before = structuredClone(p)
    try { applyPasteLayers(p, g, [a, 'ghost'], 5_000_000, null); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
    expect(p).toEqual(before)
  })

  // Data-loss dependency: a slipped audio member must come out of the copy with
  // the SAME slip, in samples. 29.97 is the discriminating rate — the frame
  // lattice is not a sublattice of the 48 kHz one, so a kind-blind snap onto the
  // frame grid would re-sync the audio and validate would reject the clone.
  it('snaps each member on ITS OWN lattice, so an audio member keeps its slip offset', () => {
    const FPS = { num: 30_000, den: 1001 }
    const fg = frameGrid(FPS)
    const frame = (i: number) => timeUsAtGridIndex(i, fg)
    const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID)
    // A frame whose canonical µs is NOT a sample boundary (every 5th frame is).
    const offSample = (from: number) => { for (let i = from; ; i++) if (snapOnGrid(frame(i), AUDIO_GRID) !== frame(i)) return i }
    const F = offSample(30), M = offSample(90)
    const g = seededGen(); const p = blankProject(g, 't'); root(p).fps = FPS
    const v = applyAddLayer(p, g, root(p).tracks[0].id, colorParams(BLACK, 1, 1), frame(F), frame(F + 60))
    const slipped = sample(gridIndex(frame(F), AUDIO_GRID) + 7)
    const au: Layer = {
      id: 'au', label: null, t_start_us: slipped, t_end_us: sample(gridIndex(slipped, AUDIO_GRID) + 96_000), enabled: true, locked: false, metadata: {}, effects: [],
      params: { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 2_000_000, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue' },
    }
    root(p).tracks[1].layers = [au]
    const slipBefore = gridIndex(au.t_start_us - find(p, v).t_start_us, AUDIO_GRID)
    expect(slipBefore).not.toBe(0)

    const delta = frame(M) - frame(F)
    const map = applyPasteLayers(p, g, [v, 'au'], delta, null)
    const vClone = find(p, map.get(v)!); const aClone = find(p, map.get('au')!)
    expect(vClone.t_start_us).toBe(frame(M))
    // The audio clone is the source shifted by the delta on the SAMPLE lattice…
    expect(aClone.t_start_us).toBe(snapOnGrid(au.t_start_us + delta, AUDIO_GRID))
    expect(isCanonicalOnGrid(aClone.t_start_us, AUDIO_GRID)).toBe(true)
    expect(isCanonicalOnGrid(aClone.t_end_us, AUDIO_GRID)).toBe(true)
    // …so the slip survives in samples, and the kind-blind answer is provably different.
    expect(gridIndex(aClone.t_start_us - vClone.t_start_us, AUDIO_GRID)).toBe(slipBefore)
    expect(snapOnGrid(au.t_start_us + delta, fg)).not.toBe(aClone.t_start_us)
  })
})

describe('delete / duplicate / paste inside a Group', () => {
  const BLACK = { r: 0, g: 0, b: 0, a: 255 }
  it("deleting the Group's layer shrinks the Group's duration and leaves the root alone", () => {
    const { p, groupId, innerId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    expect(applyDeleteLayer(p, innerId)).toBeNull() // the Group's A roll is reserved
    expect(group(p, groupId).tracks[0].layers).toEqual([])
    expect(group(p, groupId).duration_us).toBe(0)
    expect(root(p)).toEqual(rootBefore) // the parent's window now overhangs (ADR 0052 §6) — and is untouched
    expect(() => validate(p)).not.toThrow()
  })
  it("deleting the last layer on a transient track inside a Group prunes THAT track; the root's tracks stay", () => {
    const { p, idGen, groupId } = groupedProject()
    const gt = applyAddTrack(p, idGen, null, undefined, groupId)
    const l = applyAddLayer(p, idGen, gt, colorParams(BLACK, 1, 1), 0, 500_000)
    const rootTracks = root(p).tracks.map((t) => t.id)
    expect(applyDeleteLayer(p, l)).toBe(gt)
    expect(group(p, groupId).tracks.some((t) => t.id === gt)).toBe(false)
    expect(root(p).tracks.map((t) => t.id)).toEqual(rootTracks)
  })
  it('duplicates inside the Group', () => {
    const { p, idGen, groupId, innerId } = groupedProject()
    const dup = applyDuplicateLayer(p, idGen, innerId, 1_000_000)
    expect(group(p, groupId).tracks[0].layers.map((l) => l.id)).toEqual([innerId, dup])
    expect(group(p, groupId).duration_us).toBe(2_000_000)
    expect(root(p).duration_us).toBe(1_000_000)
  })
  it('paste refuses a lane in another composition (CrossCompositionMove) and a mixed set (CrossCompositionSet)', () => {
    const { p, idGen, groupId, innerId, refLayerId } = groupedProject()
    const before = structuredClone(p)
    try { applyPasteLayer(p, idGen, innerId, root(p).tracks[1].id, 0); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err).toEqual({ error: 'CrossCompositionMove', layer: innerId, from: groupId, to: p.root_id }) }
    try { applyPasteLayers(p, idGen, [refLayerId, innerId], 5_000_000, null); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CrossCompositionSet') }
    try { applyPasteLayers(p, idGen, [innerId], 5_000_000, root(p).tracks[1].id); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CrossCompositionMove') }
    expect(p).toEqual(before)
    // …and pastes inside the Group when the lane is the Group's.
    const id = applyPasteLayer(p, idGen, innerId, group(p, groupId).tracks[1].id, 2_000_000)
    expect(group(p, groupId).tracks[1].layers.map((l) => l.id)).toEqual([id])
  })
})
