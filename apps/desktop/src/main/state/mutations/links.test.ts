// apps/desktop/src/main/state/mutations/links.test.ts (read-side helpers)
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { indexLinks, linkSiblingsExcluding, checkLinkLock, layerIdSet, locateLink } from './links'
import { isCommandFailure } from '../errors'
import { group, groupedProject, root } from '../__tests__/fixtures/project'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withTwo(): Project {
  const p = blankProject(seededGen(), 't')
  root(p).tracks[0].layers = [color('a', 0, 100), color('b', 200, 300)]
  root(p).links = [{ id: 'g', members: ['a', 'b'] }]
  return p
}

describe('link read-side helpers', () => {
  it('indexLinks maps each member to its link', () => {
    const m = indexLinks([{ id: 'g', members: ['a', 'b'] }])
    expect(m.get('a')).toBe('g'); expect(m.get('b')).toBe('g'); expect(m.get('x')).toBeUndefined()
  })
  it('linkSiblingsExcluding returns the other members, sorted, [] when unlinked', () => {
    const p = withTwo()
    expect(linkSiblingsExcluding(root(p), 'a')).toEqual(['b'])
    expect(linkSiblingsExcluding(root(p), 'b')).toEqual(['a'])
    root(p).links = []
    expect(linkSiblingsExcluding(root(p), 'a')).toEqual([])
  })
  it('layerIdSet collects all layer ids', () => {
    const p = withTwo(); expect([...layerIdSet(root(p))].sort()).toEqual(['a', 'b'])
  })
  it('checkLinkLock: unlinked anchor is a no-op', () => {
    const p = withTwo(); root(p).links = []
    expect(() => checkLinkLock(root(p), 'a', ['a', 'b'])).not.toThrow()
  })
  it('checkLinkLock throws LinkLockedMember when a touched member is layer-locked', () => {
    const p = withTwo(); root(p).tracks[0].layers[1].locked = true // 'b' locked
    try { checkLinkLock(root(p), 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LinkLockedMember') }
  })
  it('checkLinkLock throws TrackLocked when a touched member sits on a locked track', () => {
    const p = withTwo()
    // move 'b' to B-roll and lock that track
    root(p).tracks[0].layers = [color('a', 0, 100)]
    root(p).tracks[1].layers = [color('b', 200, 300)]; root(p).tracks[1].locked = true
    try { checkLinkLock(root(p), 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})

describe('link read-side helpers take the composition', () => {
  it("linkSiblingsExcluding reads the Group's links, not the root's; locateLink finds a link in any composition", () => {
    const { p, groupId, innerId } = groupedProject()
    group(p, groupId).links = [{ id: 'gl', members: [innerId, 'other'] }]
    expect(linkSiblingsExcluding(group(p, groupId), innerId)).toEqual(['other'])
    expect(linkSiblingsExcluding(root(p), innerId)).toEqual([])
    expect(locateLink(p, 'gl')!.comp).toBe(group(p, groupId))
    expect(locateLink(p, 'nope')).toBeNull()
  })
})
