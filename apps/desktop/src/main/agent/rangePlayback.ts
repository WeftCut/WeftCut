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
import type { Composition, Layer, LayerParams, Project, Transition } from '../state/model'
import { eachLayer } from '../state/model'
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

function contentIn(p: Project, c: Composition, tUs: number, endTUs: number | null, depth: number): Content {
  const played: Played[] = []
  const ids = new Set<string>()
  for (const track of c.tracks) for (const layer of track.layers) {
    const overlaps = endTUs === null ? layer.t_start_us <= tUs && tUs < layer.t_end_us : layer.t_start_us < endTUs && layer.t_end_us > tUs
    if (!overlaps) continue
    const start = Math.max(layer.t_start_us, tUs)
    const end = endTUs === null ? start : Math.min(layer.t_end_us, endTUs)
    const at = sourceInstantAt(layer, start)
    let nested: Content | null = null
    if (layer.params.kind === 'CompositionRef') {
      const inner = p.compositions[layer.params.composition]
      nested = !inner || depth >= MAX_NESTING ? { played: [], transitions: [] }
        : contentIn(p, inner, at.src_us, endTUs === null ? null : sourceInstantAt(layer, end).src_us, depth + 1)
    }
    played.push({ track_id: track.id, layer, from: start - tUs, to: end - tUs, offset: start - layer.t_start_us, at, nested })
    ids.add(layer.id)
  }
  return { played, transitions: c.transitions.filter((tr) => ids.has(tr.from_layer) || ids.has(tr.to_layer)) }
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

function samePlayed(a: Played, b: Played): boolean {
  return a.track_id === b.track_id && a.layer.id === b.layer.id && a.from === b.from && a.to === b.to
    && a.at.src_us === b.at.src_us && jsonEqual(a.at.src_fraction, b.at.src_fraction)
    && (a.layer === b.layer || jsonEqual(playedValues(a.layer, a.offset), playedValues(b.layer, b.offset)))
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
    index = new Map([...eachLayer(p)].map(({ layer, composition }) => [layer.id, { layer, composition }]))
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
export function replay(p: Project, pb: Playback): Replay | null {
  let composition: Composition | undefined = p.compositions[pb.composition_id]
  let t = pb.t_us
  let follows: TackFollows | null = null
  const layers = pb.content.played.length ? layerIndex(p) : null
  for (const x of pb.content.played) {
    const found = layers!.get(x.layer.id)
    if (!found || !shows(found.layer, x.at)) continue
    const now = sourceInstantTimelineUs(found.layer, x.at, found.composition.fps)
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
  const same = sameContent(pb.content, contentIn(p, composition, t, end, 0))
  return { composition_id: composition.id, t_us: t, end_t_us: end, same, follows }
}
