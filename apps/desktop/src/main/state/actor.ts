// apps/desktop/src/main/state/actor.ts
import { produce, setAutoFreeze } from 'immer'
import type { Animated, AudioRole, Composition, Interpolation, LayerParams, MarkerAnchor, MotifRebindEntry, Project, Rational, Rgba, TransitionKind, Uuid } from './model'
import { blankProject, eachLayer, rootComposition } from './model'
import type { IdGen } from './ids'
import { History, type Actor, type EntityRef, type TrackFlagsPatch, type RoleFlagsPatch } from './history'
import { HISTORY_SUMMARY, groupAddMembersSummary, groupCreateSummary, layersEnabledSummary, moveToCompositionSummary, pastedLayersSummary, removedMediaSummary, roleGainSummary, type HistorySummary } from './history-labels'
import { CommandFailure, ValidationFailure, type CommandError } from './errors'
import { validate, reconcileMarkers, reconcileTransitions, type DroppedMarker, type DroppedTransition } from './validate'
import { gridForLayerKind, snapFrameCeil, snapFrameRound, snapOnGrid } from './snap'
import { applyAddGroupLayer, applyAddLayer, applyAddMarker, applyAddTrack, colorParams, defaultTransform, textParamsDefault } from './mutations/add'
import { applyMoveLayer, applyMoveLayersToNewTrack } from './mutations/move'
import { applyRestackLayer, type RestackPosition } from './mutations/restack'
import { applyTrimLayer, type LayerEdge } from './mutations/trim'
import { applyDeleteLayer } from './mutations/delete'
import { applyDuplicateLayer, applyPasteLayer, applyPasteLayers, pasteLayerInterval } from './mutations/duplicate'
import { applySplitLayer, parseDiscardSegments } from './mutations/split'
import { applyLinksCreate, applyLinksDissolve, applyLinksAddMembers, applyLinksRemoveMembers, applyLinksRename, linkSiblingsExcluding } from './mutations/links'
import { applyCompositionsDelete, applyGroupsAddMembers, applyGroupsCreate, applyGroupsRename, applyGroupsUngroup, type GroupCreateResult } from './mutations/groups'
import { applyMoveLayersToComposition } from './mutations/moveToComposition'
import { applySetLayersEnabled, applyUpdateLayer, type LayerPatch } from './mutations/update'
import { applyFitComposition } from './mutations/composition'
import { applyDurationAutofit, compositionOf, locateLayer, locateTrack, requireLayer, requireSameComposition, requireTrack, scopeComposition } from './mutations/helpers'
import { applyAttachMarker, applyDetachMarker, applyUpdateMarker, applyRemoveMarker, type MarkerPatch } from './mutations/markers'
import { applyDeleteTrack, applyMoveTrack, applyRenameTrack } from './mutations/tracks'
import { applyAddEffect, applyUpdateEffect, applyMoveEffect, applyRemoveEffect, type EffectPatch } from './mutations/effects'
import { applyAddTransition, applyRemoveTransition, applyUpdateTransition, type TransitionBounce } from './mutations/transitions'
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate,
  applySetMediaDerivatives, applySetMediaWorkspacePaths, applySetMediaHash, referencingLayers,
  type MediaDerivativesPatch, type WorkspacePaths } from './mutations/media'
import type { MediaItem } from './model'
import { applyUpdateLayerParams, applyUpdateLayerParamTrack, type LayerParamsPatch } from './mutations/params'
import { applySetScaleLinked, enforceScaleLinkInvariant } from './mutations/scaleLink'
import { MotifCatalog, type Manifest } from '../../shared/motifs/catalog'
import { applyAddCaptionTrack, applyRestyleCaptions, captionTracks, type Cue, type CaptionStylePatch } from './mutations/captions'
import { applyRebindMotif, motifLayerParams } from './mutations/motif'
import { canonicalizeProps, resolveMotifMaxDurUs, resolveMotifTEndUs, MotifPropError } from '../../shared/motifs/catalog'
import { parseMechanical, prodColorParams, prodTextParams, prodMediaLayer, resolveDurationUs, pickFreeOverlayTrack, demoColor } from './commands'
import { mapCommandError, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, toolEmpty, toolText, toolJson, parseUuid, parseNum, parseNumOpt, parseStr, parseBool, parseRgba, parseTransitionKind, parseTransitionKindOpt, parseTransitionPlacement, McpArgError, shapeGetParamTrack, keyframePresent, shapeDryRunResponse, mcpDef, type McpCallResult } from './mcp-commands'
import { upsertKeyframe, removeKeyframe, retimeKeyframe, setSegmentEasing, setAuto } from './keyframeEdits'
import { readLayerTrack } from './mutations/params'

setAutoFreeze(true) // snapshots are frozen — accidental mutation throws.

/** The actor stamped on MCP-created checkpoints; surfaces in list_checkpoints'
 *  result. */
const MCP_ACTOR: Actor = { kind: 'Agent', client: 'mcp' }

export type Clock = () => string
export type DiffHint = { kind: 'Coarse' } | { kind: 'Layer'; id: Uuid } | { kind: 'Composition' }
export interface ChangeEvent { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[]; new_snapshot: Project; diff_hint: DiffHint }

export type DryRunOp =
  | { kind: 'AddLayer'; track_id: Uuid; params: LayerParams; t_start_us: number; t_end_us: number }
  | { kind: 'DeleteLayer'; id: Uuid }
  | { kind: 'UpdateLayer'; id: Uuid; patch: LayerPatch }
  | { kind: 'UpdateLayerParams'; id: Uuid; patch: LayerParamsPatch }
  | { kind: 'MoveLayer'; id: Uuid; new_track_id: Uuid; new_t_start_us: number; escape_link: boolean }
  | { kind: 'SplitLayer'; id: Uuid; at_t_us: number; escape_link: boolean }
  | { kind: 'TrimLayer'; id: Uuid; edge: LayerEdge; new_t_us: number; escape_link: boolean }
  // `transition_kind`, not `kind`: the discriminant owns that name.
  | { kind: 'AddTransition'; from: Uuid; to: Uuid; duration_us: number; transition_kind: TransitionKind; placement: 'overlap' | 'extend' }
export type DryRunOutput =
  | { kind: 'AddLayer'; layer_id: Uuid }
  | { kind: 'SplitLayer'; left_id: Uuid; right_id: Uuid }
  // The overlap add's side effects are the payload: `bounces` predicts sibling
  // lane moves and lane spawns exactly as the wet command would perform (and
  // log) them — same code path, produce-and-discard.
  | { kind: 'AddTransition'; transition_id: Uuid; bounces: TransitionBounce[] }
  | { kind: 'Void' }

/** Status-log row payload — structurally matches TsActorHostDeps.emitLog so the
 *  host passes its LogBus seam (backend `log_emit`) straight through. Schema:
 *  docs/status-log.md. */
export interface ActorLogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  category: { kind: string; name?: string }
  source: { kind: 'User' } | { kind: 'Agent'; client: string } | { kind: 'System' }
  message: string
  details?: Record<string, unknown>
}

export interface ActorOptions {
  initial: Project; idGen: IdGen; clock?: Clock; actor?: Actor; motifCatalog?: MotifCatalog
  /** Status-log seam (reconcile-dropped-transition rows). Optional → no-op when
   *  omitted (tests that do not care about logging). Called AFTER a successful
   *  commit is recorded; a throwing emit is caught and must never abort. */
  emitLog?: (entry: ActorLogEntry) => void
}
export type DispatchResult = { ok: true; value: unknown } | { ok: false; error: CommandError }

export interface ActorHandle {
  snapshot(): Project
  dispatch(channel: string, args: Record<string, unknown>): DispatchResult
  command(channel: string, wireArgs: Record<string, unknown>): DispatchResult
  replaceState(next: Project): void
  subscribe(cb: (e: ChangeEvent) => void): () => void
  historyView(limit: number): ReturnType<History['view']>
  historyStatus(): ReturnType<History['status']>
  /** The stack cap — the `limit` a "give me the WHOLE stack" read should pass to
   *  `historyView` (the history panel's read; MCP's `view(100)` is a different
   *  consumer with a different need). Delegates to History so the number is never
   *  restated at a call site. */
  historyCapacity(): number
  lockHistory(reason: string): void
  unlockHistory(): void
  /** Cursor-only random access; rejects under the revert lock. See jumpTo. */
  jumpTo(index: number): void
  checkpoint(label: string, cpActor?: Actor): Uuid
  restoreCheckpoint(id: Uuid): void
  deleteCheckpoint(id: Uuid): void
  listCheckpoints(): Array<{ id: Uuid; label: string; actor: Actor; created_at: string }>
  dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }>
  mcpCall(name: string, argsJson: string): McpCallResult
  /** Replace the user-layer of the motif catalog (built-ins are always present).
   *  Called by the host after motif-store-mutating operations to keep the catalog
   *  current for the content-window clamp in applyUpdateLayerParams. */
  setUserMotifManifests(ms: Manifest[]): void
}

export function createActor(opts: ActorOptions): ActorHandle {
  const idGen = opts.idGen
  const clock: Clock = opts.clock ?? (() => '<TS>')
  const actor: Actor = opts.actor ?? { kind: 'User' }
  const history = new History(opts.initial, actor, idGen(), clock()) // consumes the Initial op_id
  const subs = new Set<(e: ChangeEvent) => void>()
  const motifCatalog: MotifCatalog = opts.motifCatalog ?? new MotifCatalog()

  function current(): Project { return history.current() }

  /** validate(next) → throw CommandFailure(ValidationFailed) on a rule failure.
   *  Every path that must reject before minting an op_id calls this. */
  function runValidate(next: Project): void {
    try { validate(next) } catch (e) {
      if (e instanceof ValidationFailure) throw new CommandFailure({ error: 'ValidationFailed', detail: e.err })
      throw e
    }
  }

  /** Run a draft mutation, then reconcile transitions and markers, then
   *  validate, record, emit — validate FIRST, op_id AFTER validate.
   *  Returns the recipe's value. Throws CommandFailure on a mutation error or a
   *  validation failure.
   *
   *  Reconcile (Policy B, spec § Edit-interaction policy) runs on EVERY commit
   *  — trim/move/split/delete/link ops stay transition-blind — inside the same
   *  produce(), so the drop lands in the SAME snapshot as the edit (one undo
   *  restores both). add/update/remove_transition need no exemption either:
   *  their OWN transition holds by construction after apply, and when
   *  update/remove move the incoming layer through a FOLLOWING transition's
   *  geometry (B is also from_layer of some B→C), reconcile dropping that
   *  chained transition — with its status row — is the designed outcome.
   *
   *  `reconcileMarkers` rides the same slot for the same three reasons, one
   *  step later: ordinary edits stay marker-blind, an anchored marker's follow
   *  (or its drop, when the clip it named was deleted) lands in the same
   *  snapshot as the edit that caused it, and both reconciles hand back
   *  primitives rather than draft references. The two are independent — a
   *  transition drop moves no layer and a marker follow reads no transition —
   *  so the order between them is free.
   *
   *  `summary` is a `HistorySummary` (history-labels.ts), not a bare string: the
   *  entry records its `.text` verbatim AND its `.key`, so the panel can
   *  translate the row without an English-prose lookup.
   *
   *  `affected` takes a FUNCTION form for the add-shaped ops, whose entity ids
   *  are minted inside the recipe and so cannot be named from the args. It runs
   *  once, after validate — a rejected commit never sees ids from a draft that
   *  was discarded. Its parameter must be ANNOTATED (the named `layerRef` /
   *  markerRefs` helpers already are): arguments are checked left to right, so
   *  the annotation is what fixes `T` — and the recipe's return type is then
   *  checked against it, which is what stops a callback naming an id the recipe
   *  never returned. */
  function commit<T>(summary: HistorySummary, affected: EntityRef[] | ((value: T) => EntityRef[]), diff: DiffHint, recipe: (draft: Project) => T): T {
    let value!: T
    let droppedTransitions: DroppedTransition[] = []
    let droppedMarkers: DroppedMarker[] = []
    // produce: a throw inside the recipe aborts and discards the draft.
    const next = produce(current(), (draft) => {
      value = recipe(draft)
      droppedTransitions = reconcileTransitions(draft)
      droppedMarkers = reconcileMarkers(draft)
    })
    // No-op guard: if the recipe left the draft unmodified, immer returns the
    // original object by reference. Recording an identical snapshot would waste
    // a history slot and an op_id, and would fool the undo-unwind property's
    // state-change detector (two entries with the same state look like "bottom").
    // Mirrors the intent of applyTrimLayer's requestedDelta===0 early return.
    // (A no-op recipe can't dirty a transition or an anchored marker, so
    // neither reconcile blocks this.)
    if (next === current()) return value
    runValidate(next)
    const refs = typeof affected === 'function' ? affected(value) : affected
    const opId = idGen() // AFTER validate — failed validate consumes no op_id
    const ts = clock()
    history.record({ op_id: opId, actor, timestamp: ts, summary: summary.text, label_key: summary.key, label_args: summary.label_args, affected: refs, snapshot: next })
    emit({ op_id: opId, actor, timestamp: ts, summary: summary.text, affected: refs, new_snapshot: next, diff_hint: diff })
    logDroppedTransitions(droppedTransitions) // after record — a failed validate logs nothing
    logDroppedMarkers(droppedMarkers)
    return value
  }

  /** One status-log row per reconcile-dropped transition. Best-effort: a
   *  throwing emit must never abort the (already recorded) commit. */
  function logDroppedTransitions(dropped: DroppedTransition[]): void {
    if (dropped.length === 0 || !opts.emitLog) return
    for (const d of dropped) {
      try {
        opts.emitLog({
          level: 'info',
          category: { kind: 'Project' },
          source: actor.kind === 'Agent' ? { kind: 'Agent', client: actor.client } : { kind: 'User' },
          message: `Transition removed: edit broke its overlap (transition ${d.id}, from ${d.from_layer}, to ${d.to_layer})`,
          details: { kind: 'TransitionReconcileDrop', transition: d.id, from_layer: d.from_layer, to_layer: d.to_layer, reason: d.reason },
        })
      } catch (err) { console.warn('[actor] emitLog failed (transition reconcile)', err) }
    }
  }

  /** One status-log row per reconcile-dropped marker — the anchored markers
   *  whose clip the edit deleted. Same seam and same best-effort discipline as
   *  logDroppedTransitions, and deliberately NO toast: this app's house pattern
   *  for a side effect the user did not ask for is prevention plus the status
   *  bar (issue #18), never an interruption. */
  function logDroppedMarkers(dropped: DroppedMarker[]): void {
    if (dropped.length === 0 || !opts.emitLog) return
    for (const d of dropped) {
      try {
        opts.emitLog({
          level: 'info',
          category: { kind: 'Project' },
          source: actor.kind === 'Agent' ? { kind: 'Agent', client: actor.client } : { kind: 'User' },
          message: `Marker removed: the clip it followed is gone (marker ${d.id}${d.label ? ` "${d.label}"` : ''}, layer ${d.layer})`,
          details: { kind: 'MarkerReconcileDrop', marker: d.id, composition: d.composition, layer: d.layer, label: d.label },
        })
      } catch (err) { console.warn('[actor] emitLog failed (marker reconcile)', err) }
    }
  }

  /** One status-log row per overlap-add sibling bounce (same best-effort seam
   *  as logDroppedTransitions: a throwing emit never aborts the already
   *  recorded commit). */
  function logTransitionBounces(bounces: TransitionBounce[]): void {
    if (bounces.length === 0 || !opts.emitLog) return
    for (const b of bounces) {
      try {
        opts.emitLog({
          level: 'info',
          category: { kind: 'Project' },
          source: actor.kind === 'Agent' ? { kind: 'Agent', client: actor.client } : { kind: 'User' },
          message: `Transition placement moved layer ${b.layer} to ${b.spawned ? `a new track ${b.to_track}` : `track ${b.to_track}`}: its lane was occupied after the shift`,
          details: { kind: 'TransitionPlacementBounce', layer: b.layer, from_track: b.from_track, to_track: b.to_track, spawned: b.spawned },
        })
      } catch (err) { console.warn('[actor] emitLog failed (transition bounce)', err) }
    }
  }

  function emit(e: ChangeEvent): void {
    for (const cb of subs) {
      try { cb(e) }
      catch (err) {
        // A throwing subscriber (e.g. the autosave serialize, or the mcpNotify
        // relay) must not starve later subscribers. Warn and continue — cf.
        // feedback_ui_actor_bridge, feedback_async_block_on_in_async.
        console.warn('[actor] change subscriber threw; continuing', err)
      }
    }
  }

  /** NON-recorded events only — these never reach history, so they carry no
   *  label key and no affected refs. */
  function broadcastUnrecorded(summary: string, snapshot: Project, diff: DiffHint = { kind: 'Coarse' }): void {
    const opId = idGen() // the unrecorded broadcast's own deterministic id
    emit({ op_id: opId, actor, timestamp: clock(), summary, affected: [], new_snapshot: snapshot, diff_hint: diff })
  }

  // ── affected-ref helpers. Every recorded commit names the entities it touched,
  //    so the history panel can label the row and select on click; a ref set read
  //    from an id-only arg comes off the PRE-mutation snapshot (same rule as
  //    restyle_captions'). `EntityRef` has three variants and gains none: it is a
  //    wire type the MCP resource exposes, and the renderer has no
  //    selected-transition or selected-link model to receive one.
  //
  //    The SINGULAR three double as commit()'s function form — `commit(s, layerRef,
  //    …)` names whatever layer id the recipe returned. ──
  function layerRef(id: Uuid): EntityRef[] { return [{ kind: 'Layer', id }] }
  function trackRef(id: Uuid): EntityRef[] { return [{ kind: 'Track', id }] }
  function markerRef(id: Uuid): EntityRef[] { return [{ kind: 'Marker', id }] }
  function layerRefs(ids: Uuid[]): EntityRef[] { return ids.map((id) => ({ kind: 'Layer', id })) }
  function markerRefs(ids: Uuid[]): EntityRef[] { return ids.map((id) => ({ kind: 'Marker', id })) }
  /** Both side layers of a transition — "this transition sits between these two".
   *  Absent transition → `[]`; the apply then rejects and nothing records. */
  function transitionSideRefs(id: Uuid): EntityRef[] {
    for (const c of Object.values(current().compositions)) {
      const t = c.transitions.find((x) => x.id === id)
      if (t) return layerRefs([t.from_layer, t.to_layer])
    }
    return []
  }
  /** A link's member layers. Absent link → `[]` (the apply rejects). */
  function linkMemberRefs(id: Uuid): EntityRef[] {
    for (const c of Object.values(current().compositions)) {
      const g = c.links.find((x) => x.id === id)
      if (g) return layerRefs(g.members)
    }
    return []
  }
  /** Every Group layer referencing a composition — a composition has no
   *  `EntityRef` of its own, so a rename row points at the clips it names. */
  function compositionRefLayers(compositionId: Uuid): EntityRef[] {
    const ids: Uuid[] = []
    for (const { layer } of eachLayer(current()))
      if (layer.params.kind === 'CompositionRef' && layer.params.composition === compositionId) ids.push(layer.id)
    return layerRefs(ids)
  }
  /** Optional `composition_id` arg → the composition, CompositionNotFound for an
   *  unknown id; absent/null → undefined (the callee defaults to the root). */
  function compositionArg(a: Record<string, unknown>): Uuid | undefined {
    const id = a.composition_id
    if (id === undefined || id === null) return undefined
    return compositionOf(current(), parseUuid(id, 'composition_id')).id
  }
  /** The renderer channel spelling of the same arg (`compositionId`). */
  function wireCompositionId(wireArgs: Record<string, unknown>): Uuid | undefined {
    const id = wireArgs.compositionId
    if (id === undefined || id === null) return undefined
    return compositionOf(current(), parseUuid(id, 'compositionId')).id
  }
  /** An MCP creation tool that names BOTH a track and a composition: the track
   *  already fixes the composition, so the id is a cross-check — unknown id →
   *  CompositionNotFound, a track that lives elsewhere → InvalidArgument (it is
   *  not missing, it is in another composition, and the message says which).
   *  An unknown track is left to the mutation's own TrackNotFound. */
  function checkTrackInComposition(trackId: Uuid, compositionId: Uuid | null): void {
    if (compositionId === null) return
    const comp = compositionOf(current(), compositionId)
    const t = locateTrack(current(), trackId)
    if (t && t.comp !== comp)
      throw new CommandFailure({ error: 'InvalidArgument', field: 'track_id', detail: `track ${trackId} belongs to composition ${t.comp.id}, not ${compositionId}` })
  }

  // ── set_composition — the WHOLE composition envelope is setup, never editing:
  //    one atomic probe validate, then one unrecorded patch fanned out over every
  //    snapshot + checkpoint. Undo walks past a canvas/rate/duration change without
  //    reverting it (docs/features.md #undo-stack-scope); an fps change is LOCKED
  //    once ANY stored snapshot holds a layer. `composition_id` names the
  //    composition whose canvas / duration the patch sets (root by default); the
  //    lattice fields cascade to every composition whichever is named. ──
  function setComposition(patch: Record<string, unknown>): void {
    const cur = current()
    const curRoot = rootComposition(cur)
    const targetId = compositionArg(patch) ?? cur.root_id
    const CANVAS_KEYS = ['width', 'height', 'fps', 'sample_rate', 'channels', 'color_space', 'background']
    const canvasChanges = CANVAS_KEYS.some((k) => patch[k] !== undefined)
    const newFps = (patch.fps as Rational | undefined) ?? curRoot.fps
    const fpsChanged = patch.fps !== undefined && (newFps.num !== curRoot.fps.num || newFps.den !== curRoot.fps.den)

    // ── The rate lock (spec R2-D1/R2-D2) ─────────────────────────────────────
    // Reject BEFORE any draft work, so a locked project mints no op_id, patches no
    // snapshot and emits nothing.
    //
    // "Temporal content" is deliberately ONE LAYER ON ANY TRACK — not markers, not
    // a pinned duration, not imported-but-unplaced media. `blankProject` mints two
    // tracks and no layers, so a fresh project stays freely re-rateable; marker
    // re-snapping is lossless, so a stray marker must not brick the rate.
    //
    // Judgement scope == write scope: the fps write is unrecorded, so it lands in
    // every stored snapshot. `History.storedSnapshotsHoldLayer` owns why a
    // current-state-only test is unsound; `errors.ts` FpsLockedByContent owns the
    // caller-facing remedy. See docs/features.md #undo-stack-scope.
    if (fpsChanged) {
      const layerCount = [...eachLayer(cur)].length // every composition: the fps write lands in all of them
      // `storedSnapshotsHoldLayer` subsumes the current state; test the live count
      // first so `locked_by` names the scope the caller can actually act on.
      const lockedByCurrent = layerCount > 0
      if (lockedByCurrent || history.storedSnapshotsHoldLayer()) {
        throw new CommandFailure({
          error: 'FpsLockedByContent', current: curRoot.fps, requested: newFps,
          layer_count: layerCount, locked_by: lockedByCurrent ? 'current' : 'history',
        })
      }
    }

    const durationChange = typeof patch.duration_us === 'number'
      ? snapFrameRound(patch.duration_us, newFps.num, newFps.den) : undefined

    // The whole patch as a recipe that is correct for ANY stored snapshot, not
    // just the current one — this is what makes the unrecorded fan-out sound:
    //   · canvas fields copy verbatim (they describe the output, not the content),
    //   · the fps re-snap runs against THAT snapshot's own markers and layers,
    //   · `applyDurationAutofit` floors a pinned duration at THAT snapshot's own
    //     content high-water mark, so no snapshot ends up shorter than its own
    //     content.
    //   · fps / sample_rate / channels CASCADE to every composition (single lattice,
    //     ADR 0052 §5) — the canvas and duration are the TARGET's alone. Without the
    //     cascade a rate change on a project holding a Group fails validate with
    //     CompositionLatticeMismatch. A snapshot that predates the target (a Group
    //     created later) takes the cascade and nothing else.
    const LATTICE_KEYS = ['fps', 'sample_rate', 'channels'] as const
    const latticePatch: Record<string, unknown> = {}
    for (const k of LATTICE_KEYS) if (patch[k] !== undefined) latticePatch[k] = patch[k]
    const buildProbe = (d: Project): void => {
      const dTarget = d.compositions[targetId]
      if (dTarget) {
        applyCanvasFields(dTarget, patch)
        if (durationChange !== undefined) { dTarget.duration_us = durationChange; dTarget.duration_pinned = true }
      }
      for (const c of Object.values(d.compositions)) {
        if (c !== dTarget) applyCanvasFields(c, latticePatch)
        if (fpsChanged) resnapComposition(c)
        applyDurationAutofit(c)
      }
    }
    /** Re-snap one composition's grid-bound fields onto its (new) frame grid. */
    const resnapComposition = (c: Composition): void => {
      {
        const nf = c.fps
        // The layer loop is unreachable BY CONSTRUCTION: the history-scoped rate
        // lock means EVERY snapshot this recipe runs over is layer-less. It stays
        // on purpose, as the correctness backstop for the two ways that can change:
        // a future "match the sequence to the first clip" flow (which sets the rate
        // while still layer-less, then adds), and any relaxation of the lock. The
        // marker + duration re-snap below is NOT dead: a layer-less project can hold
        // both, and validate's grid backstop rejects the whole fps change without it.
        for (const t of c.tracks) for (const l of t.layers) {
          // Per-KIND grid: an audio layer lives on the fixed 48 kHz lattice, which
          // does not move when fps does, so re-snapping it here would be wrong twice
          // over — it would drop a sample-precise edit AND put the endpoint off the
          // audio grid the backstop now checks it against (spec R2-D6).
          const g = gridForLayerKind(l.params.kind, nf)
          l.t_start_us = snapOnGrid(l.t_start_us, g)
          l.t_end_us = snapOnGrid(l.t_end_us, g)
          // Motif src_in_us lives on the COMPOSITION grid (re-snap); VideoClip/
          // Audio src_in_us is normalized source content time (left untouched).
          if (l.params.kind === 'Motif') l.params.src_in_us = snapFrameRound(l.params.src_in_us, nf.num, nf.den)
        }
        c.duration_us = snapFrameRound(c.duration_us, nf.num, nf.den)
        // Markers ride the SAME composition grid as layer endpoints, so they
        // re-snap with them — miss them and validate's grid backstop rejects the
        // whole fps change (OffGridTime) on any project that has a marker.
        // `snapMarkerTimes`' collapsed-region REJECTION is deliberately not reused:
        // an fps change must not fail because a region quantizes to zero frames at
        // the new rate, so such a region widens to one frame. Order is preserved —
        // the snap is monotonic.
        for (const m of c.markers) {
          m.t_us = snapFrameRound(m.t_us, nf.num, nf.den)
          if (m.end_t_us !== null && m.end_t_us !== undefined) {
            const end = snapFrameRound(m.end_t_us, nf.num, nf.den)
            m.end_t_us = end > m.t_us ? end : snapFrameCeil(m.t_us + 1, nf.num, nf.den)
          }
        }
      }
    }

    // Validate the CURRENT probe first, then fan out — atomicity: a rejected patch
    // must not leave half the envelope applied across the stack. Only the current
    // probe is validated: older snapshots are correct by construction (the recipe
    // re-snaps and floors per snapshot), and they were already valid at the rate
    // and content they hold.
    if (!canvasChanges && durationChange === undefined) return // empty patch → no event
    const probe = produce(cur, buildProbe)
    runValidate(probe)
    if (probe === cur) return // nothing actually moved → no op_id, no broadcast

    history.replaceCompositionEverywhere((p) => produce(p, buildProbe))
    broadcastUnrecorded(compositionSummary(fpsChanged, canvasChanges, durationChange !== undefined),
      current(), { kind: 'Composition' })
  }

  function fitCompositionToLayers(compositionId: Uuid | undefined): null {
    const probe = produce(current(), (d) => applyFitComposition(d, compositionId))
    runValidate(probe)
    if (probe === current()) return null // already unpinned and fitted → no event
    // A snapshot that predates the named Group has nothing to refit.
    history.replaceCompositionEverywhere((p) => compositionId !== undefined && !(compositionId in p.compositions) ? p : produce(p, (d) => applyFitComposition(d, compositionId)))
    broadcastUnrecorded('Fit composition duration to layers', current(), { kind: 'Composition' })
    return null
  }

  /** Event summary for an unrecorded composition patch. Unrecorded events never
   *  reach the history panel, so this is log/e2e-facing only — but the four
   *  strings are load-bearing in logs/e2e, so they stay verbatim. */
  function compositionSummary(fps: boolean, canvas: boolean, duration: boolean): string {
    if (fps) return 'Updated composition fps'
    if (canvas && duration) return 'Updated composition canvas and duration'
    if (canvas) return 'Updated composition canvas'
    return 'Updated composition duration'
  }
  /** Copy the present canvas fields of `patch` into a composition draft. */
  function applyCanvasFields(c: Composition, patch: Record<string, unknown>): void {
    if (typeof patch.width === 'number') c.width = patch.width
    if (typeof patch.height === 'number') c.height = patch.height
    if (patch.fps) c.fps = patch.fps as Rational
    if (typeof patch.sample_rate === 'number') c.sample_rate = patch.sample_rate
    if (typeof patch.channels === 'number') c.channels = patch.channels
    if (patch.color_space) c.color_space = patch.color_space as Composition['color_space']
    if (patch.background) c.background = patch.background as Composition['background']
  }

  // ── meta ──
  function undo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.undo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToUndo' })
    broadcastUnrecorded('Undo', snap)
  }
  function redo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.redo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToRedo' })
    broadcastUnrecorded('Redo', snap)
  }
  /** Random-access cursor move — the history panel's click-a-row action.
   *
   *  Takes the lock check FIRST, exactly like undo/redo/restore_checkpoint:
   *  jump_to is a revert path (it is undo/redo generalized), so without the check
   *  it would be a back door around the agent's revert lock. Records no entry.
   *
   *  Id burn mirrors undo/redo: a rejected jump (locked or out of range) consumes
   *  ZERO op_ids, a successful one burns exactly the broadcast's. An in-range jump
   *  to the CURRENT index is not a rejection — it succeeds and broadcasts, which
   *  costs one no-op refetch and keeps the arm free of a second no-op branch. */
  function jumpTo(index: number): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason }) // 0 ids
    const snap = history.jumpTo(index)
    if (snap === null) // 0 ids
      throw new CommandFailure({ error: 'InvalidArgument', field: 'index', detail: `history index ${index} outside [0, ${history.len()})` })
    broadcastUnrecorded('Jump to history entry', snap)
  }

  // ── checkpoints — used by the MCP checkpoint + begin_agent_session tools.
  //    checkpoint mints 1 id, no op/broadcast; restore success = 2 ids
  //    (entry op_id then broadcast op_id); CheckpointNotFound/HistoryLocked = 0. ──
  function checkpoint(label: string, cpActor: Actor = actor): Uuid {
    const id = idGen() // the checkpoint's own id — no commit, no broadcast
    return history.checkpoint(label, cpActor, id, clock())
  }
  function restoreCheckpoint(id: Uuid): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason }) // 0 ids
    if (!history.hasCheckpoint(id)) throw new CommandFailure({ error: 'CheckpointNotFound', checkpoint: id }) // 0 ids — peek BEFORE mint
    const opId = idGen() // entry op_id — minted FIRST
    const snap = history.restoreCheckpoint(id, opId, clock(), actor)!
    broadcastUnrecorded(`Restored checkpoint ${id}`, snap) // +1 broadcast id (the SECOND id)
  }
  /** Drop a checkpoint. Absent id → CheckpointNotFound, burning ZERO ids (same
   *  peek-before-mint convention restoreCheckpoint follows) — and here nothing is
   *  minted on the success path either: deleting a checkpoint changes no project
   *  state, so there is no snapshot to broadcast and autosave must not be woken.
   *  The panel that issued the delete refetches the view for itself.
   *
   *  NOT gated on lockReason(): the lock rejects REVERT paths (undo / redo /
   *  jump_to / restore_checkpoint — docs/features.md #undo-stack-scope) and this
   *  reverts nothing. */
  function deleteCheckpoint(id: Uuid): void {
    if (!history.deleteCheckpoint(id)) throw new CommandFailure({ error: 'CheckpointNotFound', checkpoint: id }) // 0 ids
  }
  function listCheckpoints(): Array<{ id: Uuid; label: string; actor: Actor; created_at: string }> {
    // list_checkpoints serializes history_view().checkpoints, which INCLUDES actor
    // — only the snapshot is dropped. The MCP path stores the agent actor.
    return history.listCheckpoints().map((c) => ({ id: c.id, label: c.label, actor: c.actor, created_at: c.created_at }))
  }

  // ── move_track — the cur===new no-op must skip
  //    commit; recording it would burn an op_id and drift every later id. ──
  function moveTrack(id: Uuid, newPosition: number): void {
    const curIdx = locateTrack(current(), id)?.trackIndex ?? -1
    if (curIdx >= 0 && curIdx === newPosition) return // no-op: no record, no broadcast
    commit(HISTORY_SUMMARY.trackMove, [{ kind: 'Track', id }], { kind: 'Coarse' }, (d) => applyMoveTrack(d, id, newPosition))
  }

  // ── update_track_flags — UNRECORDED.
  //    TrackNotFound first; then replace-everywhere + broadcast (burns one id,
  //    matching broadcast_unrecorded so the det counter stays aligned). ──
  function updateTrackFlags(id: Uuid, patch: TrackFlagsPatch): void {
    // Any composition: the history patch below searches them all too.
    if (!Object.values(current().compositions).some((c) => c.tracks.some((t) => t.id === id))) throw new CommandFailure({ error: 'TrackNotFound', track: id })
    history.replaceTrackFlagsEverywhere(id, patch)
    broadcastUnrecorded('Updated track flags', current())
  }

  // ── add_media_item — UNRECORDED. Insert into the
  //    pool (media id is the caller's, NOT counter-minted), validate the probe,
  //    then replace the pool EVERYWHERE (durable across undo) + broadcast (burns
  //    one id). No HistoryEntry. ──
  function addMediaItem(item: MediaItem): Uuid {
    const cur = current()
    const nextPool = { ...cur.media_pool, [item.id]: item }
    runValidate({ ...cur, media_pool: nextPool })
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Imported media', current())
    return item.id
  }

  // ── set_media_derivatives — UNRECORDED, NO
  //    validate. MediaNotFound first (no id); else patch the pool item, replace
  //    EVERYWHERE (durable across undo) + broadcast (1 id). ──
  function setMediaDerivatives(id: Uuid, patch: MediaDerivativesPatch): void {
    const nextPool = applySetMediaDerivatives(current().media_pool, id, patch) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media derivatives', current())
  }
  // ── set_media_workspace_paths — UNRECORDED. ──
  function setMediaWorkspacePaths(id: Uuid, paths: WorkspacePaths): void {
    const nextPool = applySetMediaWorkspacePaths(current().media_pool, id, paths) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media workspace paths', current())
  }
  // ── set_media_hash — UNRECORDED. Hash-first import:
  //    the standalone BLAKE3 pass sets the real source hash on the pool item
  //    before derivatives enqueue. Durable across undo (a content fact, not an
  //    edit). MediaNotFound first (no id); else patch + replace EVERYWHERE. ──
  function setMediaHash(id: Uuid, hash: string): void {
    const nextPool = applySetMediaHash(current().media_pool, id, hash) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media hash', current())
  }
  // ── remove_media — HYBRID. MediaNotFound → MediaInUse
  //    (when referenced && !force) → unused path (validate probe BEFORE broadcast,
  //    durable, 1 broadcast id) | force-cascade (RAW inline layer removal +
  //    commit, 1 op_id, undoable). The force path must NOT reuse applyDeleteLayer
  //    (no empty-track prune / no link cleanup). ──
  function removeMedia(id: Uuid, force: boolean): void {
    const cur = current()
    if (!(id in cur.media_pool)) throw new CommandFailure({ error: 'MediaNotFound', media: id })
    const referencing = referencingLayers(cur, id)
    if (referencing.length > 0 && !force) throw new CommandFailure({ error: 'MediaInUse', media: id, referenced_by: referencing })
    if (referencing.length === 0) {
      const nextPool = { ...cur.media_pool }
      delete nextPool[id]
      runValidate({ ...cur, media_pool: nextPool }) // validate-before-broadcast
      history.replaceMediaPoolEverywhere(nextPool)
      broadcastUnrecorded(`Removed media ${id}`, current())
      return
    }
    const affected: EntityRef[] = referencing.map((l) => ({ kind: 'Layer', id: l }))
    commit(removedMediaSummary(id, referencing.length), affected, { kind: 'Coarse' }, (d) => {
      for (const layerId of referencing) {
        for (const { track: t } of eachLayer(d)) {
          const idx = t.layers.findIndex((l) => l.id === layerId)
          if (idx >= 0) { t.layers.splice(idx, 1); break }
        }
      }
      delete d.media_pool[id]
    })
  }

  // ── set_role_gain — RECORDED (undoable). Read the
  //    role's mix bus (default-filled when absent), override ONLY gain_db
  //    (muted/solo preserved), reinsert. No affected entities, Coarse hint. ──
  function setRoleGain(role: string, gainDb: number): void {
    commit(roleGainSummary(role), [], { kind: 'Coarse' }, (d) => {
      const cur = d.audio_roles[role]
      d.audio_roles[role] = { gain_db: gainDb, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
    })
  }

  // ── update_role_flags — UNRECORDED (mirrors
  //    updateTrackFlags). Patch mute/solo into EVERY snapshot + broadcast (burns
  //    one id). Roles always exist (default-filled), so no not-found branch. ──
  function updateRoleFlags(role: string, patch: RoleFlagsPatch): void {
    history.replaceRoleFlagsEverywhere(role, patch)
    broadcastUnrecorded('Updated role flags', current())
  }

  // ── update_project_settings — UNRECORDED.
  //    Clone settings, apply the present fields, replace-everywhere + broadcast. ──
  function updateProjectSettings(patch: {
    prefer_proxies?: boolean | null
    proxy_override?: { media_id: string; value: boolean | null } | null
    shot_review?: { sensitivity: number; min_shot_us: number } | null
  }): void {
    // Validated whole or refused whole, against the SAME bounds
    // `reduce_shot_report` enforces at the napi boundary — so a pair that
    // persists is a pair next session's reduce will accept, and a bad one is
    // named here rather than surfacing as a failed reduce much later.
    function reviewedShotParams(v: unknown): { sensitivity: number; min_shot_us: number } | null {
      if (v === null) return null
      const o = v as { sensitivity?: unknown; min_shot_us?: unknown }
      if (typeof o !== 'object' || typeof o.sensitivity !== 'number' || !Number.isFinite(o.sensitivity) || o.sensitivity < 0 || o.sensitivity > 1)
        throw new CommandFailure({ error: 'InvalidArgument', field: 'shot_review.sensitivity', detail: `sensitivity ${String(o?.sensitivity)} must be a finite number in [0, 1]` })
      if (typeof o.min_shot_us !== 'number' || !Number.isSafeInteger(o.min_shot_us) || o.min_shot_us <= 0)
        throw new CommandFailure({ error: 'InvalidArgument', field: 'shot_review.min_shot_us', detail: `min_shot_us ${String(o.min_shot_us)} must be a positive whole number of microseconds` })
      return { sensitivity: o.sensitivity, min_shot_us: o.min_shot_us }
    }
    const next = { ...current().settings, proxy_overrides: { ...current().settings.proxy_overrides } }
    if (typeof patch.prefer_proxies === 'boolean') next.prefer_proxies = patch.prefer_proxies
    if (patch.proxy_override) {
      const { media_id, value } = patch.proxy_override
      if (value === null) delete next.proxy_overrides[media_id]
      else next.proxy_overrides[media_id] = value
    }
    // Absent = not in this patch; `null` = clear the tuning and fall back to
    // the detector's defaults. The refusal above happens BEFORE the replace,
    // so a rejected patch leaves every snapshot untouched.
    if (patch.shot_review !== undefined) next.shot_review = reviewedShotParams(patch.shot_review)
    history.replaceSettingsEverywhere(next)
    broadcastUnrecorded('Updated project settings', current())
  }

  // ── replace_state — wholesale project swap. validate
  //    FIRST (a failure mints NO id and leaves history intact); on success reset
  //    history to a single 'Initial' entry (drops the old project's snapshots +
  //    checkpoints + lock — they reference a different project_id) then broadcast
  //    unrecorded. modified_at is NOT touched. Mints exactly 2 ids on success
  //    (reset op_id + broadcast event id); a caller that built `next` via
  //    blankProject already spent its 4 ids → 6 total. ──
  function replaceState(next: Project): void {
    runValidate(next)                              // throws CommandFailure(ValidationFailed); no id spent
    history.reset(next, actor, idGen(), clock())   // +1 id (the 'Initial' op_id)
    broadcastUnrecorded('Replaced project state', current())  // +1 id (the event op_id)
  }

  function dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> {
    const results: Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> = []
    let scratch = current()
    for (const op of ops) {
      try {
        let value: DryRunOutput = { kind: 'Void' }
        const next = produce(scratch, (d) => {
          switch (op.kind) {
            case 'AddLayer': value = { kind: 'AddLayer', layer_id: applyAddLayer(d, idGen, op.track_id, op.params, op.t_start_us, op.t_end_us) }; break
            case 'DeleteLayer': applyDeleteLayer(d, op.id); break
            case 'UpdateLayer': applyUpdateLayer(d, op.id, op.patch); break
            case 'UpdateLayerParams': applyUpdateLayerParams(d, op.id, op.patch, motifCatalog); break
            case 'MoveLayer': applyMoveLayer(d, op.id, op.new_track_id, op.new_t_start_us, op.escape_link); break
            case 'SplitLayer': { const s = applySplitLayer(d, idGen, op.id, op.at_t_us, op.escape_link); value = { kind: 'SplitLayer', left_id: s.left, right_id: s.right }; break }
            case 'TrimLayer': applyTrimLayer(d, op.id, op.edge, op.new_t_us, op.escape_link); break
            // The SAME apply the wet arm runs, so moves, bounces, spawns and
            // refusals are predicted by one code path (bounces are primitives —
            // safe to carry out of the discarded draft).
            case 'AddTransition': { const r = applyAddTransition(d, idGen, op.from, op.to, op.duration_us, op.transition_kind, op.placement); value = { kind: 'AddTransition', transition_id: r.id, bounces: r.bounces }; break }
          }
          // Same point as commit(): after the recipe, before validate — so a
          // dry-run of an edit that breaks a transition predicts the real
          // succeed-with-drop outcome instead of a spurious ValidationFailed.
          // Drop info is discarded: DryRunOutput has no vocabulary for it.
          reconcileTransitions(d)
        })
        runValidate(next)
        scratch = next
        results.push({ ok: true, value })
      } catch (e) {
        if (e instanceof CommandFailure) { results.push({ ok: false, error: e.err }); break } // halt at first error
        throw e
      }
    }
    return results
  }

  // ── string dispatch — the op-name core that command(), mcpCall() and the unit
  //    tests all route through. ──
  function dispatch(channel: string, a: Record<string, unknown>): DispatchResult {
    try {
      switch (channel) {
        case 'add_layer': {
          const kind = a.kind as string
          let params: LayerParams
          // Size-dependent defaults read the composition the TRACK lives in,
          // never the root: a Group carries its own canvas, so centring a text
          // layer on the root frame would place it outside a smaller one.
          const into = () => requireTrack(current(), a.track as Uuid).comp
          switch (kind) {
            case 'text': params = textParamsDefault('hello', into()); break
            case 'color': { const c = into(); params = colorParams({ r: 255, g: 0, b: 0, a: 255 }, c.width, c.height); break }
            case 'video': params = videoClipParams(a.media as Uuid, parseNum(a.src_in_us, 'src_in_us'), parseNum(a.src_out_us, 'src_out_us')); break
            // Optional `role` override (default 'music'): mirrors the add-layer-site
            // role stamp at actor.ts add_media_layer auto-pair (role:'dialogue') and the
            // synthesize_speech hybrid (role:'voiceover').
            case 'audio': params = a.role
              ? { ...audioParams(a.media as Uuid, parseNum(a.src_in_us, 'src_in_us'), parseNum(a.src_out_us, 'src_out_us')), role: a.role as AudioRole }
              : audioParams(a.media as Uuid, parseNum(a.src_in_us, 'src_in_us'), parseNum(a.src_out_us, 'src_out_us')); break
            case 'image': params = imageOverlayParams(a.media as Uuid); break
            case 'Motif': params = { kind: 'Motif', motif_id: a.motif_id as string, motif_version: a.motif_version as number, props: (a.props ?? {}) as Record<string, unknown>, src_in_us: 0, transform: defaultTransform(), opacity: { mode: 'Static', value: 1 } }; break
            default: return { ok: false, error: { error: 'InvalidArgument', field: 'kind', detail: `unknown kind ${kind}` } }
          }
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, a.track as Uuid, params, parseNum(a.t_start_us, 't_start_us'), parseNum(a.t_end_us, 't_end_us')))
          return { ok: true, value: id }
        }
        // Creation ops take `composition_id?` (root by default) — the ONLY ops
        // that carry a scope; everything layer-addressed derives it (ADR 0052).
        case 'add_track': { const comp = compositionArg(a); return { ok: true, value: commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, (a.label as string) ?? null, undefined, comp)) } }
        // `anchor` rides the ADD for the same reason `add_markers` takes one per
        // row: the mark and its tie are one gesture, and splitting them into an
        // add plus an attach would put an undo step between a marker and the clip
        // it was born on. Taken on trust exactly as `add_markers` takes its rows —
        // the caller derives `t_us` from the anchor it supplies, and this commit's
        // reconcile re-derives it right back.
        case 'add_marker': { const comp = compositionArg(a); return { ok: true, value: commit(HISTORY_SUMMARY.markerAdd, markerRef, { kind: 'Coarse' }, (d) => applyAddMarker(d, idGen, parseNum(a.t_us, 't_us'), parseNumOpt(a.end_t_us, 'end_t_us') ?? null, (a.label as string) ?? 'm', { r: 0, g: 128, b: 255, a: 255 }, comp, undefined, (a.anchor as MarkerAnchor | null | undefined) ?? null)) } }
        case 'move_layer': commit(HISTORY_SUMMARY.layerMove, layerRef(a.layer as Uuid), { kind: 'Coarse' }, (d) => applyMoveLayer(d, a.layer as Uuid, a.to_track as Uuid, parseNum(a.t_start_us, 't_start_us'), (a.escape_link as boolean) ?? false)); return { ok: true, value: null }
        // move_layers_to_new_track — the whole of z-order rearrangement (ADR 0042
        // decision 2). ONE commit: the lane is minted, the layers move onto it,
        // and every lane the raise emptied goes with them, so one undo restores
        // all of it. `affected` takes commit's function form because the lane's
        // id is minted inside the recipe.
        //
        // `anchor_layer_id` + `t_start_us` are the drop strip's landing and travel
        // TOGETHER: the pair is one value on the wire's flat shape, so half of it
        // is a malformed request rather than a defaultable field. Both absent is
        // the raise that names no time (the *Move to a new track* command's).
        case 'move_layers_to_new_track': {
          const layers = a.layers as Uuid[]
          const anchorLayerId = (a.anchor_layer_id as Uuid | null | undefined) ?? null
          const anchorTStartUs = parseNumOpt(a.t_start_us, 't_start_us') ?? null
          if ((anchorLayerId === null) !== (anchorTStartUs === null)) {
            return { ok: false, error: { error: 'InvalidArgument', field: anchorLayerId === null ? 'anchor_layer_id' : 't_start_us',
              detail: 'a landing needs both anchor_layer_id and t_start_us; omit both to keep every time verbatim' } }
          }
          const anchor = anchorLayerId === null || anchorTStartUs === null
            ? null
            : { layerId: anchorLayerId, tStartUs: anchorTStartUs }
          return { ok: true, value: commit(HISTORY_SUMMARY.layerMoveToNewTrack,
            (newTrackId: Uuid) => [...layerRefs(layers), { kind: 'Track', id: newTrackId }],
            { kind: 'Coarse' }, (d) => applyMoveLayersToNewTrack(d, idGen, layers, anchor)) }
        }
        // restack_layer — anchored z-reorder (ADR 0044): ONE commit. Degradation
        // and the destination-or-null return contract are applyRestackLayer's
        // story (mutations/restack.ts). Here, `affected` takes the function form
        // because the split path mints its track inside the recipe; null trips
        // commit's no-op guard (nothing recorded, no op_id — the move_track
        // contract), so the null arm is unreachable but keeps the annotation
        // honest.
        case 'restack_layer': {
          const layer = a.layer as Uuid
          commit(HISTORY_SUMMARY.layerRestack,
            (destTrack: Uuid | null) => destTrack === null ? layerRef(layer) : [...layerRef(layer), ...trackRef(destTrack)],
            { kind: 'Coarse' },
            (d) => applyRestackLayer(d, idGen, layer, a.anchor as Uuid, a.position as RestackPosition))
          return { ok: true, value: null }
        }
        case 'trim_layer': commit(HISTORY_SUMMARY.layerTrim, layerRef(a.layer as Uuid), { kind: 'Coarse' }, (d) => applyTrimLayer(d, a.layer as Uuid, ((a.edge as string) === 'out' ? 'Out' : 'In'), parseNum(a.new_t_us, 'new_t_us'), (a.escape_link as boolean) ?? false)); return { ok: true, value: null }
        case 'delete_layer': commit(HISTORY_SUMMARY.layerDelete, layerRef(a.layer as Uuid), { kind: 'Coarse' }, (d) => applyDeleteLayer(d, a.layer as Uuid)); return { ok: true, value: null }
        // The SELECTION's delete, and the marquee's headline gesture: N swept
        // clips must cost ONE undo entry, which the singular form above cannot
        // give because it has no batch to record. `Coarse` for the same reason
        // update_param_tracks_multi is — the `Layer` hint carries a single id and
        // cannot name a change spanning several.
        //
        // The recipe is the loop and nothing else. applyDeleteLayer already drops
        // the layer from its link (auto-dissolving below 2 members), prunes the
        // track it emptied and re-runs the duration autofit on EVERY call, so a
        // batch that empties three lanes prunes three lanes with no extra
        // bookkeeping here.
        //
        // Ids are DE-DUPLICATED first: the second applyDeleteLayer for one id
        // finds nothing and throws LayerNotFound, which would turn a harmless
        // duplicate in the caller's set into a failed gesture.
        //
        // A throw aborts the WHOLE batch — produce discards the draft, so nothing
        // is deleted and nothing records. That atomicity is the right behaviour
        // rather than a partial delete: checkTrackLock is the realistic thrower,
        // and no selection a user can build holds a locked layer (a locked clip
        // cannot be clicked, the marquee skips it, and Select All excludes rather
        // than refuses it — docs/features.md § Select All). A TrackLocked here
        // therefore means the caller sent a set the UI cannot produce.
        //
        // Empty `layers` leaves the draft untouched, so commit's no-op guard
        // records nothing. The set is ONE composition's (CrossCompositionSet
        // otherwise) — a selection never spans two, and the check runs before
        // the first delete so a refusal leaves everything in place.
        case 'delete_layers': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          commit(HISTORY_SUMMARY.layerDeleteMulti, layerRefs(layers), { kind: 'Coarse' }, (d) => {
            if (layers.length > 0) requireSameComposition(d, layers)
            for (const layer of layers) applyDeleteLayer(d, layer)
          })
          return { ok: true, value: null }
        }
        case 'duplicate_layer': return { ok: true, value: commit(HISTORY_SUMMARY.layerDuplicate, layerRef, { kind: 'Coarse' }, (d) => applyDuplicateLayer(d, idGen, a.layer as Uuid, parseNum(a.t_offset_us, 't_offset_us'))) }
        // paste_layers — the whole-link duplicate. `t_start_us` is where the SEED's
        // clone starts; the shared delta is measured from the seed on the
        // pre-mutation snapshot so a drop position and an agent's request mean the
        // same thing. One commit: one undo removes every clone and their link.
        // Empty `layers` is a caller bug, not a no-op — there is no seed to
        // measure from.
        case 'paste_layers': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          if (layers.length === 0) return { ok: false, error: { error: 'InvalidArgument', field: 'layers', detail: 'at least one layer is required' } }
          const seedLoc = locateLayer(current(), layers[0])
          if (!seedLoc) return { ok: false, error: { error: 'LayerNotFound', layer: layers[0] } }
          const deltaUs = parseNum(a.t_start_us, 't_start_us') - seedLoc.layer.t_start_us
          const targetTrackId = (a.target_track_id as Uuid | null | undefined) ?? null
          const clones = commit(pastedLayersSummary(layers.length), (m: Map<Uuid, Uuid>) => layerRefs([...m.values()]), { kind: 'Coarse' },
            (d) => applyPasteLayers(d, idGen, layers, deltaUs, targetTrackId))
          return { ok: true, value: { clones: layers.map((source) => ({ source, clone: clones.get(source)! })) } }
        }
        // set_layers_enabled — the caller's set, verbatim (the renderer hands it a
        // link's members when the toggle fans out). One entry; a set already in
        // the requested state leaves the draft untouched and records nothing.
        case 'set_layers_enabled': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          const enabled = parseBool(a.enabled, 'enabled')
          commit(layersEnabledSummary(enabled, layers.length), layerRefs(layers), { kind: 'Coarse' }, (d) => applySetLayersEnabled(d, layers, enabled))
          return { ok: true, value: null }
        }
        case 'set_composition': setComposition(a); return { ok: true, value: null }
        case 'undo': undo(); return { ok: true, value: null }
        case 'redo': redo(); return { ok: true, value: null }
        case 'jump_to': jumpTo(parseNum(a.index, 'index')); return { ok: true, value: null }
        case 'restore_checkpoint': restoreCheckpoint(parseUuid(a.checkpoint_id, 'checkpoint_id')); return { ok: true, value: null }
        // create/delete_checkpoint have no MCP twin: the agent's checkpoint tools
        // are served in mcpCall's own switch (MCP_ACTOR-stamped). These are the
        // renderer's User-actor path — `checkpoint()` defaults cpActor to this
        // actor, which is `{kind:'User'}` for the production instance.
        case 'create_checkpoint': {
          const label = parseStr(a.label, 'label')
          if (label.trim() === '') throw new CommandFailure({ error: 'InvalidArgument', field: 'label', detail: 'label must be non-empty' }) // 0 ids
          return { ok: true, value: checkpoint(label) }
        }
        case 'delete_checkpoint': deleteCheckpoint(parseUuid(a.checkpoint_id, 'checkpoint_id')); return { ok: true, value: null }
        case 'split_layer': return { ok: true, value: commit(HISTORY_SUMMARY.layerSplit, (s: { left: Uuid; right: Uuid }) => layerRefs([s.left, s.right]), { kind: 'Coarse' }, (d) => applySplitLayer(d, idGen, a.layer as Uuid, parseNum(a.at_t_us, 'at_t_us'), (a.escape_link as boolean) ?? false)) }
        // split_layer_multi — coalesced multi-split for the shot-apply hybrids:
        // split `layer` at every ascending, strictly-interior timeline time in
        // `at_t_us_list` inside ONE commit, so a whole shot-split is a single
        // undo (mirrors update_layer_param_tracks' one-commit batch).
        // Each split's RIGHT half carries forward to the next cut; link-aware
        // (escape_link=false) so an auto-paired audio partner splits in lockstep
        // with the video. Cuts arrive pre-snapped from resolveShotCuts, but each
        // is re-checked against the CURRENT segment bounds and a non-interior one
        // is SKIPPED (not thrown), so a redundant/collapsed cut can never abort
        // the whole batch.
        // Two deletes ride the SAME commit, so a split and whatever it throws
        // away are one undo entry: `drop_short_us` deletes any resulting VIDEO
        // segment shorter than it, and `discard_segments` deletes the ones the
        // caller named (parseDiscardSegments owns the numbering and the
        // refusals). A segment that is both short and named is deleted once.
        // applyDeleteLayer honors empty-track cleanup for both.
        // Either delete FANS OUT across the target's link: every other member
        // OVERLAPPING the rejected segment's half-open span goes with it, so a
        // dropped or discarded take takes its paired audio along. Those pieces
        // exist only because the split in this very commit cut them; keeping
        // the audio a rejected take cut off is a half-result nobody asked for.
        // Overlap and not exact co-span, so a slipped-sync partner still
        // travels; overlap and not "every member", so a manual bundle member
        // sitting wholly inside a KEPT segment stays. `delete_layer` itself is
        // still local — this is the shot-apply's own reach, not a link rule
        // (docs/features.md § Links). A partner on a locked track fails the
        // whole op through applyDeleteLayer's own checkTrackLock and the commit
        // rolls back atomically, which IS § Links' "locks reject the whole op":
        // no special casing here.
        // Returns the ordered target segment layer ids that survived.
        case 'split_layer_multi': {
          const layer = a.layer as Uuid
          const ats = (a.at_t_us_list as number[]) ?? []
          const dropShortUs = parseNumOpt(a.drop_short_us, 'drop_short_us') ?? null
          // Refused BEFORE the commit opens: a split whose deletes turned out to
          // be unaskable is not a state any undo entry could describe.
          let discardIdx: number[] = []
          if (a.discard_segments !== undefined && a.discard_segments !== null) {
            const parsed = parseDiscardSegments(a.discard_segments, ats.length + 1)
            if (!parsed.ok) return { ok: false, error: { error: 'InvalidArgument', field: 'discard_segments', detail: parsed.detail } }
            discardIdx = parsed.value
          }
          return { ok: true, value: commit(HISTORY_SUMMARY.layerSplitByShots, layerRefs, { kind: 'Coarse' }, (d) => {
            let currentId = layer
            const ids: Uuid[] = []
            // Which segment actually carries each NOMINAL index — the numbering
            // the caller counted off the cut list. A skipped cut merges two
            // nominal segments into one real one, and without this map every
            // index past the skip would name a neighbour of what was unchecked.
            const carrier: Uuid[] = []
            for (let i = 0; i < ats.length; i++) {
              const at = ats[i]
              // Re-snap on the CURRENT SEGMENT's own grid and skip a cut that no
              // longer falls strictly inside it — defensive against a redundant cut so
              // applySplitLayer never rejects mid-batch. The segment must be located
              // first because the grid depends on its kind (spec R2-D6); shot splits
              // target video, but this op is reachable for any kind.
              const loc = locateLayer(d, currentId)
              const seg = loc ? loc.layer : null
              if (!seg) continue
              const atSnapped = snapOnGrid(parseNum(at, 'at_t_us'), gridForLayerKind(seg.params.kind, loc!.comp.fps))
              if (atSnapped <= seg.t_start_us || atSnapped >= seg.t_end_us) continue
              const { left, right } = applySplitLayer(d, idGen, currentId, atSnapped, false)
              while (carrier.length <= i) carrier.push(left)
              ids.push(left)
              currentId = right
            }
            while (carrier.length <= ats.length) carrier.push(currentId)
            ids.push(currentId)
            const discarded = new Set(discardIdx.map((i) => carrier[i]))
            if (dropShortUs === null && discarded.size === 0) return ids
            const kept: Uuid[] = []
            const targets = new Set(ids)
            for (const id of ids) {
              const loc = locateLayer(d, id)
              const seg = loc?.layer ?? null
              const short = seg !== null && dropShortUs !== null && seg.t_end_us - seg.t_start_us < dropShortUs
              if (!seg || !(short || discarded.has(id))) { kept.push(id); continue }
              // Read the link BEFORE this segment's own delete: a link
              // auto-dissolves below two members, so a two-member pair would
              // have no siblings left to read afterwards.
              const partners = linkSiblingsExcluding(loc!.comp, id).filter((sid) => {
                if (targets.has(sid)) return false // never another segment of the target
                const s = locateLayer(d, sid)?.layer
                return s !== undefined && s.t_start_us < seg.t_end_us && s.t_end_us > seg.t_start_us
              })
              applyDeleteLayer(d, id)
              // Defensive re-locate: no partner should overlap two rejected
              // segments, since a member spanning a cut was split at it — but a
              // stale id here would throw LayerNotFound and abort the whole
              // apply, so the list is checked rather than trusted.
              for (const sid of partners) if (locateLayer(d, sid)) applyDeleteLayer(d, sid)
            }
            return kept
          }) }
        }
        // add_markers — coalesced multi-marker drop for shot-boundary
        // materialization (the human/agent shot-marker surface): add every row in
        // `markers` inside ONE commit so a whole boundary set is a single undo.
        // Each row reuses applyAddMarker (same as the add_marker arm); color/label
        // default to the shot-marker style. Returns the new marker ids in order.
        //
        // Scope and tie sit at DIFFERENT levels, and neither placement is
        // arbitrary. `composition_id` is per BATCH because a marker's composition
        // is the composition being marked — one dispatch marks one timeline, the
        // same way add_marker does. `anchor` is per ROW because an anchor is a
        // layer AND a source instant inside it: a shot set shares the layer but
        // every row carries its own `src_us`, and hoisting the layer alone would
        // split one indivisible tie across two levels. The caller owns deriving
        // `t_us` from its own anchor (nothing here does); validate owns whether
        // the layer named is in this composition and can carry an anchor at all.
        case 'add_markers': {
          const rows = (a.markers as Array<{ t_us: number; end_t_us?: number | null; label?: string; color?: Rgba; anchor?: MarkerAnchor | null }>) ?? []
          const comp = compositionArg(a)
          return { ok: true, value: commit(HISTORY_SUMMARY.markerAddShots, markerRefs, { kind: 'Coarse' }, (d) =>
            rows.map((m) => applyAddMarker(d, idGen, parseNum(m.t_us, 't_us'), m.end_t_us ?? null, m.label ?? 'Shot', m.color ?? { r: 0, g: 128, b: 255, a: 255 }, comp, undefined, m.anchor ?? null))) }
        }
        case 'links_create': return { ok: true, value: commit(HISTORY_SUMMARY.linkCreate, layerRefs(a.layers as Uuid[]), { kind: 'Coarse' }, (d) => applyLinksCreate(d, idGen, a.layers as Uuid[], (a.label as string) ?? null, (a.reassign as boolean) ?? false)) }
        case 'links_dissolve': commit(HISTORY_SUMMARY.linkDissolve, linkMemberRefs(a.link as Uuid), { kind: 'Coarse' }, (d) => applyLinksDissolve(d, a.link as Uuid)); return { ok: true, value: null }
        case 'links_add_members': commit(HISTORY_SUMMARY.linkAddMembers, layerRefs(a.layers as Uuid[]), { kind: 'Coarse' }, (d) => applyLinksAddMembers(d, a.link as Uuid, a.layers as Uuid[], (a.reassign as boolean) ?? false)); return { ok: true, value: null }
        case 'links_remove_members': commit(HISTORY_SUMMARY.linkRemoveMembers, layerRefs(a.layers as Uuid[]), { kind: 'Coarse' }, (d) => applyLinksRemoveMembers(d, a.link as Uuid, a.layers as Uuid[])); return { ok: true, value: null }
        case 'links_rename': commit(HISTORY_SUMMARY.linkRename, linkMemberRefs(a.link as Uuid), { kind: 'Coarse' }, (d) => applyLinksRename(d, a.link as Uuid, (a.label as string) ?? null)); return { ok: true, value: null }
        // Groups (ADR 0052) — one commit each; the row points at the Group layer,
        // and at the members too where the op has a set of them. The result is
        // ONE shape always (not the branch-dependent shape add_video_layer has),
        // so a caller never sniffs it.
        case 'groups_create': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          const r = commit(groupCreateSummary(layers.length), (g: GroupCreateResult) => layerRef(g.layerId), { kind: 'Coarse' },
            (d) => applyGroupsCreate(d, idGen, layers, (a.label as string | null) ?? null))
          return { ok: true, value: { composition_id: r.compositionId, layer_id: r.layerId } }
        }
        case 'groups_add_members': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          const groupLayer = a.group_layer as Uuid
          commit(groupAddMembersSummary(layers.length), layerRefs([...layers, groupLayer]), { kind: 'Coarse' },
            (d) => applyGroupsAddMembers(d, idGen, layers, groupLayer))
          return { ok: true, value: null }
        }
        // The same crossing named absolutely rather than measured off a Group
        // clip (mutations/moveToComposition.ts). The row names the members
        // ALONE — a composition has no `EntityRef`, and the destination need
        // hold no clip to point at — so the destination's NAME rides in the
        // summary instead, resolved out here where an unknown id still refuses
        // before the draft is opened.
        case 'move_layers_to_composition': {
          const layers = [...new Set((a.layers as Uuid[]) ?? [])]
          const anchor = parseUuid(a.anchor_layer, 'anchor_layer')
          const anchorTStartUs = parseNum(a.anchor_t_start_us, 'anchor_t_start_us')
          // `'spawn'` is a literal, so only the third shape is a uuid.
          const toTrack: Uuid | 'spawn' | null = a.to_track === undefined || a.to_track === null
            ? null
            : a.to_track === 'spawn' ? 'spawn' : parseUuid(a.to_track, 'to_track')
          const dest = compositionOf(current(), parseUuid(a.to_composition, 'to_composition'))
          commit(moveToCompositionSummary(layers.length, dest.label), layerRefs(layers), { kind: 'Coarse' },
            (d) => applyMoveLayersToComposition(d, idGen, layers, dest.id, anchor, anchorTStartUs, toTrack))
          return { ok: true, value: null }
        }
        // Placing an existing composition: a creation op, so it carries a scope —
        // but `track` already fixes the composition, which makes `composition_id`
        // the cross-check add_video_layer's is. The row is a plain layer add,
        // because that is what this does: pre-compose is the op that makes a Group.
        case 'add_group_layer': {
          const track = parseUuid(a.track, 'track')
          checkTrackInComposition(track, compositionArg(a) ?? null)
          const source = parseUuid(a.source_composition, 'source_composition')
          const t0 = parseNum(a.t_start_us, 't_start_us')
          return { ok: true, value: commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddGroupLayer(d, idGen, source, track, t0)) }
        }
        case 'groups_ungroup': commit(HISTORY_SUMMARY.groupUngroup, layerRef(a.layer as Uuid), { kind: 'Coarse' }, (d) => applyGroupsUngroup(d, idGen, a.layer as Uuid)); return { ok: true, value: null }
        case 'groups_rename': commit(HISTORY_SUMMARY.groupRename, compositionRefLayers(a.composition as Uuid), { kind: 'Coarse' }, (d) => applyGroupsRename(d, a.composition as Uuid, (a.label as string | null) ?? null)); return { ok: true, value: null }
        // Nothing references a deletable composition, so there is no layer to name.
        case 'compositions_delete': commit(HISTORY_SUMMARY.compositionDelete, [], { kind: 'Coarse' }, (d) => applyCompositionsDelete(d, a.composition as Uuid)); return { ok: true, value: null }
        case 'update_layer': commit(HISTORY_SUMMARY.layerUpdate, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayer(d, a.layer as Uuid, a.patch as LayerPatch)); return { ok: true, value: null }
        // The four commands below end with the scale-link invariant check
        // (mutations/scaleLink.ts): result-based, so it runs once per COMMIT —
        // the plural batch is legitimately mid-divergence between its scale_x
        // and scale_y entries, and a per-entry check would unlink every linked
        // fan-out write.
        case 'update_layer_params': commit(HISTORY_SUMMARY.layerUpdateParams, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => { applyUpdateLayerParams(d, a.layer as Uuid, a.patch as LayerParamsPatch, motifCatalog); enforceScaleLinkInvariant(d, a.layer as Uuid) }); return { ok: true, value: null }
        case 'update_layer_param_track': commit(HISTORY_SUMMARY.layerKeyframeParam, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => { applyUpdateLayerParamTrack(d, a.layer as Uuid, a.param_key as string, a.track as Animated<number>); enforceScaleLinkInvariant(d, a.layer as Uuid) }); return { ok: true, value: null }
        case 'update_layer_param_tracks': commit(HISTORY_SUMMARY.layerKeyframeParams, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => { for (const [k, t] of a.entries as [string, Animated<number>][]) applyUpdateLayerParamTrack(d, a.layer as Uuid, k, t); enforceScaleLinkInvariant(d, a.layer as Uuid) }); return { ok: true, value: null }
        // The cross-LAYER form of the batch above, and the keyframe marquee's op:
        // one sub-lane row draws the diamonds of every layer on its track, so a
        // swept selection spans layers and the per-layer form would spend an undo
        // entry each. `Coarse` because the `Layer` hint carries a single id and
        // cannot name a multi-layer change. Empty `entries` leaves the draft
        // untouched, so commit's no-op guard records nothing.
        case 'update_param_tracks_multi': {
          const entries = (a.entries as [Uuid, string, Animated<number>][]) ?? []
          const layers = [...new Set(entries.map(([layer]) => layer))]
          commit(HISTORY_SUMMARY.layerKeyframeParamsMulti, layerRefs(layers), { kind: 'Coarse' }, (d) => {
            for (const [layer, key, track] of entries) applyUpdateLayerParamTrack(d, layer, key, track)
            // Once per DISTINCT layer, after every entry has landed. The check is
            // per layer, so hoisting it into the loop above would re-run it for
            // each of that layer's entries and would read exactly the half-applied
            // twin pair the note above forbids — now reachable across layers.
            for (const layer of layers) enforceScaleLinkInvariant(d, layer)
          })
          return { ok: true, value: null }
        }
        case 'set_scale_linked': commit((a.linked as boolean) ? HISTORY_SUMMARY.layerScaleLink : HISTORY_SUMMARY.layerScaleUnlink, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applySetScaleLinked(d, idGen, a.layer as Uuid, a.linked as boolean)); return { ok: true, value: null }
        // Clearing the pin is the inverse of set_composition{duration_us} and rides
        // the same unrecorded fan-out. Per snapshot it means "unpin, then refit to
        // MY OWN layer high-water mark" — the snapshot with the long layer keeps its
        // long duration, the one with none collapses to zero. A single fitted value
        // copied everywhere would be wrong for every snapshot but the current.
        case 'fit_composition_to_layers': return { ok: true, value: fitCompositionToLayers(compositionArg(a)) }
        case 'update_marker': commit(HISTORY_SUMMARY.markerUpdate, [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateMarker(d, a.marker as Uuid, a.patch as MarkerPatch)); return { ok: true, value: null }
        case 'remove_marker': commit(HISTORY_SUMMARY.markerRemove, [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveMarker(d, a.marker as Uuid)); return { ok: true, value: null }
        // The anchor is set and cleared HERE and nowhere else — `update_marker`'s
        // patch refuses the field (`parseMarkerPatch`), so an anchor can never be
        // established as a side effect of editing something else. Both rows point
        // at the Marker: what changed is the marker's tie, not the layer.
        case 'attach_marker': commit(HISTORY_SUMMARY.markerAttach, [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyAttachMarker(d, a.marker as Uuid, a.layer as Uuid)); return { ok: true, value: null }
        case 'detach_marker': commit(HISTORY_SUMMARY.markerDetach, [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyDetachMarker(d, a.marker as Uuid)); return { ok: true, value: null }
        case 'delete_track': commit(HISTORY_SUMMARY.trackDelete, [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyDeleteTrack(d, a.track as Uuid, (a.force as boolean) ?? false)); return { ok: true, value: null }
        case 'move_track': moveTrack(a.track as Uuid, parseNum(a.new_position, 'new_position')); return { ok: true, value: null }
        // RECORDED, unlike the flags patch below: a name is content, and the
        // layer label is already recorded — two rename surfaces with opposite
        // undo behaviour would be indefensible (ADR 0042). The Track ref is what
        // makes the row name the lane it renamed.
        case 'rename_track': commit(HISTORY_SUMMARY.trackRename, [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyRenameTrack(d, a.track as Uuid, (a.label as string) ?? null)); return { ok: true, value: null }
        case 'update_track_flags': updateTrackFlags(a.track as Uuid, a.patch as TrackFlagsPatch); return { ok: true, value: null }
        case 'add_effect': return { ok: true, value: commit(HISTORY_SUMMARY.effectAdd, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyAddEffect(d, idGen, a.layer as Uuid, a.kind as string)) }
        case 'update_effect': commit(HISTORY_SUMMARY.effectUpdate, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateEffect(d, a.layer as Uuid, a.effect as Uuid, a.patch as EffectPatch)); return { ok: true, value: null }
        case 'move_effect': commit(HISTORY_SUMMARY.effectReorder, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyMoveEffect(d, a.layer as Uuid, a.effect as Uuid, parseNum(a.new_index, 'new_index'))); return { ok: true, value: null }
        case 'remove_effect': commit(HISTORY_SUMMARY.effectRemove, [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveEffect(d, a.layer as Uuid, a.effect as Uuid)); return { ok: true, value: null }
        case 'add_transition': {
          // kind/direction/placement parsed BEFORE commit — a bad enum combo
          // burns no op_id. Absent kind defaults to Crossfade; absent placement
          // to 'overlap' (spec D1).
          const kind = parseTransitionKind(a.kind ?? 'Crossfade', a.direction)
          const placement = parseTransitionPlacement(a.placement)
          // Bounce info rides out via closure, NOT commit's return value: the
          // wire/MCP shape stays "the new transition id". Primitives only —
          // the recipe's draft is revoked once produce returns.
          let bounces: TransitionBounce[] = []
          const id = commit(HISTORY_SUMMARY.transitionAdd, layerRefs([a.from as Uuid, a.to as Uuid]), { kind: 'Coarse' }, (d) => {
            const r = applyAddTransition(d, idGen, a.from as Uuid, a.to as Uuid, parseNum(a.duration_us, 'duration_us'), kind, placement)
            bounces = r.bounces
            return r.id
          })
          logTransitionBounces(bounces) // after commit — a rejected add logs nothing
          return { ok: true, value: id }
        }
        case 'update_transition': {
          const kind = parseTransitionKindOpt(a.kind, a.direction)
          const patch: { duration_us?: number; kind?: TransitionKind; extended_us?: number } = {}
          const dur = parseNumOpt(a.duration_us, 'duration_us')
          if (dur !== undefined) patch.duration_us = dur
          const ext = parseNumOpt(a.extended_us, 'extended_us')
          if (ext !== undefined) patch.extended_us = ext
          if (kind !== undefined) patch.kind = kind
          commit(HISTORY_SUMMARY.transitionUpdate, transitionSideRefs(a.transition as Uuid), { kind: 'Coarse' }, (d) => applyUpdateTransition(d, a.transition as Uuid, patch))
          return { ok: true, value: null }
        }
        case 'remove_transition': commit(HISTORY_SUMMARY.transitionRemove, transitionSideRefs(a.transition as Uuid), { kind: 'Coarse' }, (d) => applyRemoveTransition(d, a.transition as Uuid)); return { ok: true, value: null }
        case 'add_media': return { ok: true, value: addMediaItem(mediaItemTemplate(a.id as Uuid, a.kind as MediaItem['kind'], (a.duration_us as number | null) ?? null, (a.with_audio as boolean | undefined) ?? false)) }
        // add_media_item — insert a FULL probed MediaItem (the import_media
        // hybrid: Rust probes/hashes, the TS host applies the write). Distinct from
        // `add_media` (template-only); the caller passes the serialized MediaItem.
        case 'add_media_item': return { ok: true, value: addMediaItem(a.media as MediaItem) }
        case 'separate_audio': return { ok: true, value: commit(HISTORY_SUMMARY.layerSeparateAudio, (audioId: Uuid) => layerRefs([a.layer as Uuid, audioId]), { kind: 'Coarse' }, (d) => applySeparateAudio(d, idGen, a.layer as Uuid)) }
        case 'set_media_derivatives': setMediaDerivatives(a.media as Uuid, a.patch as MediaDerivativesPatch); return { ok: true, value: null }
        case 'set_media_workspace_paths': setMediaWorkspacePaths(a.media as Uuid, a.paths as WorkspacePaths); return { ok: true, value: null }
        case 'set_media_hash': setMediaHash(a.media as Uuid, a.file_hash_blake3 as string); return { ok: true, value: null }
        case 'remove_media': removeMedia(a.media as Uuid, (a.force as boolean) ?? false); return { ok: true, value: null }
        case 'set_role_gain': setRoleGain(a.role as string, parseNum(a.gain_db, 'gain_db')); return { ok: true, value: null }
        case 'update_role_flags': updateRoleFlags(a.role as string, a.patch as RoleFlagsPatch); return { ok: true, value: null }
        case 'update_project_settings': updateProjectSettings(a.patch as { prefer_proxies?: boolean | null; proxy_override?: { media_id: string; value: boolean | null } | null; shot_review?: { sensitivity: number; min_shot_us: number } | null }); return { ok: true, value: null }
        case 'add_caption_track': { const comp = compositionArg(a); return { ok: true, value: commit(HISTORY_SUMMARY.trackAddCaption, trackRef, { kind: 'Coarse' }, (d) => applyAddCaptionTrack(d, idGen, a.cues as Cue[], a.comp_w as number, a.comp_h as number, (a.label as string) ?? null, comp)) } }
        case 'restyle_captions': {
          // Project-wide: one commit over EVERY caption-role track in every
          // composition, so overlapping caption lanes restyle as a single undo
          // entry. Affected refs are read from the pre-mutation snapshot (same
          // tracks the recipe patches).
          const captionRefs: EntityRef[] = captionTracks(current()).map((t) => ({ kind: 'Track', id: t.id }))
          commit(HISTORY_SUMMARY.captionRestyle, captionRefs, { kind: 'Coarse' }, (d) => applyRestyleCaptions(d, a.patch as CaptionStylePatch))
          return { ok: true, value: null }
        }
        case 'rebind_motif': {
          const updates = a.updates as MotifRebindEntry[]
          const affected: EntityRef[] = updates.map((u) => ({ kind: 'Layer', id: u.layer_id }))
          return { ok: true, value: commit(HISTORY_SUMMARY.layerRebindMotif, affected, { kind: 'Coarse' }, (d) => applyRebindMotif(d, updates)) }
        }
        case 'replace_state': {
          // Test vehicle — builds a blank from the args; production callers
          // (project_open) call replaceState(loadedProject) directly.
          const next = blankProject(idGen, (a.name as string) ?? 'untitled')
          const nextRoot = rootComposition(next)
          if (typeof a.width === 'number') nextRoot.width = a.width
          if (typeof a.height === 'number') nextRoot.height = a.height
          if (typeof a.fps_num === 'number' && typeof a.fps_den === 'number') nextRoot.fps = { num: a.fps_num, den: a.fps_den }
          replaceState(next)
          return { ok: true, value: null }
        }
        default: return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      if (e instanceof McpArgError) return { ok: false, error: { error: 'InvalidArgument', field: e.field ?? 'arguments', detail: e.mcpMessage } }
      throw e
    }
  }

  // ── production command adapter (actor.command) ──
  // Routes the renderer's real category-A channels (camelCase wire args) into
  // the gated mutation core. Mechanical channels delegate to dispatch() after
  // arg parsing; rich channels are handled inline below.
  function command(channel: string, wireArgs: Record<string, unknown>): DispatchResult {
    const mech = parseMechanical(channel, wireArgs)
    if (mech) return dispatch(mech.op, mech.args)
    try {
      switch (channel) {
        case 'add_color_layer': {
          // Resolve the overlay track when trackId is absent (reverse-scan
          // non-reserved; spawn one if none free) — inside `compositionId`'s
          // composition, the root by default. The placement scope and the
          // canvas-sized default params come from the same composition.
          const scope = scopeComposition(current(), wireCompositionId(wireArgs))
          const t0 = parseNum(wireArgs.tStartUs, 'tStartUs')
          const dur = resolveDurationUs(parseNumOpt(wireArgs.durationUs, 'durationUs'))
          const t1 = t0 + dur
          const trackId = wireArgs.trackId !== undefined ? parseUuid(wireArgs.trackId, 'trackId') : pickFreeOverlayTrack(scope, t0, t1)
          const params = prodColorParams(wireArgs, scope)
          if (trackId !== null) {
            const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, params, t0, t1))
            return { ok: true, value: id }
          }
          // No free track — spawn one in its OWN commit (the track add is a
          // separate commit, so it gets its own op_id), THEN add the layer in a
          // second commit. Two op_ids. `label: null` leaves the new lane's name
          // to be derived from its position (ADR 0042).
          const newTrackId = commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) =>
            applyAddTrack(d, idGen, null, undefined, scope.id))
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, newTrackId, params, t0, t1))
          return { ok: true, value: id }
        }
        case 'add_text_layer': {
          // Same overlay-track logic as add_color_layer.
          const scope = scopeComposition(current(), wireCompositionId(wireArgs))
          const t0 = parseNum(wireArgs.tStartUs, 'tStartUs')
          const dur = resolveDurationUs(parseNumOpt(wireArgs.durationUs, 'durationUs'))
          const t1 = t0 + dur
          const trackId = wireArgs.trackId !== undefined ? parseUuid(wireArgs.trackId, 'trackId') : pickFreeOverlayTrack(scope, t0, t1)
          const params = prodTextParams(wireArgs, scope)
          if (trackId !== null) {
            const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, params, t0, t1))
            return { ok: true, value: id }
          }
          // No free track — same two-commit pattern as add_color_layer above.
          const newTrackId = commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) =>
            applyAddTrack(d, idGen, null, undefined, scope.id))
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, newTrackId, params, t0, t1))
          return { ok: true, value: id }
        }
        case 'paste_layer': {
          // Paste uses the same automatic placement policy as add_text_layer:
          // reverse-scan non-reserved tracks for a free interval, otherwise
          // spawn a track before adding the cloned layer.
          const sourceId = parseUuid(wireArgs.layerId, 'layerId')
          const requestedStart = parseNum(wireArgs.tStartUs, 'tStartUs')
          // Timeline Alt+drag resolves an exact destination lane in the UI.
          // Keep that copy as one atomic commit instead of duplicating on the
          // source track and following it with a second move commit.
          if (wireArgs.targetTrackId !== undefined && wireArgs.targetTrackId !== null) {
            const targetTrackId = parseUuid(wireArgs.targetTrackId, 'targetTrackId')
            const id = commit(HISTORY_SUMMARY.layerDuplicate, layerRef, { kind: 'Coarse' }, (d) =>
              applyPasteLayer(d, idGen, sourceId, targetTrackId, requestedStart))
            return { ok: true, value: id }
          }
          // The free lane is sought in the SOURCE's composition: a paste never
          // crosses compositions (applyPasteLayer refuses a lane elsewhere).
          const sourceComp = requireLayer(current(), sourceId).comp
          const interval = pasteLayerInterval(current(), sourceId, requestedStart)
          const trackId = pickFreeOverlayTrack(sourceComp, interval.tStartUs, interval.tEndUs)
          if (trackId !== null) {
            const id = commit(HISTORY_SUMMARY.layerPaste, layerRef, { kind: 'Coarse' }, (d) =>
              applyPasteLayer(d, idGen, sourceId, trackId, requestedStart))
            return { ok: true, value: id }
          }
          const newTrackId = commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) =>
            applyAddTrack(d, idGen, null, undefined, sourceComp.id))
          const id = commit(HISTORY_SUMMARY.layerPaste, layerRef, { kind: 'Coarse' }, (d) =>
            applyPasteLayer(d, idGen, sourceId, newTrackId, requestedStart))
          return { ok: true, value: id }
        }
        case 'add_media_layer': {
          // add_media_layer: track_id required, kind-matched
          // params. When auto-pair fires (Video + audio.is_some() + setting on):
          // THREE separate commits (three op_ids) — add video layer, add audio
          // layer (role=dialogue) on the SAME track and span, then links_create.
          const trackId = parseUuid(wireArgs.trackId, 'trackId')
          const t0 = parseNum(wireArgs.tStartUs, 'tStartUs')
          const { params, durationUs, autoPairAudio } = prodMediaLayer(wireArgs, current())
          const t1 = t0 + durationUs
          const videoId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, trackId, params, t0, t1))
          if (autoPairAudio !== null) {
            const audioId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, autoPairAudio, t0, t1))
            commit(HISTORY_SUMMARY.linkCreate, layerRefs([videoId, audioId]), { kind: 'Coarse' }, (d) =>
              applyLinksCreate(d, idGen, [videoId, audioId], null, false))
          }
          return { ok: true, value: videoId }
        }
        case 'add_demo_color_layer': {
          // add_demo_color_layer:
          //   track=tracks.front() (spawn one if empty),
          //   t_start=track.last_layer.t_end ?? 0, duration=2s,
          //   color=demo_color(track.layers.len()), w/h=composition size.
          const snap = scopeComposition(current(), wireCompositionId(wireArgs))
          const firstTrack = snap.tracks[0]
          if (firstTrack) {
            const t0 = firstTrack.layers.at(-1)?.t_end_us ?? 0
            const t1 = t0 + 2_000_000
            const params = prodColorParams(
              { color: demoColor(firstTrack.layers.length) },
              snap,
            )
            const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, firstTrack.id, params, t0, t1))
            return { ok: true, value: id }
          }
          // No tracks at all — spawn one then add the layer inside one commit.
          // Unreachable in prod (reserved A/B-roll tracks are non-removable, so tracks is never empty); single-commit is fine. Do NOT mirror this onto the reachable no-trackId overlay path — that one resolves the track in its own commit, so the track add gets its own op_id.
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => {
            const newTrackId = applyAddTrack(d, idGen, null, undefined, snap.id)
            const t0 = 0
            const t1 = 2_000_000
            const params = prodColorParams({ color: demoColor(0) }, compositionOf(d, snap.id))
            return applyAddLayer(d, idGen, newTrackId, params, t0, t1)
          })
          return { ok: true, value: id }
        }
        case 'add_demo_text_layer': {
          // add_demo_text_layer:
          //   track=tracks.last() (spawn one if empty),
          //   t_start=track.last_layer.t_end ?? 0, duration=3s.
          // Params are textParamsDefault's, overriding only content and size —
          // a demo op that minted its own family would be a fourth default.
          const demoText = (comp: { width: number; height: number }): LayerParams => {
            const p = textParamsDefault('TEXT', comp)
            return { ...p, font: { ...p.font, size_px: 96 } }
          }
          const snap = scopeComposition(current(), wireCompositionId(wireArgs))
          const lastTrack = snap.tracks.at(-1)
          if (lastTrack) {
            const t0 = lastTrack.layers.at(-1)?.t_end_us ?? 0
            const t1 = t0 + 3_000_000
            const params = demoText(snap)
            const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, lastTrack.id, params, t0, t1))
            return { ok: true, value: id }
          }
          // No tracks at all — same unreachable single-commit case as add_demo_color_layer.
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => {
            const newTrackId = applyAddTrack(d, idGen, null, undefined, snap.id)
            return applyAddLayer(d, idGen, newTrackId, demoText(compositionOf(d, snap.id)), 0, 3_000_000)
          })
          return { ok: true, value: id }
        }
        case 'add_motif': {
          // add_motif — pure TS recorded mutation.
          // Renderer camelCase: motifId, trackId?, tStartUs, tEndUs?, props?
          const motifId = wireArgs.motifId as string | undefined
          if (typeof motifId !== 'string') return { ok: false, error: { error: 'InvalidArgument', field: 'motifId', detail: 'motifId must be a string' } }
          const manifest = motifCatalog.get(motifId)
          if (!manifest) return { ok: false, error: { error: 'InvalidArgument', field: 'motifId', detail: `unknown motif_id '${motifId}' — call list_motifs for the catalog` } }
          // Canonicalize props BEFORE any commit (reject-before-commit gate).
          let canonicalProps: Record<string, unknown>
          try {
            canonicalProps = canonicalizeProps(manifest, (wireArgs.props ?? null) as unknown)
          } catch (err) {
            if (err instanceof MotifPropError) return { ok: false, error: { error: 'InvalidArgument', field: 'props', detail: `invalid props: ${err.detail}` } }
            throw err
          }
          const tStartUs = parseNum(wireArgs.tStartUs, 'tStartUs')
          const tEndUsRaw = parseNumOpt(wireArgs.tEndUs, 'tEndUs') ?? null
          const resolvedEnd = resolveMotifTEndUs(tStartUs, tEndUsRaw, manifest.default_duration_s, resolveMotifMaxDurUs(manifest, canonicalProps))
          if (resolvedEnd <= tStartUs) return { ok: false, error: { error: 'InvalidArgument', field: 't_end_us', detail: `t_end_us ${resolvedEnd} must be greater than t_start_us ${tStartUs}` } }
          const params = motifLayerParams(manifest.id, manifest.version, canonicalProps)
          // Two-commit: if no track_id → spawn the track FIRST (in the named
          // composition, root by default), THEN the Motif layer.
          const scope = scopeComposition(current(), wireCompositionId(wireArgs))
          const trackId = wireArgs.trackId !== undefined ? parseUuid(wireArgs.trackId, 'trackId') : null
          const track = trackId ?? commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, null, undefined, scope.id))
          const layerId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, params, tStartUs, resolvedEnd))
          return { ok: true, value: layerId }
        }
        default:
          // (meta channels)
          return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported production op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      if (e instanceof McpArgError) return { ok: false, error: { error: 'InvalidArgument', field: e.field ?? 'arguments', detail: e.mcpMessage } }
      throw e
    }
  }

  // spec_to_op — MCP OperationSpec (tagged "kind", snake_case) → DryRunOp.
  function specToDryRunOp(spec: Record<string, unknown>): DryRunOp {
    const kind = spec.kind as string
    switch (kind) {
      case 'add_color_layer':
        return { kind: 'AddLayer', track_id: parseUuid(spec.track_id, 'track_id'),
          params: colorParams(parseRgba(spec.color, 'color'), parseNumOpt(spec.width, 'width') ?? 1920, parseNumOpt(spec.height, 'height') ?? 1080),
          t_start_us: parseNum(spec.t_start_us, 't_start_us'), t_end_us: parseNum(spec.t_end_us, 't_end_us') }
      case 'add_video_layer': {
        const media = parseUuid(spec.media_id, 'media_id')
        const srcIn = parseNum(spec.src_in_us, 'src_in_us')
        const srcOut = parseNum(spec.src_out_us, 'src_out_us')
        const params = current().media_pool[media]?.kind === 'Image'
          ? imageOverlayParams(media)
          : videoClipParams(media, srcIn, srcOut)
        return { kind: 'AddLayer', track_id: parseUuid(spec.track_id, 'track_id'),
          params,
          t_start_us: parseNum(spec.t_start_us, 't_start_us'), t_end_us: parseNum(spec.t_end_us, 't_end_us') }
      }
      case 'update_layer':
        return { kind: 'UpdateLayer', id: parseUuid(spec.layer_id, 'layer_id'), patch: spec.patch as LayerPatch }
      case 'update_layer_params':
        return { kind: 'UpdateLayerParams', id: parseUuid(spec.layer_id, 'layer_id'), patch: spec.patch as LayerParamsPatch }
      case 'move_layer':
        return { kind: 'MoveLayer', id: parseUuid(spec.layer_id, 'layer_id'), new_track_id: parseUuid(spec.new_track_id, 'new_track_id'), new_t_start_us: parseNum(spec.new_t_start_us, 'new_t_start_us'), escape_link: (spec.escape_link as boolean) ?? false }
      case 'split_layer':
        return { kind: 'SplitLayer', id: parseUuid(spec.layer_id, 'layer_id'), at_t_us: parseNum(spec.at_t_us, 'at_t_us'), escape_link: (spec.escape_link as boolean) ?? false }
      case 'delete_layer':
        return { kind: 'DeleteLayer', id: parseUuid(spec.layer_id, 'layer_id') }
      case 'add_transition':
        // Same gates as the wet tool's boundary: strict (kind, direction)
        // pairing and the closed placement enum, so a dry-run's arg rejection
        // matches the real call's. The transition kind rides as
        // `transition_kind` — the OperationSpec's own `kind` names the op.
        return { kind: 'AddTransition', from: parseUuid(spec.from_layer_id, 'from_layer_id'), to: parseUuid(spec.to_layer_id, 'to_layer_id'),
          duration_us: parseNum(spec.duration_us, 'duration_us'),
          transition_kind: parseTransitionKind(spec.transition_kind ?? 'Crossfade', spec.direction),
          placement: parseTransitionPlacement(spec.placement) }
      default:
        throw new McpArgError(`unknown operation kind '${kind}'`)
    }
  }

  function mcpCall(name: string, argsJson: string): McpCallResult {
    let a: Record<string, unknown>
    try { a = JSON.parse(argsJson) as Record<string, unknown> }
    catch (e) { return { ok: false, error: { code: 'invalid_params', message: `invalid args for ${name}: ${String(e)}` } } }
    try {
      // Dedicated arms for explicit-param tools. Fall through to the
      // table path for mechanical tools.
      switch (name) {
        case 'add_color_layer': {
          const p = mcpDef('add_color_layer').parseDedicated!(a)
          checkTrackInComposition(p.track as string, p.composition_id as string | null)
          const params = colorParams(p.color as Rgba, (p.width as number | undefined) ?? 1920, (p.height as number | undefined) ?? 1080)
          const id = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, p.track as string, params, p.t_start_us as number, p.t_end_us as number))
          return { ok: true, result: toolText(id) }
        }
        case 'add_video_layer': {
          const p = mcpDef('add_video_layer').parseDedicated!(a)
          const track = p.track as string
          checkTrackInComposition(track, p.composition_id as string | null)
          const media = p.media as string
          const srcIn = p.src_in_us as number
          const srcOut = p.src_out_us as number
          const t0 = p.t_start_us as number
          const t1 = p.t_end_us as number
          const snap = current()
          const item = snap.media_pool[media]
          if (item?.kind === 'Image') {
            const imageId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, imageOverlayParams(media), t0, t1))
            return { ok: true, result: toolText(imageId) }
          }
          const vParams = videoClipParams(media, srcIn, srcOut)
          const shouldPair = (snap.settings.auto_pair_audio_on_import === true) && (item?.kind === 'Video') && (item.metadata.audio != null)
          if (!shouldPair) {
            const videoId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, vParams, t0, t1))
            return { ok: true, result: toolText(videoId) }
          }
          // Paired A/V: ONE commit — video + dialogue audio on the SAME track
          // (a track holds one visual and one audio lane, so the pair shares a
          // combined row exactly like production add_media_layer) + the pair
          // link. Any failure discards the whole draft: the call commits or
          // rejects as a unit — splitting it into separate commits strands the
          // video on the timeline when the audio placement fails.
          const aParams = { ...audioParams(media, srcIn, srcOut), role: 'dialogue' as const }
          try {
            const ids = commit(HISTORY_SUMMARY.layerAddAvPair, (r: { video_layer_id: Uuid; audio_layer_id: Uuid; link_id: Uuid }) => layerRefs([r.video_layer_id, r.audio_layer_id]), { kind: 'Coarse' }, (d) => {
              const videoId = applyAddLayer(d, idGen, track, vParams, t0, t1)
              const audioId = applyAddLayer(d, idGen, track, aParams, t0, t1)
              const linkId = applyLinksCreate(d, idGen, [videoId, audioId], null, false)
              return { video_layer_id: videoId, audio_layer_id: audioId, link_id: linkId }
            })
            return { ok: true, result: toolJson(ids) }
          } catch (err) {
            if (err instanceof CommandFailure && err.err.error === 'ValidationFailed' && err.err.detail.rule === 'LayerOverlap') {
              const d = err.err.detail
              // One of the colliding pair is PRE-EXISTING (the other is a layer
              // this discarded draft minted); its lane says which half of the
              // pair collided. Audio lane blocked while the video lane was free
              // is exactly the case agents misdiagnosed for three sessions
              // running — name the cause and the ways out IN THE MESSAGE
              // (clients drop error.data).
              const existing = [...eachLayer(snap)].map((e) => e.layer).find((l) => l.id === d.a || l.id === d.b)
              if (existing && existing.params.kind === 'Audio') {
                return { ok: false, error: {
                  code: 'invalid_params',
                  message: `paired-audio overlap: the video fits, but auto_pair_audio_on_import also places a dialogue Audio layer at [${t0}, ${t1}) µs on the target track's audio lane, where Audio layer ${existing.id}${existing.label ? ` '${existing.label}'` : ''} already occupies [${existing.t_start_us}, ${existing.t_end_us}) µs. Nothing was committed (the pair is atomic). Options: create_new_track and retry add_video_layer with the new track_id (the pair lands together on one track); trim_existing / split_at_t / move_layer the blocking audio layer; or set settings.auto_pair_audio_on_import=false.`,
                  data: {
                    error: 'LayerOverlap', collided: 'paired_audio', track: d.track,
                    blocking_layer: existing.id, blocking_label: existing.label,
                    blocking_range_us: [existing.t_start_us, existing.t_end_us],
                    requested_range_us: [t0, t1],
                    options: [
                      { action: 'create_new_track', note: 'then retry add_video_layer with the new track_id' },
                      { action: 'trim_existing', layer_id: existing.id, new_t_end_us: t0 },
                      { action: 'split_at_t', layer_id: existing.id, at_t_us: t0 },
                    ],
                  },
                } }
              }
            }
            throw err // visual-lane overlap etc. → outer catch → mapCommandError
          }
        }
        // An anchor reaches this arm as the LAYER alone, unlike the prod arm's
        // `{layer, src_us}` taken on trust: `src_us` is derivable from `t_us`
        // and the clip, so a caller free to name both could name a pair that
        // disagrees, and the reconcile would settle it by moving the mark
        // somewhere nobody asked for. Deriving it here is exactly
        // `applyAttachMarker`, which is why the tie inherits that function's
        // three refusals and this arm needs none of its own.
        //
        // Add and attach share ONE commit for the prod arm's reason: the mark
        // and its tie are one gesture, so one undo takes both. A refused attach
        // throws out of the recipe (→ the outer catch → mapCommandError) and no
        // marker is created — it never survives as a free one the caller would
        // then have to notice and clean up.
        case 'add_marker': {
          const p = mcpDef('add_marker').parseDedicated!(a)
          const color = p.color as Rgba
          const tUs = p.t_us as number
          const endT = (p.end_t_us as number | undefined) ?? null
          const label = p.label as string
          const anchorLayer = (p.anchor_layer_id as Uuid | null) ?? null
          const comp = compositionArg(p)
          const id = commit(HISTORY_SUMMARY.markerAdd, markerRef, { kind: 'Coarse' }, (d) => {
            const marker = applyAddMarker(d, idGen, tUs, endT, label, color, comp)
            if (anchorLayer !== null) applyAttachMarker(d, marker, anchorLayer)
            return marker
          })
          return { ok: true, result: toolText(id) }
        }
        case 'split_layer': {
          const p = mcpDef('split_layer').parseDedicated!(a)
          const layer = p.layer as string
          const r = dispatch('split_layer', { layer, at_t_us: p.at_t_us, escape_link: (p.escape_link as boolean) ?? false })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          // dispatch('split_layer') (applySplitLayer) already returns
          // `{left, right}` (left = original layer, right = new) — return it verbatim.
          return { ok: true, result: toolJson(r.value) }
        }
        case 'lock_history': {
          const p = mcpDef('lock_history').parseDedicated!(a)
          const reason = p.reason as string
          if (reason.trim() === '') return { ok: false, error: { code: 'invalid_params', message: 'reason must be non-empty' } }
          history.lock(reason); return { ok: true, result: toolEmpty() }
        }
        case 'unlock_history': { mcpDef('unlock_history').parseDedicated!(a); history.unlock(); return { ok: true, result: toolEmpty() } }
        case 'checkpoint': {
          const p = mcpDef('checkpoint').parseDedicated!(a)
          const label = p.label as string
          if (label.trim() === '') return { ok: false, error: { code: 'invalid_params', message: 'label must be non-empty' } }
          return { ok: true, result: toolText(checkpoint(label, MCP_ACTOR)) }
        }
        case 'list_checkpoints': { mcpDef('list_checkpoints').parseDedicated!(a); return { ok: true, result: toolJson(listCheckpoints()) } }
        case 'restore_checkpoint': {
          const p = mcpDef('restore_checkpoint').parseDedicated!(a)
          const id = p.checkpoint_id as string
          restoreCheckpoint(id) // throws CommandFailure(HistoryLocked|CheckpointNotFound) → outer catch → mapCommandError → invalid_params (no data)
          return { ok: true, result: toolEmpty() }
        }
        case 'begin_agent_session': {
          const p = mcpDef('begin_agent_session').parseDedicated!(a)
          const reason = p.reason as string
          if (reason.trim() === '') return { ok: false, error: { code: 'invalid_params', message: 'reason must be non-empty' } }
          const checkpointId = checkpoint(`Pre-agent: ${reason}`, MCP_ACTOR) // 1 det id; slot-flip + log are non-state side effects
          return { ok: true, result: toolJson({ checkpoint_id: checkpointId, started_at: clock() }) }
        }
        case 'set_keyframe': {
          const p = mcpDef('set_keyframe').parseDedicated!(a)
          const layer = p.layer as string
          const paramKey = p.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          const easing = p.interp as Interpolation | undefined
          const next = upsertKeyframe(track, (p.t_us as number) - tStartUs, p.value as number, easing, idGen)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'get_param_track': {
          const p = mcpDef('get_param_track').parseDedicated!(a)
          const layer = p.layer as string
          const paramKey = p.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          return { ok: true, result: toolJson(shapeGetParamTrack(track, tStartUs)) }
        }
        case 'remove_keyframe': {
          const p = mcpDef('remove_keyframe').parseDedicated!(a)
          const layer = p.layer as string
          const keyframeId = p.keyframe_id as string
          const paramKey = p.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const fallback = track.mode === 'Static' ? track.value : (track.value[0]?.value ?? 0)
          const next = removeKeyframe(track, keyframeId, fallback)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'retime_keyframe': {
          const p = mcpDef('retime_keyframe').parseDedicated!(a)
          const layer = p.layer as string
          const keyframeId = p.keyframe_id as string
          const paramKey = p.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const next = retimeKeyframe(track, keyframeId, (p.t_us as number) - tStartUs)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'set_keyframe_easing': {
          const p = mcpDef('set_keyframe_easing').parseDedicated!(a)
          const layer = p.layer as string
          const keyframeId = p.keyframe_id as string
          const paramKey = p.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const next = setSegmentEasing(track, keyframeId, p.interp as Interpolation)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'smooth_keyframes': {
          const p = mcpDef('smooth_keyframes').parseDedicated!(a)
          const layer = p.layer as string
          const paramKey = p.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          const keyframeId = p.keyframe_id as string | null
          if (keyframeId !== null && !keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          // One key, or every key: Auto on both sides + Smooth, neighbours splined;
          // the actor's write step solves the coordinates.
          const ids = keyframeId !== null ? [keyframeId] : track.mode === 'Keyframed' ? track.value.map((k) => k.id) : []
          const next = setAuto(track, ids)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'clear_keyframes': {
          const p = mcpDef('clear_keyframes').parseDedicated!(a)
          const layer = p.layer as string
          const paramKey = p.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (track.mode === 'Static') return { ok: true, result: toolEmpty() } // no-op, no commit
          const value = (p.value as number | undefined) ?? track.value[0]?.value ?? 0
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: { mode: 'Static', value } })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'set_param_track': {
          const p = mcpDef('set_param_track').parseDedicated!(a)
          const layer = p.layer as string
          const paramKey = p.param_key as string
          const { tStartUs } = readLayerTrack(current(), layer, paramKey) // validate layer+param; current discarded
          const input = p.track as Animated<number>
          const shifted: Animated<number> = input.mode === 'Keyframed'
            ? { ...input, value: input.value.map((k) => ({ ...k, t_us: k.t_us - tStartUs })) }
            : input
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: shifted })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'dry_run': {
          const p = mcpDef('dry_run').parseDedicated!(a)
          const specs = p.operations as Array<Record<string, unknown>>
          const ops: DryRunOp[] = []
          for (let i = 0; i < specs.length; i++) {
            try { ops.push(specToDryRunOp(specs[i])) }
            catch (e) {
              if (e instanceof McpArgError) return { ok: false, error: { code: 'invalid_params', message: `operations[${i}]: ${e.mcpMessage}` } }
              throw e
            }
          }
          return { ok: true, result: shapeDryRunResponse(dryRun(ops)) }
        }
        case 'add_motif': {
          // add_motif MCP arm: pure TS, dedicated mcpCall.
          const p = mcpDef('add_motif').parseDedicated!(a)
          const motifId = p.motif_id as string
          const manifest = motifCatalog.get(motifId)
          if (!manifest) return { ok: false, error: { code: 'invalid_params', message: `unknown motif_id '${motifId}' — call list_motifs for the catalog` } }
          // Canonicalize props BEFORE any commit (reject-before-commit gate).
          let canonicalProps: Record<string, unknown>
          try {
            canonicalProps = canonicalizeProps(manifest, (p.props ?? null) as unknown)
          } catch (err) {
            if (err instanceof MotifPropError) return { ok: false, error: { code: 'invalid_params', message: `invalid props: ${err.detail}` } }
            throw err
          }
          const tStartUs = p.t_start_us as number
          const tEndUsRaw = (p.t_end_us as number | null | undefined) ?? null
          const resolvedEnd = resolveMotifTEndUs(tStartUs, tEndUsRaw, manifest.default_duration_s, resolveMotifMaxDurUs(manifest, canonicalProps))
          if (resolvedEnd <= tStartUs) return { ok: false, error: { code: 'invalid_params', message: `t_end_us ${resolvedEnd} must be greater than t_start_us ${tStartUs}` } }
          const params = motifLayerParams(manifest.id, manifest.version, canonicalProps)
          const trackId = (p.track_id as string | null | undefined) ?? null
          const compositionId = p.composition_id as string | null
          if (trackId !== null) checkTrackInComposition(trackId, compositionId)
          const scope = scopeComposition(current(), compositionId)
          const track = trackId ?? commit(HISTORY_SUMMARY.trackAdd, trackRef, { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, null, undefined, scope.id))
          const layerId = commit(HISTORY_SUMMARY.layerAdd, layerRef, { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, track, params, tStartUs, resolvedEnd))
          return { ok: true, result: toolText(layerId) }
        }
      }
      const parse = MCP_ARG_PARSERS[name]
      if (!parse) return { ok: false, error: { code: 'not_found', message: `unknown tool '${name}'` } }
      const { op, args } = parse(a)
      const r = dispatch(op, args)
      if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
      const shape = MCP_RESULT_SHAPERS[name] ?? (() => toolEmpty())
      return { ok: true, result: shape(r.value) }
    } catch (e) {
      if (e instanceof McpArgError) return { ok: false, error: e.toJson() }
      if (e instanceof CommandFailure) return { ok: false, error: mapCommandError(e.err) }
      throw e
    }
  }

  return {
    snapshot: current,
    dispatch,
    command,
    mcpCall,
    replaceState,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    historyView: (n) => history.view(n),
    historyStatus: () => history.status(),
    historyCapacity: () => history.capacity(),
    lockHistory: (r) => history.lock(r),
    unlockHistory: () => history.unlock(),
    jumpTo,
    checkpoint,
    restoreCheckpoint,
    deleteCheckpoint,
    listCheckpoints,
    dryRun,
    setUserMotifManifests(ms: Manifest[]) { motifCatalog.setUserManifests(ms) },
  }
}
