// apps/desktop/bench/hosts/ssh.ts
//
// The runner's only channel to the remote app host: OpenSSH's `ssh` and `sftp`
// against one host alias from ~/.ssh/config. All calls share a control master
// (ControlPersist) so the per-call cost is a channel, not a handshake — the
// proxy mirrors the agent's working directory before every tool call.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export interface Exec {
  code: number | null
  stdout: string
  stderr: string
}

/** OpenSSH's advisory about key exchange and the like: noise on every call
 *  through the alias, filtered so real stderr stays readable. */
const NOISE = /post-quantum|store now, decrypt later|upgraded|openssh\.com\/pq/i

function clean(text: string): string {
  return text.split(/\r?\n/).filter((l) => l.trim() && !NOISE.test(l) && !/^\*\*/.test(l.trim())).join('\n')
}

export class Ssh {
  readonly alias: string
  private readonly controlPath: string

  constructor(alias: string) {
    this.alias = alias
    // Unix socket paths are capped near 104 bytes; keep it short.
    const tag = crypto.createHash('sha1').update(`${alias}:${process.pid}`).digest('hex').slice(0, 10)
    this.controlPath = path.join(os.tmpdir(), `wb-ssh-${tag}`)
  }

  /** Options every ssh/sftp invocation shares. */
  private opts(): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', 'ControlPersist=600',
      '-o', 'ServerAliveInterval=15',
    ]
  }

  private spawnCollect(cmd: string, args: string[], stdin?: string, timeoutMs = 30 * 60_000): Promise<Exec> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.once('error', (e) => { clearTimeout(timer); reject(e) })
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr: clean(stderr) }) })
      child.stdin.end(stdin ?? '')
    })
  }

  /** One remote command line (run by the account's default shell, cmd.exe on
   *  Windows). */
  exec(command: string, timeoutMs?: number): Promise<Exec> {
    return this.spawnCollect('ssh', [...this.opts(), this.alias, command], undefined, timeoutMs)
  }

  /** An sftp batch (`sftp -b -`). A command prefixed `-` may fail without
   *  aborting the batch. Throws when the batch fails. */
  async sftp(batch: string, timeoutMs?: number): Promise<Exec> {
    const r = await this.spawnCollect('sftp', [...this.opts(), '-q', '-b', '-', this.alias], batch, timeoutMs)
    if (r.code !== 0) throw new Error(`sftp batch failed (exit ${r.code}): ${r.stderr || r.stdout}\n--- batch ---\n${batch.slice(0, 2000)}`)
    return r
  }

  /** `ssh -N -L local:127.0.0.1:remote` on its own connection (not the
   *  control master, whose lifetime is not this tunnel's), resolved once the
   *  local end accepts connections. `stderr()` holds ssh's complaints: a
   *  server with `AllowTcpForwarding no` accepts the listener and then refuses
   *  every channel ("administratively prohibited"). */
  async tunnel(localPort: number, remotePort: number): Promise<{ close(): void; stderr(): string }> {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-N',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, this.alias], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    let exited = false
    child.once('exit', () => { exited = true })
    const deadline = Date.now() + 20_000
    for (;;) {
      if (exited) throw new Error(`ssh tunnel exited: ${clean(stderr)}`)
      if (await canConnect(localPort)) break
      if (Date.now() > deadline) { child.kill(); throw new Error(`ssh tunnel to ${remotePort} not up after 20 s: ${clean(stderr)}`) }
      await new Promise((r) => setTimeout(r, 200))
    }
    return { close: () => { if (!exited) child.kill() }, stderr: () => clean(stderr) }
  }

  /** Close the control master (and with it every multiplexed channel). */
  async close(): Promise<void> {
    await this.spawnCollect('ssh', ['-o', `ControlPath=${this.controlPath}`, '-O', 'exit', this.alias]).catch(() => {})
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** sftp's spelling of a Windows path: `/C:/Users/...`. */
export function sftpPath(winPath: string): string {
  const p = winPath.replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(p) ? `/${p}` : p
}

/** A `fetch` that sends a fixed Host header. The app's MCP host rejects any
 *  Host but `127.0.0.1:<its port>` (DNS-rebinding protection), and the tunnel's
 *  local end has a different port; WHATWG fetch will not let a caller set Host,
 *  so this goes through node:http. Streams the response body, which the MCP
 *  client's SSE reader needs. */
export function hostHeaderFetch(hostHeader: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    headers.host = hostHeader
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw new Error('hostHeaderFetch: only string bodies are supported')
    if (typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body))
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        method: init?.method ?? 'GET', headers, ...(init?.signal ? { signal: init.signal } : {}),
      })
      req.once('response', (res) => {
        const h = new Headers()
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
        const status = res.statusCode ?? 500
        const nullBody = status === 204 || status === 304 || (init?.method ?? 'GET') === 'HEAD'
        if (nullBody) res.resume()
        resolve(new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), {
          status, statusText: res.statusMessage ?? '', headers: h,
        }))
      })
      req.once('error', reject)
      if (typeof body === 'string') req.write(body)
      req.end()
    })
  }) as typeof fetch
}
