import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddLayer, applyAddMarker, colorParams } from './add'
import { mediaItemTemplate, videoClipParams } from './media'
import { applyAttachMarker, applyDetachMarker, applyUpdateMarker, applyRemoveMarker } from './markers'
import { frameIndexRound, snapFrameRound, timeUsAtFrame } from '../snap'
import { isCommandFailure } from '../errors'
import { parseMarkerPatch } from '../mcp-commands'
import { group, groupedProject, root, withGroup } from '../__tests__/fixtures/project'

const BLUE = { r: 0, g: 128, b: 255, a: 255 }
function withMarkers(specs: Array<[number, number | null]>): { p: Project; ids: string[] } {
  const gen = seededGen(); const p = blankProject(gen, 't'); const ids: string[] = []
  for (const [t0, end] of specs) ids.push(applyAddMarker(p, gen, t0, end, 'm', BLUE))
  return { p, ids }
}
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }
function expectCmdErr(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}

// ── the composition frame grid ───────────────────────────────────────────────
// The spec's full rate matrix; the 1001-denominator rates are where an
// arbitrary-µs marker time is visibly off the grid.
const RATES: Array<[number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1],
]
function emptyAt(num: number, den: number): { p: Project; gen: IdGen } {
  const gen = seededGen(); const p = blankProject(gen, 't') // #1 A #2 B #3 project
  root(p).fps = { num, den }
  return { p, gen }
}
const isCanonical = (us: number, num: number, den: number) => timeUsAtFrame(frameIndexRound(us, num, den), num, den) === us

describe('applyUpdateMarker', () => {
  it('patches label/end_t_us/color without touching t_us (no re-sort)', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { label: 'chapter', end_t_us: 2_000_000, color: { r: 255, g: 0, b: 0, a: 255 } })
    const m = root(p).markers[0]
    expect(m.label).toBe('chapter'); expect(m.end_t_us).toBe(2_000_000); expect(m.color.r).toBe(255)
    expect(m.t_us).toBe(1_000_000)
  })
  it('re-sorts markers by t_us when t_us changes (stable)', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null], [3_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 5_000_000 })
    expect(root(p).markers.map((m) => m.t_us)).toEqual([2_000_000, 3_000_000, 5_000_000])
  })
  it('null/absent patch fields are "do not touch"', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: null, label: null })
    expect(root(p).markers[0].t_us).toBe(1_000_000); expect(root(p).markers[0].label).toBe('m')
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyUpdateMarker(p, 'ghost', { label: 'x' }), 'MarkerNotFound')
  })
  // `note` is the long text the Panel edits; `label` is what the lane and the
  // search palette show. Patching one must never move the other, or the two
  // fields are one field wearing two names.
  it('patches note independently of label', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { note: 'reshoot the wide; the boom dips in at 00:04' })
    expect(root(p).markers[0].note).toBe('reshoot the wide; the boom dips in at 00:04')
    expect(root(p).markers[0].label).toBe('m')
    applyUpdateMarker(p, ids[0], { label: 'boom' })
    expect(root(p).markers[0].note).toBe('reshoot the wide; the boom dips in at 00:04')
  })
  it('a null note is "do not touch", so clearing takes an empty string', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { note: 'keep me' })
    applyUpdateMarker(p, ids[0], { note: null })
    expect(root(p).markers[0].note).toBe('keep me')
    applyUpdateMarker(p, ids[0], { note: '' })
    expect(root(p).markers[0].note).toBe('')
  })
  it('a marker born free stays free through any patch', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 2_000_000, label: 'x', note: 'y', color: { r: 1, g: 2, b: 3, a: 4 } })
    expect(root(p).markers[0].anchor).toBeNull()
  })
})

// The patch surface is the ONLY generic writer of a marker, so what it refuses
// is what cannot be built inconsistently. `anchor` is refused because setting it
// without deriving `t_us` in the same commit is a lie the next reconcile would
// have to guess at; `metadata` is refused because the field no longer exists.
describe('parseMarkerPatch', () => {
  it('accepts note beside the fields it always took', () => {
    const patch = { t_us: 1, end_t_us: 2, label: 'x', note: 'long', color: { r: 0, g: 0, b: 0, a: 255 } }
    expect(parseMarkerPatch(patch)).toEqual(patch)
  })
  it('rejects a non-string note rather than silently skipping it', () => {
    expect(() => parseMarkerPatch({ note: 42 })).toThrow(/note must be a string/)
  })
  it('refuses anchor: an anchor is established only by attach/detach', () => {
    expect(() => parseMarkerPatch({ anchor: { layer: 'l', src_us: 0 } })).toThrow(/unknown key 'anchor'/)
  })
  it('still refuses the deleted metadata map', () => {
    expect(() => parseMarkerPatch({ metadata: {} })).toThrow(/unknown key 'metadata'/)
  })
})

describe('marker times enter the composition frame grid', () => {
  it.each(RATES)('%i/%i: add_marker snaps t_us and end_t_us to canonical times', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    // Arbitrary µs a UI drop or an MCP call can produce, at several phases.
    for (const tUs of [1, 12_345, 1_000_001, 999_999, 40_000_007]) {
      const id = applyAddMarker(p, gen, tUs, tUs + 5_000_003, 'm', BLUE)
      const m = root(p).markers.find((x) => x.id === id)!
      expect(m.t_us).toBe(snapFrameRound(tUs, num, den))
      expect(m.end_t_us).toBe(snapFrameRound(tUs + 5_000_003, num, den))
      expect(isCanonical(m.t_us, num, den)).toBe(true)
      expect(isCanonical(m.end_t_us!, num, den)).toBe(true)
    }
  })

  it.each(RATES)('%i/%i: 10 min / 1 h / 24 h marker times stay canonical', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    for (const tUs of [600_000_001, 3_600_000_001, 86_400_000_001]) {
      const id = applyAddMarker(p, gen, tUs, null, 'm', BLUE)
      const m = root(p).markers.find((x) => x.id === id)!
      expect(isCanonical(m.t_us, num, den)).toBe(true)
      expect(Math.abs(m.t_us - tUs)).toBeLessThanOrEqual(timeUsAtFrame(1, num, den))
    }
  })

  it.each(RATES)('%i/%i: the sorted-markers invariant holds on the SNAPPED times', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    for (const tUs of [2_000_003, 999_998, 5_000_001, 1_000_002, 7]) applyAddMarker(p, gen, tUs, null, 'm', BLUE)
    const ts = root(p).markers.map((m) => m.t_us)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })

  it('a region whose span collapses under the snap fails and mints no id', () => {
    const { p, gen } = emptyAt(30, 1)
    // 1_016_000 snaps back down to 1_000_000 at 30 fps → zero-length region.
    const err = expectCmdErr(() => applyAddMarker(p, gen, 1_000_000, 1_016_000, 'm', BLUE))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'end_t_us'])
    expectCmd(() => applyAddMarker(p, gen, 1_000_000, 500_000, 'm', BLUE), 'InvalidArgument') // end < t
    expect(root(p).markers).toEqual([])
    // #4, not #5+ → neither rejection consumed a marker id
    expect(applyAddMarker(p, gen, 0, null, 'm', BLUE)).toBe('00000000-0000-0000-0000-000000000005')
  })

  it('a region one frame long survives the snap', () => {
    const { p, gen } = emptyAt(30, 1)
    const id = applyAddMarker(p, gen, 1_000_000, 1_017_000, 'm', BLUE)
    const m = root(p).markers.find((x) => x.id === id)!
    expect([m.t_us, m.end_t_us]).toEqual([1_000_000, 1_033_333])
  })

  it('update_marker snaps t_us / end_t_us and re-sorts on the snapped value', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 2_999_990, end_t_us: 4_000_007 })
    expect(root(p).markers.map((m) => m.t_us)).toEqual([2_000_000, 3_000_000])
    expect(root(p).markers[1].end_t_us).toBe(4_000_000)
  })

  it('moving t_us onto or past end_t_us fails; the marker is untouched', () => {
    const { p, ids } = withMarkers([[1_000_000, 2_000_000]])
    expect(expectCmdErr(() => applyUpdateMarker(p, ids[0], { t_us: 2_000_000 })).error).toBe('InvalidArgument')
    expectCmd(() => applyUpdateMarker(p, ids[0], { t_us: 3_000_000 }), 'InvalidArgument')
    expect([root(p).markers[0].t_us, root(p).markers[0].end_t_us]).toEqual([1_000_000, 2_000_000])
  })
})

describe('applyRemoveMarker', () => {
  it('removes a marker by id', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null]])
    applyRemoveMarker(p, ids[0])
    expect(root(p).markers.map((m) => m.t_us)).toEqual([2_000_000])
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyRemoveMarker(p, 'ghost'), 'MarkerNotFound')
  })
})

describe('markers inside a Group', () => {
  it('add_marker takes composition_id; update / remove derive the composition from the marker id', () => {
    const gen = seededGen()
    const { p, groupId } = groupedProject(gen)
    const rootBefore = structuredClone(root(p))
    const m = applyAddMarker(p, gen, 500_000, null, 'in group', BLUE, groupId)
    expect(group(p, groupId).markers.map((x) => x.id)).toEqual([m])
    applyUpdateMarker(p, m, { label: 'renamed', t_us: 700_000 })
    expect(group(p, groupId).markers[0]).toMatchObject({ label: 'renamed', t_us: 700_000 })
    applyRemoveMarker(p, m)
    expect(group(p, groupId).markers).toEqual([])
    expect(root(p)).toEqual(rootBefore)
    expectCmd(() => applyUpdateMarker(p, m, { label: 'x' }), 'MarkerNotFound')
  })
})

// ── attach / detach: the two explicit ends of anchoring ──────────────────────
// Every case below states what the TIE means, never what `t_us` becomes:
// re-deriving the time is `reconcileMarkers`' job (validate.ts) and runs in the
// same commit, so an op-level test that asserted a moved `t_us` would be
// pinning the reconcile from the wrong side.
const MEDIA = '00000000-0000-0000-0000-0000000000bb'
/** Root with one clip on the A roll at `[1 s, 3 s)` over source `[2 s, 4 s)`,
 *  so a mark at 2 s names source 3 s and the two are never confusable. */
function withClip(): { p: Project; gen: IdGen; clipId: string; trackId: string } {
  const gen = seededGen(); const p = blankProject(gen, 't')
  p.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
  const trackId = root(p).tracks[0].id
  const clipId = applyAddLayer(p, gen, trackId, videoClipParams(MEDIA, 2_000_000, 4_000_000), 1_000_000, 3_000_000)
  return { p, gen, clipId, trackId }
}

describe('applyAttachMarker', () => {
  it('names the source instant the mark already sits on, and moves the mark nowhere', () => {
    const { p, gen, clipId } = withClip()
    const m = applyAddMarker(p, gen, 2_000_000, null, 'cut', BLUE)
    applyAttachMarker(p, m, clipId)
    expect(root(p).markers[0]).toMatchObject({ t_us: 2_000_000, anchor: { layer: clipId, src_us: 3_000_000 } })
  })

  it('re-ties an already anchored marker rather than refusing it', () => {
    const { p, gen, clipId, trackId } = withClip()
    const second = applyAddLayer(p, gen, trackId, videoClipParams(MEDIA, 0, 1_000_000), 3_000_000, 4_000_000)
    const m = applyAddMarker(p, gen, 2_000_000, null, 'cut', BLUE, null, '', { layer: clipId, src_us: 3_000_000 })
    applyUpdateMarker(p, m, { t_us: 3_500_000 })
    applyAttachMarker(p, m, second)
    expect(root(p).markers[0].anchor).toEqual({ layer: second, src_us: 500_000 })
  })

  // A mark the clip does not touch names no instant in it. The end is EXCLUSIVE
  // — the boundary after the clip's last frame belongs to whatever comes next.
  it('refuses a marker the clip does not cover, leaving it free', () => {
    const { p, gen, clipId } = withClip()
    const before = applyAddMarker(p, gen, 500_000, null, 'early', BLUE)
    expect(expectCmdErr(() => applyAttachMarker(p, before, clipId)).error).toBe('InvalidArgument')
    const atEnd = applyAddMarker(p, gen, 3_000_000, null, 'boundary', BLUE)
    expect(expectCmdErr(() => applyAttachMarker(p, atEnd, clipId)).error).toBe('InvalidArgument')
    expect(root(p).markers.map((x) => x.anchor)).toEqual([null, null])
    // The last frame the clip DOES show is still inside it.
    const inside = applyAddMarker(p, gen, 2_966_667, null, 'last frame', BLUE)
    applyAttachMarker(p, inside, clipId)
    expect(root(p).markers.find((x) => x.id === inside)!.anchor).not.toBeNull()
  })

  it('refuses a kind with no source window — the fix is a different layer, not a different time', () => {
    const { p, gen, trackId } = withClip()
    const color = applyAddLayer(p, gen, trackId, colorParams({ r: 1, g: 2, b: 3, a: 255 }, 16, 9), 4_000_000, 5_000_000)
    const m = applyAddMarker(p, gen, 4_500_000, null, 'on the colour', BLUE)
    expect(expectCmdErr(() => applyAttachMarker(p, m, color))).toEqual({
      error: 'WrongLayerKind', layer: color, expected: 'VideoClip | Audio | CompositionRef',
    })
    expect(root(p).markers.find((x) => x.id === m)!.anchor).toBeNull()
  })

  // Checked BEFORE the kind: the two timelines share no origin, so a
  // cross-composition tie is unrepresentable whatever the layer is made of.
  it('refuses a layer outside the marker`s own composition', () => {
    const gen = seededGen()
    const { p, groupId, innerId } = groupedProject(gen)
    const m = applyAddMarker(p, gen, 500_000, null, 'root mark', BLUE)
    expect(expectCmdErr(() => applyAttachMarker(p, m, innerId))).toEqual({
      error: 'CrossCompositionSet', layer: innerId, composition: groupId, expected: root(p).id,
    })
  })

  it('ties a marker inside a Group to a clip of that Group', () => {
    const gen = seededGen()
    const base = blankProject(gen, 't')
    base.media_pool[MEDIA] = mediaItemTemplate(MEDIA, 'Video', 10_000_000)
    let innerClip = ''
    const { p, groupId } = withGroup(base, gen, (g, view) => {
      innerClip = applyAddLayer(view, gen, g.tracks[0].id, videoClipParams(MEDIA, 2_000_000, 4_000_000), 1_000_000, 3_000_000)
    })
    const m = applyAddMarker(p, gen, 2_000_000, null, 'in group', BLUE, groupId)
    applyAttachMarker(p, m, innerClip)
    expect(group(p, groupId).markers[0].anchor).toEqual({ layer: innerClip, src_us: 3_000_000 })
    expect(root(p).markers).toEqual([])
  })

  it('throws MarkerNotFound / LayerNotFound for an unknown id', () => {
    const { p, gen, clipId } = withClip()
    const m = applyAddMarker(p, gen, 2_000_000, null, 'cut', BLUE)
    expectCmd(() => applyAttachMarker(p, 'ghost', clipId), 'MarkerNotFound')
    expectCmd(() => applyAttachMarker(p, m, 'ghost'), 'LayerNotFound')
  })
})

describe('applyDetachMarker', () => {
  it('clears the tie and leaves t_us exactly where the last reconcile put it', () => {
    const { p, gen, clipId } = withClip()
    const m = applyAddMarker(p, gen, 2_000_000, null, 'cut', BLUE, null, 'the boom dips in here', { layer: clipId, src_us: 3_000_000 })
    applyDetachMarker(p, m)
    expect(root(p).markers[0]).toMatchObject({ t_us: 2_000_000, anchor: null, note: 'the boom dips in here' })
  })

  it('is a no-op on an already free marker', () => {
    const { p, gen } = withClip()
    const m = applyAddMarker(p, gen, 2_000_000, null, 'cut', BLUE)
    applyDetachMarker(p, m)
    expect(root(p).markers[0].anchor).toBeNull()
  })

  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withClip()
    expectCmd(() => applyDetachMarker(p, 'ghost'), 'MarkerNotFound')
  })
})
