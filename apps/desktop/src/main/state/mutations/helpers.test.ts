// apps/desktop/src/main/state/mutations/helpers.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Track } from '../model'
import { applyDurationAutofit, dropLayerFromLinks, locateLayer, locateTrack, pruneEmptiedTrack, checkTrackLock, requireSameComposition, sourceDurationUs } from './helpers'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('helpers', () => {
  it('locateLayer finds the layer with its holders and indices', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[1].layers = [color('a', 0, 1)]
    const loc = locateLayer(p, 'a')!
    expect([loc.trackIndex, loc.layerIndex]).toEqual([1, 0])
    expect(loc.comp).toBe(root(p)); expect(loc.track).toBe(root(p).tracks[1]); expect(loc.layer.id).toBe('a')
    expect(locateLayer(p, 'nope')).toBeNull()
  })
  it('locateLayer / locateTrack search every composition — a Group layer names its Group', () => {
    const { p, groupId, innerId, innerTrackId, refLayerId } = groupedProject()
    expect(locateLayer(p, innerId)!.comp).toBe(group(p, groupId))
    expect(locateLayer(p, refLayerId)!.comp).toBe(root(p))
    expect(locateTrack(p, innerTrackId)!.comp).toBe(group(p, groupId))
  })
  it('requireSameComposition: one composition passes, a mixed set is CrossCompositionSet naming the odd member', () => {
    const { p, groupId, innerId, refLayerId } = groupedProject()
    expect(requireSameComposition(p, [innerId])).toBe(group(p, groupId))
    try { requireSameComposition(p, [refLayerId, innerId]); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err).toEqual({ error: 'CrossCompositionSet', layer: innerId, composition: groupId, expected: p.root_id }) }
    // A missing member is reported as missing, before any scope comparison.
    try { requireSameComposition(p, [refLayerId, 'ghost']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
  it('sourceDurationUs: a Group layer\'s source is its composition\'s duration', () => {
    const { p, groupId, refLayerId } = groupedProject()
    expect(sourceDurationUs(p, locateLayer(p, refLayerId)!.layer.params)).toBe(group(p, groupId).duration_us)
    expect(sourceDurationUs(p, color('x', 0, 1).params)).toBeNull()
  })
  it('applyDurationAutofit grows+shrinks unpinned, grow-only when pinned', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].layers = [color('a', 0, 5_000_000)]
    applyDurationAutofit(root(p)); expect(root(p).duration_us).toBe(5_000_000)
    root(p).tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(root(p)); expect(root(p).duration_us).toBe(2_000_000) // shrank
    root(p).duration_pinned = true; root(p).duration_us = 9_000_000
    root(p).tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(root(p)); expect(root(p).duration_us).toBe(9_000_000) // pinned: no shrink
    root(p).tracks[0].layers = [color('a', 0, 12_000_000)]
    applyDurationAutofit(root(p)); expect(root(p).duration_us).toBe(12_000_000) // pinned: overflow grows
  })
  it('pruneEmptiedTrack removes only empty+transient+unlocked tracks', () => {
    const p = blankProject(seededGen(), 't')
    // A-roll belongs to the reserved skeleton (transient:false) → survives empty.
    expect(pruneEmptiedTrack(root(p), root(p).tracks[0].id)).toBeNull()
    const lane = (id: string, over: Partial<Track>) => ({
      id, label: null, enabled: true, locked: false, muted: false, solo: false,
      removable: true, role: null, transient: true, height_px: 64, layers: [], ...over,
    } as Track)
    root(p).tracks.push(lane('tlocked', { locked: true }), lane('tfull', { layers: [color('a', 0, 1)] }), lane('tx', {}))
    expect(pruneEmptiedTrack(root(p), 'tlocked')).toBeNull() // lock out-ranks cleanup
    expect(pruneEmptiedTrack(root(p), 'tfull')).toBeNull()   // still holds a layer
    expect(pruneEmptiedTrack(root(p), 'gone')).toBeNull()    // unknown id
    expect(pruneEmptiedTrack(root(p), 'tx')).toBe('tx')
    expect(root(p).tracks.find((t) => t.id === 'tx')).toBeUndefined()
  })
  it('dropLayerFromLinks removes the member and auto-dissolves below 2', () => {
    const p = blankProject(seededGen(), 't')
    root(p).links = [{ id: 'g', members: ['a', 'b'] }]
    dropLayerFromLinks(root(p), 'a')
    expect(root(p).links.length).toBe(0) // dropped to 1 → dissolved
  })
  it('checkTrackLock throws TrackLocked / LayerNotFound, and gates a Group track like a root one', () => {
    const p = blankProject(seededGen(), 't'); root(p).tracks[0].locked = true; root(p).tracks[0].layers = [color('a', 0, 1)]
    try { checkTrackLock(p, 'a'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
    try { checkTrackLock(p, 'ghost'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
    const g = groupedProject()
    expect(checkTrackLock(g.p, g.innerId).comp).toBe(group(g.p, g.groupId))
    group(g.p, g.groupId).tracks[0].locked = true
    try { checkTrackLock(g.p, g.innerId); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
