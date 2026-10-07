import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import type { DiagnosticIncident } from '../shared/diagnostics'

const MAX_LOG_BYTES = 512 * 1024
const MAX_PENDING_BYTES = 32 * 1024
const KEEP_SESSIONS = 8
const SESSION_NAME = /^\d{13}-[a-f0-9-]{36}$/

/** Best-effort redaction, applied BEFORE disk as well as on export. Free-form
 * error text still needs human review before being attached to a public issue. */
export function redactDiagnosticText(value: string): string {
  return value.slice(0, 16_384)
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, '$1 [redacted]')
    .replace(/\b(?:set-)?cookie\s*:[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]{8,}/g, '[redacted]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}"']+)/gi, '$1[redacted]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n<>"'|]*/gi, '[path]')
    .replace(/(?:file:\/\/)?\/(?:[^/\r\n<>"':]+\/)+[^\r\n<>"']*/g, '[path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
}

interface SessionState {
  id: string
  pid: number
  startedAt: string
  version: string
  closed: boolean
  failed: boolean
  acknowledged: boolean
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export class DiagnosticsStore {
  private readonly state: SessionState
  private readonly sessionDir: string
  private pending = ''
  private logBytes = 0
  private previousStates: SessionState[] = []
  private timer: ReturnType<typeof setInterval>
  private writable = true
  private previousEvidence: SessionState | null = null
  readonly previous: DiagnosticIncident | null

  constructor(private readonly root: string, version: string, alive = processAlive) {
    fs.mkdirSync(root, { recursive: true })
    const old = fs.readdirSync(root).filter(name => SESSION_NAME.test(name)).sort().reverse()
    const inactive: string[] = []
    for (const id of old) {
      try {
        if (!fs.lstatSync(path.join(root, id)).isDirectory()) continue
        inactive.push(id)
        const statePath = path.join(root, id, 'session.json')
        if (fs.statSync(statePath).size > 4096) continue
        const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SessionState
        if (s.id !== id || !Number.isInteger(s.pid) || s.pid < 1 || typeof s.version !== 'string'
          || typeof s.startedAt !== 'string' || typeof s.closed !== 'boolean'
          || typeof s.failed !== 'boolean' || typeof s.acknowledged !== 'boolean') continue
        if (!s.closed && alive(s.pid)) {
          inactive.pop() // Another running instance owns this session.
          continue
        }
        if ((!s.closed || s.failed) && !this.previousEvidence) this.previousEvidence = s
        if ((!s.closed || s.failed) && !s.acknowledged) this.previousStates.push(s)
      } catch { /* A corrupt/incomplete marker must not stop app startup. */ }
    }
    const latest = this.previousStates[0]
    this.previous = latest ? { id: latest.id, startedAt: latest.startedAt, version: latest.version,
      reason: latest.failed ? 'process-failure' : 'unclean-exit' } : null
    // Keep the most recent failure even if it was dismissed, so reporting later
    // from Help still exports it. Fixed names only, never paths from a marker.
    const keep = new Set<string>()
    if (this.previousEvidence) keep.add(this.previousEvidence.id)
    if (latest) keep.add(latest.id)
    for (const id of inactive) {
      if (keep.size >= KEEP_SESSIONS - 1) break
      keep.add(id)
    }
    for (const id of inactive.filter(id => !keep.has(id))) {
      try { fs.rmSync(path.join(root, id), { recursive: true, force: true }) } catch { /* best effort */ }
    }
    this.previousStates = this.previousStates.filter(s => keep.has(s.id))
    this.state = { id: `${Date.now()}-${randomUUID()}`, pid: process.pid, startedAt: new Date().toISOString(),
      version, closed: false, failed: false, acknowledged: false }
    this.sessionDir = path.join(root, this.state.id)
    fs.mkdirSync(this.sessionDir)
    this.saveState()
    // Small bounded batches, no per-frame writes; sync flush also works during fatal exit.
    this.timer = setInterval(() => this.flush(), 2000)
    this.timer.unref()
  }

  get available(): boolean { return this.writable }

  setEnvironment(environment: Record<string, unknown>): void {
    try { fs.writeFileSync(path.join(this.sessionDir, 'environment.json'), JSON.stringify(environment, null, 2)) }
    catch { this.writable = false }
  }

  private saveState(): void {
    try {
      const target = path.join(this.sessionDir, 'session.json')
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.state))
      fs.renameSync(`${target}.tmp`, target)
    } catch { this.writable = false }
  }

  record(kind: string, message: string): void {
    if (!this.writable) return
    const line = JSON.stringify({ at: new Date().toISOString(), kind: kind.slice(0, 64),
      message: redactDiagnosticText(message).slice(0, 4096) }) + '\n'
    // Drop excess chatter until the next flush instead of blocking on a log storm.
    if (Buffer.byteLength(this.pending) + Buffer.byteLength(line) <= MAX_PENDING_BYTES) this.pending += line
  }

  failure(kind: string, message: string): void {
    this.flush()
    this.record(kind, message)
    this.state.failed = true
    this.saveState()
    this.flush()
  }

  flush(): void {
    if (!this.pending || !this.writable) return
    try {
      const file = path.join(this.sessionDir, 'events.jsonl')
      if (this.logBytes + Buffer.byteLength(this.pending) > MAX_LOG_BYTES) {
        fs.rmSync(path.join(this.sessionDir, 'events.previous.jsonl'), { force: true })
        fs.renameSync(file, path.join(this.sessionDir, 'events.previous.jsonl'))
        this.logBytes = 0
      }
      fs.appendFileSync(file, this.pending)
      this.logBytes += Buffer.byteLength(this.pending)
    } catch { this.writable = false }
    this.pending = ''
  }

  dismissPrevious(): void {
    for (const s of this.previousStates) {
      s.acknowledged = true
      fs.writeFileSync(path.join(this.root, s.id, 'session.json'), JSON.stringify(s))
    }
    this.previousStates = []
  }

  close(clean: boolean): void {
    clearInterval(this.timer)
    this.flush()
    this.state.closed = clean
    this.saveState()
  }

  bundle(environment: Record<string, unknown>): Uint8Array {
    this.flush()
    if (!this.writable) throw new Error('Diagnostic storage is unavailable')
    const files: Record<string, Uint8Array> = {
      'README.txt': strToU8('WeftCut diagnostics\nReview these files before attaching this ZIP to a PUBLIC GitHub issue.\nNo project files, media, settings, credential stores or memory dumps are read.\nKnown paths, URLs and credential patterns are redacted, but free-form errors can still contain private text.\nLogs are bounded and may be incomplete after abrupt termination.\n'),
      'environment.json': strToU8(JSON.stringify(environment, null, 2)),
    }
    // A still-pending notice can precede a newer, already acknowledged failure
    // when two instances ran concurrently. Export the notice's actual evidence.
    const evidence = this.previous ?? this.previousEvidence
    const ids = [this.state.id, ...(evidence ? [evidence.id] : [])]
    for (const [index, id] of ids.entries()) {
      const prefix = index === 0 ? 'current' : 'previous'
      for (const name of ['session.json', 'environment.json', 'events.previous.jsonl', 'events.jsonl']) {
        const file = path.join(this.root, id, name)
        try {
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > MAX_LOG_BYTES) continue
          files[`${prefix}/${name}`] = strToU8(fs.readFileSync(file, 'utf8'))
        } catch { /* No events yet, or previous session was pruned/unreadable. */ }
      }
    }
    // STORE: bounded input, no CPU-heavy compression on the editor main thread.
    return zipSync(files, { level: 0 })
  }
}
