// apps/desktop/src/main/agent/tacks.ts
// Tacks: the time ranges an agent points the user at for review (ADR 0115).
//
// Runtime state of ONE project opening, owned beside agent activity and reset
// with it. Not in `Project`, not recorded, not serialized, never touched by
// undo, redo, checkpoint restore or the history lock — so nothing here goes
// through the actor's commit path. The store holds what the agent said (a free
// time on a composition's clock, or a layer's SOURCE time) and derives where
// that sits on a timeline every time it is read, with the same source↔timeline
// mapping and hibernation rule anchored markers use (`summary.ts`,
// `mutations/markers.ts`). There is no stored timeline time to keep in step.
import { randomUUID } from 'node:crypto'
import type { Composition, Layer, Project } from '../state/model'
import { eachLayer } from '../state/model'
import { CommandFailure } from '../state/errors'
import { hasSourceWindow } from '../state/mutations/helpers'
import { snapMarkerTimes, sourceInstantAt } from '../state/mutations/markers'
import { sourceInstantHibernating, sourceInstantTimelineUs } from '../state/summary'
import { TACK_CAPACITY, type Tack, type TackKind, type TackRange, type TackStatus, type TackView } from '../../shared/agent-activity'

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

type Placement = Pick<TackView, 'composition_id' | 't_us' | 'end_t_us' | 'state'>
const STALE: Placement = { composition_id: null, t_us: null, end_t_us: null, state: 'stale' }

/** Where a tack sits in `p` right now. `layers` resolves an anchor's layer
 *  anywhere in the project — a clip moved into a Group takes its tacks along,
 *  as it takes its anchored markers. */
function place(p: Project, range: TackRange, layers: LayerIndex): Placement {
  if (range.kind === 'free') {
    if (!(range.composition_id in p.compositions)) return STALE
    return { composition_id: range.composition_id, t_us: range.t_us, end_t_us: range.end_t_us, state: 'visible' }
  }
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
    const shown = layer.t_end_us <= t ? e : Math.min(e, layer.t_end_us)
    end = shown > t ? shown : null
  }
  return { composition_id: composition.id, t_us: t, end_t_us: end, state: 'visible' }
}

type LayerIndex = () => Map<string, { layer: Layer; composition: Composition }>
/** Every layer of `p` by id, built on first use: most refreshes hold no
 *  anchored tack and never need it. */
function lazyLayerIndex(p: Project): LayerIndex {
  let index: Map<string, { layer: Layer; composition: Composition }> | null = null
  return () => index ??= new Map([...eachLayer(p)].map(({ layer, composition }) => [layer.id, { layer, composition }]))
}

const samePlacement = (a: Placement | undefined, b: Placement): boolean =>
  a !== undefined && a.composition_id === b.composition_id && a.t_us === b.t_us && a.end_t_us === b.end_t_us && a.state === b.state

export class TackStore {
  private records = new Map<string, Tack>()
  private placed = new Map<string, Placement>()
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
      if (compositionId === null || at.composition_id === compositionId) out.push(structuredClone({ ...t, ...at }))
    }
    return out
  }

  /** The views of the given ids, as they stand. For delta publication. */
  viewsOf(ids: ReadonlySet<string>): TackView[] {
    const out: TackView[] = []
    for (const t of this.records.values()) if (ids.has(t.id)) out.push(structuredClone({ ...t, ...this.placed.get(t.id)! }))
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
      const at = place(p, t.range, layers)
      if (!samePlacement(this.placed.get(t.id), at)) { this.placed.set(t.id, at); dirty.push(t.id) }
    }
    if (dirty.length) this.deps.changed(dirty, [])
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
        kind: input.kind, label: input.label, body: input.body, status: 'open', range: ranges[i]!, created_at,
      })
      return id
    })
    // Placed against the project they were validated on, which is the one
    // every other placement was just refreshed against.
    const layers = lazyLayerIndex(p)
    for (const id of ids) this.placed.set(id, place(p, this.records.get(id)!.range, layers))
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
    for (const id of ids) { this.records.delete(id); this.placed.delete(id) }
    if (ids.length) this.deps.changed([], ids)
    return ids
  }

  /** Drop everything without reporting it: the owner publishes a reset. */
  clear(): void {
    this.records.clear()
    this.placed.clear()
    this.placedFor = null
  }

  private notFound(id: string): TackError {
    return new TackError('TackNotFound', `tack ${id} not found in this project opening — project://tacks lists them; nothing was changed`, 'tack_id')
  }

  /** The stored range of one input, or a refusal naming `at`. An anchored
   *  range is derived exactly as `add_marker` derives its anchor: the times
   *  land on the composition's frame grid first, then the clip names the
   *  source instant under each — with `applyAttachMarker`'s refusals. */
  private range(p: Project, input: TackInput, at: string): TackRange {
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
      return { kind: 'free', composition_id: c.id, t_us: tUs, end_t_us: endTUs }
    }
    const layerId = input.anchor_layer_id
    let found: { layer: Layer; composition: Composition } | null = null
    for (const e of eachLayer(p)) if (e.layer.id === layerId) { found = e; break }
    if (!found) throw new TackError('LayerNotFound', `${at}.anchor_layer_id: layer ${layerId} not found — project://tracks lists them`, 'anchor_layer_id')
    const { layer, composition } = found
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
      kind: 'anchored', layer_id: layerId, src_us: start.src_us, src_end_us: end?.src_us ?? null,
      ...(start.src_fraction ? { src_fraction: start.src_fraction } : {}),
      ...(end?.src_fraction ? { src_end_fraction: end.src_fraction } : {}),
    }
  }
}
