// apps/desktop/src/main/agent/tacks.ts
// Tacks: the time ranges an agent points the user at for review (ADR 0115).
//
// Runtime state of ONE project opening, owned beside agent activity and reset
// with it. Not in `Project`, not recorded, not serialized, never touched by
// undo, redo, checkpoint restore or the history lock — so nothing here goes
// through the actor's commit path. The store holds what the agent said (a free
// time on a composition's clock, a layer's SOURCE time, or each end's clip and
// source time) and derives where that sits on a timeline every time it is
// read, with the same source↔timeline mapping and hibernation rule anchored
// markers use (`summary.ts`, `mutations/markers.ts`).
//
// Following content is modelled on fuzzy anchoring (Hypothesis: the content
// anchor first, the position as fallback, an orphan when lost) and on clip
// markers (OTIO): without `anchor_layer_id` each end of a tack ties itself to
// the clip under it, and an end that loses its clip keeps its place relative
// to the start. A tack also remembers the clips it covered; once one of them
// changes in more than a move in time, the tack reads `outdated` (as a review
// comment on changed lines does on GitHub or Gerrit).
import { randomUUID } from 'node:crypto'
import type { Composition, Layer, Project, Track } from '../state/model'
import { eachLayer } from '../state/model'
import { CommandFailure } from '../state/errors'
import { hasSourceWindow } from '../state/mutations/helpers'
import { snapMarkerTimes, sourceInstantAt } from '../state/mutations/markers'
import { layerUnchangedOrShifted } from '../state/reviewDiff'
import { sourceEndInstantLost, sourceInstantHibernating, sourceInstantTimelineUs, sourceRegionShownEndUs } from '../state/summary'
import {
  TACK_CAPACITY, type AffectedTack, type Tack, type TackEdgeAnchor, type TackFollows, type TackKind, type TackRange, type TackStatus,
  type TackToReview, type TackView,
} from '../../shared/agent-activity'

/** Who created a tack: the MCP call running when `create` was entered. */
export interface TackAttribution { session_id: string | null; connection_id: string; client: string; activity_id: string }

/** One tack as `create_tacks` receives it, already type-checked by its parser.
 *  `t_us` / `end_t_us` are timeline times; with `anchor_layer_id` they are
 *  converted to that clip's source time here, as `add_marker` converts. */
export interface TackInput {
  label: string
  body: string
  kind: TackKind
  t_us: number
  end_t_us: number | null
  anchor_layer_id: string | null
  composition_id: string | null
}
export interface TackPatch { label?: string; body?: string; kind?: TackKind; status?: TackStatus }

export type TackErrorName = 'TackLimit' | 'TackNotFound' | 'NoCurrentCall' | 'InvalidArgument'
  | 'CompositionNotFound' | 'LayerNotFound' | 'WrongLayerKind' | 'CrossCompositionSet'

/** A refusal. Every one is raised before the store changes, so a refused call
 *  leaves every tack as it was. */
export class TackError extends Error {
  constructor(readonly error: TackErrorName, message: string, readonly field?: string) {
    super(message)
    this.name = 'TackError'
  }
}

export interface TackStoreDeps {
  /** The project the derived placement is read against. */
  project: () => Project
  /** The current MCP call, or null outside one — or inside one that began in
   *  an earlier project opening, whose late result must not land here. */
  caller: () => TackAttribution | null
  /** Records or placements changed (`dirty`) or went away (`removed`). */
  changed: (dirty: readonly string[], removed: readonly string[]) => void
  capacity?: number
  now?: () => string
  newId?: () => string
}

type Place = Pick<TackView, 'composition_id' | 't_us' | 'end_t_us' | 'state'>
type Placement = Place & Pick<TackView, 'outdated'>
const STALE: Place = { composition_id: null, t_us: null, end_t_us: null, state: 'stale' }

/** A layer a tack covered at creation, as it was then: the snapshot's own
 *  object (immer never mutates it), held by reference — never copied. `start`
 *  marks the start's anchor, whose loss is the tack's `stale` state rather
 *  than an outdating. */
interface Covered { layer: Layer; start: boolean }

/** Where a tack sits in `p` right now. `layers` resolves an anchor's layer
 *  anywhere in the project — a clip moved into a Group takes its tacks along,
 *  as it takes its anchored markers. */
function place(p: Project, range: TackRange, layers: LayerIndex): Place {
  if (range.kind === 'free') {
    if (!(range.composition_id in p.compositions)) return STALE
    return { composition_id: range.composition_id, t_us: range.t_us, end_t_us: range.end_t_us, state: 'visible' }
  }
  if (range.kind === 'edges') return placeEdges(p, range, layers)
  const found = layers().get(range.layer_id)
  if (!found) return STALE
  const { layer, composition } = found
  const start = { src_us: range.src_us, src_fraction: range.src_fraction }
  if (sourceInstantHibernating(start, layer)) return { composition_id: composition.id, t_us: null, end_t_us: null, state: 'hibernating' }
  const t = sourceInstantTimelineUs(layer, start, composition.fps)
  let end: number | null = null
  if (range.src_end_us !== null) {
    const e = sourceInstantTimelineUs(layer, { src_us: range.src_end_us, src_fraction: range.src_end_fraction }, composition.fps)
    // Drawn only as far as the clip still runs, as `markerShownEnd` draws an
    // anchored region: past the out point is no longer the material it names.
    // A region a later retime squeezed under one frame reads as a point.
    const shown = sourceRegionShownEndUs(layer, t, e)
    end = shown > t ? shown : null
  }
  return { composition_id: composition.id, t_us: t, end_t_us: end, state: 'visible' }
}

/** An `edges` range. The start decides where the tack is: on its clip (stale
 *  when the clip exists nowhere, hibernating when its frame was trimmed away),
 *  or, unanchored, at its created time. The end follows its own clip when that
 *  still shows the frame in the same composition after the start; otherwise
 *  — lost, trimmed away, moved elsewhere, crossed over — it keeps the created
 *  length from the start, i.e. moves by the start's delta. That is always
 *  after the start, since the created range spans at least a frame. */
function placeEdges(p: Project, range: Extract<TackRange, { kind: 'edges' }>, layers: LayerIndex): Place {
  let compositionId: string
  let t: number
  if (range.start !== null) {
    const found = layers().get(range.start.layer_id)
    if (!found) return STALE
    const { layer, composition } = found
    if (sourceInstantHibernating(range.start, layer)) return { composition_id: composition.id, t_us: null, end_t_us: null, state: 'hibernating' }
    compositionId = composition.id
    t = sourceInstantTimelineUs(layer, range.start, composition.fps)
  } else {
    if (!(range.composition_id in p.compositions)) return STALE
    compositionId = range.composition_id
    t = range.t_us
  }
  if (range.end_t_us === null) return { composition_id: compositionId, t_us: t, end_t_us: null, state: 'visible' }
  if (range.end !== null) {
    const found = layers().get(range.end.layer_id)
    if (found && found.composition.id === compositionId && !sourceEndInstantLost(range.end, found.layer)) {
      const e = sourceInstantTimelineUs(found.layer, range.end, found.composition.fps)
      if (e > t) return { composition_id: compositionId, t_us: t, end_t_us: e, state: 'visible' }
    }
  }
  return { composition_id: compositionId, t_us: t, end_t_us: range.end_t_us + (t - range.t_us), state: 'visible' }
}

/** Whether a covered layer has changed in more than a move in time since the
 *  tack was created — by the agent or the user alike. A covered layer gone is
 *  outdating too, except the start's anchor: that loss is `stale`. */
function outdated(covered: readonly Covered[] | undefined, layers: LayerIndex): boolean {
  if (!covered) return false
  for (const c of covered) {
    const now = layers().get(c.layer.id)
    if (!now) { if (!c.start) return true; continue }
    if (!layerUnchangedOrShifted(c.layer, now.layer)) return true
  }
  return false
}

type LayerIndex = () => Map<string, { layer: Layer; composition: Composition }>
/** Every layer of `p` by id, built on first use: a refresh that holds only
 *  free tacks never needs it. */
function lazyLayerIndex(p: Project): LayerIndex {
  let index: Map<string, { layer: Layer; composition: Composition }> | null = null
  return () => index ??= new Map([...eachLayer(p)].map(({ layer, composition }) => [layer.id, { layer, composition }]))
}

const samePlacement = (a: Placement | undefined, b: Placement): boolean =>
  a !== undefined && a.composition_id === b.composition_id && a.t_us === b.t_us && a.end_t_us === b.end_t_us && a.state === b.state && a.outdated === b.outdated

/** Which clip each end follows, as `TackView.follows` reports it. */
export function tackFollows(range: TackRange): TackFollows {
  switch (range.kind) {
    case 'free': return { start: null, end: null }
    case 'anchored': return { start: { layer_id: range.layer_id }, end: range.src_end_us === null ? null : { layer_id: range.layer_id } }
    case 'edges': return {
      start: range.start === null ? null : { layer_id: range.start.layer_id },
      end: range.end === null ? null : { layer_id: range.end.layer_id },
    }
  }
}

/** The one change a call made to a tack's placement, most serious first, or
 *  null for none. A tack woken from hibernation reads as moved. */
function placementChange(was: Placement, now: Placement): AffectedTack['change'] | null {
  if (now.state !== 'visible') return now.state !== was.state ? now.state : now.outdated && !was.outdated ? 'outdated' : null
  if (now.outdated && !was.outdated) return 'outdated'
  if (was.state !== 'visible') return 'moved'
  const length = (x: Placement) => x.end_t_us === null ? null : x.end_t_us - x.t_us!
  if (length(was) !== length(now)) return 'resized'
  return was.composition_id !== now.composition_id || was.t_us !== now.t_us ? 'moved' : null
}

/** The tracks an edge may tie to, in preference order: A roll tracks first,
 *  then the rest in the composition's own order. A disabled track or layer
 *  shows nothing, so nothing on it is "the clip under" an instant; a transient
 *  (user-added) lane is ordinary content and counts. */
function edgeCandidates(c: Composition): Array<{ track: Track; layer: Layer }> {
  const tracks = c.tracks.filter((t) => t.enabled)
  return [...tracks.filter((t) => t.role === 'ARoll'), ...tracks.filter((t) => t.role !== 'ARoll')]
    .flatMap((track) => track.layers.filter((l) => l.enabled && hasSourceWindow(l.params)).map((layer) => ({ track, layer })))
}
/** A start sits on a frame — `[t_start, t_end)`; an end closes one — `(t_start, t_end]`. */
const holdsStart = (l: Layer, t: number) => l.t_start_us <= t && t < l.t_end_us
const holdsEnd = (l: Layer, t: number) => l.t_start_us < t && t <= l.t_end_us

function edgeAnchor(layer: Layer, t: number): TackEdgeAnchor {
  const at = sourceInstantAt(layer, t)
  return { layer_id: layer.id, src_us: at.src_us, ...(at.src_fraction ? { src_fraction: at.src_fraction } : {}) }
}

/** The layers a tack covers on `tracks`: those overlapping its range, or
 *  holding its instant when it is a point. */
function coveredOn(tracks: readonly Track[], tUs: number, endTUs: number | null, startId: string | null): Covered[] {
  const out: Covered[] = []
  for (const track of new Set(tracks)) for (const layer of track.layers) {
    const overlaps = endTUs === null ? holdsStart(layer, tUs) : layer.t_start_us < endTUs && layer.t_end_us > tUs
    if (overlaps) out.push({ layer, start: layer.id === startId })
  }
  return out
}

export class TackStore {
  private records = new Map<string, Tack>()
  private placed = new Map<string, Placement>()
  /** The layers each tack covered at creation, for `outdated`. Kept off the
   *  record: views are copies, and a layer is no part of the wire. */
  private covered = new Map<string, Covered[]>()
  private placedFor: Project | null = null
  private readonly capacity: number
  private readonly now: () => string
  private readonly newId: () => string

  constructor(private deps: TackStoreDeps) {
    this.capacity = deps.capacity ?? TACK_CAPACITY
    this.now = deps.now ?? (() => new Date().toISOString())
    this.newId = deps.newId ?? randomUUID
  }

  get size(): number { return this.records.size }

  has(id: string): boolean { return this.records.has(id) }

  /** Every tack with its placement, in creation order — or only those placed
   *  in `compositionId`. Copies: a caller cannot reach the store's records. */
  views(compositionId: string | null = null): TackView[] {
    if (compositionId !== null && !(compositionId in this.deps.project().compositions))
      throw new TackError('CompositionNotFound', `composition ${compositionId} not found — project://compositions lists them`, 'composition')
    this.refresh()
    const out: TackView[] = []
    for (const t of this.records.values()) {
      const at = this.placed.get(t.id)!
      if (compositionId === null || at.composition_id === compositionId) out.push(this.view(t, at))
    }
    return out
  }

  private view(t: Tack, at: Placement): TackView {
    return structuredClone({ ...t, ...at, follows: tackFollows(t.range) })
  }

  /** The views of the given ids, as they stand. For delta publication. */
  viewsOf(ids: ReadonlySet<string>): TackView[] {
    const out: TackView[] = []
    for (const t of this.records.values()) if (ids.has(t.id)) out.push(this.view(t, this.placed.get(t.id)!))
    return out
  }

  /** The placements of `client`'s open tacks as they stand, for
   *  `affectedSince` once a call has run — or null when it holds none, which
   *  is the common case and costs one pass over the records. By client, not
   *  connection: an agent that reconnects (a new chat, a restarted shim) is
   *  still the one that left them. */
  watch(client: string): ReadonlyMap<string, Placement> | null {
    const ids: string[] = []
    for (const t of this.records.values()) if (t.client === client && t.status === 'open') ids.push(t.id)
    if (ids.length === 0) return null
    this.refresh()
    return new Map(ids.map((id) => [id, this.placed.get(id)!]))
  }

  /** The watched tacks, still open, whose placement, state or outdatedness
   *  changed since `watch`. */
  affectedSince(before: ReadonlyMap<string, Placement>): AffectedTack[] {
    this.refresh()
    const out: AffectedTack[] = []
    for (const [id, was] of before) {
      const t = this.records.get(id)
      if (!t || t.status !== 'open') continue
      const change = placementChange(was, this.placed.get(id)!)
      if (change !== null) out.push({ tack_id: id, label: t.label, change })
    }
    return out
  }

  /** `client`'s open tacks that no longer point where they were made to:
   *  stale, hibernating or outdated — from any of its sessions, since a later
   *  session's edits are what usually strand an earlier session's tacks. */
  toReview(client: string): TackToReview[] {
    this.refresh()
    const out: TackToReview[] = []
    for (const t of this.records.values()) {
      if (t.client !== client || t.status !== 'open') continue
      const at = this.placed.get(t.id)!
      if (at.state !== 'visible' || at.outdated) out.push({ tack_id: t.id, label: t.label, state: at.state, outdated: at.outdated })
    }
    return out
  }

  /** Re-derive every placement against the current project and report the
   *  tacks whose placement moved. A no-op while the project is the one last
   *  placed against, so calling it on every change and every read is cheap. */
  refresh(): void {
    const p = this.deps.project()
    if (p === this.placedFor) return
    this.placedFor = p
    const layers = lazyLayerIndex(p)
    const dirty: string[] = []
    for (const t of this.records.values()) {
      const at = this.placement(p, t, layers)
      if (!samePlacement(this.placed.get(t.id), at)) { this.placed.set(t.id, at); dirty.push(t.id) }
    }
    if (dirty.length) this.deps.changed(dirty, [])
  }

  private placement(p: Project, t: Tack, layers: LayerIndex): Placement {
    return { ...place(p, t.range, layers), outdated: outdated(this.covered.get(t.id), layers) }
  }

  /** Validate the whole batch, then create it — all or nothing. */
  create(inputs: readonly TackInput[]): string[] {
    const who = this.deps.caller()
    if (who === null) throw new TackError('NoCurrentCall', 'create_tacks ran outside a current MCP call of this project opening (the project was replaced while it ran); nothing was created')
    if (this.records.size + inputs.length > this.capacity)
      throw new TackError('TackLimit', `TackLimit: this project opening holds ${this.records.size} of ${this.capacity} tacks and ${inputs.length} more would exceed it. Nothing was created; delete_tacks the resolved or dismissed ones (or a finished session's) first.`)
    this.refresh()
    const p = this.placedFor!
    const ranges = inputs.map((input, i) => this.range(p, input, `tacks[${i}]`))
    const created_at = this.now()
    const ids = inputs.map((input, i) => {
      const id = this.newId()
      this.records.set(id, {
        id, session_id: who.session_id, connection_id: who.connection_id, client: who.client, activity_id: who.activity_id,
        kind: input.kind, label: input.label, body: input.body, status: 'open', range: ranges[i]!.range, created_at,
      })
      if (ranges[i]!.covered.length) this.covered.set(id, ranges[i]!.covered)
      return id
    })
    // Placed against the project they were validated on, which is the one
    // every other placement was just refreshed against.
    const layers = lazyLayerIndex(p)
    for (const id of ids) this.placed.set(id, this.placement(p, this.records.get(id)!, layers))
    this.deps.changed(ids, [])
    return ids
  }

  update(id: string, patch: TackPatch): TackView {
    const t = this.records.get(id)
    if (!t) throw this.notFound(id)
    if (patch.label !== undefined) t.label = patch.label
    if (patch.body !== undefined) t.body = patch.body
    if (patch.kind !== undefined) t.kind = patch.kind
    if (patch.status !== undefined) t.status = patch.status
    this.refresh()
    this.deps.changed([id], [])
    return this.viewsOf(new Set([id]))[0]!
  }

  /** Remove the listed tacks — every id must exist, or none goes — or every
   *  tack created in work session `session`. Returns the ids removed. */
  delete(selector: { tack_ids: readonly string[] } | { session_id: string }): string[] {
    let ids: string[]
    if ('tack_ids' in selector) {
      const missing = selector.tack_ids.find((id) => !this.records.has(id))
      if (missing !== undefined) throw this.notFound(missing)
      ids = [...new Set(selector.tack_ids)]
    } else {
      ids = [...this.records.values()].filter((t) => t.session_id === selector.session_id).map((t) => t.id)
    }
    for (const id of ids) { this.records.delete(id); this.placed.delete(id); this.covered.delete(id) }
    if (ids.length) this.deps.changed([], ids)
    return ids
  }

  /** Drop everything without reporting it: the owner publishes a reset. */
  clear(): void {
    this.records.clear()
    this.placed.clear()
    this.covered.clear()
    this.placedFor = null
  }

  private notFound(id: string): TackError {
    return new TackError('TackNotFound', `tack ${id} not found in this project opening — project://tacks lists them; nothing was changed`, 'tack_id')
  }

  /** The stored range of one input and the layers it covers, or a refusal
   *  naming `at`. The times land on the composition's frame grid first, as
   *  `add_marker` lands them. With `anchor_layer_id` the clip names the source
   *  instant under each — with `applyAttachMarker`'s refusals. Without it,
   *  each end ties itself to the clip under it (`edgeCandidates` order; the
   *  end keeps the start's clip when that clip also holds it), and a range
   *  with no clip under either end stays free. */
  private range(p: Project, input: TackInput, at: string): { range: TackRange; covered: Covered[] } {
    const snap = (c: Composition) => {
      try { return snapMarkerTimes(c, input.t_us, input.end_t_us) }
      catch (e) {
        if (e instanceof CommandFailure && e.err.error === 'InvalidArgument')
          throw new TackError('InvalidArgument', `${at}.${e.err.field}: ${e.err.detail}`, e.err.field)
        throw e
      }
    }
    if (input.anchor_layer_id === null) {
      const compositionId = input.composition_id ?? p.root_id
      const c = p.compositions[compositionId]
      if (!c) throw new TackError('CompositionNotFound', `${at}.composition_id: composition ${compositionId} not found — project://compositions lists them`, 'composition_id')
      const { tUs, endTUs } = snap(c)
      const candidates = edgeCandidates(c)
      const start = candidates.find((x) => holdsStart(x.layer, tUs)) ?? null
      const end = endTUs === null ? null
        : start !== null && holdsEnd(start.layer, endTUs) ? start
        : candidates.find((x) => holdsEnd(x.layer, endTUs)) ?? null
      if (start === null && end === null) return { range: { kind: 'free', composition_id: c.id, t_us: tUs, end_t_us: endTUs }, covered: [] }
      return {
        range: {
          kind: 'edges', composition_id: c.id, t_us: tUs, end_t_us: endTUs,
          start: start === null ? null : edgeAnchor(start.layer, tUs),
          end: end === null ? null : edgeAnchor(end.layer, endTUs!),
        },
        covered: coveredOn([start, end].flatMap((x) => x === null ? [] : [x.track]), tUs, endTUs, start?.layer.id ?? null),
      }
    }
    const layerId = input.anchor_layer_id
    let found: { layer: Layer; composition: Composition; track: Track } | null = null
    for (const e of eachLayer(p)) if (e.layer.id === layerId) { found = e; break }
    if (!found) throw new TackError('LayerNotFound', `${at}.anchor_layer_id: layer ${layerId} not found — project://tracks lists them`, 'anchor_layer_id')
    const { layer, composition, track } = found
    if (input.composition_id !== null && input.composition_id !== composition.id)
      throw new TackError('CrossCompositionSet', `${at}.anchor_layer_id: layer ${layerId} is in composition ${composition.id}, not ${input.composition_id} — omit composition_id, or name the clip's own`, 'composition_id')
    if (!hasSourceWindow(layer.params))
      throw new TackError('WrongLayerKind', `${at}.anchor_layer_id: layer ${layerId} is a ${layer.params.kind}, which has no source time to follow — anchor to a VideoClip, Audio or Group layer, or omit anchor_layer_id`, 'anchor_layer_id')
    const { tUs, endTUs } = snap(composition)
    if (tUs < layer.t_start_us || tUs >= layer.t_end_us)
      throw new TackError('InvalidArgument', `${at}.t_us ${tUs} is outside layer ${layerId}'s span [${layer.t_start_us}, ${layer.t_end_us}) — an anchored tack must start on its clip`, 't_us')
    const start = sourceInstantAt(layer, tUs)
    const end = endTUs === null ? null : sourceInstantAt(layer, endTUs)
    return {
      range: {
        kind: 'anchored', layer_id: layerId, src_us: start.src_us, src_end_us: end?.src_us ?? null,
        ...(start.src_fraction ? { src_fraction: start.src_fraction } : {}),
        ...(end?.src_fraction ? { src_end_fraction: end.src_fraction } : {}),
      },
      covered: coveredOn([track], tUs, endTUs, layerId),
    }
  }
}
