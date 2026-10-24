// apps/desktop/bench/drivers/dsh.ts
//
// DeepSeek Harness (`dsh --profile headless`) as a bench client, for DeepSeek
// models (`--driver dsh --model deepseek-flash`; `provider/model` names another
// route). As with the Claude driver, the machine's own setup changes nothing
// about a run:
// - Each run boots in its own DSH_HOME and agents home, fresh temp dirs, so
//   the user's dsh profiles, settings, skills and sessions stay out.
// - The skill under test sits where dsh finds a project skill
//   (`<workdir>/.dsh/skills`).
// - A patch overlay names the app as the only MCP server and turns off the
//   tools the Claude driver also withholds: shell, web, subagents, jobs,
//   workflows.
// - It also stops the session-log upload to DeepSeek and OTel capture.
//
// dsh headless answers one task per process, so the stand-in user's go-ahead
// is a second process that adopts the first one's Session (`--session-id`).
// The key is DEEPSEEK_API_KEY from the environment, else the user's own
// `~/.dsh/.env`; it is handed to the child, never written into the run.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Driver, DriverRunInput, DriverRunOutput } from './types'

const SERVER = 'weftcut'
const DEFAULT_PROVIDER = 'deepseek-official'

/** Rows of the headless profile turned off for a run: the tools the Claude
 *  driver withholds too. File tools, skills, todo and goal stay. */
const DISABLED_ROWS = ['tool-bash', 'tool-jobs', 'tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow']

/** USD per million tokens at peak hours, from DeepSeek's price list
 *  (api-docs.deepseek.com/quick_start/pricing, read 2026-10-24). Off-peak is
 *  half. A model not listed is run, and its cost recorded as unknown. */
const PEAK_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'deepseek-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
}

/** Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. (Chinese public
 *  holidays are off-peak too; a run on one is priced high.) */
export function isPeak(at: Date): boolean {
  const d = at.getUTCDay(), h = at.getUTCHours()
  return d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
}

/** A long tool call (transcribing a clip, a search) must not time out at
 *  dsh's 60 s default; the session's own timeout still bounds the run. */
const TOOL_CALL_TIMEOUT_MS = 15 * 60_000

function apiKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const env = fs.readFileSync(path.join(os.homedir(), '.dsh', '.env'), 'utf8')
    const m = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(env)
    return m?.[1]
  } catch { return undefined }
}

export function modelRoute(model: string): { provider: string; model: string } {
  const i = model.indexOf('/')
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + 1) } : { provider: DEFAULT_PROVIDER, model }
}

/** The run's overlay on the headless profile, as JSON (which YAML reads). */
export function runPatch(input: Pick<DriverRunInput, 'mcp' | 'model'>): unknown[] {
  return [
    { id: 'agent-default-model', config: modelRoute(input.model) },
    { id: 'session-log-deepseek', config: { enabled: false } },
    ...DISABLED_ROWS.map((id) => ({ id, disabled: true })),
    { insert: [{ id: `mcp-${SERVER}`, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: SERVER, transport: 'streamable-http', url: input.mcp.url,
      headers: { Authorization: `Bearer ${input.mcp.bearer_token}` },
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS, failOnStartupError: true,
    } }] },
  ]
}

interface Usage { input: number; cachedInput: number; output: number; steps: number }

/** Billed tokens and model round trips over the run's event stream: each
 *  `status` `step_end` event carries that step's provider usage. */
export function streamUsage(lines: string[]): Usage {
  const u: Usage = { input: 0, cachedInput: 0, output: 0, steps: 0 }
  for (const line of lines) {
    if (!line.includes('step_end')) continue
    try {
      const e = JSON.parse(line) as { type?: string; phase?: string; usage?: Record<string, number> }
      if (e.type !== 'status' || e.phase !== 'step_end') continue
      u.steps++
      const n = (k: string) => (typeof e.usage?.[k] === 'number' ? e.usage[k]! : 0)
      // inputTokens counts the uncached prompt; cache reads are billed apart.
      u.input += n('inputTokens') + n('cacheReadTokens'); u.cachedInput += n('cacheReadTokens'); u.output += n('outputTokens')
    } catch { /* a partial line */ }
  }
  return u
}

interface RunEvent { type: string; [k: string]: unknown }

export const dshDriver: Driver = {
  name: 'dsh',
  async run(input: DriverRunInput): Promise<DriverRunOutput> {
    const transcriptPath = path.join(input.artifacts_dir, 'transcript.jsonl')
    const stderrPath = path.join(input.artifacts_dir, 'driver-stderr.log')
    const key = apiKey()
    if (!key) {
      fs.writeFileSync(transcriptPath, '')
      return { transcript_path: transcriptPath, exit: { ok: false, code: null, signal: null, timed_out: false, error: 'dsh driver: no DEEPSEEK_API_KEY in the environment or in ~/.dsh/.env' } }
    }
    if (!fs.existsSync(path.join(input.skill_path, 'SKILL.md'))) throw new Error(`no SKILL.md in ${input.skill_path}`)
    // Copied, not linked, as in the Claude driver: the agent's write tool must
    // not reach the repo's skill.
    fs.cpSync(input.skill_path, path.join(input.workdir, '.dsh', 'skills', SERVER), { recursive: true })
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-dsh-'))
    const patchPath = path.join(home, 'bench.patch.yml')
    fs.writeFileSync(patchPath, JSON.stringify(runPatch(input), null, 2))
    const env: NodeJS.ProcessEnv = {
      ...process.env, DEEPSEEK_API_KEY: key, DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, 'agents'),
      DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'workspace-write',
    }
    const transcript = fs.createWriteStream(transcriptPath)
    const stderr = fs.createWriteStream(stderrPath)
    const started = new Date()
    const deadline = started.getTime() + input.limits.timeout_ms

    let sessionId: string | undefined
    let timedOut = false
    // One process per user message; each adopts the Session the first opened.
    const runOnce = (message: string) => new Promise<{ code: number | null; signal: string | null; final?: string; failed?: string; spawnError?: Error }>((resolve) => {
      const args = ['--profile', 'headless', '--patch', patchPath, '--json', ...(sessionId ? ['--session-id', sessionId] : []), '-']
      const child = spawn('dsh', args, { cwd: input.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.end(message)
      child.stderr.pipe(stderr, { end: false })
      let final: string | undefined, failed: string | undefined, pending = ''
      child.stdout.on('data', (chunk: Buffer) => {
        transcript.write(chunk)
        pending += chunk.toString('utf8')
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl); pending = pending.slice(nl + 1)
          try {
            const e = JSON.parse(line) as RunEvent
            if (e.type === 'session' && typeof e.sessionId === 'string') sessionId = e.sessionId
            if (e.type === 'final') final = String(e.text ?? '')
            if (e.type === 'status' && e.phase === 'turn_end') { const r = e.reason as { kind?: string; message?: string } | undefined; if (r?.kind !== 'completed') failed = `turn ended: ${r?.kind ?? 'unknown'}${r?.message ? ` (${r.message})` : ''}` }
            if (e.type === 'error') failed = String(e.message ?? e.code ?? 'error')
          } catch { /* not an event line */ }
        }
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, Math.max(1_000, deadline - Date.now()))
      child.once('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, spawnError: e }) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, final, failed }) })
    })

    const replies: string[] = []
    let turn = 0
    let last = await runOnce(input.task.prompt)
    for (;;) {
      turn++
      if (last.spawnError || timedOut || last.code !== 0 || !input.next_user_turn || !sessionId) break
      const reply = await input.next_user_turn(turn, last.final).catch(() => null)
      if (!reply) break
      replies.push(reply)
      last = await runOnce(reply)
    }
    await Promise.all([transcript, stderr].map((s) => new Promise((r) => s.end(r))))

    // The Session log stays with the run's evidence; the home goes.
    const sessions = path.join(home, 'sessions')
    if (fs.existsSync(sessions)) fs.cpSync(sessions, path.join(input.artifacts_dir, 'dsh-sessions'), { recursive: true })
    const usage = streamUsage(fs.readFileSync(transcriptPath, 'utf8').split('\n'))
    fs.rmSync(home, { recursive: true, force: true })
    const peak = PEAK_PRICES[modelRoute(input.model).model], k = isPeak(started) ? 1 : 0.5
    const cost = usage.steps && peak ? k * ((usage.input - usage.cachedInput) * peak.input + usage.cachedInput * peak.cachedInput + usage.output * peak.output) / 1e6 : undefined

    const error = last.spawnError ? last.spawnError.message
      : timedOut ? `timed out after ${input.limits.timeout_ms} ms`
      : last.failed ? `dsh reported an error: ${last.failed}`
      : last.code !== 0 ? `dsh exited ${last.code ?? last.signal}; see driver-stderr.log`
      : undefined
    return {
      transcript_path: transcriptPath,
      final_message: last.final,
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(usage.steps ? { turns: usage.steps } : {}),
      ...(replies.length ? { user_replies: replies } : {}),
      exit: { ok: !error, code: last.code, signal: last.signal, timed_out: timedOut, ...(error ? { error } : {}) },
    }
  },
}
