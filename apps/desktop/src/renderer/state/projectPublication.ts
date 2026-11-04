import type { ProjectPublication, ProjectPublicationReply, ProjectVersion } from '../../shared/projectPublication'
import { applySnapshotPatches } from '../../shared/snapshotPatch'

export type ProjectPublicationFailure = 'read-failed' | 'stale-response' | 'superseded-session' | 'stopped' | 'unavailable'

/** A view barrier failed. The accepted mutation must NOT be submitted again:
 *  retry the publication read instead. This error never claims a save failed. */
export class ProjectPublicationError extends Error {
  constructor(readonly reason: ProjectPublicationFailure, cause?: unknown) {
    super(`Project view publication failed (${reason}); refresh the view without repeating the edit.`, { cause })
    this.name = 'ProjectPublicationError'
  }
}

interface PublicationOptions<T> {
  /** `base` names the answer this client holds; null asks for the whole projection. */
  read: (traceId: string | undefined, base: number | null) => Promise<ProjectPublicationReply<T>>
  apply: (summary: T | null, publication: ProjectPublication<T>, traceId?: string) => void
  /** Carries the held view's references over to a whole projection, which crossed
   *  IPC with none of them. Differences keep them by construction. */
  adopt?: (held: T | null, next: T | null) => T | null
  onError?: (error: ProjectPublicationError) => void
}
interface Barrier {
  version: ProjectVersion | null
  force: number
  resolve: () => void
  reject: (error: ProjectPublicationError) => void
}

const UNFIT = Symbol('difference does not fit the held view')

function compare(a: ProjectVersion, b: ProjectVersion): number {
  return a.session - b.session || a.revision - b.revision
}
function copy(version: ProjectVersion): ProjectVersion { return { ...version } }

/** One renderer's publication owner. Events and command receipts name the same
 *  target; callers never schedule reads themselves. There is one active read and
 *  at most one newer target, regardless of event volume. A complete response is
 *  applied only when it catches up with the newest known target. Null is a valid
 *  closed workspace, while a failed read preserves the last successfully applied
 *  view. Versions are session-scoped, not history cursors or persistence status.
 *
 *  Errors reject waiting callers and are reported once for background observers.
 *  A subsequent wait/refresh retries only the read. stop() ends this owner's
 *  lifetime, rejects its barriers and prevents late responses from publishing.
 *
 *  It also owns the held view, so a read's base and the view a difference lands
 *  on cannot disagree. A difference that does not fit is not a failure: the
 *  client asks for the whole projection and no caller hears of it (ADR 0157). */
export class ProjectPublicationClient<T> {
  private desired: ProjectVersion | null = null
  private applied: ProjectVersion | null = null
  private view: T | null = null
  private viewId: number | null = null
  private traceId: string | undefined
  private inFlight = false
  private stopped = false
  private forceRequested = 0
  private forceApplied = 0
  private staleTarget: ProjectVersion | null = null
  private staleResponses = 0
  private barriers = new Set<Barrier>()

  constructor(private readonly options: PublicationOptions<T>) {}

  observe(version: ProjectVersion, traceId?: string): void {
    if (this.stopped) return
    this.request(version, traceId)
    this.startRead()
  }

  waitFor(version: ProjectVersion, traceId?: string): Promise<void> {
    if (this.stopped) return Promise.reject(new ProjectPublicationError('stopped'))
    if (this.applied && version.session < this.applied.session) return Promise.reject(new ProjectPublicationError('superseded-session'))
    this.request(version, traceId)
    return this.barrier(version, 0)
  }

  /** Force external/readiness data to be rechecked even at the same revision. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.reject(new ProjectPublicationError('stopped'))
    this.forceRequested++
    return this.barrier(this.desired, this.forceRequested)
  }

  /** Catch up with existing work, following a replacement session if one opens
   *  while waiting. A fresh client performs its initial read. */
  settle(): Promise<void> {
    if (this.stopped) return Promise.reject(new ProjectPublicationError('stopped'))
    return this.barrier(null, this.forceRequested)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectBarriers(new ProjectPublicationError('stopped'))
  }

  private request(version: ProjectVersion, traceId?: string): void {
    if (this.desired === null || compare(version, this.desired) > 0) {
      this.desired = copy(version)
      this.traceId = traceId
    } else if (compare(version, this.desired) === 0 && traceId !== undefined) {
      this.traceId = traceId
    }
  }

  private caughtUp(): boolean {
    return this.applied !== null && (this.desired === null || compare(this.applied, this.desired) >= 0)
      && this.forceApplied >= this.forceRequested
  }

  private barrier(version: ProjectVersion | null, force: number): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this.barriers.add({ version: version && copy(version), force, resolve, reject })
    })
    this.resolveBarriers()
    this.startRead()
    return result
  }

  private materialize(reply: ProjectPublicationReply<T>): T | null | typeof UNFIT {
    if (!('patches' in reply)) return this.options.adopt ? this.options.adopt(this.view, reply.summary) : reply.summary
    if (reply.base !== this.viewId) return UNFIT
    try { return applySnapshotPatches(this.view, reply.patches) }
    catch (error) { console.warn('[project publication] a difference did not fit the held view', error); return UNFIT }
  }

  private resolveBarriers(): void {
    if (this.applied === null) return
    for (const barrier of this.barriers) {
      if (barrier.version && barrier.version.session < this.applied.session) {
        this.barriers.delete(barrier)
        barrier.reject(new ProjectPublicationError('superseded-session'))
      } else if ((barrier.version ? compare(this.applied, barrier.version) >= 0 : this.caughtUp()) && this.forceApplied >= barrier.force) {
        this.barriers.delete(barrier)
        barrier.resolve()
      }
    }
  }

  private rejectBarriers(error: ProjectPublicationError): void {
    for (const barrier of this.barriers) barrier.reject(error)
    this.barriers.clear()
  }

  private startRead(): void {
    if (this.stopped || this.inFlight || this.caughtUp()) return
    this.inFlight = true
    const requested = this.desired && copy(this.desired)
    const force = this.forceRequested
    const traceId = this.traceId
    this.traceId = undefined
    // runRead catches every failure, including adapter/reporting failures, so an
    // event observer never creates an unhandled rejected promise.
    void this.runRead(requested, force, traceId)
  }

  private async runRead(requested: ProjectVersion | null, force: number, traceId?: string): Promise<void> {
    let failed = false
    try {
      const publication = await this.options.read(traceId, this.viewId)
      if (this.stopped) return
      const target = this.desired
      if ((target && compare(publication.version, target) < 0)
        || (this.applied && compare(publication.version, this.applied) < 0)) {
        // One follow-up is normal if a new event arrived during the read. Only
        // responses behind the target known at read start consume the retry.
        if (requested && compare(publication.version, requested) < 0) {
          if (!this.staleTarget || compare(this.staleTarget, requested) !== 0) {
            this.staleTarget = requested
            this.staleResponses = 0
          }
          if (++this.staleResponses >= 2) throw new ProjectPublicationError('stale-response')
        }
      } else if (force >= this.forceRequested) {
        const summary = this.materialize(publication)
        if (summary === UNFIT) {
          this.viewId = null
          this.request(publication.version, traceId)
          return
        }
        this.options.apply(summary, { version: publication.version, summary }, traceId)
        this.view = summary
        this.viewId = publication.viewId
        this.applied = copy(publication.version)
        if (!this.desired || compare(publication.version, this.desired) > 0) this.desired = copy(publication.version)
        if (compare(publication.version, this.desired) >= 0) this.traceId = undefined
        this.forceApplied = force
        this.staleResponses = 0
        this.staleTarget = null
        this.resolveBarriers()
      }
    } catch (cause) {
      if (this.stopped) return
      failed = true
      this.staleResponses = 0
      this.staleTarget = null
      const error = cause instanceof ProjectPublicationError ? cause : new ProjectPublicationError('read-failed', cause)
      this.rejectBarriers(error)
      try { this.options.onError?.(error) } catch { /* Reporting cannot break the owner. */ }
    } finally {
      this.inFlight = false
      if (!failed) this.startRead()
    }
  }
}

type ActivePublication = Pick<ProjectPublicationClient<unknown>, 'waitFor' | 'settle' | 'refresh' | 'stop'>
let active: ActivePublication | undefined

/** Installation and identity-guarded cleanup live here so IPC and the store
 *  depend on this module without importing one another. Replacing an owner ends
 *  its ability to publish immediately, even if its effect cleanup is delayed. */
export function attachProjectPublication(client: ActivePublication): () => void {
  if (active !== client) active?.stop()
  active = client
  return () => { if (active === client) active = undefined }
}

/** Startup open/new commands may precede the mirror's mount. Only those callers
 *  opt out of an unavailable barrier; the eventual mount owns its initial read.
 *  When a mirror is mounted, even startup commands wait for their version. */
export function awaitProjectPublication(version: ProjectVersion, allowUnmounted = false, traceId?: string): Promise<void> {
  return active?.waitFor(version, traceId) ?? (allowUnmounted ? Promise.resolve() : Promise.reject(new ProjectPublicationError('unavailable')))
}

export function settleActiveProjectPublication(): Promise<void> {
  return active?.settle() ?? Promise.reject(new ProjectPublicationError('unavailable'))
}

export function refreshActiveProjectPublication(): Promise<void> {
  return active?.refresh() ?? Promise.reject(new ProjectPublicationError('unavailable'))
}
