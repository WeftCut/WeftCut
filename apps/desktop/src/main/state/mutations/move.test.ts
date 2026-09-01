// apps/desktop/src/main/state/mutations/move.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyMoveLayer, applyMoveLayersToNewTrack } from './move'
import { isCommandFailure } from '../errors'
import { applyLinksCreate } from './links'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('applyMoveLayer', () => {
  it('moves within a track, snapping both edges and preserving duration', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, root(p).tracks[0].id, 2_000_000, false)
    const l = root(p).tracks[0].layers[0]
    expect(l.t_start_us).toBe(2_000_000)
    expect(l.t_end_us - l.t_start_us).toBe(1_000_000) // duration preserved
  })
  /// The other half of a twin that spans the process boundary: the timeline's
  /// move projection promises where a drag will land, and `TrackLane` gives that
  /// promise precedence over the project until the landing matches it — so a
  /// promise computed by an arithmetic THIS function does not share is one the
  /// project can never satisfy, and the lane draws it over the real clip for the
  /// rest of the session.
  ///
  /// A 61-frame clip at 30 fps landing on frame 1 is the case that exposes it:
  /// `snapped landing + snapped duration` is 2_066_666, one microsecond off the
  /// lattice point this returns. The renderer half is
  /// `Timeline.interaction.test.tsx`, "Timeline move promise", whose
  /// `ACTOR_LANDING` is these two numbers.
  it('lands the 61-frame wedge case on the lattice, not on landing + duration', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 2_033_333)
    applyMoveLayer(p, a, root(p).tracks[0].id, 33_333, false)
    const l = root(p).tracks[0].layers[0]
    expect(l.t_start_us).toBe(33_333)
    expect(l.t_end_us).toBe(2_066_667)
  })
  it('moves across tracks', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, root(p).tracks[1].id, 0, false)
    expect(root(p).tracks[0].layers).toHaveLength(0)
    expect(root(p).tracks[1].layers[0].id).toBe(a)
  })
  it('rejects a missing layer and a locked source track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyMoveLayer(p, 'ghost', root(p).tracks[0].id, 0, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    root(p).tracks[0].locked = true
    try { applyMoveLayer(p, a, root(p).tracks[0].id, 1_000_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})

describe('move link lock checks (not corpus-gated)', () => {
  it('rejects a coupled move when a link sibling is layer-locked', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 0, 100_000)]
    root(p).tracks[1].layers = [color('b', 0, 100_000)]
    applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    root(p).tracks[1].layers[0].locked = true // sibling b locked
    try { applyMoveLayer(p, 'a', root(p).tracks[0].id, 500_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LinkLockedMember') }
  })
  it('escape_link bypasses the sibling lock check and moves only the target', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 0, 100_000)]
    root(p).tracks[1].layers = [color('b', 0, 100_000)]
    applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)
    root(p).tracks[1].layers[0].locked = true
    expect(() => applyMoveLayer(p, 'a', root(p).tracks[0].id, 500_000, true)).not.toThrow()
    expect(root(p).tracks[1].layers[0].t_start_us).toBe(0) // sibling unmoved
  })

  // ── The zero boundary: a move stops, it does not deform ────────────────────
  it('stops a lone layer at 0 with its duration intact instead of writing a negative start', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 1_000_000, 2_000_000)]
    applyMoveLayer(p, 'a', root(p).tracks[0].id, -5_000_000, false)
    const a = root(p).tracks[0].layers[0]
    expect(a.t_start_us).toBe(0)
    expect(a.t_end_us).toBe(1_000_000) // NOT clamped-in-place: the duration rides along
  })

  it('stops a link at 0 as a set — earliest member on 0, spacing kept, nobody shortened', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [color('a', 1_000_000, 2_000_000)] // target, 1 s duration
    root(p).tracks[1].layers = [color('b', 500_000, 600_000)]     // earliest member, 100 ms
    applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)

    // Asks for -1 000 000; the set can only travel -500 000 before `b` hits zero.
    applyMoveLayer(p, 'a', root(p).tracks[0].id, 0, false)

    const a = root(p).tracks[0].layers[0]
    const b = root(p).tracks[1].layers[0]
    expect(b.t_start_us).toBe(0)                    // earliest member lands exactly on 0
    expect(a.t_start_us).toBe(500_000)              // ...and keeps its 500 ms lead
    expect(b.t_end_us - b.t_start_us).toBe(100_000) // NEGATIVE CONTROL: the pre-fix code
    expect(a.t_end_us - a.t_start_us).toBe(1_000_000) // left b at [0, -400_000)
  })

  it('lets a sample-aligned audio member decide where the link stops', () => {
    // The stop is driven by whichever member is earliest, on WHICHEVER lattice — an
    // `earliestStart` that only scanned the frame grid would walk the audio negative.
    // 999_979 µs is sample 47 999 at 48 kHz; it is not a 30 fps frame boundary.
    const p = blankProject(seededGen(), 't')
    const au = color('au', 999_979, 1_999_979)
    au.params = {
      kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1_000_000,
      gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
      fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue',
    }
    root(p).tracks[0].layers = [color('v', 1_000_000, 2_000_000)]
    root(p).tracks[1].layers = [au]
    applyLinksCreate(p, seededGen(), ['v', 'au'], null, false)

    applyMoveLayer(p, 'v', root(p).tracks[0].id, -3_000_000, false)

    expect(root(p).tracks[1].layers[0].t_start_us).toBe(0)
    expect(root(p).tracks[0].layers[0].t_start_us).toBeGreaterThanOrEqual(0)
  })

  it('cross-track link move changes only the target track and shifts siblings in place', () => {
    const p = blankProject(seededGen(), 't')
    root(p).tracks[0].layers = [
      color('a', 0, 100_000),
      color('b', 200_000, 300_000),
    ]
    root(p).tracks[1].layers = []
    applyLinksCreate(p, seededGen(), ['a', 'b'], null, false)

    applyMoveLayer(p, 'a', root(p).tracks[1].id, 500_000, false)

    expect(root(p).tracks[1].layers.map((l) => l.id)).toEqual(['a'])
    expect(root(p).tracks[1].layers[0].t_start_us).toBe(500_000)
    expect(root(p).tracks[0].layers.map((l) => l.id)).toEqual(['b'])
    expect(root(p).tracks[0].layers[0].t_start_us).toBe(700_000)
  })
})

// A layer-addressed move derives its composition from the layer (ADR 0052): no
// scope argument, and the destination lane has to be in that same composition.
describe('applyMoveLayer inside a Group', () => {
  it('moves within the Group with no scope argument; the root is untouched', () => {
    const { p, groupId, innerId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    applyMoveLayer(p, innerId, group(p, groupId).tracks[1].id, 2_000_000, false)
    expect(group(p, groupId).tracks[0].layers).toEqual([])
    expect(group(p, groupId).tracks[1].layers[0]).toMatchObject({ id: innerId, t_start_us: 2_000_000, t_end_us: 3_000_000 })
    expect(group(p, groupId).duration_us).toBe(3_000_000)
    expect(root(p)).toEqual(rootBefore)
  })
  it('refuses a destination track in another composition (CrossCompositionMove), touching nothing', () => {
    const { p, groupId, innerId, refLayerId } = groupedProject()
    const before = structuredClone(p)
    try { applyMoveLayer(p, innerId, root(p).tracks[1].id, 0, false); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err).toEqual({ error: 'CrossCompositionMove', layer: innerId, from: groupId, to: p.root_id }) }
    try { applyMoveLayer(p, refLayerId, group(p, groupId).tracks[1].id, 0, false); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CrossCompositionMove') }
    expect(p).toEqual(before)
  })
  it("applyMoveLayersToNewTrack mints the lane in the layers' composition and refuses a mixed set", () => {
    const { p, idGen, groupId, innerId, refLayerId } = groupedProject()
    try { applyMoveLayersToNewTrack(p, idGen, [innerId, refLayerId]); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('CrossCompositionSet') }
    const rootTracks = root(p).tracks.length
    const t = applyMoveLayersToNewTrack(p, idGen, [innerId])
    expect(group(p, groupId).tracks.at(-1)!.id).toBe(t)
    expect(group(p, groupId).tracks.at(-1)!.layers.map((l) => l.id)).toEqual([innerId])
    expect(root(p).tracks).toHaveLength(rootTracks)
  })
})

/// `anchor` is the whole of the difference between the raise's two entry points:
/// the *Move to a new track* command names no time and must not invent one, the
/// drop strip resolves one from the pointer and the clip has to land on it.
describe('applyMoveLayersToNewTrack: the landing', () => {
  /// Two clips two seconds apart, on two lanes — the shape that makes both
  /// "every member moves by the same delta" and "the raise empties more than one
  /// lane" observable at once. Returns them in time order.
  function twoLanes() {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, root(p).tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 1_000_000, 2_000_000)
    const b = applyAddLayer(p, g, root(p).tracks[1].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 3_000_000, 4_000_000)
    return { p, g, a, b }
  }
  const spans = (p: ReturnType<typeof twoLanes>['p'], trackId: string) =>
    root(p).tracks.find((t) => t.id === trackId)!.layers.map((l) => [l.id, l.t_start_us, l.t_end_us])

  it('carries every time verbatim when no anchor is named — an off-lattice one included', () => {
    const { p, g, a } = twoLanes()
    // Deliberately off the 30 fps lattice. An endpoint's grid follows the
    // layer's KIND and not its track, so a raise that re-snapped would move a
    // time the caller never asked about — the reason the verbatim path takes no
    // shift at all rather than a zero one.
    root(p).tracks[0].layers[0].t_start_us = 40_000
    root(p).tracks[0].layers[0].t_end_us = 1_040_000
    const lane = applyMoveLayersToNewTrack(p, g, [a])
    expect(spans(p, lane)).toEqual([[a, 40_000, 1_040_000]])
  })

  it('lands the anchor and holds every other member to its phase', () => {
    const { p, g, a, b } = twoLanes()
    const lane = applyMoveLayersToNewTrack(p, g, [a, b], { layerId: a, tStartUs: 2_000_000 })
    // A moved +1 s; B is still 2 s behind it, and both are on the one new lane.
    expect(spans(p, lane)).toEqual([[a, 2_000_000, 3_000_000], [b, 4_000_000, 5_000_000]])
    // Both source lanes emptied. They are the RESERVED skeleton, which the prune
    // leaves standing (`transient && !locked`), so what the raise proves here is
    // that it emptied them — not that it removed them.
    expect(root(p).tracks.at(-1)!.id).toBe(lane)
    expect(root(p).tracks.slice(0, -1).flatMap((t) => t.layers)).toEqual([])
  })

  it('snaps the requested head onto the grid before the set follows it', () => {
    const { p, g, a } = twoLanes()
    // Half a frame past frame 60 at 30 fps. The anchor's own grid decides, and
    // the delta the set travels is measured from the SNAPPED head — sending the
    // raw one would land the clip off the ghost that promised it.
    const lane = applyMoveLayersToNewTrack(p, g, [a], { layerId: a, tStartUs: 2_016_000 })
    expect(spans(p, lane)).toEqual([[a, 2_000_000, 3_000_000]])
  })

  it('floors the set at zero as one body, not member by member', () => {
    const { p, g, a, b } = twoLanes()
    // Ask for the LATER clip at 0: the delta that would put it there takes the
    // earlier one to −2 s, so the whole set stops where the earliest member hits
    // zero. Clamping per member would flatten the 2 s between them.
    const lane = applyMoveLayersToNewTrack(p, g, [a, b], { layerId: b, tStartUs: 0 })
    expect(spans(p, lane)).toEqual([[a, 0, 1_000_000], [b, 2_000_000, 3_000_000]])
  })

  it('refuses an anchor that is not in the raised set, before minting a lane', () => {
    const { p, g, a, b } = twoLanes()
    const before = structuredClone(p)
    try { applyMoveLayersToNewTrack(p, g, [a], { layerId: b, tStartUs: 0 }); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err).toMatchObject({ error: 'InvalidArgument', field: 'anchor_layer_id' }) }
    // Byte-identical: a refusal burns no id and leaves no half-built lane.
    expect(p).toEqual(before)
  })
})
