import type { WebContents } from 'electron'
import type { MotifOsrFrame } from './offscreenFrames'
import type { CaptureArgs, CaptureOptions, CaptureRun, CaptureTicket } from './capture'
import type { FrameWriter, MotifFrameStore } from './frameStore'
import type { FrameRead, MotifFrameWriteQueue, QueuedWrite } from './frameWriteQueue'
import type { MotifCacheAddress, MotifFramePriority, StoredMotifFrame } from '../../shared/motifs/frameTransport'
import { asMotifCapacity, MotifError, motifErrorCode, motifSuperseded } from '../../shared/motifs/errors'
import { backgroundResourcePause, reserveResources } from '../resources'

type TextureOsrFrame = Extract<MotifOsrFrame, { kind: 'texture' }>
type BitmapOsrFrame = Extract<MotifOsrFrame, { kind: 'bitmap' }>

/** A request that wants the frame's pixels: a preview or an export frame. */
export interface DisplaySubscriber {
  owner: WebContents
  priority: MotifFramePriority
  isCurrent: () => boolean
  /** An export's finalization: its GPU copy counts against it. */
  finalizationId?: number
  /** `store: 'keep'`: the reply waits for the write and reports it. */
  keep: boolean
}
/** A request that wants the frame stored and nothing back (preparation). */
export interface PersistSubscriber {
  priority: MotifFramePriority
  isCurrent: () => boolean
}
export interface FrameJobHandle {
  setPriority(priority: MotifFramePriority): void
  /** Withdraws the request (superseded). Its job's capture is cancelled only
   * when nobody else waits for it. */
  cancel(): void
}
export interface FrameJobRequest<T> { result: Promise<T>; handle: FrameJobHandle }

/** What a job uses of the capture session that owns it (`MotifCaptureService`). */
export interface FrameJobSession {
  capture<T>(args: CaptureArgs, consume: (frame: MotifOsrFrame) => Promise<T>, options: CaptureOptions): CaptureRun<T>
  /** The next capture is a shared texture. */
  textures(): boolean
  /** A failure of the shared-texture output: later captures are bitmaps. */
  useBitmaps(reason: unknown): void
  /** One display's copy of a leased texture. */
  copy(owner: WebContents, frame: TextureOsrFrame, finalizationId?: number): Promise<StoredMotifFrame>
  /** A bitmap's picture as straight RGBA. */
  straighten(frame: BitmapOsrFrame): Promise<Buffer>
  /** Reads the pixels inside the lease; the returned step encodes and stores
   * them. `rgba` is a bitmap's picture when a display already straightened it. */
  read(frame: MotifOsrFrame, args: CaptureArgs, writer: FrameWriter, rgba?: Buffer): FrameRead
  readonly writes: MotifFrameWriteQueue
  /** A live write failed. It never reaches a display. */
  liveWriteFailed(error: unknown): void
}

interface Member {
  /** Null for persistence. */
  display: DisplaySubscriber | null
  afterMiss: boolean
  priority: MotifFramePriority
  isCurrent: () => boolean
  cancelled: boolean
  settled: boolean
  /** `joined`: in a job before its lease. `leased`: its job's lease took it.
   * `waiting`: arrived after a lease and waits for that job's write. */
  stage: 'joined' | 'leased' | 'waiting'
  job: Job | null
  resolve(value: StoredMotifFrame | undefined): void
  reject(error: unknown): void
}

type JobState = 'probing' | 'queued' | 'leased' | 'writing' | 'done'
interface Job {
  /** Its table key; null for an unaddressed capture, which no one joins. */
  key: string | null
  address: MotifCacheAddress | undefined
  args: CaptureArgs
  state: JobState
  /** Subscribers before the lease. */
  members: Set<Member>
  ticket: CaptureTicket | null
  release: (() => void) | null
  writer: Promise<FrameWriter | null> | null
  /** Settles once the job has left the table: whether its write stored the frame. */
  outcome: Promise<boolean>
  settle(written: boolean): void
}

const RANK: Record<MotifFramePriority, number> = { current: 0, ahead: 1, background: 2 }
const addressKey = (address: MotifCacheAddress) => `${address.hash}:${address.frame}`
const live = (member: Member) => !member.cancelled && member.isCurrent()
/** Main never reads stored pixels on the capture path (ADR 0154). */
const storedFrame = (): StoredMotifFrame => ({ kind: 'stored', persisted: true })

/** `reserveResources`, its refusal coded `capacity`. */
function reserve(...args: Parameters<typeof reserveResources>): () => void {
  try { return reserveResources(...args) } catch (error) { throw asMotifCapacity(error) }
}

/** Only a `device` failure, or an uncoded one, which comes from the
 * shared-texture output itself (its lease, GPU copy or readback), switches the
 * session to bitmaps. Every coded failure (a disk write, a resource refusal, a
 * superseded request, the Motif's own script, a hung host, a held mutex)
 * happened before or beside that output: a bitmap retry would not fix it, and
 * the switch would cost every later frame its GPU path. */
export function failsTexturePath(error: unknown): boolean {
  const code = motifErrorCode(error)
  return code === undefined || code === 'device'
}

/** One job per cache address of one workspace store: every request for a frame
 * (display or persistence) that arrives before its capture's lease shares that
 * capture, and every write of the address is this job's (ADR 0160). A request
 * after the lease waits for the write. Unaddressed captures (parameter
 * previews, e2e) get a job of their own outside the table. */
export class MotifFrameJobs {
  private readonly table = new Map<string, Job>()

  constructor(private readonly store: MotifFrameStore, private readonly session: FrameJobSession) {}

  /** `afterMiss`: the renderer read `address` after a `stored` answer and
   * missed, so this request is never answered `stored`: it captures and
   * offers a write like any display. A skipped live write leaves the file;
   * the miss already dropped the frame from coverage. A first read miss comes
   * without `afterMiss` and is checked against the store (ADR 0160). */
  display(address: MotifCacheAddress | undefined, args: CaptureArgs, subscriber: DisplaySubscriber, afterMiss: boolean): FrameJobRequest<StoredMotifFrame> {
    return this.request(subscriber, subscriber, afterMiss, address, args) as FrameJobRequest<StoredMotifFrame>
  }

  /** Never stats the store: preparation asks only for frames its inventory
   * lacks. Resolves once this request's frame is written. */
  persist(address: MotifCacheAddress, args: CaptureArgs, subscriber: PersistSubscriber): FrameJobRequest<void> {
    return this.request(null, subscriber, false, address, args) as FrameJobRequest<void>
  }

  private request(display: DisplaySubscriber | null, subscriber: PersistSubscriber, afterMiss: boolean, address: MotifCacheAddress | undefined, args: CaptureArgs): FrameJobRequest<StoredMotifFrame | undefined> {
    let member!: Member
    const result = new Promise<StoredMotifFrame | undefined>((resolve, reject) => {
      member = {
        display, afterMiss, priority: subscriber.priority, isCurrent: subscriber.isCurrent,
        cancelled: false, settled: false, stage: 'joined', job: null,
        resolve: value => { if (!member.settled) { member.settled = true; resolve(value) } },
        reject: error => { if (!member.settled) { member.settled = true; reject(error) } },
      }
    })
    this.admit(member, address, args)
    return {
      result,
      handle: {
        setPriority: priority => {
          member.priority = priority
          if (member.job) this.prioritize(member.job)
        },
        cancel: () => this.cancel(member),
      },
    }
  }

  private admit(member: Member, address: MotifCacheAddress | undefined, args: CaptureArgs): void {
    if (member.settled) return
    if (!live(member)) { member.reject(motifSuperseded()); return }
    if (!address) {
      const job = this.create(null, undefined, args)
      this.join(job, member)
      this.queue(job)
      return
    }
    const key = addressKey(address)
    const job = this.table.get(key)
    if (!job) {
      const created = this.create(key, address, args)
      this.table.set(key, created)
      this.join(created, member)
      if (member.display && !member.afterMiss) void this.probe(created)
      else this.queue(created)
      return
    }
    if (job.state === 'probing' || job.state === 'queued') {
      this.join(job, member)
      this.prioritize(job)
      return
    }
    // Past its lease: this job's write decides. The job leaves the table
    // before its outcome settles, so a request that still needs a capture
    // starts a new job.
    member.stage = 'waiting'
    member.job = null
    void job.outcome.then(written => {
      if (member.settled) return
      if (!live(member)) { member.reject(motifSuperseded()); return }
      if (written && !(member.display && member.afterMiss)) { member.resolve(member.display ? storedFrame() : undefined); return }
      member.stage = 'joined'
      this.admit(member, address, args)
    })
  }

  private create(key: string | null, address: MotifCacheAddress | undefined, args: CaptureArgs): Job {
    let settle!: (written: boolean) => void
    const outcome = new Promise<boolean>(resolve => { settle = resolve })
    return { key, address, args, state: 'queued', members: new Set(), ticket: null, release: null, writer: null, outcome, settle }
  }

  private join(job: Job, member: Member): void {
    job.members.add(member)
    member.stage = 'joined'
    member.job = job
    // Bind the destination before capture: a project switch cannot redirect
    // the frame into the next workspace.
    if (job.address && (!member.display || member.display.keep)) this.prepare(job)
  }

  private prepare(job: Job): Promise<FrameWriter | null> {
    if (!job.writer) {
      job.writer = this.store.prepareWrite(job.address!.hash, job.address!.frame)
      job.writer.catch(() => {})
    }
    return job.writer
  }

  private priority(job: Job): MotifFramePriority {
    let best: MotifFramePriority = 'background'
    for (const member of job.members) if (!member.cancelled && RANK[member.priority] < RANK[best]) best = member.priority
    return best
  }

  private prioritize(job: Job): void {
    if (job.state === 'queued') job.ticket?.setPriority(this.priority(job))
  }

  private wanted(job: Job): boolean {
    for (const member of job.members) if (live(member)) return true
    return false
  }

  private cancel(member: Member): void {
    if (member.settled || member.cancelled) return
    member.cancelled = true
    // A leased request keeps its place: a copy already made is still sent,
    // and the renderer closes what arrives.
    if (member.stage === 'leased') return
    const job = member.job
    member.job = null
    member.reject(motifSuperseded())
    if (!job) return
    job.members.delete(member)
    if (job.state !== 'queued') return
    if (job.members.size > 0) { this.prioritize(job); return }
    job.ticket?.cancel()
    this.finish(job, false)
  }

  /** Is the frame already stored? Answers every display that may be answered
   * `stored`; persistence and `afterMiss` displays go on to capture. */
  private async probe(job: Job): Promise<void> {
    job.state = 'probing'
    const { hash, frame } = job.address!
    // Stat-only (docs/motifs.md#preparation-l2-baking): the renderer's reader
    // reads and verifies it, and an unreadable entry is captured afterMiss.
    const stored = await this.store.has(hash, frame).catch(() => false)
    for (const member of [...job.members]) {
      if (live(member) && !(stored && member.display && !member.afterMiss)) continue
      job.members.delete(member)
      member.job = null
      if (live(member)) member.resolve(storedFrame())
      else member.reject(motifSuperseded())
    }
    if (job.members.size === 0) this.finish(job, false)
    else this.queue(job)
  }

  private queue(job: Job): void {
    job.state = 'queued'
    if (!job.release) {
      // One reservation per job, borrowed from the plan of the first export
      // in it now; an export joining later is not charged (ADR 0160).
      const finalizationId = [...job.members].find(member => member.display?.finalizationId !== undefined)?.display?.finalizationId
      try { job.release = reserve(0, 16 + job.args.width * job.args.height * 16 / 1048576, finalizationId) }
      catch (error) { this.fail(job, error); return }
    }
    void this.run(job)
  }

  /** Captures until a lease takes the job. A failure of the shared-texture
   * output before the lease moves the session to bitmaps and captures again
   * for everyone; any other failure is everyone's. */
  private async run(job: Job): Promise<void> {
    for (;;) {
      const texture = this.session.textures()
      try {
        // Inside the try: a capture that throws before it returns fails the
        // job like one that rejects, instead of leaving it queued.
        const { result, ticket } = this.session.capture(job.args, frame => this.lease(job, frame), {
          priority: this.priority(job), isCurrent: () => this.wanted(job),
        })
        job.ticket = ticket
        await result
        return
      } catch (error) {
        job.ticket = null
        // A lease, or the last request leaving, has settled everyone.
        if (job.state !== 'queued') return
        if (texture && failsTexturePath(error) && this.wanted(job)) { this.session.useBitmaps(error); continue }
        this.fail(job, error)
        return
      }
    }
  }

  /** Inside the capture lease. Every display gets pixels before the write is
   * offered: a texture by its own GPU copy, a bitmap straightened once for all.
   * A kept display or persistence makes the write one that waits for a slot;
   * otherwise displays offer a live write that a full queue skips. */
  private async lease(job: Job, frame: MotifOsrFrame): Promise<void> {
    if (job.state !== 'queued') throw motifSuperseded()
    job.state = 'leased'
    job.ticket = null
    const leased: Member[] = []
    for (const member of job.members) {
      member.job = null
      if (live(member)) { member.stage = 'leased'; leased.push(member) }
      else member.reject(motifSuperseded())
    }
    job.members.clear()
    // Nobody left: no copy, no write.
    if (leased.length === 0) { this.finish(job, false); throw motifSuperseded() }

    const displays = leased.filter(member => member.display)
    const persists = leased.filter(member => !member.display)
    const wait = job.address !== undefined && (persists.length > 0 || displays.some(member => member.display!.keep))
    let rgba: Buffer | undefined
    let rgbaError: unknown
    if (frame.kind === 'bitmap' && displays.length > 0) {
      try { rgba = await this.session.straighten(frame) } catch (error) { rgbaError = error }
    }
    const kept = new Map<Member, StoredMotifFrame>()
    await Promise.all(displays.map(member => this.deliver(job, member, frame, rgba, rgbaError, wait ? kept : null)))

    let queued: QueuedWrite | null = null
    let failure: unknown = null
    let recapture = false
    if (wait) {
      try {
        const writer = await this.prepare(job)
        if (!writer) throw new MotifError('closed', 'Motif frame has no open workspace')
        try { queued = await this.session.writes.offer('wait', this.session.read(frame, job.args, writer, rgba)) }
        catch (error) {
          failure = error
          // The readback failed with the texture output: persistence captures
          // the frame again, as a bitmap. The switch is made here, not trusted
          // to the readback: a texture again would fail again, without end.
          if (frame.kind === 'texture' && failsTexturePath(error)) {
            this.session.useBitmaps(error)
            recapture = !this.session.textures()
          }
        }
      } catch (error) { failure = error }
    } else {
      if (job.address) queued = await this.offerLive(job, frame, rgba)
      this.unreserve(job)
    }
    job.state = 'writing'
    void this.written(job, queued, failure, recapture, wait, kept, persists)
  }

  private async deliver(job: Job, member: Member, frame: MotifOsrFrame, rgba: Buffer | undefined, rgbaError: unknown, kept: Map<Member, StoredMotifFrame> | null): Promise<void> {
    const { display } = member
    try {
      // A capture can finish after a document reload, whose new preload on the
      // same WebContents must not lease this texture.
      if (!live(member)) throw motifSuperseded()
      let pixels: StoredMotifFrame
      if (frame.kind === 'texture') pixels = await this.session.copy(display!.owner, frame, display!.finalizationId)
      else if (rgba) pixels = { kind: 'pixels', width: frame.width, height: frame.height, bytes: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) }
      else throw rgbaError
      if (kept && display!.keep) kept.set(member, pixels)
      else member.resolve({ ...pixels, persisted: false })
    } catch (error) {
      if (frame.kind === 'texture' && failsTexturePath(error)) {
        this.session.useBitmaps(error)
        member.stage = 'joined'
        this.admit(member, job.address, job.args)
      } else member.reject(error)
    }
  }

  /** A frame nobody asked to keep is stored when there is room: never under
   * memory pressure, without room in the cache, or when both write slots are
   * taken. No failure here reaches a display. Pixels in flight are charged to
   * the write, which outlives the lease. */
  private async offerLive(job: Job, frame: MotifOsrFrame, rgba: Buffer | undefined): Promise<QueuedWrite | null> {
    const { hash, frame: index } = job.address!
    try {
      if (backgroundResourcePause() === 'memory' || !this.store.hasRoom(hash, index)) return null
      return await this.session.writes.offer('skip', async () => {
        const release = reserve(0, job.args.width * job.args.height * 8 / 1048576)
        try {
          const writer = await this.prepare(job)
          if (!writer) throw new MotifError('closed', 'Motif frame has no open workspace')
          const encodeAndStore = await this.session.read(frame, job.args, writer, rgba)()
          return () => encodeAndStore().finally(release)
        } catch (error) { release(); throw error }
      })
    } catch (error) {
      this.session.liveWriteFailed(error)
      return null
    }
  }

  /** After the lease: the job leaves the table with its write's outcome, so
   * requests waiting for it read the frame or capture it again. A failed write
   * costs the cache, never pixels a display already has. */
  private async written(job: Job, queued: QueuedWrite | null, failure: unknown, recapture: boolean, wait: boolean, kept: Map<Member, StoredMotifFrame>, persists: Member[]): Promise<void> {
    let written = false
    if (queued) {
      try { await queued.written; written = true }
      catch (error) { failure = error; if (!wait) this.session.liveWriteFailed(error) }
    }
    this.finish(job, written)
    for (const [member, pixels] of kept) member.resolve({ ...pixels, persisted: written })
    for (const member of persists) {
      if (!live(member)) member.reject(motifSuperseded())
      else if (written) member.resolve(undefined)
      else if (recapture) { member.stage = 'joined'; this.admit(member, job.address, job.args) }
      else member.reject(failure ?? new MotifError('closed', 'Motif frame was not stored'))
    }
  }

  private fail(job: Job, error: unknown): void {
    for (const member of job.members) {
      member.job = null
      member.reject(live(member) ? error : motifSuperseded())
    }
    job.members.clear()
    this.finish(job, false)
  }

  private finish(job: Job, written: boolean): void {
    if (job.state === 'done') return
    job.state = 'done'
    if (job.key !== null && this.table.get(job.key) === job) this.table.delete(job.key)
    this.unreserve(job)
    job.settle(written)
  }

  /** Releases the job's reservation once, whichever of the lease or the
   * finish comes first. */
  private unreserve(job: Job): void {
    const release = job.release
    job.release = null
    release?.()
  }
}
