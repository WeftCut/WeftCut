import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { diffRanges, placeRanges, rangesToReview } from './reviewRanges'
import { diffProjects } from './reviewDiff'
import { blankProject, rootComposition, type AudioParams, type Layer, type Project } from './model'
import { seededGen } from './ids'
import { applyAddGroupLayer, applyAddLayer, applyAddTrack, colorParams } from './mutations/add'
import { audioParams, mediaItemTemplate, videoClipParams } from './mutations/media'
import { applySplitLayer } from './mutations/split'
import { applyLinksCreate } from './mutations/links'
import type { Change, ChangedRange } from '../../shared/review'

const VIDEO = '00000000-0000-0000-0000-0000000000aa'
const MUSIC = '00000000-0000-0000-0000-0000000000bb'
const S = 1_000_000

/** Picture A B C at [0,2) [2,4) [4,6) s from three stretches of one file, and
 *  a music bed under all of it. */
function setup() {
  const ids = seededGen()
  const p = blankProject(ids, 'ranges')
  p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 60 * S)
  p.media_pool[MUSIC] = mediaItemTemplate(MUSIC, 'Audio', 60 * S)
  const root = rootComposition(p)
  const picture = root.tracks[0]!.id
  const music = applyAddTrack(p, ids, 'Music')
  const a = applyAddLayer(p, ids, picture, videoClipParams(VIDEO, 0, 2 * S), 0, 2 * S)
  const b = applyAddLayer(p, ids, picture, videoClipParams(VIDEO, 10 * S, 12 * S), 2 * S, 4 * S)
  const c = applyAddLayer(p, ids, picture, videoClipParams(VIDEO, 20 * S, 22 * S), 4 * S, 6 * S)
  const bed = applyAddLayer(p, ids, music, audioParams(MUSIC, 0, 6 * S), 0, 6 * S)
  return { p, ids, picture, music, a, b, c, bed, root: p.root_id }
}

/** `setup` with a fourth clip D at [6,8) s and the bed under all four. */
function setupD() {
  const s = setup()
  const d = applyAddLayer(s.p, s.ids, s.picture, videoClipParams(VIDEO, 30 * S, 32 * S), 6 * S, 8 * S)
  const bed = layer(s.p, s.bed); bed.t_end_us = 8 * S; (bed.params as AudioParams).src_out_us = 8 * S
  return { ...s, d }
}

const layer = (d: Project, id: string): Layer => {
  for (const c of Object.values(d.compositions)) for (const t of c.tracks) for (const l of t.layers) if (l.id === id) return l
  throw new Error(`no layer ${id}`)
}
const remove = (d: Project, id: string) => {
  for (const c of Object.values(d.compositions)) for (const t of c.tracks) t.layers = t.layers.filter(l => l.id !== id)
}
const shift = (d: Project, id: string, by: number) => { const l = layer(d, id); l.t_start_us += by; l.t_end_us += by }
/** Cut the music bed at `at` and close it up: its stretch from `from` on
 *  plays from `at`, as a ripple across every track leaves it. */
const closeBed = (d: Project, s: ReturnType<typeof setup>, at: number, from: number) => {
  const bed = layer(d, s.bed), params = bed.params as AudioParams
  const end = params.src_out_us
  bed.t_end_us = at; params.src_out_us = at
  rootComposition(d).tracks.find(t => t.id === s.music)!.layers.push({ ...bed, id: 'bed-tail', t_start_us: at, t_end_us: at + end - from, params: { ...params, src_in_us: from, src_out_us: end } })
}

/** Every change unreviewed, as after one agent edit. */
const ranges = (before: Project, after: Project, user: (c: Change) => boolean = () => false): ChangedRange[] => {
  const changes = diffProjects(before, after)
  return diffRanges(before, after, { unreviewed: changes.filter(c => !user(c)), user: changes.filter(user) })
}
const brief = (rs: readonly ChangedRange[]) => rs.map(r => [r.class, r.t_start_us / S, r.t_end_us / S, r.before_start_us / S, r.before_end_us / S])

describe('diffRanges', () => {
  it('finds nothing where nothing changed, or only a label', () => {
    const s = setup()
    expect(ranges(s.p, s.p)).toEqual([])
    expect(ranges(s.p, produce(s.p, d => { layer(d, s.b).label = 'Interview' }))).toEqual([])
  })

  it('reads a ripple delete across every track as one cut point, the tail unchanged', () => {
    const s = setup()
    const after = produce(s.p, d => {
      remove(d, s.b); shift(d, s.c, -2 * S)
      // The music closes up with the picture: its later stretch is a new clip.
      closeBed(d, s, 2 * S, 4 * S)
    })
    expect(brief(ranges(s.p, after))).toEqual([['removed', 2, 2, 2, 4]])
  })

  it('reads a picture rippled without its music as out of sync over the whole tail', () => {
    const s = setup()
    const after = produce(s.p, d => { remove(d, s.b); shift(d, s.c, -2 * S) })
    const rs = ranges(s.p, after)
    // From the cut on, what plays pairs the picture with music two seconds
    // later than before: one range to the end, its offset stated.
    expect(brief(rs)).toEqual([['modified', 2, 6, 2, 6]])
    expect(rs[0]!.sync_offset_us).toBe(2 * S)
  })

  describe('sync', () => {
    /** Ripple-delete B from `setupD`: the picture closes up, the bed stays. */
    const rippleB = (d: Project, s: ReturnType<typeof setupD>) => { remove(d, s.b); shift(d, s.c, -2 * S); shift(d, s.d, -2 * S) }
    const sync = (rs: readonly ChangedRange[]) =>
      rs.map(r => [r.t_start_us / S, r.t_end_us / S, r.only, r.sync_offset_us, r.sound_lag_us, r.sound_role, r.sync_bound])

    it('reads a bed under a rippled hole as only out of sync, the music late against the picture', () => {
      const s = setupD()
      const rs = ranges(s.p, produce(s.p, d => rippleB(d, s)))
      // The removed clip's hole is the range's onset; everything after it
      // is the same picture and the same music, two seconds apart.
      expect(brief(rs)).toEqual([['modified', 2, 8, 2, 8]])
      expect(sync(rs)).toEqual([[2, 8, 'sync', 2 * S, 2 * S, 'music', undefined]])
    })

    it('says which kind plays apart when it is one kind, and only then', () => {
      const s = setupD()
      // The bed becomes a B-roll over all four clips: picture against picture.
      const broll = produce(s.p, d => { layer(d, s.bed).params = videoClipParams(VIDEO, 40 * S, 48 * S) })
      const pictures = ranges(broll, produce(broll, d => rippleB(d, s)))
      expect(sync(pictures)).toEqual([[2, 8, 'sync', 2 * S, undefined, undefined, undefined]])
      expect(pictures[0]!.sync_between).toBe('picture')
      // Picture against the music bed names neither kind alone.
      expect(ranges(s.p, produce(s.p, d => rippleB(d, s)))[0]!.sync_between).toBeUndefined()
    })

    it('marks the sync bound when linked layers play apart', () => {
      const s = setupD()
      applyLinksCreate(s.p, s.ids, [s.c, s.d, s.bed], false)
      const rs = ranges(s.p, produce(s.p, d => rippleB(d, s)))
      expect(sync(rs)).toEqual([[2, 8, 'sync', 2 * S, 2 * S, 'music', true]])
    })

    it('marks the sync bound when dialogue plays apart from the picture', () => {
      const s = setupD()
      ;(layer(s.p, s.bed).params as AudioParams).role = 'dialogue'
      const rs = ranges(s.p, produce(s.p, d => rippleB(d, s)))
      expect(sync(rs)).toEqual([[2, 8, 'sync', 2 * S, 2 * S, 'dialogue', true]])
    })

    it('keeps the offset but not sync-only where something also plays differently', () => {
      const s = setupD()
      const after = produce(s.p, d => {
        rippleB(d, s)
        ;(layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 }
      })
      // The dimmed C plays at 2-4 s now and played at 4-6 s: only past both
      // is the stretch the same content out of sync.
      expect(ranges(s.p, after).map(r => [r.t_start_us / S, r.t_end_us / S, r.only, r.sync_offset_us]))
        .toEqual([[2, 6, undefined, 2 * S], [6, 8, 'sync', 2 * S]])
    })

    it('reads content removed further into the stretch as more than out of sync', () => {
      const s = setupD()
      const titles = applyAddTrack(s.p, s.ids, 'Titles')
      applyAddLayer(s.p, s.ids, titles, colorParams({ r: 1, g: 2, b: 3, a: 255 }, 64, 64), 5 * S, 6 * S)
      const title = rootComposition(s.p).tracks.find(t => t.id === titles)!.layers[0]!.id
      const rs = ranges(s.p, produce(s.p, d => { rippleB(d, s); remove(d, title) }))
      // The hole at the onset is the cut the stretch starts at; the title
      // gone at 5 s is a removal of its own.
      expect(rs.map(r => [r.t_start_us / S, r.t_end_us / S, r.only])).toEqual([[2, 5, 'sync'], [5, 6, undefined], [6, 8, 'sync']])
    })

    it('states no sync where every track moved alike', () => {
      const s = setup()
      const after = produce(s.p, d => { remove(d, s.b); shift(d, s.c, -2 * S); closeBed(d, s, 2 * S, 4 * S) })
      expect(ranges(s.p, after).map(r => [r.class, r.sync_offset_us, r.only])).toEqual([['removed', undefined, undefined]])
    })

    it('states each stretch\'s own offset where the displacements change along one residual', () => {
      const s = setupD()
      const after = produce(s.p, d => { remove(d, s.b); shift(d, s.c, -2 * S); shift(d, s.d, -S) })
      // C plays 2 s early against the bed, D 1 s; where both stand against
      // it the picture parts disagree, so no one lag is true there.
      expect(sync(ranges(s.p, after))).toEqual([
        [2, 5, 'sync', 2 * S, 2 * S, 'music', undefined],
        [5, 6, 'sync', 2 * S, undefined, undefined, undefined],
        [6, 8, 'sync', S, S, 'music', undefined],
      ])
    })
  })

  it('reads a lift as a removal with its width, and an insert as an addition', () => {
    const s = setup()
    expect(brief(ranges(s.p, produce(s.p, d => { remove(d, s.b) }))))
      .toEqual([['removed', 2, 4, 2, 4]])
    const inserted = produce(s.p, d => {
      const track = rootComposition(d).tracks.find(t => t.id === s.picture)!
      track.layers.push({ ...layer(d, s.a), id: 'title', t_start_us: 6 * S, t_end_us: 7 * S, params: colorParams({ r: 1, g: 2, b: 3, a: 255 }, 64, 64) })
    })
    expect(brief(ranges(s.p, inserted))).toEqual([['added', 6, 7, 6, 6]])
  })

  it('finds no change in a razor split, which plays the same', () => {
    const s = setup()
    const ids = seededGen(1000)
    expect(ranges(s.p, produce(s.p, d => { applySplitLayer(d, ids, s.b, 3 * S, false) }))).toEqual([])
  })

  it('narrows a fade added to a clip to the fade itself', () => {
    const s = setup()
    const after = produce(s.p, d => { (layer(d, s.c).params as { fade_in_us: number }).fade_in_us = S / 2 })
    expect(brief(ranges(s.p, after))).toEqual([['modified', 4, 4.5, 4, 4.5]])
  })

  it('reads a value change over a whole clip as that clip, picture only', () => {
    const s = setup()
    const after = produce(s.p, d => { (layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 } })
    const [r] = ranges(s.p, after)
    expect(brief([r!])).toEqual([['modified', 4, 6, 4, 6]])
    expect(r!.only).toBe('picture')
  })

  it('reads a shorter replacement as one modified range, both lengths kept', () => {
    const s = setup()
    const after = produce(s.p, d => {
      // B's 2 s become 1 s of other material; everything after closes up,
      // the music with it.
      const b = layer(d, s.b)
      b.t_end_us = 3 * S; Object.assign(b.params, { src_in_us: 30 * S, src_out_us: 31 * S })
      shift(d, s.c, -S)
      closeBed(d, s, 3 * S, 4 * S)
    })
    expect(brief(ranges(s.p, after))).toEqual([['modified', 2, 3, 2, 4]])
  })

  it('attributes a range to review when any unreviewed change plays in it, else to the user', () => {
    const s = setup()
    const after = produce(s.p, d => {
      (layer(d, s.a).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 }
      ;(layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 }
    })
    const byUser = (c: Change) => c.id === `Layer:${s.c}`
    const rs = ranges(s.p, after, byUser)
    expect(rs.map(r => [r.t_start_us / S, r.source, r.change_ids])).toEqual([
      [0, 'review', [`Layer:${s.a}`]],
      [4, 'user', [`Layer:${s.c}`]],
    ])
  })

  it('reads new material where nothing played as one addition per stretch that plays, never the silence between', () => {
    const s = setup()
    const after = produce(s.p, d => {
      const track = rootComposition(d).tracks.find(t => t.id === s.picture)!
      const title = (id: string, t0: number) => ({ ...layer(d, s.a), id, t_start_us: t0, t_end_us: t0 + S, params: colorParams({ r: 1, g: 2, b: 3, a: 255 }, 64, 64) })
      track.layers.push(title('t1', 7 * S), title('t2', 9 * S))
    })
    expect(brief(ranges(s.p, after))).toEqual([['added', 7, 8, 6, 6], ['added', 9, 10, 6, 6]])
  })

  it('names only unreviewed changes to a reader of the unreviewed list alone', () => {
    const s = setup()
    const after = produce(s.p, d => {
      (layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 }
      ;(layer(d, s.bed).params as AudioParams).gain_db = { mode: 'Static', value: -6 }
    })
    // The user's quieter music plays under all of it; only where the agent's
    // dimmed C plays too is there something to review.
    const all = ranges(s.p, after, c => c.id === `Layer:${s.bed}`)
    expect(all.map(r => [r.t_start_us / S, r.t_end_us / S, r.source, r.change_ids, r.includes_user])).toEqual([
      [0, 4, 'user', [`Layer:${s.bed}`], undefined],
      [4, 6, 'review', [`Layer:${s.c}`, `Layer:${s.bed}`], true],
    ])
    const changes = diffProjects(s.p, after).filter(c => c.id !== `Layer:${s.bed}`)
    expect(rangesToReview(all, changes).map(r => [r.change_ids, r.includes_user])).toEqual([[[`Layer:${s.c}`], undefined]])
  })

  it('keeps a user lift beside an agent change a range of its own', () => {
    const s = setupD()
    const after = produce(s.p, d => {
      (layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 }
      remove(d, s.d)
    })
    const rs = ranges(s.p, after, c => c.id === `Layer:${s.d}`)
    expect(rs.map(r => [r.class, r.t_start_us / S, r.t_end_us / S, r.source])).toEqual([['modified', 4, 6, 'review'], ['removed', 6, 8, 'user']])
  })

  it('compares a Group by what it shows of its composition', () => {
    const ids = seededGen()
    const p = blankProject(ids, 'groups')
    p.media_pool[VIDEO] = mediaItemTemplate(VIDEO, 'Video', 60 * S)
    const inner = structuredClone(rootComposition(p))
    inner.id = 'inner'; inner.tracks.forEach((t, i) => { t.id = `inner-track-${i}` })
    inner.tracks[0]!.layers = []
    p.compositions[inner.id] = inner
    applyAddLayer(p, ids, inner.tracks[0]!.id, videoClipParams(VIDEO, 0, 4 * S), 0, 4 * S)
    applyAddLayer(p, ids, inner.tracks[0]!.id, videoClipParams(VIDEO, 10 * S, 14 * S), 4 * S, 8 * S)
    inner.duration_us = 8 * S
    const group = applyAddGroupLayer(p, ids, inner.id, rootComposition(p).tracks[0]!.id, 0, 8 * S)
    // Show only the Group's first 4 s.
    const g = layer(p, group); g.t_end_us = 4 * S; (g.params as { src_out_us: number }).src_out_us = 4 * S
    const second = p.compositions.inner!.tracks[0]!.layers[1]!.id
    const after = produce(p, d => { (layer(d, second).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 } })
    const rs = ranges(p, after)
    // Inside, the change is where it is; outside, the Group never shows it.
    expect(rs.map(r => [r.composition_id, r.t_start_us / S, r.t_end_us / S])).toEqual([['inner', 4, 8]])
  })
})

describe('placeRanges', () => {
  it('moves a range found between earlier snapshots to where its content plays now', () => {
    const s = setup()
    const then = produce(s.p, d => { (layer(d, s.c).params as { opacity: unknown }).opacity = { mode: 'Static', value: 0.5 } })
    const found = ranges(s.p, then)
    // A later ripple pulls everything after A two seconds earlier.
    const now = produce(then, d => {
      remove(d, s.b); shift(d, s.c, -2 * S)
      closeBed(d, s, 2 * S, 4 * S)
    })
    expect(placeRanges(found, then, now).map(r => [r.t_start_us / S, r.t_end_us / S])).toEqual([[2, 4]])
  })
})
