import { isMotifFrameAddress } from './frameAddress'
import {
  MOTIF_READER_PORT, MOTIF_READER_RESET,
  type MotifReaderControl, type MotifReaderMissReport, type MotifReaderReport,
} from '../../shared/motifs/readerProtocol'

/** `MessagePortMain`, as far as main uses it. */
export interface MotifReaderPort { close(): void }

/** `UtilityProcess`, as far as main uses it. */
export interface MotifReaderChild {
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: () => void): unknown
  postMessage(message: unknown, transfer?: MotifReaderPort[]): void
  kill(): boolean
}

/** The renderer document's `WebContents`, as far as main uses it. */
export interface MotifReaderDocument {
  isDestroyed(): boolean
  postMessage(channel: string, message: unknown, transfer?: MotifReaderPort[]): void
  send(channel: string): void
}

export interface MotifReaderWorkspace { generation: number | null; root: string | null }

interface Dependencies {
  fork(): MotifReaderChild
  channel(): { port1: MotifReaderPort; port2: MotifReaderPort }
  /** The generation and raster root `currentMotifStore()` uses; the root is
   * null during a transition and with no workspace. */
  workspace(): MotifReaderWorkspace
  reportMiss(hash: string, frame: number): void
  log(line: string): void
}

const RESTART_MIN_MS = 250
const RESTART_MAX_MS = 8_000
const STABLE_MS = 60_000

/** A document's one connection. `owed`: it asked and needs a channel from a
 * live utility; `sent`: `port1` is with the utility and main holds `port2`
 * until the utility acknowledges it; `delivered`: the document has `port2`. */
type Connection =
  | { state: 'owed' }
  | { state: 'sent'; id: number; port: MotifReaderPort }
  | { state: 'delivered'; id: number }

/** Main's side of the app-wide Motif reader utility (ADR 0154). It starts the
 * process on the first connect, keeps it on the current raster root, hands
 * each renderer document one port the utility has accepted, and folds the
 * utility's miss reports into coverage. Main is not on the read path. */
export class MotifReaderService {
  private child: MotifReaderChild | null = null
  private spawned = false
  private startedAt = 0
  private notBefore = 0
  private failures = 0
  private restart: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private nextPort = 0
  /** One connection per live document; a reconnect supersedes the previous one. */
  private documents = new Map<MotifReaderDocument, Connection>()

  constructor(private readonly deps: Dependencies) {}

  /** `motif:reader-connect`: give `port1` to the utility, starting it when
   * needed, and post `port2` to the document once the utility has it. */
  connect(owner: MotifReaderDocument): void {
    if (this.stopped || owner.isDestroyed()) return
    this.retire(owner)
    this.documents.set(owner, { state: 'owed' })
    this.start()
    this.flush()
  }

  /** The document navigated, reloaded, crashed or was destroyed. */
  retire(owner: MotifReaderDocument): void {
    const connection = this.documents.get(owner)
    if (!connection) return
    this.documents.delete(owner)
    // A `port1` the utility has not acknowledged yet is retired on its ack.
    if (connection.state === 'sent') connection.port.close()
    else if (connection.state === 'delivered') this.post({ type: 'retire', id: connection.id })
  }

  /** Every workspace activate or end, and the start of each transition. */
  workspaceChanged(): void {
    this.post({ type: 'workspace', ...this.deps.workspace() })
  }

  stop(): void {
    this.stopped = true
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    for (const connection of this.documents.values()) {
      if (connection.state === 'sent') connection.port.close()
    }
    this.documents.clear()
    const child = this.child
    this.child = null
    this.spawned = false
    try { child?.kill() } catch { /* already gone */ }
  }

  private post(message: MotifReaderControl, transfer?: MotifReaderPort[]): void {
    // Before 'spawn' the current state is sent on spawn instead.
    if (!this.child || !this.spawned) return
    try { this.child.postMessage(message, transfer) } catch { /* its exit restarts the lane */ }
  }

  /** A fresh channel for each owed document, `port1` to the live utility. */
  private flush(): void {
    if (!this.spawned) return
    for (const [owner, connection] of this.documents) {
      if (connection.state !== 'owed') continue
      if (owner.isDestroyed()) { this.documents.delete(owner); continue }
      const { port1, port2 } = this.deps.channel()
      const id = ++this.nextPort
      this.documents.set(owner, { state: 'sent', id, port: port2 })
      this.post({ type: 'port', id }, [port1])
    }
  }

  /** The utility attached `port1` of `id`: only now does the document get
   * `port2`. A superseded or retired id is retired in the utility too. */
  private ready(id: number): void {
    for (const [owner, connection] of this.documents) {
      if (connection.state !== 'sent' || connection.id !== id) continue
      if (!owner.isDestroyed()) {
        try {
          owner.postMessage(MOTIF_READER_PORT, null, [connection.port])
          this.documents.set(owner, { state: 'delivered', id })
          return
        } catch { /* destroyed meanwhile */ }
      }
      this.documents.delete(owner)
      connection.port.close()
      break
    }
    this.post({ type: 'retire', id })
  }

  private start(): void {
    if (this.stopped || this.child || this.restart) return
    const wait = this.notBefore - Date.now()
    if (wait > 0) {
      this.restart = setTimeout(() => { this.restart = null; this.start() }, wait)
      return
    }
    this.startedAt = Date.now()
    let child: MotifReaderChild
    try { child = this.deps.fork() } catch (error) {
      this.exited(`fork failed: ${String(error).slice(0, 256)}`)
      return
    }
    this.child = child
    this.spawned = false
    child.on('spawn', () => {
      if (this.child !== child) return
      this.spawned = true
      this.workspaceChanged()
      this.flush()
    })
    child.on('message', message => { if (this.child === child) this.received(message) })
    // A V8 fatal error is followed by 'exit'; an unhandled 'error' would throw in main.
    child.on('error', () => {})
    child.on('exit', code => { if (this.child === child) this.exited(`code ${code}`) })
  }

  private exited(reason: string): void {
    this.child = null
    this.spawned = false
    if (this.stopped) return
    if (Date.now() - this.startedAt >= STABLE_MS) this.failures = 0
    const delay = Math.min(RESTART_MIN_MS * 2 ** this.failures, RESTART_MAX_MS)
    this.failures++
    this.notBefore = Date.now() + delay
    this.deps.log(`[motif-reader] utility process exited (${reason}); restarting in ${delay} ms`)
    // Every `port1` died with the process. A document still owed its port
    // gets one from the restarted utility, never a reset; one that had its
    // port reconnects on the reset.
    let live = 0
    for (const [owner, connection] of this.documents) {
      if (connection.state === 'sent') connection.port.close()
      if (owner.isDestroyed()) { this.documents.delete(owner); continue }
      live++
      if (connection.state !== 'delivered') {
        this.documents.set(owner, { state: 'owed' })
        continue
      }
      this.documents.delete(owner)
      try { owner.send(MOTIF_READER_RESET) } catch { /* destroyed meanwhile */ }
    }
    // With no document left, the next connect starts it, still after `notBefore`.
    if (live > 0) this.start()
  }

  private received(message: unknown): void {
    const report = message as MotifReaderReport | null
    if (!report || typeof report !== 'object') return
    if (report.type === 'port-ready') {
      if (Number.isSafeInteger(report.id)) this.ready(report.id)
    } else if (report.type === 'miss') this.missed(report)
  }

  private missed(miss: MotifReaderMissReport): void {
    if (!isMotifFrameAddress(miss.hash, miss.frame)) return
    // A report from an older generation names a file main no longer covers.
    if (typeof miss.generation !== 'number' || miss.generation !== this.deps.workspace().generation) return
    try { this.deps.reportMiss(miss.hash, miss.frame) } catch { /* no store while a project opens */ }
  }
}
