// apps/desktop/bench/runner.ts
//
// One bench run: launch the built app, set the task's project up over a real
// MCP client, snapshot it, hand the session to a driver, snapshot again and
// record what changed. Everything measured here comes from the app — the
// agent's own report is kept, but only beside the evidence (ADR 0123: no
// self-certification).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { launchApp } from '../e2e/electron/helpers/driver'
import { resourceDiagnostics } from '../e2e/electron/helpers/resourceDiagnostics'
import { initEval } from '../src/renderer/eval'
import { diffProjects } from '../src/main/state/reviewDiff'
import { parseProject } from '../src/main/state/serialize'
import type { WeftcutApi } from '../src/shared/ipc'
import { driverNamed } from './drivers'
import { mediaJobLog, recordMediaJobs, waitForMedia } from './mediaReady'
import type { McpEndpoint, RunResult } from './drivers/types'
import { resolveArgs, type BenchTask } from './tasks'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))

/** One cell of the matrix, as `run.mjs` plans it. */
export interface PlannedRun {
  run_id: string
  task: BenchTask
  model: string
  driver: string
  skill_path: string
  out_dir: string
  timeout_ms: number
  /** Bound on the wait for imported media's background jobs. */
  media_timeout_ms: number
  /** Pins the app's resource policy memory (Settings → Resources). Unset
   *  keeps the app's own default, 35% of host RAM. */
  app_memory_mib?: number
  budget_usd?: number
}

type McpCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

/** A sibling module another ticket owns, loaded only if it exists yet — the
 *  runner must not need them to run a synthetic task. */
async function optionalModule<T>(file: string): Promise<T | null> {
  const p = path.join(BENCH_DIR, file)
  return fs.existsSync(p) ? ((await import(pathToFileURL(p).href)) as T) : null
}

function hashDir(dir: string): string {
  const h = crypto.createHash('sha256')
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(path.relative(dir, p)).update('\0').update(fs.readFileSync(p)).update('\0')
    }
  }
  walk(dir)
  return h.digest('hex')
}

function appRevision(): string | null {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: BENCH_DIR, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Catalog entries keyed by id. A Motif the agent opened, edited or installed
 *  shows up as an id the baseline lacked or an entry whose record moved. */
function diffMotifs(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>) {
  const was = new Map(before.map((m) => [String(m.id), JSON.stringify(m)]))
  return {
    added: after.filter((m) => !was.has(String(m.id))),
    changed: after.filter((m) => was.has(String(m.id)) && was.get(String(m.id)) !== JSON.stringify(m)),
  }
}

function writeJson(dir: string, name: string, value: unknown): string {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n')
  return name
}

/** The project and every setup call, made over the same authenticated MCP
 *  surface the agent will use — so a setup the agent could not have reached
 *  fails here, not as a mystery inside the run. */
async function setUpProject(call: McpCall, task: BenchTask, parentFolder: string): Promise<void> {
  await call('create_project', {
    parent_folder: parentFolder, name: task.id,
    width: task.project.width, height: task.project.height, fps: task.project.fps,
  })
  const fixtures = new Map<string, string>()
  if (task.fixtures.length) {
    const mod = await optionalModule<{ resolveFixture(id: string): Promise<string> }>('fixtures/fixtures.mjs')
    if (!mod) throw new Error(`task ${task.id} needs fixtures but bench/fixtures/fixtures.mjs does not exist`)
    for (const id of task.fixtures) fixtures.set(id, await mod.resolveFixture(id))
  }
  const refs = new Map<string, unknown>()
  for (const [i, step] of task.setup.entries()) {
    const args = resolveArgs(step.args ?? {}, fixtures, refs) as Record<string, unknown>
    const result = await call(step.tool, args).catch((e: Error) => {
      throw new Error(`setup[${i}] ${step.tool}: ${e.message}`)
    })
    if (step.as) refs.set(step.as, result)
  }
}

/** Copy what the agent wrote into its working directory (a Motif package, say)
 *  minus the skill the driver installed there. */
function copyWorkdir(workdir: string, dest: string): string | null {
  const entries = fs.readdirSync(workdir).filter((e) => e !== '.claude')
  const extra = fs.existsSync(path.join(workdir, '.claude'))
    ? fs.readdirSync(path.join(workdir, '.claude')).filter((e) => e !== 'skills').map((e) => path.join('.claude', e))
    : []
  if (!entries.length && !extra.length) return null
  for (const e of [...entries, ...extra]) fs.cpSync(path.join(workdir, e), path.join(dest, e), { recursive: true })
  return path.basename(dest)
}

export async function runOne(plan: PlannedRun): Promise<RunResult> {
  const startedAt = new Date()
  fs.mkdirSync(plan.out_dir, { recursive: true })
  const result: RunResult = {
    run_id: plan.run_id, task_id: plan.task.id, model: plan.model, driver: plan.driver,
    skill: null, app_revision: appRevision(),
    transcript: null, baseline_project: null, final_project: null, review_diff: null, review_diff_size: null,
    checklist: null, audit: null, frames: null, cost: { usd: null, turns: null }, rounds: null,
    app_resources: null, media_wait: null, motifs: null, workdir_copy: null, final_message: null, exit: null, error: null,
    started_at: startedAt.toISOString(), duration_ms: 0,
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-bench-'))
  const workdir = path.join(scratch, 'work')
  fs.mkdirSync(workdir)
  let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined
  let client: Client | undefined
  try {
    const launched = await launchApp()
    app = launched.app
    const page = launched.page
    // The main process's own log: job failures and admission waits show up
    // here and nowhere the MCP client can see.
    const appLog = fs.createWriteStream(path.join(plan.out_dir, 'app.log'))
    app.process().stdout?.pipe(appLog)
    app.process().stderr?.pipe(appLog)
    result.skill = { path: plan.skill_path, sha256: hashDir(plan.skill_path) }
    const driver = driverNamed(plan.driver)
    const mcp = (await page.evaluate(() => (window as unknown as { api: WeftcutApi }).api.mcp.getInfo())) as McpEndpoint
    client = new Client({ name: 'weftcut-bench', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${mcp.bearer_token}` } },
    }))
    const c = client
    const call: McpCall = async (name, args) => {
      const r = await c.callTool({ name, arguments: args })
      if (r.isError) throw new Error(JSON.stringify(r.content))
      if (r.structuredContent) return r.structuredContent
      // Some tools answer JSON as text (read_project's views do); setup refs
      // must reach into those too, e.g. the A-roll track's id.
      const text = (r.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text
      if (text === undefined) return {}
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    }
    const read = async (uri: string): Promise<unknown> => {
      const content = (await c.readResource({ uri })).contents[0]
      if (!content || !('text' in content)) throw new Error(`${uri}: expected a text resource`)
      return JSON.parse(content.text)
    }
    const readMotifs = () => read('motifs://current') as Promise<Array<Record<string, unknown>>>

    const invoke = (cmd: string, args: Record<string, unknown> = {}) =>
      page.evaluate(([c, a]) => (window as unknown as { api: WeftcutApi }).api.backend.invoke(c, a), [cmd, args] as const)
    if (plan.app_memory_mib !== undefined)
      await invoke('app_settings_set', { patch: { resource_policy: { memory_mib: plan.app_memory_mib } } })
    const settings = await invoke('app_settings_get') as { resource_policy?: unknown; resource_allocation?: unknown }
    result.app_resources = { policy: settings.resource_policy ?? null, allocation: settings.resource_allocation ?? null }

    await recordMediaJobs(page)
    await setUpProject(call, plan.task, path.join(scratch, 'projects'))
    result.media_wait = await waitForMedia(page, () => read('project://media') as never, plan.media_timeout_ms)
      .finally(async () => { writeJson(plan.out_dir, 'media-jobs.json', await mediaJobLog(page).catch(() => [])) })
      .catch(async (e: Error) => {
        // A stuck job is almost always the resource governor declining to
        // admit it; its ledger says which limit.
        const diag = await resourceDiagnostics(page).catch((d: Error) => ({ error: d.message }))
        writeJson(plan.out_dir, 'media-wait-diagnostics.json', diag)
        const status = (diag as { renderer?: { sampledStatus?: { pressure?: string; memory_mib?: number } } }).renderer?.sampledStatus
        const alloc = (result.app_resources?.allocation as { memory_mib?: number } | null)?.memory_mib
        if (status?.pressure === 'constrained')
          e.message += `; the app reports memory pressure (process tree ${Math.round(status.memory_mib ?? 0)} MiB over its ` +
            `${alloc ?? '?'} MiB allocation), so background jobs are not admitted — raise it with --app-memory-mib`
        throw e
      })
    const baselineWire = await read('project://current')
    result.baseline_project = writeJson(plan.out_dir, 'baseline.json', baselineWire)
    const motifsBefore = await readMotifs()

    const out = await driver.run({
      task: plan.task, skill_path: plan.skill_path, mcp, model: plan.model, workdir,
      artifacts_dir: plan.out_dir,
      limits: { timeout_ms: plan.timeout_ms, ...(plan.budget_usd !== undefined ? { budget_usd: plan.budget_usd } : {}) },
    })
    result.transcript = path.relative(plan.out_dir, out.transcript_path)
    result.cost = { usd: out.cost_usd ?? null, turns: out.turns ?? null }
    result.final_message = out.final_message ?? null
    result.exit = out.exit
    // A failed or timed-out session still changed the project; the evidence
    // below is taken regardless, and the exit says how the session ended.
    if (!out.exit.ok) result.error = out.exit.error ?? 'driver reported failure'

    const finalWire = await read('project://current')
    result.final_project = writeJson(plan.out_dir, 'final.json', finalWire)
    result.motifs = diffMotifs(motifsBefore, await readMotifs())
    result.workdir_copy = copyWorkdir(workdir, path.join(plan.out_dir, 'workdir'))
    // parseProject snaps times on the frame grid through the eval WASM, which
    // the app initialises at boot and this process must do itself.
    await initEval()
    const changes = diffProjects(parseProject(baselineWire), parseProject(finalWire))
    result.review_diff = writeJson(plan.out_dir, 'review-diff.json', changes)
    result.review_diff_size = changes.length

    const checklist = await optionalModule<{ evaluateChecklist(task: BenchTask, project: unknown): unknown }>('checklist.mjs')
    result.checklist = checklist ? await checklist.evaluateChecklist(plan.task, finalWire) : null
  } catch (e) {
    const msg = e instanceof Error ? e.stack ?? e.message : String(e)
    result.error = result.error ? `${result.error}\n${msg}` : msg
  } finally {
    result.duration_ms = Date.now() - startedAt.getTime()
    writeJson(plan.out_dir, 'run.json', result)
    await client?.close().catch(() => {})
    await app?.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return result
}

/** The one line per run a person scans in the console. */
export function summaryLine(r: RunResult, outDir: string): string {
  const cost = r.cost.usd === null ? '—' : `$${r.cost.usd.toFixed(4)}`
  const verdict = r.error ? `ERROR ${r.error.split('\n')[0]}` : 'ok'
  return `[bench] ${r.task_id} · ${r.driver}/${r.model} · ${verdict} · cost ${cost} · turns ${r.cost.turns ?? '—'}` +
    ` · diff ${r.review_diff_size ?? '—'} change(s) · media wait ${r.media_wait ? `${Math.round(r.media_wait.waited_ms / 1000)} s` : '—'}` +
    ` · ${Math.round(r.duration_ms / 1000)} s → ${outDir}`
}
