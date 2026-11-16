// apps/desktop/src/main/state/reviewRanges.ts
//
// Where a composition plays differently from the review baseline (ADR 0169):
// the changed ranges the review bands paint. Owns slicing a composition into
// what plays, the shift-free comparison of two stretches, the in-order
// alignment of both sides and the classification of what stays unmatched.
// Not the entity diff (`reviewDiff.ts`) and not attribution: a range lists the
// entity changes playing in it and borrows their list (ADR 0115).
import type { Change, ChangeClass, ChangedRange, EntityKey } from '../../shared/review'
import { entityKey } from '../../shared/review'
import { keyTimeUs } from '../../shared/keyframe'
import { localAtContent } from '../../renderer/layerTiming'
import { addTime, approximateTime, exactTime, ZERO_TIME } from '../../renderer/timeMapping'
import { playbackValues } from '../agent/playbackValues'
import type { Composition, Layer, Project, Transition } from './model'
import { sourceInstantAt } from './mutations/markers'
import { jsonEqual } from './reviewEntities'
import type { SourceInstant } from './summary'

/** Compositions nest without cycles (validate); this only keeps a malformed
 *  project from recursing without end. */
const MAX_NESTING = 32

// ── Slices ────────────────────────────────────────────────────────────────────

/** One layer playing over a slice: the snapshot's own object. */
interface Item { layer: Layer; role_gain_db: number }
/** A stretch over which the same items and transitions play, in track order. */
/** A transition playing over a slice, and where it opens. */
interface Played { tr: Transition; start: number }
interface Slice {
  start: number
  end: number
  items: readonly Item[]
  transitions: readonly Played[]
  /** What plays, without times or values: equal for any two slices that can
   *  play the same, so matching only compares slices that share one. */
  key: string
}
interface Timeline {
  slices: readonly Slice[]
  /** Where the last layer ends; nothing plays past it. */
  end: number
}

const EMPTY_TIMELINE: Timeline = { slices: [], end: 0 }

function itemKey(l: Layer): string {
  const p = l.params
  switch (p.kind) {
    case 'VideoClip': case 'Audio': case 'ImageOverlay': return `${p.kind}:${p.media}`
    case 'CompositionRef': return `${p.kind}:${p.composition}`
    case 'Motif': return `${p.kind}:${p.motif_id}`
    case 'Text': case 'Color': return p.kind
  }
}

/** Every keyframe time of an animated value under `value`, relative to its
 *  layer's start: where what a layer plays can change mid-slice. */
function keyTimes(value: unknown, out: number[]): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const v of value) keyTimes(v, out); return }
  const record = value as Record<string, unknown>
  if (record.mode === 'Keyframed' && Array.isArray(record.value)) {
    for (const k of record.value as { t_us: number }[]) out.push(Math.round(keyTimeUs(k as Parameters<typeof keyTimeUs>[0])))
    return
  }
  for (const [k, v] of Object.entries(record)) if (k !== 'props') keyTimes(v, out)
}

/** Where a layer's own playback can change: its ends, its fades' ends, its
 *  keyframes. Splitting slices there lets a fade added to a long clip change
 *  only the fade's stretch. */
function layerBoundaries(l: Layer, out: number[]): void {
  out.push(l.t_start_us, l.t_end_us)
  const p = l.params
  if ('fade_in_us' in p) {
    if (p.fade_in_us > 0) out.push(l.t_start_us + p.fade_in_us)
    if (p.fade_out_us > 0) out.push(l.t_end_us - p.fade_out_us)
  }
  const times: number[] = []
  keyTimes(p, times)
  keyTimes(l.effects, times)
  for (const t of times) out.push(l.t_start_us + t)
}

function transitionWindow(tr: Transition, layers: ReadonlyMap<string, Layer>): [number, number] | null {
  const incoming = layers.get(tr.to_layer), outgoing = layers.get(tr.from_layer)
  if (!incoming && !outgoing) return null
  const start = incoming?.t_start_us ?? (outgoing!.t_end_us - tr.duration_us)
  return [start, start + tr.duration_us]
}

/** A composition's slices, kept per composition object: a commit re-slices
 *  only the compositions it touched (immer keeps the rest), and a reader of
 *  both sides slices the baseline once. */
interface Kept { roles: Project['audio_roles']; inner: Map<string, Timeline>; timeline: Timeline }
const kept = new WeakMap<Composition, Kept>()

/** The Group compositions `c` shows, by id. */
function referenced(c: Composition): Set<string> {
  const ids = new Set<string>()
  for (const t of c.tracks) for (const l of t.layers) if (l.params.kind === 'CompositionRef') ids.add(l.params.composition)
  return ids
}

/** `c`'s slices in project `p`: kept while `c`, the role gains and every Group
 *  timeline it shows are the same objects. */
function timelineOf(p: Project, c: Composition, depth = 0): Timeline {
  const refs = referenced(c)
  const inner = new Map<string, Timeline>()
  if (depth < MAX_NESTING) for (const id of refs) {
    const ic = p.compositions[id]
    if (ic) inner.set(id, timelineOf(p, ic, depth + 1))
  }
  const k = kept.get(c)
  const hasAudio = c.tracks.some(t => t.layers.some(l => l.params.kind === 'Audio'))
  if (k && (!hasAudio || k.roles === p.audio_roles) && k.inner.size === inner.size
    && [...inner].every(([id, tl]) => k.inner.get(id) === tl)) return k.timeline
  const timeline = slice(p, c, inner)
  kept.set(c, { roles: p.audio_roles, inner, timeline })
  return timeline
}

function slice(p: Project, c: Composition, inner: ReadonlyMap<string, Timeline>): Timeline {
  const bounds: number[] = [0]
  const layers = new Map<string, Layer>()
  let end = 0
  for (const t of c.tracks) for (const l of t.layers) {
    layers.set(l.id, l)
    end = Math.max(end, l.t_end_us)
    layerBoundaries(l, bounds)
    if (l.params.kind !== 'CompositionRef') continue
    // What a Group shows changes where its composition's slices do: carry
    // those boundaries out through the Group's own timing.
    const tl = inner.get(l.params.composition)
    if (!tl) continue
    for (const s of tl.slices) {
      const t = l.t_start_us + Math.round(approximateTime(localAtContent(l.params, exactTime(s.start))))
      if (t > l.t_start_us && t < l.t_end_us) bounds.push(t)
    }
  }
  const windows = new Map<Transition, [number, number]>()
  for (const tr of c.transitions) {
    const w = transitionWindow(tr, layers)
    if (!w) continue
    windows.set(tr, w)
    bounds.push(w[0], w[1])
  }
  const sorted = [...new Set(bounds)].filter(t => t >= 0 && t <= end).sort((a, b) => a - b)
  // Each track's layers by start, walked once across the boundaries.
  const tracks = c.tracks.map(t => [...t.layers].sort((a, b) => a.t_start_us - b.t_start_us))
  const cursor = tracks.map(() => 0)
  const slices: Slice[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const s = sorted[i]!, e = sorted[i + 1]!
    const items: Item[] = []
    tracks.forEach((ls, ti) => {
      while (cursor[ti]! < ls.length && ls[cursor[ti]!]!.t_end_us <= s) cursor[ti]! += 1
      for (let j = cursor[ti]!; j < ls.length && ls[j]!.t_start_us <= s; j++) {
        const l = ls[j]!
        if (l.t_end_us <= s) continue
        const role_gain_db = l.params.kind === 'Audio' ? p.audio_roles[l.params.role]?.gain_db ?? 0 : 0
        items.push({ layer: l, role_gain_db })
      }
    })
    const transitions: Played[] = []
    for (const tr of c.transitions) { const w = windows.get(tr); if (w !== undefined && w[0] <= s && w[1] > s) transitions.push({ tr, start: w[0] }) }
    const key = items.length === 0 ? '' : `${items.map(x => itemKey(x.layer)).join('|')}#${transitions.length}`
    slices.push({ start: s, end: e, items, transitions, key })
  }
  return { slices, end }
}

/** The slice of `tl` playing at `t`, or null past its end or before zero. */
function sliceAt(tl: Timeline, t: number): Slice | null {
  const hit = tl.slices[firstEndingAfter(tl, t)]
  return hit && hit.start <= t ? hit : null
}

// ── Plays the same ────────────────────────────────────────────────────────────

const instants = new WeakMap<Layer, Map<number, SourceInstant>>()
function instantAt(layer: Layer, tUs: number): SourceInstant {
  let byT = instants.get(layer)
  if (!byT) instants.set(layer, byT = new Map())
  let at = byT.get(tUs)
  if (!at) byT.set(tUs, at = sourceInstantAt(layer, tUs))
  return at
}
/** The timeline instant at which `layer` shows content time `at` — outside its
 *  own span when it does not show it. */
function placeOf(layer: Layer, at: SourceInstant): number {
  const time = addTime(exactTime(at.src_us), at.src_fraction ?? ZERO_TIME)
  return layer.t_start_us + Math.round(approximateTime(localAtContent(layer.params, time)))
}
const sameInstant = (a: SourceInstant, b: SourceInstant) =>
  a === b || (a.src_us === b.src_us && jsonEqual(a.src_fraction, b.src_fraction))

const verdicts = new WeakMap<Layer, WeakMap<Layer, Map<string, boolean>>>()
function sameValues(a: Layer, aOffset: number, b: Layer, bOffset: number, duration: number): boolean {
  if (a === b && aOffset === bOffset) return true
  // A layer only moved keeps its params and effects objects (immer), and what
  // it plays at the same offset into it is the same.
  if (aOffset === bOffset && a.params === b.params && a.effects === b.effects && a.enabled === b.enabled
    && a.metadata === b.metadata && a.t_end_us - a.t_start_us === b.t_end_us - b.t_start_us) return true
  let byB = verdicts.get(a)
  if (!byB) verdicts.set(a, byB = new WeakMap())
  let byOffsets = byB.get(b)
  if (!byOffsets) byB.set(b, byOffsets = new Map())
  const key = `${aOffset}:${bOffset}:${duration}`
  let same = byOffsets.get(key)
  if (same === undefined) byOffsets.set(key, same = jsonEqual(playbackValues(a, aOffset, duration), playbackValues(b, bOffset, duration)))
  return same
}

/** One side of the comparison: a project and its compositions' timelines. */
interface Side { p: Project }

/** Whether `x` at `ta` and `y` at `tb` start on the same content of the same
 *  kind, under the same role gain — the cheap half of playing the same. */
function sameStart(x: Item, ta: number, y: Item, tb: number): boolean {
  return x.role_gain_db === y.role_gain_db && x.layer.params.kind === y.layer.params.kind
    && sameInstant(instantAt(x.layer, ta), instantAt(y.layer, tb))
}

/** Whether `x` at `ta` on side A plays what `y` plays at `tb` on side B, for
 *  `d` µs, once they start the same (`sameStart`). */
function sameRest(A: Side, x: Item, ta: number, B: Side, y: Item, tb: number, d: number, depth: number): boolean {
  if (!sameValues(x.layer, ta - x.layer.t_start_us, y.layer, tb - y.layer.t_start_us, d)) return false
  const px = x.layer.params, py = y.layer.params
  if (px.kind !== 'CompositionRef' || py.kind !== 'CompositionRef') return true
  if (depth >= MAX_NESTING) return true
  const ca = A.p.compositions[px.composition], cb = B.p.compositions[py.composition]
  if (!ca || !cb) return !ca && !cb
  // Equal values include the rate, so both sides show as much of their Group.
  const ia = instantAt(x.layer, ta), ib = instantAt(y.layer, tb)
  const innerEnd = instantAt(x.layer, ta + d).src_us
  return sameStretch(A, ca, ia.src_us, B, cb, ib.src_us, Math.max(0, innerEnd - ia.src_us), depth + 1)
}

function sameTransitions(a: Slice | null, ta: number, b: Slice | null, tb: number): boolean {
  const xs = a?.transitions ?? [], ys = b?.transitions ?? []
  return xs.length === ys.length && xs.every((x, i) => {
    const y = ys[i]!
    return x.tr.duration_us === y.tr.duration_us && jsonEqual(x.tr.kind, y.tr.kind) && ta - x.start === tb - y.start
  })
}

/** Whether two slices play the same from `ta` and `tb`, for `d` µs (both
 *  stretches inside their slice; null = nothing plays). */
function samePiece(A: Side, a: Slice | null, ta: number, B: Side, b: Slice | null, tb: number, d: number, depth: number): boolean {
  const xs = a?.items ?? [], ys = b?.items ?? []
  if (xs.length !== ys.length || !sameTransitions(a, ta, b, tb)) return false
  // Every item's start before any item's values: reused material that lines
  // up on one track fails on another without comparing values at all.
  for (let i = 0; i < xs.length; i++) if (!sameStart(xs[i]!, ta, ys[i]!, tb)) return false
  for (let i = 0; i < xs.length; i++) if (!sameRest(A, xs[i]!, ta, B, ys[i]!, tb, d, depth)) return false
  return true
}

/** Whether `ca` from `ta` on side A plays what `cb` plays from `tb` on side B,
 *  for `d` µs — across however many slices either side has there. */
function sameStretch(A: Side, ca: Composition, ta: number, B: Side, cb: Composition, tb: number, d: number, depth = 0): boolean {
  const tla = timelineOf(A.p, ca), tlb = timelineOf(B.p, cb)
  let pos = 0
  while (pos < d) {
    const sa = sliceAt(tla, ta + pos), sb = sliceAt(tlb, tb + pos)
    const nextA = sa ? sa.end - ta : nextStart(tla, ta + pos) - ta
    const nextB = sb ? sb.end - tb : nextStart(tlb, tb + pos) - tb
    const to = Math.min(nextA, nextB, d)
    if (!samePiece(A, sa, ta + pos, B, sb, tb + pos, to - pos, depth)) return false
    pos = to
  }
  return true
}

/** Where the next slice after `t` starts; nothing plays until then. */
function nextStart(tl: Timeline, t: number): number {
  const s = tl.slices
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid]!.start <= t) lo = mid + 1; else hi = mid }
  return s[lo]?.start ?? Infinity
}

// ── Matching ──────────────────────────────────────────────────────────────────

/** A stretch that plays the same on both sides, `delta` later now. */
interface Match {
  b0: number; b1: number
  c0: number; c1: number
  delta: number
  /** Every item on both sides is the same entity: a tie between equal content
   *  prefers the match that keeps identity. */
  sameEntity: boolean
}

/** The content time a slice's first item plays over it: two slices can only
 *  play the same where these overlap. */
function contentSpan(sl: Slice): [number, number] {
  const x = sl.items[0]!.layer
  return [instantAt(x, sl.start).src_us, instantAt(x, sl.end).src_us]
}

/** Baseline slices that play the same things, by where in their first item's
 *  content they sit, for finding the ones a current slice overlaps. */
interface Bucket { slices: Slice[]; spans: [number, number][]; longest: number }

/** Every pair of slices that could play the same, verified. A pair is only
 *  tried when both play the same things and their first items' content
 *  overlaps, so a long film of reused material stays near linear. */
const bucketsKept = new WeakMap<Timeline, Map<string, Bucket>>()
function bucketsOf(tla: Timeline): Map<string, Bucket> {
  const hit = bucketsKept.get(tla)
  if (hit) return hit
  const byKey = new Map<string, Bucket>()
  for (const sl of tla.slices) {
    if (sl.key === '') continue
    let at = byKey.get(sl.key)
    if (!at) byKey.set(sl.key, at = { slices: [], spans: [], longest: 0 })
    at.slices.push(sl)
  }
  for (const bucket of byKey.values()) {
    const order = bucket.slices.map((sl, i) => ({ sl, span: contentSpan(sl), i })).sort((x, y) => x.span[0] - y.span[0])
    bucket.slices = order.map(o => o.sl)
    bucket.spans = order.map(o => o.span)
    bucket.longest = order.reduce((m, o) => Math.max(m, o.span[1] - o.span[0]), 0)
  }
  bucketsKept.set(tla, byKey)
  return byKey
}

function candidates(A: Side, tla: Timeline, B: Side, tlb: Timeline): Match[] {
  const byKey = bucketsOf(tla)
  const out: Match[] = []
  let lastDelta = 0
  for (const cs of tlb.slices) {
    if (cs.key === '') continue
    // Most of a film plays where it did, or as far off as what came just
    // before it: a slice that plays the same whole at that displacement needs
    // no search. Only a whole-slice match short-cuts — a partial one may be
    // beaten by another.
    const quick = (delta: number): boolean => {
      const bs = sliceAt(tla, cs.start - delta)
      if (!bs || bs.key !== cs.key || bs.start + delta > cs.start || bs.end + delta < cs.end) return false
      if (!samePiece(A, bs, cs.start - delta, B, cs, cs.start, cs.end - cs.start, 0)) return false
      out.push({ b0: cs.start - delta, b1: cs.end - delta, c0: cs.start, c1: cs.end, delta, sameEntity: bs.items.every((it, k) => it.layer.id === cs.items[k]!.layer.id) })
      lastDelta = delta
      return true
    }
    if (quick(lastDelta) || (lastDelta !== 0 && quick(0))) continue
    const bucket = byKey.get(cs.key)
    if (!bucket) continue
    const [from, to] = contentSpan(cs)
    // The first baseline span that could still reach `from`.
    let lo = 0, hi = bucket.spans.length
    const floor = from - bucket.longest
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bucket.spans[mid]![0] < floor) lo = mid + 1; else hi = mid }
    for (let i = lo; i < bucket.spans.length && bucket.spans[i]![0] < Math.max(to, from + 1); i++) {
      const [s0, s1] = bucket.spans[i]!
      if (s1 <= from && !(s0 === s1 && s0 === from)) continue
      const bs = bucket.slices[i]!
      // The displacement that lines up the first item's content: where the
      // baseline shows what the current slice opens on.
      const x = bs.items[0]!.layer, y = cs.items[0]!.layer
      const delta = cs.start - placeOf(x, instantAt(y, cs.start))
      const c0 = Math.max(bs.start + delta, cs.start), c1 = Math.min(bs.end + delta, cs.end)
      if (c1 <= c0) continue
      if (!samePiece(A, bs, c0 - delta, B, cs, c0, c1 - c0, 0)) continue
      const sameEntity = bs.items.every((it, k) => it.layer.id === cs.items[k]!.layer.id)
      out.push({ b0: c0 - delta, b1: c1 - delta, c0, c1, delta, sameEntity })
      lastDelta = delta
    }
  }
  return out
}

/** A chain's worth, compared in order: matched time, then time matched to the
 *  same entity, then the least displacement. */
type Score = [number, number, number]
const better = (a: Score, b: Score) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
const ZERO_SCORE: Score = [0, 0, 0]

/** The best chain of matches in order on both sides, none overlapping another
 *  on either — the alignment. A Fenwick tree over the current ends answers
 *  "the best chain ending before here" for each match in baseline order. */
function chain(matches: Match[]): Match[] {
  if (matches.length === 0) return []
  const byStart = [...matches].sort((a, b) => a.b0 - b.b0 || a.c0 - b.c0)
  const byEnd = [...byStart.keys()].sort((i, j) => byStart[i]!.b1 - byStart[j]!.b1)
  const ends = [...new Set(byStart.map(m => m.c1))].sort((a, b) => a - b)
  const rank = (c: number) => { let lo = 0, hi = ends.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid]! <= c) lo = mid + 1; else hi = mid } return lo }
  const tree: { score: Score; at: number }[] = Array.from({ length: ends.length + 1 }, () => ({ score: ZERO_SCORE, at: -1 }))
  const put = (pos: number, score: Score, at: number) => { for (let i = pos; i < tree.length; i += i & -i) if (better(score, tree[i]!.score)) tree[i] = { score, at } }
  const best = (pos: number) => { let r = { score: ZERO_SCORE, at: -1 }; for (let i = pos; i > 0; i -= i & -i) if (better(tree[i]!.score, r.score)) r = tree[i]!; return r }
  const scores: Score[] = new Array(byStart.length)
  const prev: number[] = new Array(byStart.length).fill(-1)
  let added = 0
  for (let k = 0; k < byStart.length; k++) {
    const m = byStart[k]!
    // Every match ending (on the baseline side) before this one starts may
    // precede it; enter them, then ask for the best ending before its current
    // start.
    while (added < byEnd.length && byStart[byEnd[added]!]!.b1 <= m.b0) {
      const j = byEnd[added]!
      if (scores[j] !== undefined) put(rank(byStart[j]!.c1), scores[j]!, j)
      added += 1
    }
    const p = best(rank(m.c0))
    const len = m.b1 - m.b0
    scores[k] = [p.score[0] + len, p.score[1] + (m.sameEntity ? len : 0), p.score[2] - Math.abs(m.delta)]
    prev[k] = p.at
  }
  let top = 0
  for (let k = 1; k < scores.length; k++) if (better(scores[k]!, scores[top]!)) top = k
  const out: Match[] = []
  for (let k = top; k !== -1; k = prev[k]!) out.push(byStart[k]!)
  out.reverse()
  // Adjacent matches with one displacement are one stretch.
  const merged: Match[] = []
  for (const m of out) {
    const last = merged.at(-1)
    if (last && last.delta === m.delta && last.b1 === m.b0 && last.c1 === m.c0) merged[merged.length - 1] = { ...last, b1: m.b1, c1: m.c1, sameEntity: last.sameEntity && m.sameEntity }
    else merged.push(m)
  }
  return merged
}

// ── Ranges ────────────────────────────────────────────────────────────────────

/** Whether anything plays in `[t0, t1)` of `tl`. */
function plays(tl: Timeline, t0: number, t1: number): boolean {
  for (let i = firstEndingAfter(tl, t0); i < tl.slices.length && tl.slices[i]!.start < t1; i++) if (tl.slices[i]!.items.length > 0) return true
  return false
}

/** The stretches of `[t0, t1)` in which something plays, in order. */
function playing(tl: Timeline, t0: number, t1: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = firstEndingAfter(tl, t0); i < tl.slices.length && tl.slices[i]!.start < t1; i++) {
    const sl = tl.slices[i]!
    if (sl.items.length === 0) continue
    const a = Math.max(t0, sl.start), e = Math.min(t1, sl.end)
    const last = out.at(-1)
    if (last && last[1] === a) last[1] = e
    else out.push([a, e])
  }
  return out
}

/** The index of the first slice of `tl` ending after `t`. */
function firstEndingAfter(tl: Timeline, t: number): number {
  const s = tl.slices
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid]!.end <= t) lo = mid + 1; else hi = mid }
  return lo
}

/** The playback-relevant entities playing in `[t0, t1)` of `c` on side `S`:
 *  layers, transitions, the role gains they play under, and what a Group
 *  shows there — the entities whose changes can make the stretch differ. */
function entitiesIn(S: Side, c: Composition, t0: number, t1: number, out: Set<EntityKey>, depth = 0): void {
  const tl = timelineOf(S.p, c)
  for (let i = firstEndingAfter(tl, t0); i < tl.slices.length && tl.slices[i]!.start < t1; i++) {
    const s = tl.slices[i]!
    for (const x of s.transitions) out.add(entityKey('Transition', x.tr.id))
    for (const x of s.items) {
      out.add(entityKey('Layer', x.layer.id))
      const p = x.layer.params
      if (p.kind === 'Audio') out.add(entityKey('AudioRole', p.role))
      if (p.kind !== 'CompositionRef' || depth >= MAX_NESTING) continue
      const inner = S.p.compositions[p.composition]
      if (!inner) continue
      const a = Math.max(t0, s.start, x.layer.t_start_us), b = Math.min(t1, s.end, x.layer.t_end_us)
      if (b > a) entitiesIn(S, inner, instantAt(x.layer, a).src_us, instantAt(x.layer, b).src_us, out, depth + 1)
    }
  }
}

/** How far apart the current items at `t` moved from where the baseline
 *  played their content — when they moved by different amounts, the tracks
 *  play out of sync by the spread. Only layers with a source window count. */
function syncOffset(B: Side, cb: Composition, t: number, baseline: ReadonlyMap<string, Layer>): number | undefined {
  const s = sliceAt(timelineOf(B.p, cb), t)
  if (!s) return undefined
  const deltas = new Set<number>()
  for (const x of s.items) {
    const kind = x.layer.params.kind
    if (kind !== 'VideoClip' && kind !== 'Audio' && kind !== 'CompositionRef') continue
    const was = baseline.get(x.layer.id)
    if (!was) return undefined
    deltas.add(t - placeOf(was, instantAt(x.layer, t)))
  }
  if (deltas.size < 2) return undefined
  return Math.max(...deltas) - Math.min(...deltas)
}

/** Which list each changed entity is on, and whether it plays: a
 *  composition counts only for a track reorder. */
export interface ChangeLists { unreviewed: readonly Change[]; user: readonly Change[] }

interface Listed { source: 'review' | 'user'; cls: ChangeClass }
function listIndex(lists: ChangeLists): Map<EntityKey, Listed> {
  const out = new Map<EntityKey, Listed>()
  const add = (c: Change, source: 'review' | 'user') => {
    if (c.id.startsWith('Composition:') && !c.details.some(d => d.type === 'aspect' && d.aspect === 'placement')) return
    out.set(c.id, { source, cls: c.class })
  }
  for (const c of lists.unreviewed) add(c, 'review')
  for (const c of lists.user) add(c, 'user')
  return out
}

let unattributedWarned = false

/** The changed ranges of every composition of `current` against `baseline`,
 *  in composition then time order. */
export function diffRanges(baseline: Project, current: Project, lists: ChangeLists): ChangedRange[] {
  if (baseline === current) return []
  const A: Side = { p: baseline }, B: Side = { p: current }
  const index = listIndex(lists)
  const out: ChangedRange[] = []
  for (const cb of Object.values(current.compositions)) {
    const ca = baseline.compositions[cb.id]
    const tla = ca ? timelineOf(baseline, ca) : EMPTY_TIMELINE
    const tlb = timelineOf(current, cb)
    if (tla === tlb) continue
    const matches = ca ? chain(candidates(A, tla, B, tlb)) : []
    const layersBefore = new Map<string, Layer>(), layersNow = new Map<string, Layer>()
    if (ca) for (const t of ca.tracks) for (const l of t.layers) layersBefore.set(l.id, l)
    for (const t of cb.tracks) for (const l of t.layers) layersNow.set(l.id, l)
    let b = 0, c = 0
    const residual = (b1: number, c1: number) => {
      // Where nothing played, each stretch that plays now is its own
      // addition: silence between two new clips is no part of either.
      if (b1 - b > 0 && plays(tla, b, b1)) { emit(b, b1, c, c1); return }
      const islands = playing(tlb, c, c1)
      if (islands.length === 0) { emit(b, b1, c, c1); return }
      for (const [i0, i1] of islands) emit(b, b1, i0, i1)
    }
    // A residual as long on both sides moved nothing inside it: each piece
    // between slice edges is its own comparison, so a user's lift beside
    // the agent's change stays the user's, and pieces alike join again.
    const emit = (b: number, b1: number, c: number, c1: number) => {
      if (b1 - b <= 0 || b1 - b !== c1 - c) { const r = describe(b, b1, c, c1); if (r) out.push(r); return }
      const shift = c - b
      const cuts = new Set<number>([c, c1])
      for (const sl of tlb.slices) if (sl.start > c && sl.start < c1) cuts.add(sl.start)
      for (const sl of tla.slices) if (sl.start > b && sl.start < b1) cuts.add(sl.start + shift)
      const at = [...cuts].sort((x, y) => x - y)
      let held: ChangedRange | null = null
      for (let i = 0; i + 1 < at.length; i++) {
        const r = describe(at[i]! - shift, at[i + 1]! - shift, at[i]!, at[i + 1]!)
        if (r === null) { if (held) out.push(held); held = null; continue }
        if (held && held.class === r.class && held.source === r.source && held.gap === r.gap && held.t_end_us === r.t_start_us) {
          held = joined(held, r)
        } else {
          if (held) out.push(held)
          held = r
        }
      }
      if (held) out.push(held)
    }
    const describe = (b: number, b1: number, c: number, c1: number): ChangedRange | null => {
      const lenB = b1 - b, lenC = c1 - c
      if (lenB <= 0 && lenC <= 0) return null
      const keys = new Set<EntityKey>()
      if (ca && lenB > 0) entitiesIn(A, ca, b, b1, keys)
      if (lenC > 0) { entitiesIn(B, cb, c, c1, keys); keys.add(entityKey('Composition', cb.id)) }
      const review: EntityKey[] = [], user: EntityKey[] = []
      const classes = new Set<ChangeClass>()
      for (const k of keys) {
        const at = index.get(k)
        if (!at) continue
        ;(at.source === 'review' ? review : user).push(k)
        classes.add(at.cls)
      }
      const r = classify(tla, b, b1, tlb, c, c1, classes)
      if (r === null) return null
      if (review.length === 0 && user.length === 0 && !unattributedWarned) {
        // The signature and the entity diff disagree on what plays: a bug in
        // one of them, never a range the user may skip.
        unattributedWarned = true
        console.warn('[review] a changed range has no entity change', cb.id, b, b1, c, c1)
      }
      const range: ChangedRange = {
        composition_id: cb.id, class: r.cls, t_start_us: c, t_end_us: c1, before_start_us: b, before_end_us: b1,
        source: review.length > 0 || user.length === 0 ? 'review' : 'user', change_ids: [...review, ...user],
        ...(r.gap ? { gap: true as const } : {}),
      }
      if (review.length > 0 && user.length > 0) range.includes_user = true
      if (r.cls === 'modified' && ca) {
        const offset = syncOffset(B, cb, c, layersBefore)
        if (offset !== undefined && offset > 0) range.sync_offset_us = offset
      }
      if (range.sync_offset_us === undefined) {
        const only = onlyOf([...review, ...user], layersBefore, layersNow)
        if (only) range.only = only
      }
      return range
    }
    for (const m of matches) { residual(m.b0, m.c0); b = m.b1; c = m.c1 }
    residual(Math.max(b, tla.end), Math.max(c, tlb.end))
  }
  return out
}

/** Two adjacent ranges of one class and owner as one. */
function joined(a: ChangedRange, b: ChangedRange): ChangedRange {
  const ids = [...new Set([...a.change_ids, ...b.change_ids])]
  const out: ChangedRange = { ...a, t_end_us: b.t_end_us, before_end_us: b.before_end_us, change_ids: ids }
  if (a.includes_user || b.includes_user) out.includes_user = true
  if (a.only !== b.only) delete out.only
  const sync = Math.max(a.sync_offset_us ?? 0, b.sync_offset_us ?? 0)
  if (sync > 0) out.sync_offset_us = sync
  return out
}

/** A residual stretch, `[b0, b1)` on the baseline and `[c0, c1)` now, as a
 *  changed range — null when nothing about it changed (an equal gap).
 *  `classes`: the classes of the entity changes playing in it. A stretch
 *  only removals play in lost something and gained nothing, though a music
 *  bed under a lifted clip still plays there. */
function classify(tla: Timeline, b0: number, b1: number, tlb: Timeline, c0: number, c1: number, classes: ReadonlySet<ChangeClass>): { cls: ChangeClass; gap?: true } | null {
  const lenB = b1 - b0, lenC = c1 - c0
  const hasB = lenB > 0 && plays(tla, b0, b1), hasC = lenC > 0 && plays(tlb, c0, c1)
  if (!hasB && !hasC) {
    // Silence on both sides: only its length can differ.
    if (lenB === lenC) return null
    return lenC < lenB ? { cls: 'removed', gap: true } : { cls: 'added', gap: true }
  }
  if (!hasC) return { cls: 'removed' }
  if (!hasB) return { cls: 'added' }
  if (classes.size === 1 && !classes.has('modified')) return { cls: [...classes][0]! }
  return { cls: 'modified' }
}

/** Whether only audio or only picture plays differently: read from the kinds
 *  of the layers whose changes play there. */
function onlyOf(keys: readonly EntityKey[], before: ReadonlyMap<string, Layer>, now: ReadonlyMap<string, Layer>): 'audio' | 'picture' | undefined {
  let audio = false, picture = false
  for (const k of keys) {
    if (k.startsWith('AudioRole:')) { audio = true; continue }
    if (k.startsWith('Transition:') || k.startsWith('Composition:')) { picture = true; continue }
    if (!k.startsWith('Layer:')) continue
    const id = k.slice('Layer:'.length)
    const l = now.get(id) ?? before.get(id)
    if (!l) continue
    if (l.params.kind === 'Audio') audio = true
    else picture = true
  }
  return audio && !picture ? 'audio' : picture && !audio ? 'picture' : undefined
}

/** The ranges a reader of the unreviewed list alone reads: the ones to
 *  review, naming only unreviewed changes — so a user-only edit elsewhere
 *  reads as nothing new to that reader. */
export function rangesToReview(ranges: readonly ChangedRange[], unreviewed: readonly Change[]): ChangedRange[] {
  const ids = new Set(unreviewed.map(c => c.id))
  return ranges.filter(r => r.source === 'review').map(r => {
    if (r.includes_user === undefined) return r
    const { includes_user: _, ...rest } = r
    return { ...rest, change_ids: r.change_ids.filter(id => ids.has(id)) }
  })
}

// ── Mapping an earlier alignment onto now ─────────────────────────────────────

/** Ranges computed between two earlier snapshots (an activity's own), placed
 *  on the current timeline: each end goes where the content it bounds plays
 *  now, or to the edge of what replaced it. A range of a composition gone
 *  since is dropped. */
export function placeRanges(ranges: readonly ChangedRange[], then: Project, current: Project): ChangedRange[] {
  if (then === current || ranges.length === 0) return [...ranges]
  const A: Side = { p: then }, B: Side = { p: current }
  const maps = new Map<string, Match[] | null>()
  const mapOf = (id: string): Match[] | null => {
    if (!maps.has(id)) {
      const ca = then.compositions[id], cb = current.compositions[id]
      maps.set(id, ca && cb ? chain(candidates(A, timelineOf(then, ca), B, timelineOf(current, cb))) : null)
    }
    return maps.get(id)!
  }
  const place = (ms: readonly Match[], t: number, side: 'start' | 'end'): number => {
    let c = 0
    for (const m of ms) {
      if (t < m.b0) return side === 'start' ? c : m.c0
      if (t < m.b1 || (side === 'end' && t === m.b1)) return t + m.delta
      c = m.c1
    }
    return c
  }
  const out: ChangedRange[] = []
  for (const r of ranges) {
    const ms = mapOf(r.composition_id)
    if (ms === null) continue
    const s = place(ms, r.t_start_us, 'start')
    const e = r.t_end_us === r.t_start_us ? s : Math.max(s, place(ms, r.t_end_us, 'end'))
    out.push({ ...r, t_start_us: s, t_end_us: e })
  }
  return out
}
