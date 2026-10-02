import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project, type TrackRole } from '../model'
import { applyAddTrack, applyAddLayer, colorParams } from './add'
import { applyDeleteTrack, applyMoveTrack, applyRenameTrack } from './tracks'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function base(): { p: Project; gen: IdGen } { const gen = seededGen(); return { p: blankProject(gen, 't'), gen } }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyDeleteTrack', () => {
  it('removes an empty custom track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyDeleteTrack(p, t, false)
    expect(root(p).tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('rejects a reserved (non-removable) track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, root(p).tracks[0].id, false), 'TrackNotRemovable')
  })
  it.each(['ARoll', 'BRoll'] as TrackRole[])('protects %s even with force and a legacy removable flag', (role) => {
    const { p } = base()
    const track = root(p).tracks.find((t) => t.role === role)!
    track.removable = true
    const before = structuredClone(p)
    expectCmd(() => applyDeleteTrack(p, track.id, true), 'TrackNotRemovable')
    expect(p).toEqual(before)
  })
  it.each(['AudioA', 'AudioB', 'Caption'] as TrackRole[])('deletes a legacy %s lane marked non-removable', (role) => {
    const { p, gen } = base()
    const id = applyAddTrack(p, gen, 'extra')
    Object.assign(root(p).tracks[2], { role, removable: false, transient: false })
    applyDeleteTrack(p, id, true)
    expect(root(p).tracks.map((t) => t.role)).toEqual(['ARoll', 'BRoll'])
  })
  it('keeps the surviving members of a link when at least two remain', () => {
    const { p, gen } = base()
    const t = applyAddTrack(p, gen, 'extra')
    const params = colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1)
    const gone = applyAddLayer(p, gen, t, params, 0, 1_000_000)
    const keep = [
      applyAddLayer(p, gen, root(p).tracks[0].id, params, 0, 1_000_000),
      applyAddLayer(p, gen, root(p).tracks[1].id, params, 0, 1_000_000),
    ]
    const linkId = gen()
    root(p).links = [{ id: linkId, members: [gone, ...keep] }]
    applyDeleteTrack(p, t, true)
    expect(root(p).links).toEqual([{ id: linkId, members: keep }])
  })
  it('rejects a non-empty track without force', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expectCmd(() => applyDeleteTrack(p, t, false), 'TrackNotEmpty')
  })
  it('force-deletes a non-empty track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyDeleteTrack(p, t, true)
    expect(root(p).tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, 'ghost', false), 'TrackNotFound')
  })
})

describe('applyMoveTrack', () => {
  it('rejects locked tracks and locked members without changing order', () => {
    const { p, gen } = base()
    const id = applyAddTrack(p, gen, 'locked')
    applyAddLayer(p, gen, id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    const track = root(p).tracks.at(-1)!
    track.locked = true
    let before = structuredClone(p)
    expectCmd(() => applyMoveTrack(p, id, 0), 'TrackLocked')
    expect(p).toEqual(before)
    track.locked = false
    track.layers[0].locked = true
    before = structuredClone(p)
    expectCmd(() => applyMoveTrack(p, id, 0), 'InvalidArgument')
    expect(p).toEqual(before)
  })
  it.each([-1, 0.5, NaN, Infinity])('rejects invalid position %s', (position) => {
    const { p, gen } = base()
    const id = applyAddTrack(p, gen, 'extra')
    const before = structuredClone(p)
    expectCmd(() => applyMoveTrack(p, id, position), 'TrackPositionOutOfRange')
    expect(p).toEqual(before)
  })
  it('reorders a track to a new position', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra') // appended at idx 2
    applyMoveTrack(p, t, 0)
    expect(root(p).tracks[0].id).toBe(t)
  })
  it('throws TrackPositionOutOfRange when position >= len', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, root(p).tracks[0].id, 9), 'TrackPositionOutOfRange')
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, 'ghost', 0), 'TrackNotFound')
  })
})

describe('track ops inside a Group', () => {
  it("delete / rename / move address the Group's track by id; the root's tracks are untouched", () => {
    const { p, idGen, groupId } = groupedProject()
    const rootBefore = structuredClone(root(p))
    const t = applyAddTrack(p, idGen, 'extra', undefined, groupId) // idx 2 in the Group
    applyRenameTrack(p, t, ' Lower third ')
    expect(group(p, groupId).tracks[2].label).toBe('Lower third')
    applyMoveTrack(p, t, 0)
    expect(group(p, groupId).tracks[0].id).toBe(t)
    applyAddLayer(p, idGen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 2_000_000)
    applyDeleteTrack(p, t, true)
    expect(group(p, groupId).tracks.some((x) => x.id === t)).toBe(false)
    expect(group(p, groupId).duration_us).toBe(1_000_000)
    expect(root(p)).toEqual(rootBefore)
  })
})
