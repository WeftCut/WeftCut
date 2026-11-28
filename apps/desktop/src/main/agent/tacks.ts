// apps/desktop/src/main/agent/tacks.ts
// Tacks: comments on what plays in a time range, opened by an agent for the
// user or by the user for an agent, and answered by either (ADR 0115, ADR 0117,
// ADR 0185).
//
// Runtime state of ONE project opening, owned beside agent activity and reset
// with it. Not in `Project`, not recorded, not serialized, never touched by
// undo, redo, checkpoint restore or the history lock — so nothing here goes
// through the actor's commit path.
//
// At creation the store records what plays in the range, across every track;
// every read replays that record against the current project
// (`rangePlayback.ts`, which owns what "plays the same" means). Two states only: current while it plays the
// same, outdated otherwise (as a review comment on changed lines is on GitHub
// or Gerrit). Derived, never latched: an undo that restores the content makes
// the tack current again.
import { randomUUID } from 'node:crypto'
import type { Project } from '../state/model'
import { CommandFailure } from '../state/errors'
import { snapMarkerTimes } from '../state/mutations/markers'
import { recordPlayback, replay, type Playback } from './rangePlayback'
import {
  TACK_BODY_LIMIT, TACK_CAPACITY, TACK_REPLY_LIMIT, USER_TACK_LABEL_LENGTH, type AffectedTack, type Tack,
  type TackAuthor, type TackKind, type TackRange, type TackStatus, type TackToReview, type TackView, type UserTackInput,
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

export type TackErrorName = 'TackLimit' | 'ReplyLimit' | 'TackNotFound' | 'NoCurrentCall' | 'InvalidArgument' | 'CompositionNotFound' | 'UserTack'

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

/** The side that did not write `t`'s last message, while it is open. */
function awaiting(t: Tack): TackAuthor | null {
  if (t.status !== 'open') return null
  const last = t.replies.at(-1)?.author ?? t.author
  return last === 'agent' ? 'user' : 'agent'
}

/** A message's text as written, or a refusal naming `field`. */
function messageText(v: string, field: string): string {
  if (v.trim() === '') throw new TackError('InvalidArgument', `${field} must be non-empty`, field)
  if (v.length > TACK_BODY_LIMIT) throw new TackError('InvalidArgument', `${field} is ${v.length} characters; at most ${TACK_BODY_LIMIT}`, field)
  return v
}

/** What the user wrote as a tack's label and body: the label is its first
 *  line, cut to fit a panel row and a chip; the body holds the rest only when
 *  the label is not already all of it. */
export function userTackText(text: string): { label: string; body: string } {
  const all = text.trim()
  const first = all.split('\n', 1)[0]!.trim()
  const label = first.length > USER_TACK_LABEL_LENGTH ? `${first.slice(0, USER_TACK_LABEL_LENGTH - 1).trimEnd()}…` : first
  return { label, body: label === all ? '' : all }
}
const UNPLACED: Placement = { composition_id: null, t_us: null, end_t_us: null, outdated: true, follows: null }

/** Where a tack sits in `p` right now, and whether its range still plays what
 *  it did; no place once its composition is gone. */
function place(p: Project, playback: Playback): Placement {
  const at = replay(p, playback)
  return at === null ? UNPLACED : { composition_id: at.composition_id, t_us: at.t_us, end_t_us: at.end_t_us, outdated: !at.same, follows: at.follows }
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
  /** What played in each tack's range at creation. Kept off the record:
   *  views are copies, and a layer is no part of the wire. */
  private playbacks = new Map<string, Playback>()
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
    return structuredClone({ ...t, ...at, awaiting: awaiting(t) })
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
    const dirty: string[] = []
    for (const t of this.records.values()) {
      const at = place(p, this.playbacks.get(t.id)!)
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
        id, author: 'agent', session_id: who.session_id, connection_id: who.connection_id, client: who.client, activity_id: who.activity_id,
        kind: input.kind, label: input.label, body: input.body, status: 'open', range: ranges[i]!.range, created_at,
        seen_at: null, replies: [],
      })
      this.playbacks.set(id, ranges[i]!.playback)
      return id
    })
    // Placed against the project they were validated on, which is the one
    // every other placement was just refreshed against.
    for (const id of ids) this.placed.set(id, place(p, this.playbacks.get(id)!))
    this.deps.changed(ids, [])
    return ids
  }

  /** A tack the user opened from the panel: no session, no client, no kind —
   *  it asks the agents for a change. Returns its id. */
  createByUser(input: UserTackInput): string {
    if (this.records.size + 1 > this.capacity)
      throw new TackError('TackLimit', `this project opening holds ${this.capacity} tacks already; clear the closed ones first`)
    const { label, body } = userTackText(messageText(input.text, 'text'))
    this.refresh()
    const p = this.placedFor!
    const { range, playback } = this.range(p, input, 'tack')
    const id = this.newId()
    this.records.set(id, {
      id, author: 'user', session_id: null, connection_id: null, client: null, activity_id: null,
      kind: null, label, body, status: 'open', range, created_at: this.now(), seen_at: null, replies: [],
    })
    this.playbacks.set(id, playback)
    this.placed.set(id, place(p, playback))
    this.deps.changed([id], [])
    return id
  }

  /** Add one message to a tack's conversation. An agent's carries the
   *  current call's client; the user's reopens a closed tack, since writing to
   *  it hands the move back to the agents. */
  reply(id: string, author: TackAuthor, body: string): TackView {
    const t = this.records.get(id)
    if (!t) throw this.notFound(id)
    const text = messageText(body, 'body')
    let client: string | null = null
    if (author === 'agent') {
      const who = this.deps.caller()
      if (who === null) throw new TackError('NoCurrentCall', 'reply_tack ran outside a current MCP call of this project opening (the project was replaced while it ran); nothing was added')
      client = who.client
    }
    if (t.replies.length >= TACK_REPLY_LIMIT)
      throw new TackError('ReplyLimit', `tack ${id} holds ${TACK_REPLY_LIMIT} replies already; open a new tack to go on`, 'tack_id')
    t.replies.push({ author, body: text, at: this.now(), client, seen_at: null })
    if (author === 'user') t.status = 'open'
    this.refresh()
    this.deps.changed([id], [])
    return this.viewsOf(new Set([id]))[0]!
  }

  /** Stamp the user's messages in `ids` that no agent has read yet as read
   *  now. Called after an agent's read was answered, so that answer still
   *  shows them unread. */
  markSeen(ids: Iterable<string>): void {
    const at = this.now()
    const dirty: string[] = []
    for (const id of ids) {
      const t = this.records.get(id)
      if (!t) continue
      let changed = false
      if (t.author === 'user' && t.seen_at === null) { t.seen_at = at; changed = true }
      for (const r of t.replies) if (r.author === 'user' && r.seen_at === null) { r.seen_at = at; changed = true }
      if (changed) dirty.push(id)
    }
    if (dirty.length) this.deps.changed(dirty, [])
  }

  /** Apply `patch`. An agent may only change the status of the user's tacks
   *  — and not even that: the user's request is theirs to close, and a closed
   *  tack leaves the timeline, which would hide the agent's answer. */
  update(id: string, patch: TackPatch, by: TackAuthor): TackView {
    const t = this.records.get(id)
    if (!t) throw this.notFound(id)
    if (by === 'agent' && t.author === 'user')
      throw new TackError('UserTack', `tack ${id} is the user's: reply_tack to answer it, and leave closing it to the user; nothing was changed`, 'tack_id')
    if (patch.kind !== undefined && t.author === 'user')
      throw new TackError('InvalidArgument', `tack ${id} is the user's and has no kind`, 'kind')
    if (patch.label !== undefined) t.label = patch.label
    if (patch.body !== undefined) t.body = patch.body
    if (patch.kind !== undefined) t.kind = patch.kind
    if (patch.status !== undefined) t.status = patch.status
    this.refresh()
    this.deps.changed([id], [])
    return this.viewsOf(new Set([id]))[0]!
  }

  /** Remove the listed tacks — every id must exist, or none goes — or every
   *  tack created in work session `session`. Only the user removes a user
   *  tack. Returns the ids removed. */
  delete(selector: { tack_ids: readonly string[] } | { session_id: string }, by: TackAuthor): string[] {
    let ids: string[]
    if ('tack_ids' in selector) {
      const missing = selector.tack_ids.find((id) => !this.records.has(id))
      if (missing !== undefined) throw this.notFound(missing)
      const theirs = by === 'agent' ? selector.tack_ids.find((id) => this.records.get(id)!.author === 'user') : undefined
      if (theirs !== undefined) throw new TackError('UserTack', `tack ${theirs} is the user's; only the user removes it. Nothing was removed`, 'tack_ids')
      ids = [...new Set(selector.tack_ids)]
    } else {
      ids = [...this.records.values()].filter((t) => t.session_id === selector.session_id).map((t) => t.id)
    }
    for (const id of ids) { this.records.delete(id); this.placed.delete(id); this.playbacks.delete(id) }
    if (ids.length) this.deps.changed([], ids)
    return ids
  }

  /** Drop everything without reporting it: the owner publishes a reset. */
  clear(): void {
    this.records.clear()
    this.placed.clear()
    this.playbacks.clear()
    this.placedFor = null
  }

  private notFound(id: string): TackError {
    return new TackError('TackNotFound', `tack ${id} not found in this project opening — project://tacks lists them; nothing was changed`, 'tack_id')
  }

  /** The stored range of one input and what plays in it, or a refusal naming
   *  `at`. The times land on the composition's frame grid first, as
   *  `add_marker` lands them. */
  private range(p: Project, input: Pick<TackInput, 't_us' | 'end_t_us' | 'composition_id'>, at: string): { range: TackRange; playback: Playback } {
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
    return { range: { composition_id: c.id, t_us: tUs, end_t_us: endTUs }, playback: recordPlayback(p, c.id, tUs, endTUs) }
  }
}
