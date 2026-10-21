// apps/desktop/bench/runner.ts
//
// One bench run: start the app on its host (this machine, or a remote one
// over SSH: hosts/), set the task's project up over a real MCP client — or
// open a settled copy of it from the template store — snapshot it, hand the
// session to a driver, snapshot again and record what changed. Everything
// measured here comes from the app — the agent's own report is kept, but only
// beside the evidence (ADR 0123: no self-certification).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { initEval } from '../src/renderer/eval'
import { diffProjects } from '../src/main/state/reviewDiff'
import { parseProject } from '../src/main/state/serialize'
import { driverNamed } from './drivers'
import { startLocalHost } from './hosts/local'
import { runSlug, startRemoteHost } from './hosts/remote'
import type { HostSession, TemplateMeta } from './hosts/types'
import { waitForMedia } from './mediaReady'
import type { RunResult } from './drivers/types'
import { resolveArgs, type BenchTask } from './tasks'
import { compareBaselines, projectNameFor, templateKey } from './templates.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Where the app runs. `remote` is a Windows host reached by an ssh alias. */
export type HostPlan =
  | { kind: 'local' }
  | { kind: 'remote'; alias: string; repo: string; keep: boolean; node?: string }

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
  host: HostPlan
  /** Set the project up from scratch even when a template exists (and
   *  replace the template). */
  rebuild_templates: boolean
  /** Extra measurements after the evidence is taken: `transcribe` times one
   *  transcribe_clip on the A-roll clip (no model spend). */
  probes: string[]
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
async function setUpProject(call: McpCall, task: BenchTask, parentFolder: string, name: string, fixtures: ReadonlyMap<string, string>): Promise<void> {
  await call('create_project', {
    parent_folder: parentFolder, name,
    width: task.project.width, height: task.project.height, fps: task.project.fps,
  })
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

type Wire = { root_id?: string; compositions?: Record<string, { tracks?: Array<{ role?: string; layers?: Array<{ id: string; params?: { kind?: string } }> }> }> }

/** The A-roll VideoClip layers of a project snapshot: where setup must have
 *  put the footage. */
function aRollClips(wire: unknown): string[] {
  const w = wire as Wire
  const root = w.root_id ? w.compositions?.[w.root_id] : undefined
  return (root?.tracks ?? []).filter((t) => t.role === 'ARoll')
    .flatMap((t) => t.layers ?? []).filter((l) => l.params?.kind === 'VideoClip').map((l) => l.id)
}

/** A tiny Motif package: a full-frame box of one colour, with a white
 *  square in its bottom-right corner (a cropped preview would miss it). */
function probeMotifFiles(color: string): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({
      id: 'bench-probe', name: 'Bench Probe', version: 1, size: [640, 360],
      default_duration_s: 2, content_duration_s: 1, props_schema: {},
    }, null, 2),
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:360px;' +
      'overflow:hidden;background:transparent}#b{position:absolute;left:0;top:0;width:640px;height:360px}' +
      '#c{position:absolute;left:480px;top:270px;width:160px;height:90px;background:#fff}</style></head>' +
      `<body><div id="b"></div><div id="c"></div><script>motif.define({ setup: async function () { document.getElementById("b").style.background = "${color}" } })</script></body></html>`,
  }
}

// callTool's result type is a union with the task form; only content matters.
const blocks = (r: unknown) => ((r as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string; data?: string }>
const texts = (r: unknown) => blocks(r).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
const imageHash = (r: unknown) => {
  const img = blocks(r).find((b) => b.type === 'image')
  return img?.data ? crypto.createHash('sha256').update(img.data).digest('hex').slice(0, 16) : null
}

/** `--probe motif-dir`: the agent's file path, model-free. Through the
 *  endpoint the agent is given (remote: the path proxy), write a Motif folder
 *  in the local workdir, open it as a directory draft, preview it, change it
 *  locally (and delete a file) and preview again. Shows the mirror and the
 *  path rewrites against the real app: the second preview must render the
 *  new file, and no answer may carry the mirror's path. */
async function motifDirProbe(endpoint: { url: string; bearer_token: string }, workdir: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  const out: Record<string, unknown> = {}
  const pc = new Client({ name: 'weftcut-bench-probe', version: '1' }, { capabilities: {} })
  try {
    await pc.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.bearer_token}` } } }))
    const dir = path.join(workdir, 'bench-probe-motif')
    fs.mkdirSync(dir, { recursive: true })
    for (const [f, text] of Object.entries(probeMotifFiles('#e02020'))) fs.writeFileSync(path.join(dir, f), text)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'deleted before the second preview\n')
    const opened = await pc.callTool({ name: 'open_motif_draft', arguments: { source: { kind: 'directory', path: dir } } })
    const openedJson = (opened.structuredContent ?? JSON.parse(texts(opened) || '{}')) as { draft_id?: string; revision?: string }
    out.open = { is_error: !!opened.isError, draft_id: openedJson.draft_id ?? null, revision: openedJson.revision ?? null, ...(opened.isError ? { text: texts(opened).slice(0, 1000) } : {}) }
    if (opened.isError || !openedJson.draft_id) throw new Error(`open_motif_draft failed: ${texts(opened).slice(0, 500)}`)
    const id = openedJson.draft_id
    const p1 = await pc.callTool({ name: 'preview_motif', arguments: { id, t_sec: 0.5, width: 320, height: 180 } })
    fs.writeFileSync(path.join(dir, 'index.html'), probeMotifFiles('#2040e0')['index.html']!)
    fs.rmSync(path.join(dir, 'notes.txt'))
    const p2 = await pc.callTool({ name: 'preview_motif', arguments: { id, t_sec: 0.5, width: 320, height: 180 } })
    const info = await pc.callTool({ name: 'read_motif', arguments: { id } })
    const infoText = JSON.stringify(info)
    Object.assign(out, {
      preview_1: { is_error: !!p1.isError, image_sha: imageHash(p1) },
      preview_2: { is_error: !!p2.isError, image_sha: imageHash(p2) },
      preview_changed: imageHash(p1) !== null && imageHash(p1) !== imageHash(p2),
      read_motif_names_local_dir: infoText.includes(dir),
      read_motif_has_windows_path: /[A-Za-z]:\\\\/.test(infoText),
      read_motif_files: (info.structuredContent as { files?: Array<{ path: string }> } | undefined)?.files?.map((f) => f.path)
        ?? (JSON.parse(texts(info) || '{}') as { files?: Array<{ path: string }> }).files?.map((f) => f.path) ?? null,
    })
    out.ok = !p1.isError && !p2.isError && out.preview_changed === true
  } catch (e) {
    out.ok = false
    out.error = (e as Error).message.slice(0, 2000)
  } finally {
    await pc.close().catch(() => {})
  }
  out.ms = Date.now() - started
  return out
}

/** `--probe motif-edits`: the file-only path, model-free. Start an empty
 *  draft, write the probe package whole, preview, change one colour with an
 *  exact-match `edits` entry and preview again (the frame must differ); an
 *  ambiguous edit must be refused without a new revision. */
async function motifEditsProbe(endpoint: { url: string; bearer_token: string }, outDir: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  const out: Record<string, unknown> = {}
  const pc = new Client({ name: 'weftcut-bench-probe', version: '1' }, { capabilities: {} })
  try {
    await pc.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.bearer_token}` } } }))
    const json = (r: unknown) => ((r as { structuredContent?: unknown }).structuredContent ?? JSON.parse(texts(r) || '{}')) as { draft_id?: string; revision?: string }
    const opened = json(await pc.callTool({ name: 'open_motif_draft', arguments: { source: { kind: 'empty', name: 'Bench Edits Probe' } } }))
    const id = opened.draft_id
    if (!id) throw new Error('open_motif_draft returned no draft_id')
    const files = probeMotifFiles('#e02020')
    const written = await pc.callTool({ name: 'update_motif_files', arguments: { draft_id: id, expected_revision: opened.revision,
      files: Object.entries(files).map(([p, text]) => ({ path: p, text })) } })
    if (written.isError) throw new Error(`whole-file write failed: ${texts(written).slice(0, 500)}`)
    const p1 = await pc.callTool({ name: 'preview_motif', arguments: { id, t_sec: 0.5, width: 320, height: 180 } })
    const edited = await pc.callTool({ name: 'update_motif_files', arguments: { draft_id: id, expected_revision: json(written).revision,
      files: [{ path: 'index.html', edits: [{ old: '#e02020', new: '#2040e0' }] }] } })
    const p2 = await pc.callTool({ name: 'preview_motif', arguments: { id, t_sec: 0.5, width: 320, height: 180 } })
    // The returned PNG's own size (IHDR), and a copy to look at: the white
    // corner square shows the whole canvas was scaled, not cropped.
    const png = Buffer.from(blocks(p2).find((b) => b.type === 'image')?.data ?? '', 'base64')
    if (png.length > 24) fs.writeFileSync(path.join(outDir, 'probe-motif-edits-preview.png'), png)
    out.preview_png = png.length > 24 ? [png.readUInt32BE(16), png.readUInt32BE(20)] : null
    out.preview_reported = JSON.parse(blocks(p2).filter((b) => b.type === 'text').map((b) => b.text).join('') || '{}')
    const ambiguous = await pc.callTool({ name: 'update_motif_files', arguments: { draft_id: id, expected_revision: json(edited).revision,
      files: [{ path: 'index.html', edits: [{ old: '640px', new: '600px' }] }] } })
    const after = json(await pc.callTool({ name: 'read_motif', arguments: { id } }))
    Object.assign(out, {
      edit: { is_error: !!edited.isError, ...(edited.isError ? { text: texts(edited).slice(0, 500) } : {}) },
      preview_changed: imageHash(p1) !== null && imageHash(p1) !== imageHash(p2),
      ambiguous: { is_error: !!ambiguous.isError, text: texts(ambiguous).slice(0, 300) },
      revision_kept: after.revision === json(edited).revision,
    })
    await pc.callTool({ name: 'delete_motif', arguments: { id } })
    out.ok = !edited.isError && out.preview_changed === true && !!ambiguous.isError && out.revision_kept === true
      && JSON.stringify(out.preview_png) === '[320,180]'
  } catch (e) {
    out.ok = false
    out.error = (e as Error).message.slice(0, 2000)
  } finally {
    await pc.close().catch(() => {})
  }
  out.ms = Date.now() - started
  return out
}

function startHost(plan: PlannedRun, workdir: string): Promise<HostSession> {
  const base = { run_slug: runSlug(plan.run_id), out_dir: plan.out_dir, workdir, ...(plan.app_memory_mib !== undefined ? { app_memory_mib: plan.app_memory_mib } : {}) }
  return plan.host.kind === 'local' ? startLocalHost(base) : startRemoteHost({ ...base, ...plan.host })
}

export async function runOne(plan: PlannedRun): Promise<RunResult> {
  const startedAt = new Date()
  fs.mkdirSync(plan.out_dir, { recursive: true })
  const result: RunResult = {
    run_id: plan.run_id, task_id: plan.task.id, model: plan.model, driver: plan.driver,
    skill: null, app_revision: null, host: null, models: null, fixtures: null, template: null, setup_check: null,
    transcript: null, baseline_project: null, final_project: null, review_diff: null, review_diff_size: null,
    checklist: null, audit: null, frames: null, cost: { usd: null, turns: null }, rounds: null,
    app_resources: null, media_wait: null, motifs: null, workdir_copy: null, probes: null, final_message: null, exit: null, error: null,
    started_at: startedAt.toISOString(), duration_ms: 0,
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-bench-'))
  const workdir = path.join(scratch, 'work')
  fs.mkdirSync(workdir)
  let session: HostSession | undefined
  let client: Client | undefined
  try {
    session = await startHost(plan, workdir)
    const s = session
    result.host = s.record
    result.app_revision = s.app.revision
    result.models = s.models ?? null
    result.skill = { path: plan.skill_path, sha256: hashDir(plan.skill_path) }
    const driver = driverNamed(plan.driver)
    client = new Client({ name: 'weftcut-bench', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(s.runnerTransport.url), {
      requestInit: { headers: { Authorization: `Bearer ${s.runnerTransport.bearer_token}` } },
      ...(s.runnerTransport.fetch ? { fetch: s.runnerTransport.fetch } : {}),
    }))
    const c = client
    const call: McpCall = async (name, args) => {
      // Setup imports and transcription can outlast the SDK's 60 s default.
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000, resetTimeoutOnProgress: true })
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

    result.app_resources = await s.appResources()
    await s.jobEvents?.start()

    // Fixtures resolve on the app's host ({fixture:id} is the MP4 there),
    // with what the fetch recorded about them (transcode, ffmpeg, sha256).
    const { paths: fixtures, meta: fixtureMeta } = await s.resolveFixtures(plan.task.fixtures)
    result.fixtures = Object.keys(fixtureMeta).length ? Object.fromEntries(Object.entries(fixtureMeta).map(([id, m]) => [id, {
      file: m.output, transcode: m.transcode, source: m.source, trim: m.trim, created_at: m.created_at,
    }])) : null
    const projectName = projectNameFor(plan.task)
    const projectDir = s.joinPath(s.projectsDir, projectName)
    // A template only pays where there is media to settle.
    let template: { key: string; parts: Record<string, unknown>; fresh: boolean; stored: { meta: TemplateMeta; baseline: unknown; tasks: string[] } | null } | null = null
    if (plan.task.fixtures.length) {
      const fixtureHashes = Object.fromEntries(plan.task.fixtures.map((id) => [id, fixtureMeta[id]!.output.sha256]))
      const { key, parts } = templateKey({ task: plan.task, fixtureHashes, app: s.app, host: s.hostId })
      const stored = plan.rebuild_templates ? null : await s.templates.get(key)
      template = { key, parts, fresh: !stored, stored }
    }

    const setupStarted = Date.now()
    if (template?.stored) {
      const restored = await s.templates.restore(template.key, projectDir)
      await call('open_project', { path: projectDir })
      const tasks = await s.templates.label(template.key, plan.task.id)
      result.template = { key: template.key, fresh_build: false, restore_ms: restored.ms, bytes: restored.bytes, built_at: template.stored.meta.created_at,
        build_media_wait_ms: template.stored.meta.media_wait_ms, tasks }
    } else {
      await setUpProject(call, plan.task, s.projectsDir, projectName, fixtures)
      result.template = template
        ? { key: template.key, fresh_build: true, ...(plan.rebuild_templates ? { forced: true } : {}) }
        : { key: null, reason: 'task has no fixtures: nothing to settle' }
    }
    const setupMs = Date.now() - setupStarted

    try {
      result.media_wait = await waitForMedia({
        readPool: () => read('project://media') as never,
        readEvents: s.jobEvents ? () => s.jobEvents!.read() : null,
        timeoutMs: plan.media_timeout_ms,
        projectDir,
      })
    } catch (e) {
      const diag = await s.timeoutDiagnostics()
      writeJson(plan.out_dir, 'media-wait-diagnostics.json', diag)
      const status = (diag as { renderer?: { sampledStatus?: { pressure?: string; memory_mib?: number } } }).renderer?.sampledStatus
      const alloc = (result.app_resources?.allocation as { memory_mib?: number } | null)?.memory_mib
      if (status?.pressure === 'constrained')
        (e as Error).message += `; the app reports memory pressure (process tree ${Math.round(status.memory_mib ?? 0)} MiB over its ` +
          `${alloc ?? '?'} MiB allocation), so background jobs are not admitted — raise it with --app-memory-mib`
      throw e
    } finally {
      if (s.jobEvents) writeJson(plan.out_dir, 'media-jobs.json', await s.jobEvents.read().catch(() => []))
    }
    const baselineWire = await read('project://current')
    result.baseline_project = writeJson(plan.out_dir, 'baseline.json', baselineWire)
    const clips = aRollClips(baselineWire)
    result.setup_check = { a_roll_video_clips: clips.length, setup_ms: setupMs }

    if (template && result.template && 'fresh_build' in result.template) {
      if (template.fresh) {
        // Autosave debounces 500 ms; let the settled state reach project.json.
        await new Promise((r) => setTimeout(r, 2_000))
        const meta: TemplateMeta = { key: template.key, parts: template.parts, project_dir: projectDir, created_at: new Date().toISOString(), media_wait_ms: result.media_wait.waited_ms }
        const saved = await s.templates.save(template.key, projectDir, meta, baselineWire, plan.task.id)
        Object.assign(result.template, { saved_ms: saved.ms, bytes: saved.bytes, tasks: [plan.task.id] })
      } else {
        const cmp = compareBaselines(template.stored!.baseline, template.stored!.meta.project_dir, baselineWire, projectDir)
        Object.assign(result.template, { baseline_equivalent: cmp.equivalent, ...(cmp.equivalent ? {} : { differences: cmp.differences }) })
      }
    }
    // Where the app runs and what GPU it holds, with the media work done.
    const status = await s.status().catch((e: Error) => ({ error: e.message }))
    if (status) result.host = { ...s.record, gpu: status }
    const motifsBefore = await readMotifs()

    const out = await driver.run({
      task: plan.task, skill_path: plan.skill_path, mcp: s.agentEndpoint, model: plan.model, workdir,
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

    if (plan.probes.includes('transcribe')) {
      // Read-only (transcribe_clip changes nothing), and after the evidence,
      // so neither the baseline nor the agent's run sees its cache.
      const layer = aRollClips(finalWire)[0] ?? clips[0]
      const started = Date.now()
      const probe: Record<string, unknown> = { tool: 'transcribe_clip', layer_id: layer ?? null }
      try {
        if (!layer) throw new Error('no A-roll VideoClip to transcribe')
        const r = await call('transcribe_clip', { layer_id: layer }) as { backend?: string; language?: string; word_timing?: string; segments?: Array<{ text: string }> }
        Object.assign(probe, { ok: true, backend: r.backend, language: r.language, word_timing: r.word_timing, segments: r.segments?.length ?? 0,
          first_text: r.segments?.[0]?.text ?? null })
      } catch (e) {
        Object.assign(probe, { ok: false, error: (e as Error).message.slice(0, 2000) })
      }
      probe.ms = Date.now() - started
      result.probes = { ...(result.probes ?? {}), transcribe: probe }
    }
    if (plan.probes.includes('motif-dir'))
      result.probes = { ...(result.probes ?? {}), 'motif-dir': await motifDirProbe(s.agentEndpoint, workdir) }
    if (plan.probes.includes('motif-edits'))
      result.probes = { ...(result.probes ?? {}), 'motif-edits': await motifEditsProbe(s.agentEndpoint, plan.out_dir) }
  } catch (e) {
    // A host that failed to start still says how far it got.
    const hostRecord = (e as { hostRecord?: Record<string, unknown> }).hostRecord
    if (hostRecord && !result.host) result.host = hostRecord
    const msg = e instanceof Error ? e.stack ?? e.message : String(e)
    result.error = result.error ? `${result.error}\n${msg}` : msg
  } finally {
    result.duration_ms = Date.now() - startedAt.getTime()
    writeJson(plan.out_dir, 'run.json', result)
    await client?.close().catch(() => {})
    await session?.close().catch((e: Error) => { result.error = `${result.error ? `${result.error}\n` : ''}teardown: ${e.message}` })
    // Teardown facts (what was stopped, what is left on the host) land in
    // the record close() filled in.
    if (session) result.host = { ...(result.host ?? {}), ...session.record }
    writeJson(plan.out_dir, 'run.json', result)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return result
}

/** The one line per run a person scans in the console. */
export function summaryLine(r: RunResult, outDir: string): string {
  const cost = r.cost.usd === null ? '—' : `$${r.cost.usd.toFixed(4)}`
  const verdict = r.error ? `ERROR ${r.error.split('\n')[0]}` : 'ok'
  const tpl = r.template && 'fresh_build' in r.template ? ` · template ${r.template.fresh_build ? 'built' : 'reused'}` : ''
  return `[bench] ${r.task_id} · ${r.driver}/${r.model} · ${verdict} · cost ${cost} · turns ${r.cost.turns ?? '—'}` +
    ` · diff ${r.review_diff_size ?? '—'} change(s) · media wait ${r.media_wait ? `${Math.round(r.media_wait.waited_ms / 1000)} s` : '—'}${tpl}` +
    ` · ${Math.round(r.duration_ms / 1000)} s → ${outDir}`
}
