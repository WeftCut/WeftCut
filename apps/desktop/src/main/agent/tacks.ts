// apps/desktop/src/main/agent/tacks.ts
// Tacks: comments on what plays in a time range, left by an agent for the user
// to review (ADR 0115, ADR 0117).
//
// Runtime state of ONE project opening, owned beside agent activity and reset
// with it. Not in `Project`, not recorded, not serialized, never touched by
// undo, redo, checkpoint restore or the history lock — so nothing here goes
// through the actor's commit path.
//
// At creation the store records what plays in the range, across every track
// (`playedIn`). Every read places the range again — its created length, moved
// as far as the first covered layer that still shows the content its part
// started on moved — and compares what plays there now. Whichever layer
// moves it, a range whose content moved together plays the same; one whose
// content did not is outdated wherever it is drawn. Two states only: current while it plays the
// same, outdated otherwise (as a review comment on changed lines is on GitHub
// or Gerrit). Derived, never latched: an undo that restores the content makes
// the tack current again.
import { randomUUID } from 'node:crypto'
import type { Composition, Layer, Project, Transition } from '../state/model'
import { eachLayer } from '../state/model'
import { CommandFailure } from '../state/errors'
import { hasSourceWindow } from '../state/mutations/helpers'
import { snapMarkerTimes, sourceInstantAt } from '../state/mutations/markers'
import { jsonEqual, transitionEqual } from '../state/reviewEntities'
import { sourceInstantHibernating, sourceInstantTimelineUs, type SourceInstant } from '../state/summary'
import {
  TACK_CAPACITY, type AffectedTack, type Tack, type TackFollows, type TackKind, type TackRange, type TackStatus,
  type TackToReview, type TackView,
} from '../../shared/agent-activity'

/** Who created a tack: the MCP call running when `create` was entered. */
export interface TackAttribution { session_id: string | null; connection_id: string; client: string; activity_id: string }

/** One tack as `create_tacks` receives it, already type-checked by its parser.
 *  `t_us` / `end_t_us` are times on the composition's timeline. */
export interface TackInput {
  label: string
  body: string
  kind: TackKind
  t_us: number
  end_t_us: number | null
  composition_id: string | null
}
export interface TackPatch { label?: string; body?: string; kind?: TackKind; status?: TackStatus }

export type TackErrorName = 'TackLimit' | 'TackNotFound' | 'NoCurrentCall' | 'InvalidArgument' | 'CompositionNotFound'

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

type Placement = Pick<TackView, 'composition_id' | 't_us' | 'end_t_us' | 'outdated' | 'follows'>
const UNPLACED: Placement = { composition_id: null, t_us: null, end_t_us: null, outdated: true, follows: null }

// ── What plays in a range ─────────────────────────────────────────────────────

/** One layer as it plays inside a range: the part of it the range covers, as
 *  offsets from the range's start, and the content time that part starts at —
 *  a source instant for a layer with a source window, else its offset into
 *  the layer (past a Motif's `src_in_us`). `layer` is the snapshot's own
 *  object, held by reference — immer never mutates it. */
interface Played {
  track_id: string
  layer: Layer
  from: number
  to: number
  at: SourceInstant
  /** What plays over that part in a Group's composition; null for other kinds. */
  nested: RangeContent | null
}
interface RangeContent { played: Played[]; transitions: Transition[] }

/** Compositions nest without cycles (validate); this only keeps a malformed
 *  project from recursing without end. */
const MAX_NESTING = 32

/** What plays in `[tUs, endTUs)` of `c` — or at the instant `tUs` for a point
 *  — on every track, in track order (bottom of the z-stack first): each
 *  overlapping layer's part, and the transitions touching those layers. Markers are notes, not playback;
 *  track toggles are preference-shaped (review excludes them too). */
function playedIn(p: Project, c: Composition, tUs: number, endTUs: number | null, depth = 0): RangeContent {
  const played: Played[] = []
  const ids = new Set<string>()
  for (const track of c.tracks) for (const layer of track.layers) {
    const overlaps = endTUs === null ? layer.t_start_us <= tUs && tUs < layer.t_end_us : layer.t_start_us < endTUs && layer.t_end_us > tUs
    if (!overlaps) continue
    const start = Math.max(layer.t_start_us, tUs)
    const end = endTUs === null ? start : Math.min(layer.t_end_us, endTUs)
    const params = layer.params
    const at: SourceInstant = hasSourceWindow(params) ? sourceInstantAt(layer, start)
      : { src_us: ('src_in_us' in params ? params.src_in_us : 0) + start - layer.t_start_us }
    let nested: RangeContent | null = null
    if (params.kind === 'CompositionRef') {
      const inner = p.compositions[params.composition]
      nested = !inner || depth >= MAX_NESTING ? { played: [], transitions: [] }
        : playedIn(p, inner, at.src_us, endTUs === null ? null : sourceInstantAt(layer, end).src_us, depth + 1)
    }
    played.push({ track_id: track.id, layer, from: start - tUs, to: end - tUs, at, nested })
    ids.add(layer.id)
  }
  return { played, transitions: c.transitions.filter((tr) => ids.has(tr.from_layer) || ids.has(tr.to_layer)) }
}

/** A layer's values apart from where it sits and which stretch of its source
 *  it shows — what `Played.from` / `to` / `at` already say for the part that
 *  plays — so a trim or a move outside the range compares equal. */
function layerBody(l: Layer): unknown {
  const params = l.params
  return {
    ...l, t_start_us: 0, t_end_us: 0,
    params: 'src_in_us' in params ? { ...params, src_in_us: 0, ...('src_out_us' in params ? { src_out_us: 0 } : {}) } : params,
  }
}

function samePlayed(a: Played, b: Played): boolean {
  return a.track_id === b.track_id && a.layer.id === b.layer.id && a.from === b.from && a.to === b.to
    && a.at.src_us === b.at.src_us && jsonEqual(a.at.src_fraction, b.at.src_fraction)
    && (a.layer === b.layer || jsonEqual(layerBody(a.layer), layerBody(b.layer)))
    && (a.nested === null ? b.nested === null : b.nested !== null && sameContent(a.nested, b.nested))
}

function sameContent(a: RangeContent, b: RangeContent): boolean {
  return a.played.length === b.played.length && a.played.every((x, i) => samePlayed(x, b.played[i]!))
    && a.transitions.length === b.transitions.length && a.transitions.every((x, i) => transitionEqual(x, b.transitions[i]!))
}

// ── Placement ─────────────────────────────────────────────────────────────────

/** A layer the range may move with: its id, the content time its covered
 *  part starts at, and the timeline time that read at creation. */
interface Follow { layer_id: string; at: SourceInstant; t_us: number }

/** Every covered layer, in track order. Which one moves the range matters
 *  only for where an outdated tack is drawn: content that moved together
 *  moved every covered layer alike. */
const followsOf = (tUs: number, content: RangeContent): Follow[] =>
  content.played.map((x) => ({ layer_id: x.layer.id, at: x.at, t_us: tUs + x.from }))

/** Where content time `at` of `layer` reads on its timeline now, or null when
 *  the layer no longer shows it — the source↔timeline mapping anchored markers
 *  use for a layer with a source window, the plain offset into it otherwise. */
function readsAt(layer: Layer, at: SourceInstant, fps: Composition['fps']): number | null {
  const params = layer.params
  if (hasSourceWindow(params)) return sourceInstantHibernating(at, layer) ? null : sourceInstantTimelineUs(layer, at, fps)
  const t = layer.t_start_us + at.src_us - ('src_in_us' in params ? params.src_in_us : 0)
  return layer.t_start_us <= t && t < layer.t_end_us ? t : null
}

/** What the store keeps beside a record: what played in its range at
 *  creation, and the layers it may follow. Off the record — views are copies,
 *  and a layer is no part of the wire. */
interface Made { content: RangeContent; follows: Follow[] }

type LayerIndex = () => Map<string, { layer: Layer; composition: Composition }>
/** Every layer of `p` by id, built on first use: a refresh that holds only
 *  tacks following nothing never needs it. */
function lazyLayerIndex(p: Project): LayerIndex {
  let index: Map<string, { layer: Layer; composition: Composition }> | null = null
  return () => index ??= new Map([...eachLayer(p)].map(({ layer, composition }) => [layer.id, { layer, composition }]))
}

/** Where a tack sits in `p` right now, and whether its range still plays what
 *  it did. The first covered layer that still shows its content moves the
 *  range — into another composition too, as a clip moved into a Group takes
 *  its anchored markers; with none, the range stays where it was made, and
 *  has no place once that composition is gone. A range moved before zero is
 *  held at zero, and plays differently there. */
function place(p: Project, range: TackRange, made: Made, layers: LayerIndex): Placement {
  let composition = p.compositions[range.composition_id]
  let t = range.t_us
  let follows: TackFollows | null = null
  for (const f of made.follows) {
    const found = layers().get(f.layer_id)
    const now = found ? readsAt(found.layer, f.at, found.composition.fps) : null
    if (found === undefined || now === null) continue
    composition = found.composition
    t = Math.max(0, range.t_us + now - f.t_us)
    follows = {
      layer_id: f.layer_id, t_us: now,
      ...(hasSourceWindow(found.layer.params) ? { src_us: f.at.src_us, ...(f.at.src_fraction ? { src_fraction: f.at.src_fraction } : {}) } : {}),
    }
    break
  }
  if (!composition) return UNPLACED
  const end = range.end_t_us === null ? null : t + range.end_t_us - range.t_us
  const outdated = !sameContent(made.content, playedIn(p, composition, t, end))
  return { composition_id: composition.id, t_us: t, end_t_us: end, outdated, follows }
}

const samePlacement = (a: Placement | undefined, b: Placement): boolean =>
  a !== undefined && a.composition_id === b.composition_id && a.t_us === b.t_us && a.end_t_us === b.end_t_us && a.outdated === b.outdated
  && a.follows?.layer_id === b.follows?.layer_id && a.follows?.t_us === b.follows?.t_us

/** The one change a call made to a tack, most serious first, or null for none. */
function placementChange(was: Placement, now: Placement): AffectedTack['change'] | null {
  if (now.outdated && !was.outdated) return 'outdated'
  return was.composition_id !== now.composition_id || was.t_us !== now.t_us ? 'moved' : null
}

export class TackStore {
  private records = new Map<string, Tack>()
  private placed = new Map<string, Placement>()
  private made = new Map<string, Made>()
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
    return structuredClone({ ...t, ...at })
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

  /** The watched tacks, still open, that moved or went outdated since `watch`. */
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

  /** `client`'s open outdated tacks — from any of its sessions, since a later
   *  session's edits are what usually outdate an earlier session's tacks. */
  toReview(client: string): TackToReview[] {
    this.refresh()
    const out: TackToReview[] = []
    for (const t of this.records.values()) {
      if (t.client !== client || t.status !== 'open') continue
      if (this.placed.get(t.id)!.outdated) out.push({ tack_id: t.id, label: t.label })
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
    return place(p, t.range, this.made.get(t.id)!, layers)
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
      this.made.set(id, ranges[i]!.made)
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
    for (const id of ids) { this.records.delete(id); this.placed.delete(id); this.made.delete(id) }
    if (ids.length) this.deps.changed([], ids)
    return ids
  }

  /** Drop everything without reporting it: the owner publishes a reset. */
  clear(): void {
    this.records.clear()
    this.placed.clear()
    this.made.clear()
    this.placedFor = null
  }

  private notFound(id: string): TackError {
    return new TackError('TackNotFound', `tack ${id} not found in this project opening — project://tacks lists them; nothing was changed`, 'tack_id')
  }

  /** The stored range of one input and what plays in it, or a refusal naming
   *  `at`. The times land on the composition's frame grid first, as
   *  `add_marker` lands them. */
  private range(p: Project, input: TackInput, at: string): { range: TackRange; made: Made } {
    const compositionId = input.composition_id ?? p.root_id
    const c = p.compositions[compositionId]
    if (!c) throw new TackError('CompositionNotFound', `${at}.composition_id: composition ${compositionId} not found — project://compositions lists them`, 'composition_id')
    let tUs: number, endTUs: number | null
    try { ({ tUs, endTUs } = snapMarkerTimes(c, input.t_us, input.end_t_us)) }
    catch (e) {
      if (e instanceof CommandFailure && e.err.error === 'InvalidArgument')
        throw new TackError('InvalidArgument', `${at}.${e.err.field}: ${e.err.detail}`, e.err.field)
      throw e
    }
    const content = playedIn(p, c, tUs, endTUs)
    return { range: { composition_id: c.id, t_us: tUs, end_t_us: endTUs }, made: { content, follows: followsOf(tUs, content) } }
  }
}
