// Fixtures of the black-box shim tests (`integration.test.ts`): the targets the
// cases run against, a client that speaks JSON-RPC lines to a spawned target,
// and apps on real Streamable HTTP that record what they were sent.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http, { type Server as HttpServer } from 'node:http'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListRootsResultSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'

export const TOKEN = 'itest-token'

/// How long a case waits for something it expects before reporting that it
/// never happened. A liveness bound, never the thing asserted.
export const WITNESS_MS = 20_000

/// The pause between two progress beats of the scripted app's `heartbeat`.
export const BEAT_MS = 100

/// Names the native binary a second target runs: an absolute path, started as
/// `<bin> mcp` (`npm run build:weftcut` builds it at out/cli/weftcut). Unset,
/// the cases run against the JS bundle alone.
export const NATIVE_BIN_ENV = 'WEFTCUT_CLI_BIN'

/// One implementation of the stdio MCP server, as the processes a client starts.
export interface Target {
  name: string
  native: boolean
  /// The version the build was stamped with: what `initialize` reports and its
  /// instructions name.
  stamp: string
  /// argv of the stdio server.
  serve(): string[]
  /// argv of a terminal subcommand (none: the bare command).
  argv(...sub: string[]): string[]
}

/// The esbuild bundle of `main.ts`, run by this Node. `bundle` is read at spawn
/// time: the file is built after the targets are listed.
export function jsTarget(bundle: () => string, stamp: string): Target {
  return {
    name: 'JS bundle',
    native: false,
    stamp,
    serve: () => [process.execPath, bundle()],
    argv: (...sub) => [process.execPath, bundle(), ...sub],
  }
}

/// The binary `WEFTCUT_CLI_BIN` names, or null when the variable is unset. A
/// path that is set but names no file is a mistake worth stopping on, not a
/// reason to run fewer cases.
export function nativeTarget(stamp: string): Target | null {
  const bin = process.env[NATIVE_BIN_ENV]
  if (!bin) return null
  if (!path.isAbsolute(bin) || !fs.statSync(bin, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${NATIVE_BIN_ENV} must be the absolute path of the native binary; got ${bin}`)
  }
  return {
    name: 'native binary',
    native: true,
    stamp,
    serve: () => [bin, 'mcp'],
    argv: (...sub) => [bin, ...sub],
  }
}

/// A target's environment: the profile under test, and none of the shim
/// settings the developer's own shell may carry.
export function shimEnv(userData: string, extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  for (const name of ['WEFTCUT_APP', 'WEFTCUT_MCP_TOOL_TIMEOUT_MS', 'WEFTCUT_MCP_TOOL_MAX_TOTAL_MS', 'ELECTRON_RUN_AS_NODE']) {
    delete env[name]
  }
  return { ...env, WEFTCUT_USERDATA: userData, ...extra }
}

export function writeAuth(userData: string, port: number): void {
  fs.writeFileSync(path.join(userData, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port }))
}

/// Runs a terminal subcommand to its exit. Asynchronous on purpose: the app it
/// may talk to lives in this process, which a synchronous spawn would block.
export function run(
  target: Target,
  sub: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const [command, ...args] = target.argv(...sub)
  return new Promise((resolve) => {
    const child = execFile(command!, args, { env, encoding: 'utf8' }, (_error, stdout, stderr) => {
      resolve({ status: child.exitCode, stdout, stderr })
    })
    // No input: a target that mistook the subcommand for the stdio server
    // reads end-of-input and exits instead of waiting.
    child.stdin?.end()
  })
}

/// An append-only record a case waits on: what arrived or was observed, in order.
export class Witness<T> {
  readonly items: T[] = []
  private readonly wake = new Set<() => void>()

  push(item: T): void {
    this.items.push(item)
    for (const wake of [...this.wake]) wake()
  }

  /// Resolves with what `look` returns once it returns something, asked again
  /// after every new item; rejects naming `what` when it never does.
  when<R>(what: string, look: () => R | undefined | null | false): Promise<R> {
    return new Promise((resolve, reject) => {
      const first = look()
      if (first) return resolve(first)
      const again = (): void => {
        const got = look()
        if (!got) return
        clearTimeout(timer)
        this.wake.delete(again)
        resolve(got)
      }
      const timer = setTimeout(() => {
        this.wake.delete(again)
        reject(new Error(`never happened within ${WITNESS_MS} ms: ${what}`))
      }, WITNESS_MS)
      this.wake.add(again)
    })
  }

  /// The first item at index `from` or later that passes `test`.
  find(what: string, test: (item: T) => boolean, from = 0): Promise<T> {
    return this.when(what, () => this.items.slice(from).find(test))
  }
}

/// One JSON-RPC message, as loosely as a test reads it.
export interface Message {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

export const CLIENT_INFO = { name: 'itest-client', version: '4.5.6' }

/// A client on a target's stdio that sees every line: each message the target
/// writes is recorded in order, so a case can assert what was NOT sent as well.
/// Its request ids count from 0, the range an implementation's own counter
/// would also start in.
export class StdioClient {
  readonly received = new Witness<Message>()
  /// The same messages as the target wrote them, a line each.
  readonly lines: string[] = []
  /// The exit code, once the process is gone.
  readonly exited: Promise<number | null>
  private readonly child: ChildProcessWithoutNullStreams
  private nextId = 0
  private gone = false

  constructor(target: Target, env: Record<string, string>) {
    const [command, ...args] = target.serve()
    this.child = spawn(command!, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    // The pieces of the line still arriving. Only the new chunk is searched for
    // a line end: a message of megabytes arrives in hundreds of chunks.
    let partial: string[] = []
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      const pieces = chunk.split('\n')
      for (const piece of pieces.slice(0, -1)) {
        const line = [...partial, piece].join('').trim()
        partial = []
        if (!line) continue
        this.lines.push(line)
        this.received.push(JSON.parse(line) as Message)
      }
      partial.push(pieces.at(-1)!)
    })
    this.child.stderr.resume()
    // A write after the process ended reports here; the case fails on what it
    // was waiting for instead.
    this.child.stdin.on('error', () => {})
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        this.gone = true
        resolve(code)
      })
    })
  }

  send(message: Message): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params !== undefined ? { params } : {}) })
  }

  /// Sends a request; `answer()` waits for its response, result or error. A
  /// case that expects none (a cancelled call) never asks.
  start(method: string, params?: unknown): { id: number; answer(): Promise<Message> } {
    const id = this.nextId++
    this.send({ id, method, ...(params !== undefined ? { params } : {}) })
    // `method` absent: a request the app makes may carry the same id.
    const answer = (): Promise<Message> =>
      this.received.find(`an answer to ${method} (id ${id})`, (m) => m.id === id && m.method === undefined)
    return { id, answer }
  }

  request(method: string, params?: unknown): Promise<Message> {
    return this.start(method, params).answer()
  }

  /// The handshake a client opens with; resolves with the `initialize` answer.
  async initialize(
    over: { protocolVersion?: string; capabilities?: Record<string, unknown>; clientInfo?: { name: string; version: string } } = {},
  ): Promise<Message> {
    const answer = await this.request('initialize', {
      protocolVersion: over.protocolVersion ?? LATEST_PROTOCOL_VERSION,
      capabilities: over.capabilities ?? {},
      clientInfo: over.clientInfo ?? CLIENT_INFO,
    })
    this.notify('notifications/initialized')
    return answer
  }

  /// The responses received for request `id`.
  answersTo(id: number): Message[] {
    return this.received.items.filter((m) => m.id === id && m.method === undefined)
  }

  endInput(): void {
    this.child.stdin.end()
  }

  /// Stops reading the target's output, as a client that went away without
  /// closing the target's input does. Resolves once the pipe is closed, so the
  /// target's next write is one into a pipe nobody reads.
  stopReading(): Promise<void> {
    return new Promise((resolve) => {
      this.child.stdout.once('close', () => resolve())
      this.child.stdout.destroy()
    })
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  async dispose(): Promise<void> {
    if (!this.gone) this.child.kill('SIGKILL')
    await this.exited
  }
}

/// One session an app accepted.
export interface AppSession {
  id: string
  /// The `initialize` params it was opened with, as they arrived.
  opened: { protocolVersion: string; capabilities: unknown; clientInfo: { name: string; version: string } }
  server: Server
  /// The id of every request the session was sent, in order.
  requestIds: unknown[]
  /// The standalone SSE stream (the session's GET) has been answered.
  streaming: boolean
  /// The client ended the session with a DELETE.
  deleted: boolean
}

export interface AppHost {
  readonly port: number
  readonly sessions: AppSession[]
  /// Receives a word whenever `sessions`, or anything a scripted app records,
  /// changes: what `seen.when` re-reads its condition on.
  readonly seen: Witness<string>
  /// From now on no request is answered; the sockets stay open.
  freeze(): void
  /// Gone at once: the listener closed and every socket dropped.
  kill(): Promise<void>
}

/// The hosting of `src/main/mcp/index.ts` in small: a bearer-gated `/mcp` with
/// one Streamable HTTP session, and one `makeServer()`, per initialize.
export async function hostApp(makeServer: (session: AppSession) => Server, seen = new Witness<string>()): Promise<AppHost> {
  const sessions: AppSession[] = []
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; session: AppSession }>()
  let frozen = false
  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use('/mcp', (req, res, next) => {
    if (frozen) return
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })
  app.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const known = sid ? transports.get(sid) : undefined
    const body = req.body as { id?: unknown; method?: unknown } | undefined
    if (known) {
      const { transport, session } = known
      if (req.method === 'POST' && body?.method !== undefined && body.id !== undefined) session.requestIds.push(body.id)
      if (req.method === 'GET') {
        // The transport registers the stream before it answers, so the answer's
        // status line is the earliest moment a notification cannot be lost.
        const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res
        res.writeHead = ((...args: unknown[]) => {
          if (args[0] === 200) {
            session.streaming = true
            seen.push('stream')
          }
          return writeHead(...args)
        }) as typeof res.writeHead
      }
      await transport.handleRequest(req, res, req.body)
      if (req.method === 'DELETE') {
        session.deleted = true
        seen.push('deleted')
      }
      return
    }
    if (!sid && isInitializeRequest(req.body)) {
      const session: AppSession = {
        id: '',
        opened: req.body.params as AppSession['opened'],
        server: undefined as never,
        requestIds: [body?.id],
        streaming: false,
        deleted: false,
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          session.id = id
          transports.set(id, { transport, session })
          sessions.push(session)
          seen.push('session')
        },
      })
      session.server = makeServer(session)
      await session.server.connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'no session' }, id: null })
  })
  const listener = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  let killed: Promise<void> | null = null
  return {
    port: (listener.address() as { port: number }).port,
    sessions,
    seen,
    freeze: () => {
      frozen = true
    },
    kill: () => {
      killed ??= new Promise<void>((resolve) => {
        listener.close(() => resolve())
        listener.closeAllConnections()
      })
      return killed
    },
  }
}

/// One tool call a scripted app received.
export interface AppCall {
  session: AppSession
  name: string
  /// The progress token the call arrived with, if any.
  progressToken: unknown
  /// Aborted when the app was told to cancel the call.
  signal: AbortSignal
  /// The handler has returned: the app's reply is on its way.
  finished: boolean
}

export interface ScriptedApp extends AppHost {
  readonly calls: AppCall[]
  /// Lets every `slow` and unbounded `heartbeat` call now in flight finish.
  release(): void
}

/// The one tool a scripted app lists. Its definition holds what a careless
/// re-encoding would rewrite: markup characters, and a number JSON writes in
/// exponent form.
export const ADD_MARKER = {
  name: 'add_marker',
  description: 'Add a marker.\nSecond line, with <b>markup</b> & more.',
  inputSchema: { type: 'object' as const, properties: { t_us: { type: 'number', maximum: 1e21 } } },
}

/// What a scripted app's `read_project { view: "session" }` reports as open.
export const OPEN_PROJECT = { name: 'Demo', dir: '/p/Demo' }

/// An app whose tools do what a case needs and record how they were called:
///  - `slow` answers only once released or cancelled;
///  - `heartbeat` sends a progress beat every `BEAT_MS`, `beats` times when
///    given, else until released, then answers;
///  - `ask_roots` asks the client for its roots and answers with them;
///  - `read_project` answers the session view;
///  - `echo` answers its `text` argument;
///  - any other name answers `called:<name>`.
/// Only `add_marker` is listed. `version` is what the app reports as its own.
export async function startScriptedApp(version = '0.0.0'): Promise<ScriptedApp> {
  const seen = new Witness<string>()
  const calls: AppCall[] = []
  const hanging = new Set<() => void>()
  const makeServer = (session: AppSession): Server => {
    const server = new Server({ name: 'weftcut', version }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ADD_MARKER] }))
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const { name } = req.params
      const progressToken = req.params._meta?.progressToken
      const call: AppCall = { session, name, progressToken, signal: extra.signal, finished: false }
      calls.push(call)
      seen.push('call')
      extra.signal.addEventListener('abort', () => seen.push('cancelled'), { once: true })
      const text = (t: string): { content: { type: 'text'; text: string }[] } => {
        call.finished = true
        seen.push('finished')
        return { content: [{ type: 'text' as const, text: t }] }
      }
      if (name === 'slow') {
        await new Promise<void>((resolve) => {
          hanging.add(resolve)
          extra.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return text('done:slow')
      }
      if (name === 'heartbeat') {
        const beats = (req.params.arguments as { beats?: number } | undefined)?.beats
        let released = false
        if (beats === undefined) hanging.add(() => { released = true })
        for (let beat = 1; !released && !extra.signal.aborted && (beats === undefined || beat <= beats); beat++) {
          await sleep(BEAT_MS)
          if (progressToken !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: beat, ...(beats !== undefined ? { total: beats } : {}) },
            })
          }
        }
        return text('done:heartbeat')
      }
      if (name === 'ask_roots') {
        const { roots } = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema)
        return text(JSON.stringify(roots))
      }
      if (name === 'echo') return text(String((req.params.arguments as { text?: unknown } | undefined)?.text))
      if (name === 'read_project') {
        const view = { project: OPEN_PROJECT }
        return { ...text(JSON.stringify(view)), structuredContent: view }
      }
      return text(`called:${name}`)
    })
    return server
  }
  const host = await hostApp(makeServer, seen)
  return {
    ...host,
    calls,
    release: () => {
      for (const finish of [...hanging]) finish()
      hanging.clear()
    },
  }
}

/// An endpoint that is not this app version's: it answers `initialize` at
/// `protocolVersion` whatever the client asked for, in plain JSON.
export async function startForeignApp(protocolVersion: string): Promise<{ port: number; kill(): Promise<void> }> {
  const listener = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 200 : 405).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body) as { id?: unknown; method?: string }
      if (message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'weftcut', version: '0.0.0' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'add_marker', inputSchema: { type: 'object' } }] }
            : {}
      res
        .writeHead(200, {
          'content-type': 'application/json',
          ...(message.method === 'initialize' ? { 'mcp-session-id': 'foreign-session' } : {}),
        })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (listener.address() as { port: number }).port,
    kill: () =>
      new Promise<void>((resolve) => {
        listener.close(() => resolve())
        listener.closeAllConnections()
      }),
  }
}

/// A loopback port nothing listens on: what `mcp_auth.json` names after the
/// app has quit.
export async function unusedPort(): Promise<number> {
  const listener = http.createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()))
  const { port } = listener.address() as { port: number }
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  return port
}

/// Resolves once `file` exists.
export function fileAppears(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      watcher.close()
      resolve()
    }
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) done()
    })
    const timer = setTimeout(() => {
      watcher.close()
      reject(new Error(`never happened within ${WITNESS_MS} ms: ${file} exists`))
    }, WITNESS_MS)
    if (fs.existsSync(file)) done()
  })
}
