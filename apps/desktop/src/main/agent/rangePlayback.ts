// apps/desktop/src/main/agent/rangePlayback.ts
// What plays in a time range of a composition, and where — if anywhere — the
// same thing plays now (ADR 0117). The tack store records one `Playback` per
// tack and `replay`s it on every read; this module owns what "plays the same"
// means.
//
// A range plays the same when every track, in the same order, holds the same
// layers over the same offsets from the range's start, each starting on the
// same content time, with the same values where they affect what plays — and
// the same transitions between them, and, through a Group layer, the same
// playback over the stretch of its composition it shows. Normalized away, so
// that an edit outside the range is no change inside it: where a layer sits
// and which stretch of its source it shows (the offsets and content time
// already say that for the part in range), keyframe times (stored from the
// layer's start, so a head trim shifts them; compared from the range's
// start), and a layer's label and lock, which play nothing. Markers are notes,
// and track toggles preference-shaped (review excludes them too).
//
// Cost: every tack is replayed on every commit, so what a replay reads is
// indexed, and what it derives is kept, per model object — a track's layers
// by time, a composition's transitions by layer, the project's layers by id,
// and a layer's content times (exact arithmetic, the dearest part) — each
// built once, on first read. Immer keeps an unedited object's identity across
// commits, so a commit re-derives only what it touched, however many tacks
// read it, and a replay costs a binary search per track.
import type { Composition, Layer, LayerParams, Project, Rational, Track, Transition } from '../state/model'
import { shiftKeyframes } from '../state/mutations/animated'
import { hasSourceWindow, shiftLayerKeyframes } from '../state/mutations/helpers'
import { sourceInstantAt } from '../state/mutations/markers'
import { jsonEqual, transitionEqual } from '../state/reviewEntities'
import { sourceInstantTimelineUs, type SourceInstant } from '../state/summary'
import { sourceIn, sourceOut } from '../../renderer/layerTiming'
import { addTime, compareTime, exactTime, ZERO_TIME } from '../../renderer/timeMapping'
import type { TackFollows } from '../../shared/agent-activity'

/** One layer as it plays inside a range: the part of it the range covers, as
 *  offsets from the range's start, and the content time that part starts on.
 *  `layer` is the snapshot's own object, held by reference — immer never
 *  mutates it. */
interface Played {
  track_id: string
  layer: Layer
  from: number
  to: number
  /** How far into the layer the part starts, on its own timeline clock. */
  offset: number
  at: SourceInstant
  /** What plays over that part in a Group's composition; null for other kinds. */
  nested: Content | null
}
interface Content { played: Played[]; transitions: Transition[] }

/** What played in a range when it was recorded. Opaque: only `replay` reads it. */
export interface Playback {
  readonly composition_id: string
  readonly t_us: number
  readonly end_t_us: number | null
  readonly content: Content
}

/** Where a recorded range sits now and whether it plays what it did. The range
 *  keeps its length; `follows` is the layer that placed it, null when none
 *  still shows what it covered and the range stayed where it was recorded. */
export interface Replay {
  composition_id: string
  t_us: number
  end_t_us: number | null
  same: boolean
  follows: TackFollows | null
}

/** Compositions nest without cycles (validate); this only keeps a malformed
 *  project from recursing without end. */
const MAX_NESTING = 32

/** The content time `layer` shows at timeline instant `tUs`, kept per layer
 *  object: the same object at the same instant is the same answer, and the
 *  same object — so `samePlayed` can tell an unedited part by identity. */
const instants = new WeakMap<Layer, Map<number, SourceInstant>>()
function instantAt(layer: Layer, tUs: number): SourceInstant {
  let byT = instants.get(layer)
  if (!byT) instants.set(layer, byT = new Map())
  let at = byT.get(tUs)
  if (!at) byT.set(tUs, at = sourceInstantAt(layer, tUs))
  return at
}

/** Where `layer` shows the recorded content time `at` now, on a `fps` grid —
 *  null when it no longer shows it — kept per layer object and recorded
 *  instant. */
const places = new WeakMap<Layer, WeakMap<SourceInstant, { fps: Rational; t_us: number | null }>>()
function placeOf(layer: Layer, at: SourceInstant, fps: Rational): number | null {
  let byAt = places.get(layer)
  if (!byAt) places.set(layer, byAt = new WeakMap())
  const kept = byAt.get(at)
  if (kept && kept.fps.num === fps.num && kept.fps.den === fps.den) return kept.t_us
  const t_us = shows(layer, at) ? sourceInstantTimelineUs(layer, at, fps) : null
  byAt.set(at, { fps, t_us })
  return t_us
}

/** A track's layers by start, with the running maximum of their ends. */
interface TrackIndex { layers: Layer[]; maxEnd: number[] }
const trackIndexes = new WeakMap<Track, TrackIndex>()
function trackIndex(track: Track): TrackIndex {
  let index = trackIndexes.get(track)
  if (!index) {
    const layers = [...track.layers].sort((a, b) => a.t_start_us - b.t_start_us)
    const maxEnd: number[] = []
    for (const l of layers) maxEnd.push(Math.max(maxEnd.at(-1) ?? -Infinity, l.t_end_us))
    trackIndexes.set(track, index = { layers, maxEnd })
  }
  return index
}

/** The layers of `track` overlapping `[tUs, endTUs)` — or showing at `tUs`
 *  for a point — by start. Every layer before the first whose running end
 *  passes `tUs` ends at or before it. */
function overlapping(track: Track, tUs: number, endTUs: number | null): Layer[] {
  const { layers, maxEnd } = trackIndex(track)
  let lo = 0, hi = layers.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (maxEnd[mid]! > tUs) hi = mid; else lo = mid + 1 }
  const out: Layer[] = []
  for (let i = lo; i < layers.length; i++) {
    const l = layers[i]!
    if (endTUs === null ? l.t_start_us > tUs : l.t_start_us >= endTUs) break
    if (l.t_end_us > tUs) out.push(l)
  }
  return out
}

/** A composition's transitions by the layers they join, as indexes into its
 *  list — so the ones a range plays keep the list's order. */
const transitionIndexes = new WeakMap<readonly Transition[], Map<string, number[]>>()
function transitionsOf(c: Composition, layerIds: ReadonlySet<string>): Transition[] {
  if (c.transitions.length === 0 || layerIds.size === 0) return []
  let index = transitionIndexes.get(c.transitions)
  if (!index) {
    index = new Map()
    c.transitions.forEach((tr, i) => {
      for (const id of [tr.from_layer, tr.to_layer]) { const at = index!.get(id); if (at) at.push(i); else index!.set(id, [i]) }
    })
    transitionIndexes.set(c.transitions, index)
  }
  const at = new Set<number>()
  for (const id of layerIds) for (const i of index.get(id) ?? []) at.add(i)
  return [...at].sort((a, b) => a - b).map((i) => c.transitions[i]!)
}

function contentIn(p: Project, c: Composition, tUs: number, endTUs: number | null, depth: number): Content {
  const played: Played[] = []
  const ids = new Set<string>()
  for (const track of c.tracks) for (const layer of overlapping(track, tUs, endTUs)) {
    const start = Math.max(layer.t_start_us, tUs)
    const end = endTUs === null ? start : Math.min(layer.t_end_us, endTUs)
    const at = instantAt(layer, start)
    let nested: Content | null = null
    if (layer.params.kind === 'CompositionRef') {
      const inner = p.compositions[layer.params.composition]
      nested = !inner || depth >= MAX_NESTING ? { played: [], transitions: [] }
        : contentIn(p, inner, at.src_us, endTUs === null ? null : instantAt(layer, end).src_us, depth + 1)
    }
    played.push({ track_id: track.id, layer, from: start - tUs, to: end - tUs, offset: start - layer.t_start_us, at, nested })
    ids.add(layer.id)
  }
  return { played, transitions: transitionsOf(c, ids) }
}

/** Record what plays in `[tUs, endTUs)` of composition `compositionId` — or
 *  at the instant `tUs` for a point. The composition must exist. */
export function recordPlayback(p: Project, compositionId: string, tUs: number, endTUs: number | null): Playback {
  const c = p.compositions[compositionId]
  if (!c) throw new Error(`recordPlayback: composition ${compositionId} not found`)
  return { composition_id: compositionId, t_us: tUs, end_t_us: endTUs, content: contentIn(p, c, tUs, endTUs, 0) }
}

/** The layer's values that affect what plays, keyframes timed from the part's
 *  start, `offset` into the layer. Built only when two snapshots hold
 *  different objects for one layer. */
function playedValues(l: Layer, offset: number): unknown {
  const params = structuredClone(l.params) as LayerParams & Record<string, unknown>
  shiftLayerKeyframes(params, -offset)
  for (const k of ['src_in_us', 'src_out_us', 'content_window', 'source_phase']) delete params[k]
  const effects = structuredClone(l.effects)
  for (const effect of effects) for (const track of Object.values(effect.params)) shiftKeyframes(track, -offset)
  return { kind: l.params.kind, enabled: l.enabled, metadata: l.metadata, params, effects }
}

/** Whether two objects of one layer play the same values, `aOffset` and
 *  `bOffset` into each — kept per pair of objects: a recorded layer edited in
 *  a way that plays nothing (a rename) is compared once, not on every commit. */
const verdicts = new WeakMap<Layer, WeakMap<Layer, Map<string, boolean>>>()
function sameValues(a: Layer, aOffset: number, b: Layer, bOffset: number): boolean {
  if (a === b) return true
  let byB = verdicts.get(a)
  if (!byB) verdicts.set(a, byB = new WeakMap())
  let byOffsets = byB.get(b)
  if (!byOffsets) byB.set(b, byOffsets = new Map())
  const key = `${aOffset}:${bOffset}`
  let same = byOffsets.get(key)
  if (same === undefined) byOffsets.set(key, same = jsonEqual(playedValues(a, aOffset), playedValues(b, bOffset)))
  return same
}

function samePlayed(a: Played, b: Played): boolean {
  return a.track_id === b.track_id && a.layer.id === b.layer.id && a.from === b.from && a.to === b.to
    && (a.at === b.at || (a.at.src_us === b.at.src_us && jsonEqual(a.at.src_fraction, b.at.src_fraction)))
    && sameValues(a.layer, a.offset, b.layer, b.offset)
    && (a.nested === null ? b.nested === null : b.nested !== null && sameContent(a.nested, b.nested))
}

function sameContent(a: Content, b: Content): boolean {
  return a.played.length === b.played.length && a.played.every((x, i) => samePlayed(x, b.played[i]!))
    && a.transitions.length === b.transitions.length && a.transitions.every((x, i) => transitionEqual(x, b.transitions[i]!))
}

/** Whether `layer` still shows content time `at` — inside its half-open
 *  `[in, out)` window — the hibernation rule anchored markers follow, for
 *  every kind of layer. */
function shows(layer: Layer, at: SourceInstant): boolean {
  const time = addTime(exactTime(at.src_us), at.src_fraction ?? ZERO_TIME)
  return compareTime(time, sourceIn(layer.params)) >= 0 && compareTime(time, sourceOut(layer)) < 0
}

const layerIndexes = new WeakMap<Project, Map<string, { layer: Layer; composition: Composition }>>()
function layerIndex(p: Project): Map<string, { layer: Layer; composition: Composition }> {
  let index = layerIndexes.get(p)
  if (!index) {
    index = new Map()
    for (const composition of Object.values(p.compositions))
      for (const track of composition.tracks) for (const layer of track.layers) index.set(layer.id, { layer, composition })
    layerIndexes.set(p, index)
  }
  return index
}

/** Where `pb` plays in `p` now. The first layer it covered, in track order,
 *  that still shows the content its part started on moves the range by as
 *  far as that content moved — into another composition too, as a clip moved
 *  into a Group takes its anchored markers. Which one is immaterial to
 *  `same`: content that moved together moved every covered layer alike. With
 *  none, the range stays where it was recorded; null once that composition
 *  is gone. A range moved before zero is held at zero, and plays differently
 *  there. */
/** What a playback last played against, per track — and whether that was
 *  the same — so a replay over tracks that still hold the very same layer
 *  objects in its range answers without building or comparing anything. Not
 *  kept over a Group layer: what it plays is read through another
 *  composition. */
interface LastReplay {
  composition_id: string; t: number; end: number | null
  tracks: readonly Track[]; layers: Layer[][]; transitions: readonly Transition[]; same: boolean
}
const lastReplays = new WeakMap<Playback, LastReplay>()

function sameAsLast(last: LastReplay | undefined, c: Composition, t: number, end: number | null): boolean {
  if (!last || last.composition_id !== c.id || last.t !== t || last.end !== end
    || last.transitions !== c.transitions || last.tracks.length !== c.tracks.length) return false
  if (last.tracks === c.tracks) return true
  for (let i = 0; i < c.tracks.length; i++) {
    const track = c.tracks[i]!, was = last.tracks[i]!
    if (track === was) continue
    if (track.id !== was.id) return false
    const now = overlapping(track, t, end), before = last.layers[i]!
    if (now.length !== before.length || now.some((l, j) => l !== before[j])) return false
  }
  return true
}

export function replay(p: Project, pb: Playback): Replay | null {
  let composition: Composition | undefined = p.compositions[pb.composition_id]
  let t = pb.t_us
  let follows: TackFollows | null = null
  const layers = pb.content.played.length ? layerIndex(p) : null
  for (const x of pb.content.played) {
    const found = layers!.get(x.layer.id)
    const now = found ? placeOf(found.layer, x.at, found.composition.fps) : null
    if (now === null || !found) continue
    composition = found.composition
    t = Math.max(0, now - x.from)
    follows = {
      layer_id: x.layer.id, t_us: now,
      ...(hasSourceWindow(found.layer.params) ? { src_us: x.at.src_us, ...(x.at.src_fraction ? { src_fraction: x.at.src_fraction } : {}) } : {}),
    }
    break
  }
  if (!composition) return null
  const end = pb.end_t_us === null ? null : t + pb.end_t_us - pb.t_us
  const last = lastReplays.get(pb)
  let same: boolean
  if (sameAsLast(last, composition, t, end)) same = last!.same
  else {
    const content = contentIn(p, composition, t, end, 0)
    same = sameContent(pb.content, content)
    const layers = composition.tracks.map((track) => content.played.filter((x) => x.track_id === track.id).map((x) => x.layer))
    if (content.played.some((x) => x.nested !== null)) lastReplays.delete(pb)
    else lastReplays.set(pb, { composition_id: composition.id, t, end, tracks: composition.tracks, layers, transitions: composition.transitions, same })
  }
  return { composition_id: composition.id, t_us: t, end_t_us: end, same, follows }
}
