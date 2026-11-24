// Closing a cut in a linked talking-head edit, at every rate in the preset
// list. Every edge of a linked V+A pair, its audio's included, is a frame of
// the composition grid (ADR 0038), so the pair shares its edges exactly, and
// at 29.97/59.94 those frames are not sample times. Any edit that read the
// audio on another lattice would land the two members apart there.
//
// The three routes an editor takes to "delete up to the playhead and close the
// gap": the timeline's ripple delete of the piece before the cut, the agent's
// split → lift → `shift_layers` by the video hole, and the same from the end
// of the clip. Each must be accepted, leave every lane flush on frames, and
// keep every linked pair's relation: its edges in whole frames and where its
// source time 0 lands.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { frameGrid, gridIndex, isCanonicalOnGrid, timeUsAtGridIndex } from '../snap'
import { root } from './fixtures/project'

const RATES: ReadonlyArray<[number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1],
]
const MEDIA = 'ripple-fractional-av'
const CLIP_FRAMES = 30
const CLIPS = 4
const CUT_CLIP = 2

type Actor = ReturnType<typeof createActor>
interface Pair { v: string; au: string }

function idOf(r: { ok: boolean; value?: unknown; error?: unknown }): string {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}

function mcp(a: Actor, tool: string, args: Record<string, unknown>) {
  const r = a.mcpCall(tool, JSON.stringify(args))
  if (!r.ok) throw new Error(`${tool}: ${r.error.message}`)
  return r
}

/** Back-to-back linked V+A clips on one lane, both members on the same frames
 *  and reading the same source, as an import's pair lands. */
function talkingHead(num: number, den: number): { a: Actor; pairs: Pair[]; frame: (i: number) => number } {
  const gen = seededGen()
  const p = blankProject(gen, 'ripple-fractional')
  root(p).fps = { num, den }
  const a = createActor({ initial: p, idGen: gen, clock: () => '<TS>' })
  a.dispatch('add_media', { id: MEDIA, kind: 'Video', duration_us: 600_000_000, with_audio: true })
  const lane = root(a.snapshot()).tracks[0].id
  const g = frameGrid({ num, den })
  const frame = (i: number) => timeUsAtGridIndex(i, g)
  const pairs: Pair[] = []
  for (let k = 0; k < CLIPS; k++) {
    const s = frame(k * CLIP_FRAMES)
    const e = frame((k + 1) * CLIP_FRAMES)
    const v = idOf(a.dispatch('add_layer', { track: lane, kind: 'video', media: MEDIA, src_in_us: 0, src_out_us: e - s, t_start_us: s, t_end_us: e }))
    const au = idOf(a.dispatch('add_layer', { track: lane, kind: 'audio', media: MEDIA, src_in_us: 0, src_out_us: e - s, t_start_us: s, t_end_us: e }))
    idOf(a.dispatch('links_create', { layers: [v, au] }))
    pairs.push({ v, au })
  }
  return { a, pairs, frame }
}

const layersOf = (p: Project) => root(p).tracks.flatMap((t) => t.layers)
const at = (p: Project, id: string) => layersOf(p).find((l) => l.id === id)!

/** The pieces a split left on the right of `t`, video and audio. */
function rightOf(p: Project, t: number, pair: Pair): Pair {
  const pieces = layersOf(p).filter((l) => l.id !== pair.v && l.id !== pair.au && l.t_start_us === t)
  return { v: pieces.find((l) => l.params.kind !== 'Audio')!.id, au: pieces.find((l) => l.params.kind === 'Audio')!.id }
}

/** Each overlap class's layers on the lane, in time order, touch end to start,
 *  with every edge a frame. */
function expectFlush(p: Project): void {
  const g = frameGrid(root(p).fps)
  for (const audio of [false, true]) {
    const lane = layersOf(p).filter((l) => (l.params.kind === 'Audio') === audio).sort((x, y) => x.t_start_us - y.t_start_us)
    expect(lane[0].t_start_us).toBe(0)
    for (let i = 1; i < lane.length; i++) expect(lane[i].t_start_us, `${audio ? 'audio' : 'video'} #${i}`).toBe(lane[i - 1].t_end_us)
    for (const l of lane) expect(isCanonicalOnGrid(l.t_start_us, g) && isCanonicalOnGrid(l.t_end_us, g), l.id).toBe(true)
  }
}

/** Where a layer's source time 0 lands on the timeline. */
const sourceZero = (p: Project, id: string) => {
  const l = at(p, id)
  if (l.params.kind !== 'Audio' && l.params.kind !== 'VideoClip') throw new Error(`${id} has no source`)
  return l.t_start_us - l.params.src_in_us
}

/** A pair's relation: its audio's edges against its video's in whole frames,
 *  and the difference of where each member's source time 0 lands (the sync
 *  offset ADR 0038 derives, in µs). */
const relation = (p: Project, pair: Pair) => {
  const g = frameGrid(root(p).fps)
  const v = at(p, pair.v)
  const au = at(p, pair.au)
  return {
    start: gridIndex(au.t_start_us, g) - gridIndex(v.t_start_us, g),
    end: gridIndex(au.t_end_us, g) - gridIndex(v.t_end_us, g),
    sync: sourceZero(p, pair.au) - sourceZero(p, pair.v),
  }
}

function expectRelationsKept(before: Project, after: Project, pairs: readonly Pair[]): void {
  for (const pair of pairs) expect(relation(after, pair), `pair ${pair.v}`).toEqual(relation(before, pair))
}

for (const [num, den] of RATES) {
  describe(`at ${num}/${den}`, () => {
    for (let cutFrame = 1; cutFrame < CLIP_FRAMES; cutFrame++) {
      it(`closes the start of a clip cut at frame ${cutFrame}, by ripple delete and by shift_layers`, () => {
        for (const route of ['ripple', 'shift'] as const) {
          const { a, pairs, frame } = talkingHead(num, den)
          const clip = pairs[CUT_CLIP]
          const clipStart = frame(CUT_CLIP * CLIP_FRAMES)
          const playhead = frame(CUT_CLIP * CLIP_FRAMES + cutFrame)
          mcp(a, 'split_layer', { layer_id: clip.v, t_cut_us: [playhead] })
          const kept = [...pairs.filter((x) => x !== clip), rightOf(a.snapshot(), playhead, clip)]
          const before = a.snapshot()
          if (route === 'ripple') {
            mcp(a, 'delete_layers', { layer_ids: [clip.v, clip.au], ripple: true })
          } else {
            mcp(a, 'delete_layers', { layer_ids: [clip.v, clip.au] })
            mcp(a, 'shift_layers', { t_from_us: playhead, delta_us: -(playhead - clipStart) })
          }
          const after = a.snapshot()
          expectFlush(after)
          expectRelationsKept(before, after, kept)
          expect(at(after, kept[kept.length - 1].v).t_start_us, route).toBe(clipStart)
        }
      })

      it(`closes the end of a clip cut at frame ${cutFrame} with shift_layers`, () => {
        const { a, pairs, frame } = talkingHead(num, den)
        const clip = pairs[CUT_CLIP]
        const clipEnd = frame((CUT_CLIP + 1) * CLIP_FRAMES)
        const playhead = frame(CUT_CLIP * CLIP_FRAMES + cutFrame)
        mcp(a, 'split_layer', { layer_id: clip.v, t_cut_us: [playhead] })
        const tail = rightOf(a.snapshot(), playhead, clip)
        const kept = pairs.filter((x) => x !== clip).concat([clip])
        const before = a.snapshot()
        mcp(a, 'delete_layers', { layer_ids: [tail.v, tail.au] })
        mcp(a, 'shift_layers', { t_from_us: clipEnd, delta_us: -(clipEnd - playhead) })
        const after = a.snapshot()
        expectFlush(after)
        expectRelationsKept(before, after, kept)
        expect(at(after, pairs[CUT_CLIP + 1].v).t_start_us).toBe(playhead)
      })
    }
  })
}
