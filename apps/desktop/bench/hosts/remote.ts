// apps/desktop/bench/hosts/remote.ts
//
// The app on another machine (Windows), driven over SSH; the agent and the
// runner stay here. Per run, under <USERPROFILE>\weftcut-bench on the host:
//
//   runs\<slug>\profile   isolated userData seeded from the user's profile
//                         (config files re-pointed, model files hard-linked)
//   runs\<slug>\projects  the task's project
//   runs\<slug>\work      one-way mirror of the agent's local workdir
//   cache\fixtures        fixtures, fetched and verified there (fetch.mjs)
//   templates\<key>       settled projects (templates.mjs)
//
// The app is started in the logged-on console session (pc.ps1 `launch`), its
// MCP endpoint reached through an `ssh -L` tunnel, and the agent given the
// path-mapping proxy (proxy/proxy.ts) in front of it. No Playwright page
// exists: everything goes through MCP, and the media wait reads the pool only.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMirror, sftpBatch } from '../proxy/mirror.mjs'
import { startMcpProxy, type McpProxy } from '../proxy/proxy'
import { Ssh, freePort, hostHeaderFetch, sftpPath } from './ssh'
import type { HostSession, HostStartOptions, TemplateMeta, TemplateStore } from './types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BENCH_DIR = path.dirname(HERE)

export interface RemoteOptions {
  /** ssh alias (~/.ssh/config). */
  alias: string
  /** The WeftCut checkout on the host, already built (`out\main\index.js`). */
  repo: string
  /** Keep the run directory (profile, project, mirror) after the run. */
  keep: boolean
  /** node.exe on the host, for fetch.mjs; pc.ps1 has a default. */
  node?: string
}

const win = path.win32

/** One pc.ps1 operation; resolves its JSON result or throws its error text. */
async function op<T = Record<string, unknown>>(ssh: Ssh, root: string, name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const b64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
  const r = await ssh.exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win.join(root, 'bin', 'pc.ps1')}" -Op ${name} -ArgsB64 ${b64}`, timeoutMs)
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('@@RESULT@@'))
  if (r.code === 0 && line) return JSON.parse(line.slice('@@RESULT@@'.length)) as T
  const err = r.stdout.split('@@ERROR@@')[1]?.trim()
  throw new Error(`remote ${name} failed (exit ${r.code}): ${err || r.stderr || r.stdout}`.slice(0, 4000))
}

/** Host facts that do not change between runs of one invocation. */
const infoCache = new Map<string, Promise<{ root: string; info: Record<string, unknown> }>>()

async function hostInfo(ssh: Ssh, opts: RemoteOptions): Promise<{ root: string; info: Record<string, unknown> }> {
  const k = `${opts.alias}|${opts.repo}`
  if (!infoCache.has(k)) infoCache.set(k, (async () => {
    const home = (await ssh.exec('echo %USERPROFILE%')).stdout.trim().split(/\r?\n/).pop()?.trim()
    if (!home || !/^[A-Za-z]:\\/.test(home)) throw new Error(`cannot read %USERPROFILE% on ${opts.alias} (got ${JSON.stringify(home)}); is it a Windows host?`)
    const root = win.join(home, 'weftcut-bench')
    // The helper and the fixture tooling, refreshed every invocation.
    const fx = path.join(BENCH_DIR, 'fixtures')
    await ssh.sftp([
      `-mkdir "${sftpPath(root)}"`, `-mkdir "${sftpPath(win.join(root, 'bin'))}"`, `-mkdir "${sftpPath(win.join(root, 'fixtures'))}"`,
      `-mkdir "${sftpPath(win.join(root, 'runs'))}"`, `-mkdir "${sftpPath(win.join(root, 'templates'))}"`,
      `put "${path.join(HERE, 'pc.ps1')}" "${sftpPath(win.join(root, 'bin', 'pc.ps1'))}"`,
      ...['fixtures.mjs', 'fetch.mjs', 'fixtures.json'].map((f) => `put "${path.join(fx, f)}" "${sftpPath(win.join(root, 'fixtures', f))}"`),
    ].join('\n') + '\n')
    const info = await op(ssh, root, 'info', { repo: opts.repo })
    if (!info.main_present || !info.electron_present) throw new Error(`the checkout at ${opts.repo} on ${opts.alias} is not built (main ${info.main_present}, electron ${info.electron_present})`)
    return { root, info }
  })())
  return infoCache.get(k)!
}

/** Fail fast with the reason when ssh cannot reach the app port through the
 *  tunnel — on a host whose sshd has `AllowTcpForwarding no` the listener
 *  comes up and every connection is reset. */
async function probeTunnel(url: string, fetchImpl: typeof fetch, tunnelStderr: () => string): Promise<void> {
  try {
    await fetchImpl(url, { method: 'GET' })
  } catch (e) {
    await new Promise((r) => setTimeout(r, 300))
    const why = tunnelStderr()
    if (/administratively prohibited/i.test(why))
      throw new Error('the remote sshd refuses TCP forwarding ("administratively prohibited"), so the MCP port cannot be tunnelled. ' +
        'On the host, set `AllowTcpForwarding local` (or yes) in C:\\ProgramData\\ssh\\sshd_config — optionally narrowed with ' +
        '`PermitOpen 127.0.0.1:*` in a `Match User` block — and restart the sshd service.')
    throw new Error(`cannot reach the app through the ssh tunnel: ${(e as Error).message}${why ? `; ssh: ${why}` : ''}`)
  }
}

export async function startRemoteHost(opts: HostStartOptions & RemoteOptions): Promise<HostSession> {
  const ssh = new Ssh(opts.alias)
  const { root, info } = await hostInfo(ssh, opts)
  const runDir = win.join(root, 'runs', opts.run_slug)
  const record: Record<string, unknown> = {
    kind: 'remote', alias: opts.alias,
    ...Object.fromEntries(['computer', 'user', 'os', 'cpu', 'logical_cpus', 'ram_gib', 'gpus', 'node', 'ffmpeg'].map((k) => [k, info[k]])),
    repo: opts.repo, run_dir: runDir, kept: opts.keep,
  }
  const proxyLog = fs.createWriteStream(path.join(opts.out_dir, 'proxy.log'))
  let pid: number | null = null
  let token: string | null = null
  let tunnel: { close(): void; stderr(): string } | null = null
  let proxy: McpProxy | null = null
  let closed = false

  const teardown = async (): Promise<void> => {
    if (closed) return
    closed = true
    const t: Record<string, unknown> = {}
    await proxy?.close().catch((e: Error) => { t.proxy_error = e.message })
    if (proxy) record.proxy = { log: 'proxy.log', ...proxy.stats }
    tunnel?.close()
    try {
      if (pid !== null) t.stop = await op(ssh, root, 'stop', { run: opts.run_slug, pid })
      // The app's stdout/stderr and the project's own log folder.
      const appLog = path.join(opts.out_dir, 'app.log')
      const got = path.join(opts.out_dir, '.remote-logs')
      fs.mkdirSync(got, { recursive: true })
      await ssh.sftp([
        `-get "${sftpPath(win.join(runDir, 'app.out.log'))}" "${path.join(got, 'out.log')}"`,
        `-get "${sftpPath(win.join(runDir, 'app.err.log'))}" "${path.join(got, 'err.log')}"`,
      ].join('\n') + '\n').catch(() => {})
      // The app prints its MCP connect line, bearer included, to stdout; the
      // token must not reach this disk.
      const redact = (text: string) => (token ? text.split(token).join('<redacted>') : text).replace(/Bearer [0-9A-Za-z._~+/-]{16,}/g, 'Bearer <redacted>')
      fs.writeFileSync(appLog, ['out.log', 'err.log'].map((f) => {
        const p = path.join(got, f)
        return fs.existsSync(p) ? `--- ${f === 'out.log' ? 'stdout' : 'stderr'} ---\n${redact(fs.readFileSync(p, 'utf8'))}` : ''
      }).join('\n'))
      fs.rmSync(got, { recursive: true, force: true })
      // The project's own log folder (one project per run).
      await ssh.sftp(`-get -r "${sftpPath(win.join(runDir, 'projects'))}/*/Logs" "${path.join(opts.out_dir, 'project-logs')}"\n`).catch(() => {})
      t.cleanup = await op(ssh, root, 'cleanup', { run: opts.run_slug, keep: opts.keep })
      t.after = await op(ssh, root, 'strays', {})
    } catch (e) {
      t.error = (e as Error).message
    }
    record.teardown = t
    proxyLog.end()
    await ssh.close()
  }

  try {
    const prepared = await op(ssh, root, 'prepare', { run: opts.run_slug, ...(opts.app_memory_mib !== undefined ? { memory_mib: opts.app_memory_mib } : {}) })
    const profile = String(prepared.profile)
    record.profile_seed = { seeded: prepared.seeded, linked_files: prepared.linked_files, linked_bytes: prepared.linked_bytes, method: 'hardlink' }
    const appDir = win.join(opts.repo, 'apps', 'desktop')
    // launchApp's arguments and environment (e2e/electron/helpers/driver.ts):
    // locale, isolated userData, the built main entry; no GL switches on
    // Windows.
    const launched = await op(ssh, root, 'launch', {
      run: opts.run_slug,
      electron: win.join(opts.repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
      cwd: appDir,
      args: ['--lang=en-US', `--user-data-dir=${profile}`, win.join(appDir, 'out', 'main', 'index.js')],
      env: { LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' },
      ffmpeg_dir: win.join(appDir, 'resources', 'ffmpeg', 'win'),
    })
    pid = Number(launched.pid)
    record.launch = launched
    if (launched.session_id === 0) throw new Error('the app started in session 0 (no desktop, no GPU); is the user logged on at the console?')
    const auth = await op<{ port: number; token: string }>(ssh, root, 'wait-auth', { run: opts.run_slug, pid, timeout_s: 120 })
    token = auth.token
    const localPort = await freePort()
    tunnel = await ssh.tunnel(localPort, auth.port)
    const url = `http://127.0.0.1:${localPort}/mcp`
    const fetchImpl = hostHeaderFetch(`127.0.0.1:${auth.port}`)
    await probeTunnel(url, fetchImpl, tunnel.stderr)
    const upstream = { url, bearer_token: auth.token, fetch: fetchImpl }

    const remoteWork = win.join(runDir, 'work')
    const mirror = createMirror({
      localRoot: opts.workdir,
      push: async (plan) => { await ssh.sftp(sftpBatch(plan, opts.workdir, sftpPath(remoteWork))) },
    })
    proxy = await startMcpProxy({
      upstream, localRoot: opts.workdir, remoteRoot: remoteWork,
      sync: () => mirror.sync(),
      log: (e) => { proxyLog.write(JSON.stringify(e) + '\n') },
    })

    const templates: TemplateStore = {
      async get(key) {
        const r = await op<{ meta: TemplateMeta | null; baseline?: string }>(ssh, root, 'template-status', { key })
        return r.meta ? { meta: r.meta, baseline: JSON.parse(r.baseline!) } : null
      },
      async save(key, projectDir, meta, baseline) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tpl-'))
        try {
          fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
          fs.writeFileSync(path.join(tmp, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n')
          const metaFile = win.join(runDir, 'template-meta.json')
          const baselineFile = win.join(runDir, 'template-baseline.json')
          await ssh.sftp(`put "${path.join(tmp, 'meta.json')}" "${sftpPath(metaFile)}"\nput "${path.join(tmp, 'baseline.json')}" "${sftpPath(baselineFile)}"\n`)
          return await op<{ ms: number; bytes: number }>(ssh, root, 'template-save', { key, project_dir: projectDir, meta_file: metaFile, baseline_file: baselineFile })
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      },
      restore: (key, destDir) => op<{ ms: number; bytes: number }>(ssh, root, 'template-restore', { key, dest: destDir }),
    }

    const rawStatus = () => op(ssh, root, 'status', { run: opts.run_slug, pid })
    // For run.json: where the tree runs and what GPU it holds (the settings
    // file the op also returns feeds appResources instead).
    const status = async () => {
      const { app_settings: _settings, ...rest } = await rawStatus()
      return rest
    }
    return {
      kind: 'remote',
      record,
      app: { revision: (info.app_revision as string | null) ?? null, build: String(info.build_sha256) },
      hostId: `remote:${String(info.computer)}`,
      runnerTransport: upstream,
      agentEndpoint: proxy.endpoint,
      projectsDir: win.join(runDir, 'projects'),
      joinPath: (...p) => win.join(...p),
      async resolveFixtures(ids) {
        if (!ids.length) return new Map()
        const r = await op<{ paths: Record<string, string> }>(ssh, root, 'fixtures', { ids, ...(opts.node ? { node: opts.node } : {}) }, 60 * 60_000)
        for (const id of ids) if (!r.paths[id]) throw new Error(`fixture ${id} did not resolve on ${opts.alias}`)
        return new Map(ids.map((id) => [id, r.paths[id]!]))
      },
      async appResources() {
        const s = (await rawStatus()).app_settings as { resource_policy?: unknown; resource_allocation?: unknown } | null
        return s ? { policy: s.resource_policy ?? null, allocation: s.resource_allocation ?? null } : null
      },
      models: prepared.models,
      jobEvents: null,
      async timeoutDiagnostics() {
        return { note: 'remote host: no renderer, so no governor ledger; app.log and project-logs/ hold the job failures', status: await status().catch((e: Error) => ({ error: e.message })) }
      },
      status,
      templates,
      close: teardown,
    }
  } catch (e) {
    await teardown().catch(() => {})
    // The launch and teardown facts still belong in run.json.
    if (e instanceof Error) Object.assign(e, { hostRecord: record })
    throw e
  }
}

/** Is `ssh` usable at all, and does the alias resolve? Cheap preflight. */
export function remotePreflight(alias: string): string | null {
  const r = spawnSync('ssh', ['-G', alias], { encoding: 'utf8' })
  if (r.error) return `ssh not found: ${r.error.message}`
  if (r.status !== 0) return `ssh -G ${alias} failed: ${r.stderr.trim()}`
  return null
}

/** A run slug short enough for Windows paths under the run directory. */
export function runSlug(runId: string): string {
  const stamp = runId.split('/')[0]!.replace(/[^0-9T]/g, '').slice(0, 15)
  return `${stamp}-${crypto.createHash('sha1').update(runId).digest('hex').slice(0, 6)}`
}
