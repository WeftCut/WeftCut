// apps/desktop/bench/hosts/local.ts
//
// The app on this machine, launched by the e2e launcher (isolated userData,
// test env, GL switches). The renderer is reachable, so the media wait also
// hears the app's job events and a stuck wait gets the governor's ledger.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchApp } from '../../e2e/electron/helpers/driver'
import { resourceDiagnostics } from '../../e2e/electron/helpers/resourceDiagnostics'
import type { WeftcutApi } from '../../src/shared/ipc'
import type { McpEndpoint } from '../drivers/types'
import { mediaJobLog, recordMediaJobs } from '../mediaReady'
import type { FixtureMeta, HostSession, HostStartOptions, TemplateMeta, TemplateStore } from './types'

const BENCH_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const APP_DIR = path.dirname(BENCH_DIR)
export const LOCAL_TEMPLATES_DIR = path.join(BENCH_DIR, '.cache', 'templates')

export function localAppRevision(): string | null {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty'], { cwd: BENCH_DIR, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** The built app's fingerprint: every file under out/ by name and size (Vite
 *  names chunks by content), the main entry's bytes, and the native addons by
 *  size and mtime. Same recipe as pc.ps1's `info`. */
export function localBuildFingerprint(): string {
  const out = path.join(APP_DIR, 'out')
  const lines: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else lines.push(`${p.slice(out.length).replace(/\//g, '\\')}|${fs.statSync(p).size}`)
    }
  }
  if (fs.existsSync(out)) walk(out)
  lines.sort()
  const main = path.join(out, 'main', 'index.js')
  if (fs.existsSync(main)) lines.push(`main=${crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex')}`)
  const native = path.join(APP_DIR, 'native')
  const addons = fs.existsSync(native)
    ? fs.readdirSync(native, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.node'))
    : []
  lines.push(...addons.map((e) => {
    const st = fs.statSync(path.join(e.parentPath, e.name))
    return `${e.name}|${st.size}|${Math.round(st.mtimeMs)}`
  }).sort())
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

function dirBytes(dir: string): number {
  let n = 0
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size
  return n
}

export const localTemplates: TemplateStore = {
  async get(key) {
    const dir = path.join(LOCAL_TEMPLATES_DIR, key)
    if (!fs.existsSync(path.join(dir, 'template.json'))) return null
    const tasks = path.join(dir, 'tasks.txt')
    return {
      meta: JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8')) as TemplateMeta,
      baseline: JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8')),
      tasks: fs.existsSync(tasks) ? fs.readFileSync(tasks, 'utf8').split('\n').filter(Boolean) : [],
    }
  },
  async label(key, taskId) {
    const file = path.join(LOCAL_TEMPLATES_DIR, key, 'tasks.txt')
    const tasks = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
    if (!tasks.includes(taskId)) {
      tasks.push(taskId)
      fs.writeFileSync(file, tasks.join('\n') + '\n')
    }
    return tasks
  },
  async save(key, projectDir, meta, baseline, taskId) {
    const started = Date.now()
    const dir = path.join(LOCAL_TEMPLATES_DIR, key)
    const tmp = `${dir}.tmp`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    // Timestamps kept: the app compares a media file's mtime with the one it
    // recorded at import.
    fs.cpSync(projectDir, path.join(tmp, 'project'), {
      recursive: true, preserveTimestamps: true,
      filter: (src) => !['Backups', 'Logs'].includes(path.relative(projectDir, src).split(path.sep)[0] ?? ''),
    })
    fs.writeFileSync(path.join(tmp, 'template.json'), JSON.stringify(meta, null, 2) + '\n')
    fs.writeFileSync(path.join(tmp, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n')
    fs.writeFileSync(path.join(tmp, 'tasks.txt'), `${taskId}\n`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)
    return { ms: Date.now() - started, bytes: dirBytes(path.join(dir, 'project')) }
  },
  async restore(key, destDir) {
    const started = Date.now()
    if (fs.existsSync(destDir)) throw new Error(`${destDir} already exists`)
    fs.cpSync(path.join(LOCAL_TEMPLATES_DIR, key, 'project'), destDir, { recursive: true, preserveTimestamps: true })
    return { ms: Date.now() - started, bytes: dirBytes(destDir) }
  },
}

export async function startLocalHost(opts: HostStartOptions): Promise<HostSession> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-bench-proj-'))
  const { app, page } = await launchApp()
  try {
    // The main process's own log: job failures and admission waits show up
    // here and nowhere the MCP client can see.
    const appLog = fs.createWriteStream(path.join(opts.out_dir, 'app.log'))
    app.process().stdout?.pipe(appLog)
    app.process().stderr?.pipe(appLog)
    const mcp = (await page.evaluate(() => (window as unknown as { api: WeftcutApi }).api.mcp.getInfo())) as McpEndpoint
    const invoke = (cmd: string, args: Record<string, unknown> = {}) =>
      page.evaluate(([c, a]) => (window as unknown as { api: WeftcutApi }).api.backend.invoke(c, a), [cmd, args] as const)
    if (opts.app_memory_mib !== undefined)
      await invoke('app_settings_set', { patch: { resource_policy: { memory_mib: opts.app_memory_mib } } })
    const record: Record<string, unknown> = {
      kind: 'local', hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length, ram_gib: Math.round(os.totalmem() / 2 ** 30 * 10) / 10,
    }
    return {
      kind: 'local',
      record,
      app: { revision: localAppRevision(), build: localBuildFingerprint() },
      hostId: `local:${os.hostname()}`,
      runnerTransport: { url: mcp.url, bearer_token: mcp.bearer_token },
      agentEndpoint: mcp,
      projectsDir: path.join(scratch, 'projects'),
      joinPath: (...p) => path.join(...p),
      writeText: async (p, text) => { fs.writeFileSync(p, text) },
      async resolveFixtures(ids) {
        const mod = await import(pathToFileURL(path.join(BENCH_DIR, 'fixtures', 'fixtures.mjs')).href) as
          { resolveFixtureWithMeta(id: string): Promise<{ path: string; meta: FixtureMeta }> }
        const got = await Promise.all(ids.map(async (id) => [id, await mod.resolveFixtureWithMeta(id)] as const))
        return { paths: new Map(got.map(([id, r]) => [id, r.path])), meta: Object.fromEntries(got.map(([id, r]) => [id, r.meta])) }
      },
      async appResources() {
        const s = await invoke('app_settings_get') as { resource_policy?: unknown; resource_allocation?: unknown }
        return { policy: s.resource_policy ?? null, allocation: s.resource_allocation ?? null }
      },
      models: null,
      jobEvents: {
        start: () => recordMediaJobs(page),
        read: () => mediaJobLog(page) as never,
      },
      // A stuck job is almost always the resource governor declining to admit
      // it; its ledger says which limit.
      timeoutDiagnostics: () => resourceDiagnostics(page).catch((d: Error) => ({ error: d.message })),
      async status() { return null },
      templates: localTemplates,
      async close() {
        await app.close()
        fs.rmSync(scratch, { recursive: true, force: true })
      },
    }
  } catch (e) {
    await app.close().catch(() => {})
    fs.rmSync(scratch, { recursive: true, force: true })
    throw e
  }
}
