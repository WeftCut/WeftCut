// `weftcut mcp` as a black box, over real transports: the binary is spawned as
// a client would spawn it and bridged to an app on real Streamable HTTP — the
// server shape the Electron main process hosts. The cases are what the stdio
// server owes a client and the app. They run the binary `npm run build:cli`
// builds, or the one WEFTCUT_CLI_BIN names (`shimHarness.ts`).
//
// A second app, the real `buildMcpServer`, is the other side of the parity
// gate: every request a client can send answers the same through the shim as
// HTTP-direct.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js'
import {
  ClientRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  ResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import { installCli } from '../main/mcp/cliInstall.js'
import { mcpInstructions } from '../main/mcp/instructions.js'
import { buildMcpServer } from '../main/mcp/server.js'
import { createActor } from '../main/state/actor.js'
import { uuidV7Gen } from '../main/state/ids.js'
import { blankProject } from '../main/state/model.js'
import {
  ADD_MARKER,
  BEAT_MS,
  CLIENT_INFO,
  OPEN_PROJECT,
  StdioClient,
  TOKEN,
  WITNESS_MS,
  fileAppears,
  cliTarget,
  hostApp,
  run,
  shimEnv,
  startForeignApp,
  startScriptedApp,
  unusedPort,
  writeAuth,
  type AppHost,
  type Message,
  type ScriptedApp,
  type Target,
} from './shimHarness.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/// The binary is stamped at its build from package.json.
const APP_VERSION = (JSON.parse(fs.readFileSync(path.join(HERE, '../../package.json'), 'utf8')) as { version: string }).version
const target = cliTarget(APP_VERSION)
/// A binary inside an app's `resources/cli/` finds that app beside itself,
/// so a case about having no app to launch cannot run on it.
const besideAnApp = (): boolean => /[\\/]resources[\\/]cli$/i.test(path.dirname(fs.realpathSync(target.bin)))

let tmp: string

const SYNTHETIC = ['weftcut_status', 'launch_weftcut']
const CATALOG_CHANGED = [
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/prompts/list_changed',
]

/// A tool-call idle window short enough to wait out in a case.
const SHORT_IDLE_MS = 300
/// An idle window several beats long: a `heartbeat` call stays inside it for
/// as long as its beats keep arriving.
const BEATING_IDLE_MS = 10 * BEAT_MS
/// Enough beats that the call outlasts `BEATING_IDLE_MS` by half again, so
/// only a window each beat re-arms lets it finish.
const BEATS = (BEATING_IDLE_MS * 1.5) / BEAT_MS
/// A total cap that ends a call while its beats are still arriving.
const TOTAL_CAP_MS = 4 * BEAT_MS

// A case may wait out several witnesses; each is bounded by WITNESS_MS.
vi.setConfig({ testTimeout: 3 * WITNESS_MS })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shim-itest-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/// What a case started, ended after it in reverse order: clients before apps.
const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const end of cleanups.splice(0).reverse()) await end()
})

/// A fresh userData directory whose `mcp_auth.json` names `port`; `null`
/// leaves the file out, as on a machine where the app never ran.
function profile(port: number | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'profile-'))
  if (port !== null) writeAuth(dir, port)
  return dir
}

async function scriptedApp(version?: string): Promise<ScriptedApp> {
  const app = await startScriptedApp(version)
  cleanups.push(() => app.kill())
  return app
}

/// A line-level client on a freshly spawned target.
function open(target: Target, userData: string, env: Record<string, string> = {}): StdioClient {
  const client = new StdioClient(target, shimEnv(userData, env))
  cleanups.push(() => client.dispose())
  return client
}

/// The SDK's client on a freshly spawned target, initialized.
async function sdkClient(target: Target, userData: string): Promise<Client> {
  const [command, ...args] = target.serve()
  const transport = new StdioClientTransport({ command: command!, args, env: shimEnv(userData), stderr: 'ignore' })
  const client = new Client({ name: 'itest', version: '0' }, { capabilities: {} })
  cleanups.push(() => client.close().catch(() => {}))
  await client.connect(transport)
  return client
}

const textOf = (answer: Message): string => (answer.result as { content: { text: string }[] }).content[0]!.text

const callTool = (client: StdioClient, name: string, args: Record<string, unknown> = {}): Promise<Message> =>
  client.request('tools/call', { name, arguments: args })

/// Sends `bytes` of text (at least) through the app's `echo` tool and expects
/// it back whole. The text holds what an encoder might rewrite; the comparison
/// avoids `toBe`, so a failure does not print megabytes.
async function expectEchoed(client: StdioClient, bytes: number): Promise<void> {
  const unit = 'frame<&>é '
  const text = unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)))
  const echoed = textOf(await callTool(client, 'echo', { text }))
  expect(echoed.length).toBe(text.length)
  expect(echoed === text, 'the echoed text equals what was sent').toBe(true)
}

async function toolNames(client: StdioClient): Promise<string[]> {
  const listed = await client.request('tools/list', {})
  return (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name)
}

/// Resolves once all three list_changed notifications arrived after message
/// `from` of what the client has received.
const catalogChanged = (client: StdioClient, from: number): Promise<Message[]> =>
  Promise.all(CATALOG_CHANGED.map((method) => client.received.find(`${method} after message ${from}`, (m) => m.method === method, from)))

const methodsSince = (client: StdioClient, from: number): (string | undefined)[] =>
  client.received.items.slice(from).map((m) => m.method)

/// A JSON-RPC error's code, for the SDK client's rejections.
const errorOf = (p: Promise<unknown>): Promise<{ code: number; message: string }> =>
  p.then(
    () => { throw new Error('expected a JSON-RPC error') },
    (e: unknown) => {
      if (e instanceof McpError) return { code: e.code, message: e.message }
      throw e
    },
  )

describe('weftcut mcp over real stdio + HTTP', () => {
  describe('initialize', () => {
    it("is answered by the shim itself, app or no app: its capabilities, its stamp, the app's instructions", async () => {
      const client = open(target, profile(null))
      const answer = await client.initialize()
      expect(answer.result).toEqual({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
        serverInfo: { name: 'weftcut-mcp', version: target.stamp },
        instructions: mcpInstructions(target.stamp),
      })
      expect((await client.request('ping')).result).toEqual({})
    })

    it('speaks the protocol version the client asked for when the SDK supports it, else the latest', async () => {
      for (const asked of [...SUPPORTED_PROTOCOL_VERSIONS, '1999-01-01']) {
        const client = open(target, profile(null))
        const answer = await client.initialize({ protocolVersion: asked })
        const expected = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION
        expect((answer.result as { protocolVersion: string }).protocolVersion, `asked for ${asked}`).toBe(expected)
        await client.dispose()
      }
    })

    it('answers only initialize and ping before the client has initialized', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      const early = await client.request('tools/list', {})
      expect(early.error?.code).toBe(ErrorCode.InvalidRequest)
      expect(app.sessions).toHaveLength(0)
    })
  })

  describe('catalog', () => {
    it('serves synthetic ∪ real and passes calls through (bearer included)', async () => {
      const app = await scriptedApp()
      const client = await sdkClient(target, profile(app.port))
      // The etiquette rides the build, at the stamped version.
      expect(client.getInstructions()).toBe(mcpInstructions(target.stamp))
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual([...SYNTHETIC, 'add_marker'])
      const result = await client.callTool({ name: 'add_marker', arguments: {} })
      expect(JSON.stringify(result.content)).toContain('called:add_marker')
    })

    it("lists the app's tools as the app wrote them: no character escaped, no number rewritten", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      const listing = client.start('tools/list', {})
      const listed = await listing.answer()
      expect((listed.result as { tools: unknown[] }).tools.at(-1)).toEqual(ADD_MARKER)
      // The line itself, where an equal value may still be spelled differently.
      const line = client.lines.find((l) => (JSON.parse(l) as Message).id === listing.id)!
      expect(line).toContain(JSON.stringify(ADD_MARKER))
    })

    // A tool result with image frames. Past what the SDK's stdio reader accepts
    // in one message: the binary is not what limits a client's message size.
    it('carries a message of many megabytes whole, in both directions, with no ceiling of its own', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      await expectEchoed(client, STDIO_DEFAULT_MAX_BUFFER_SIZE + 1)
    })

    it('annotates the synthetic tools: status reads, launch is safe to repeat', async () => {
      const client = await sdkClient(target, profile(null))
      const { tools } = await client.listTools()
      const annotations = (name: string): unknown => tools.find((t) => t.name === name)?.annotations
      expect(annotations('weftcut_status')).toEqual({ readOnlyHint: true, openWorldHint: false })
      expect(annotations('launch_weftcut')).toEqual({ destructiveHint: false, idempotentHint: true, openWorldHint: false })
    })

    it('with the app away: the synthetic tools, empty listings, and an error per request that says what to do', async () => {
      // Auth file still names the (now-dead) port — the down-with-auth shape.
      const port = await unusedPort()
      const client = await sdkClient(target, profile(port))
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(SYNTHETIC)
      // The listings answer empty rather than fail: nothing to list until the app is up.
      expect((await client.listResources()).resources).toEqual([])
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
      expect((await client.listPrompts()).prompts).toEqual([])
      const status = await client.callTool({ name: 'weftcut_status', arguments: {} })
      expect(JSON.stringify(status.content)).toContain('not running')
      expect(JSON.stringify(status.content)).toContain('launch_weftcut')
      for (const send of [
        () => client.callTool({ name: 'add_marker', arguments: {} }),
        () => client.readResource({ uri: 'project://settings' }),
        () => client.getPrompt({ name: 'cut-pauses' }),
      ]) {
        const error = await errorOf(send())
        expect(error.code).toBe(ErrorCode.InternalError)
        expect(error.message).toContain(`http://127.0.0.1:${port}/mcp`)
        expect(error.message).toContain('launch_weftcut')
      }
      // A request the shim has no down-state answer for is not one of its methods.
      const unknown = await errorOf(client.request({ method: 'logging/setLevel', params: { level: 'info' } }, ResultSchema))
      expect(unknown.code).toBe(ErrorCode.MethodNotFound)
    })

    it('sends an error message without a code prefix of its own', async () => {
      const port = await unusedPort()
      const client = open(target, profile(port))
      await client.initialize()
      expect((await callTool(client, 'add_marker')).error).toEqual({
        code: ErrorCode.InternalError,
        message:
          `WeftCut is not running (nothing answering at http://127.0.0.1:${port}/mcp). ` +
          'Call the launch_weftcut tool to start it, or ask the user to open WeftCut; ' +
          'the full tool catalog appears in this session automatically once the app is up.',
      })
    })

    it('on a machine where the app never ran, the error and the status say so', async () => {
      const client = await sdkClient(target, profile(null))
      const error = await errorOf(client.callTool({ name: 'add_marker', arguments: {} }))
      expect(error.message).toContain('never been launched')
      const status = await client.callTool({ name: 'weftcut_status', arguments: {} })
      expect(JSON.stringify(status.content)).toContain('never been launched')
    })

    it('follows the app up and down, announcing each change, on whatever port mcp_auth.json names by then', async () => {
      const userData = profile(await unusedPort())
      const client = open(target, userData)
      await client.initialize()
      expect(await toolNames(client)).toEqual(SYNTHETIC)

      let mark = client.received.items.length
      const app = await scriptedApp()
      writeAuth(userData, app.port)
      // A listing is when a just-started app becomes visible, without waiting on the poll.
      expect(await toolNames(client)).toEqual([...SYNTHETIC, 'add_marker'])
      await catalogChanged(client, mark)

      mark = client.received.items.length
      await app.kill()
      const failed = await callTool(client, 'add_marker')
      expect(failed.error?.message).toContain('WeftCut is not running')
      await catalogChanged(client, mark)
      expect(await toolNames(client)).toEqual(SYNTHETIC)
    })
  })

  describe('weftcut_status and launch_weftcut', () => {
    it('weftcut_status names the app, its endpoint and the open project', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      const status = textOf(await callTool(client, 'weftcut_status'))
      expect(status).toContain('WeftCut is running (weftcut 0.0.0)')
      expect(status).toContain(`Endpoint: http://127.0.0.1:${app.port}/mcp`)
      expect(status).toContain(`Project: ${OPEN_PROJECT.name} (${OPEN_PROJECT.dir})`)
      expect(status).toContain('The full tool catalog is available in this session.')
    })

    it('weftcut_status names the CLI version only when the app answering is another one', async () => {
      const other = await scriptedApp('0.0.1-other')
      const beside = open(target, profile(other.port))
      await beside.initialize()
      expect(textOf(await callTool(beside, 'weftcut_status')).split('\n')).toEqual([
        'WeftCut is running (weftcut 0.0.1-other).',
        `Endpoint: http://127.0.0.1:${other.port}/mcp`,
        `This weftcut CLI is version ${target.stamp}, not the running app's 0.0.1-other.`,
        `Project: ${OPEN_PROJECT.name} (${OPEN_PROJECT.dir})`,
        'The full tool catalog is available in this session.',
      ])
      const same = await scriptedApp(target.stamp)
      const matching = open(target, profile(same.port))
      await matching.initialize()
      expect(textOf(await callTool(matching, 'weftcut_status')).split('\n')).toEqual([
        `WeftCut is running (weftcut ${target.stamp}).`,
        `Endpoint: http://127.0.0.1:${same.port}/mcp`,
        `Project: ${OPEN_PROJECT.name} (${OPEN_PROJECT.dir})`,
        'The full tool catalog is available in this session.',
      ])
    })

    it("the shim's own requests to the app never reuse an id of the client's", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      // Client requests and status reads interleaved: the reads are the shim's
      // own requests, sent into the session the client's ids travel in.
      for (let round = 0; round < 3; round++) {
        await callTool(client, 'add_marker')
        await callTool(client, 'weftcut_status')
      }
      const session = app.calls.at(-1)!.session
      const ids = session.requestIds.map((id) => `${typeof id}:${String(id)}`)
      expect(ids.filter((id, at) => ids.indexOf(id) !== at), 'request ids the app session saw twice').toEqual([])
      expect(app.calls.filter((c) => c.session === session && c.name === 'read_project')).toHaveLength(3)
    })

    it('launch_weftcut on a running app reports that and starts nothing', async () => {
      const app = await scriptedApp()
      // Nothing is at this path: starting it would be reported as a failure.
      const client = open(target, profile(app.port), { WEFTCUT_APP: path.join(tmp, 'no-such-app') })
      await client.initialize()
      const answer = await callTool(client, 'launch_weftcut')
      expect(answer.result.isError).toBeUndefined()
      expect(textOf(answer)).toContain('already running')
    })

    // A shell script stands in for the app; Windows starts no script by its path.
    it.skipIf(process.platform === 'win32')(
      'launch_weftcut starts WEFTCUT_APP without ELECTRON_RUN_AS_NODE and answers once the endpoint is up',
      async () => {
        const userData = profile(await unusedPort())
        const marker = path.join(userData, 'launched')
        const script = path.join(userData, 'fake-app.sh')
        fs.writeFileSync(script, `#!/bin/sh\nprintf '%s' "\${ELECTRON_RUN_AS_NODE-unset}" > '${marker}'\n`, { mode: 0o755 })
        const client = open(target, userData, { WEFTCUT_APP: script, ELECTRON_RUN_AS_NODE: '1' })
        await client.initialize()
        const mark = client.received.items.length
        const launching = client.start('tools/call', { name: 'launch_weftcut', arguments: {} })
        await fileAppears(marker)
        // "The app came up": only now does anything listen.
        const app = await scriptedApp()
        writeAuth(userData, app.port)
        const answer = await launching.answer()
        expect(answer.result.isError).toBeUndefined()
        expect(textOf(answer)).toContain('launched and its MCP endpoint is up')
        expect(fs.readFileSync(marker, 'utf8')).toBe('unset')
        await catalogChanged(client, mark)
        expect(await toolNames(client)).toContain('add_marker')
      },
    )

    // A shell script stands in for the app; Windows starts no script by its path.
    it.skipIf(process.platform === 'win32')(
      'starts what <userData>/cli/launch.json records, its arguments verbatim',
      async () => {
        const userData = profile(await unusedPort())
        const marker = path.join(userData, 'launched')
        const script = path.join(userData, 'fake-app.sh')
        fs.writeFileSync(script, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > '${marker}'\n`, { mode: 0o755 })
        const args = ['--profile', 'two words', '$HOME', '']
        // Written as the app writes it; no binary is installed beside it.
        installCli({
          source: path.join(userData, 'no-binary'),
          userDataDir: userData,
          platform: process.platform,
          launch: { exec: script, args, version: target.stamp },
        })
        const client = open(target, userData)
        await client.initialize()
        const launching = client.start('tools/call', { name: 'launch_weftcut', arguments: {} })
        await fileAppears(marker)
        const app = await scriptedApp()
        writeAuth(userData, app.port)
        const answer = await launching.answer()
        expect(answer.result.isError).toBeUndefined()
        expect(textOf(answer)).toContain('launched and its MCP endpoint is up')
        expect(fs.readFileSync(marker, 'utf8')).toBe(args.map((arg) => `${arg}\n`).join(''))
      },
    )

    it.skipIf(besideAnApp())('with no app recorded or beside it, says WeftCut must be opened once', async () => {
      const client = open(target, profile(await unusedPort()))
      await client.initialize()
      const answer = await callTool(client, 'launch_weftcut')
      expect(answer.result.isError).toBe(true)
      expect(textOf(answer)).toBe(
        'This weftcut CLI does not know where the WeftCut app is installed. ' +
          'Ask the user to open WeftCut once (the app records how to start it), ' +
          'or set the WEFTCUT_APP environment variable to a launchable WeftCut executable.',
      )
    })

    it.skipIf(process.platform === 'win32')('a call during a launch that is waiting joins that wait and starts nothing', async () => {
      const userData = profile(await unusedPort())
      const marker = path.join(userData, 'launched')
      const script = path.join(userData, 'fake-app.sh')
      fs.writeFileSync(script, `#!/bin/sh\necho started >> '${marker}'\n`, { mode: 0o755 })
      const client = open(target, userData, { WEFTCUT_APP: script })
      await client.initialize()
      const first = client.start('tools/call', { name: 'launch_weftcut', arguments: {} })
      await fileAppears(marker)
      const second = client.start('tools/call', { name: 'launch_weftcut', arguments: {} })
      // Lines are taken in order: the second call was read before this answer.
      await client.request('ping')
      const app = await scriptedApp()
      writeAuth(userData, app.port)
      for (const call of [first, second]) {
        const answer = await call.answer()
        expect(answer.result.isError).toBeUndefined()
        expect(textOf(answer)).toContain('launched and its MCP endpoint is up')
      }
      expect(fs.readFileSync(marker, 'utf8')).toBe('started\n')
    })
  })

  describe('long tool calls', () => {
    it('a call silent past the idle window is answered "still working": nothing cancelled, the session kept', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), { WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(SHORT_IDLE_MS) })
      await client.initialize()
      expect(await toolNames(client)).toContain('add_marker')
      const mark = client.received.items.length
      const answer = await callTool(client, 'slow')
      expect(answer.result.isError).toBe(true)
      const message = textOf(answer)
      expect(message).toContain('WeftCut is running')
      expect(message).toContain('slow is still working inside the app')
      expect(message).toContain(`${SHORT_IDLE_MS} ms of no progress`)
      expect(message).toContain('joins the in-flight job')
      expect(message).toContain('WEFTCUT_MCP_TOOL_TIMEOUT_MS')
      expect(message).not.toContain('not running')
      // The next call runs in the session the slow one is still running in,
      // and that one was never told to stop.
      expect(textOf(await callTool(client, 'add_marker'))).toBe('called:add_marker')
      const [slow, next] = [app.calls.find((c) => c.name === 'slow')!, app.calls.find((c) => c.name === 'add_marker')!]
      expect(next.session).toBe(slow.session)
      expect(slow.signal.aborted).toBe(false)
      expect(methodsSince(client, mark)).not.toContain('notifications/tools/list_changed')
    })

    it("the app's reply to a call the shim already answered is dropped", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), { WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(SHORT_IDLE_MS) })
      await client.initialize()
      const slow = client.start('tools/call', { name: 'slow', arguments: {} })
      expect((await slow.answer()).result.isError).toBe(true)
      app.release()
      await app.seen.when('the slow job finished in the app', () => app.calls.find((c) => c.name === 'slow')?.finished)
      // A round trip behind the late reply, so it has had its way through the shim.
      expect(textOf(await callTool(client, 'add_marker'))).toBe('called:add_marker')
      expect(client.answersTo(slow.id)).toHaveLength(1)
    })

    it("progress from the app re-arms the idle window and reaches the client under the client's token", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), { WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(BEATING_IDLE_MS) })
      await client.initialize()
      const answer = await client.request('tools/call', {
        name: 'heartbeat',
        arguments: { beats: BEATS },
        _meta: { progressToken: 'client-token' },
      })
      // The work outlasts the window (see BEATS): only the beats kept it alive.
      expect(answer.result.isError).toBeUndefined()
      expect(textOf(answer)).toBe('done:heartbeat')
      const relayed = client.received.items.filter((m) => m.method === 'notifications/progress').map((m) => m.params as unknown)
      expect(relayed).toEqual(
        Array.from({ length: BEATS }, (_, at) => ({ progressToken: 'client-token', progress: at + 1, total: BEATS })),
      )
    })

    it('progress re-arms the idle window for a client that asked for none, and none is relayed', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), { WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(BEATING_IDLE_MS) })
      await client.initialize()
      const answer = await callTool(client, 'heartbeat', { beats: BEATS })
      expect(answer.result.isError).toBeUndefined()
      expect(textOf(answer)).toBe('done:heartbeat')
      expect(client.received.items.filter((m) => m.method === 'notifications/progress')).toEqual([])
    })

    it('WEFTCUT_MCP_TOOL_MAX_TOTAL_MS ends the wait on a call whose progress keeps arriving', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), {
        WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(BEATING_IDLE_MS),
        WEFTCUT_MCP_TOOL_MAX_TOTAL_MS: String(TOTAL_CAP_MS),
      })
      await client.initialize()
      // No `beats`: the call beats until released, so the idle window never ends it.
      const answer = await callTool(client, 'heartbeat')
      expect(answer.result.isError).toBe(true)
      expect(textOf(answer)).toContain('heartbeat is still working inside the app')
      expect(textOf(answer)).toContain(`${TOTAL_CAP_MS} ms total limit set by WEFTCUT_MCP_TOOL_MAX_TOTAL_MS`)
      app.release()
    })

    it('past the idle window with an app that no longer answers: the down error, and the catalog change', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port), { WEFTCUT_MCP_TOOL_TIMEOUT_MS: String(SHORT_IDLE_MS) })
      await client.initialize()
      const slow = client.start('tools/call', { name: 'slow', arguments: {} })
      await app.seen.when('the app received the call', () => app.calls.some((c) => c.name === 'slow'))
      const mark = client.received.items.length
      app.freeze() // every later request, the liveness ping included, goes unanswered
      const answer = await slow.answer()
      expect(answer.error?.code).toBe(ErrorCode.InternalError)
      expect(answer.error?.message).toContain(`WeftCut is not running (nothing answering at http://127.0.0.1:${app.port}/mcp)`)
      await catalogChanged(client, mark)
    })

    // The idle windows are the defaults, minutes long, so none runs out here:
    // the calls fail because the app is gone.
    it('every call in flight when the app goes away fails with the down error, idle window or not', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      const tokens = ['first-token', 'second-token']
      const calls = tokens.map((progressToken) =>
        client.start('tools/call', { name: 'heartbeat', arguments: {}, _meta: { progressToken } }),
      )
      // A relayed beat per call: the app has begun answering it, so what is
      // lost with the app is an answer under way, not a request that failed to send.
      for (const token of tokens) {
        await client.received.find(`a beat of the call under ${token}`, (m) => m.method === 'notifications/progress' && m.params?.progressToken === token)
      }
      const mark = client.received.items.length
      await app.kill()
      for (const call of calls) {
        const answer = await call.answer()
        expect(answer.error?.code).toBe(ErrorCode.InternalError)
        expect(answer.error?.message).toContain(`WeftCut is not running (nothing answering at http://127.0.0.1:${app.port}/mcp)`)
      }
      await catalogChanged(client, mark)
    })

    it("the client's cancel reaches the app's job, and the session stays up", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      const slow = client.start('tools/call', { name: 'slow', arguments: {} })
      const job = await app.seen.when('the app received the call', () => app.calls.find((c) => c.name === 'slow'))
      const mark = client.received.items.length
      client.notify('notifications/cancelled', { requestId: slow.id, reason: 'user pressed stop' })
      await app.seen.when("the app's job was cancelled", () => job.signal.aborted)
      expect(textOf(await callTool(client, 'add_marker'))).toBe('called:add_marker')
      expect(app.calls.at(-1)!.session).toBe(job.session)
      expect(methodsSince(client, mark)).not.toContain('notifications/tools/list_changed')
    })
  })

  describe('the app session', () => {
    it('is opened once, after the client initialized, as that client: name, version, capabilities, protocol version', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      // Answered by the shim itself: it is up and reading, and has met no client yet.
      expect((await client.request('ping')).result).toEqual({})
      expect(app.sessions).toHaveLength(0)
      const asked = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v !== LATEST_PROTOCOL_VERSION)!
      const capabilities = { roots: { listChanged: true }, sampling: {}, experimental: { 'x-itest': { nested: [1, 'two', null] } } }
      await client.initialize({ protocolVersion: asked, capabilities })
      await callTool(client, 'add_marker')
      // One session over the whole run: there was no earlier one to reopen.
      expect(app.sessions).toHaveLength(1)
      expect(app.sessions[0]!.opened).toEqual({ protocolVersion: asked, capabilities, clientInfo: CLIENT_INFO })
    })


    it('carries what the app sends on its own to the client, verbatim', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      await callTool(client, 'add_marker')
      const { session } = app.calls.at(-1)!
      await app.seen.when("the session's standalone stream is open", () => session.streaming)
      const params = { note: 'any method the app sends', nested: { list: [1, 'two', null] } }
      await session.server.notification({ method: 'notifications/example/forwarded', params })
      const got = await client.received.find('the notification the app sent', (m) => m.method === 'notifications/example/forwarded')
      expect(got).toEqual({ jsonrpc: '2.0', method: 'notifications/example/forwarded', params })
    })

    it("carries a request the app makes during a call to the client, and the client's answer back", async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      const roots = [{ uri: 'file:///home/u/project', name: 'project' }]
      await client.initialize({ capabilities: { roots: {} } })
      const call = client.start('tools/call', { name: 'ask_roots', arguments: {} })
      const asked = await client.received.find("the app's roots/list request", (m) => m.method === 'roots/list' && m.id !== undefined)
      client.send({ id: asked.id!, result: { roots } })
      expect(JSON.parse(textOf(await call.answer()))).toEqual(roots)
    })

    it('carries a request the app makes outside any call, over the standalone stream', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      const roots = [{ uri: 'file:///home/u/project', name: 'project' }]
      await client.initialize({ capabilities: { roots: {} } })
      await callTool(client, 'add_marker')
      const { session } = app.calls.at(-1)!
      await app.seen.when("the session's standalone stream is open", () => session.streaming)
      const answering = client.received
        .find("the app's roots/list request", (m) => m.method === 'roots/list' && m.id !== undefined)
        .then((asked) => client.send({ id: asked.id!, result: { roots } }))
      // Together: a refusal of the app's request fails the case as itself.
      const [answer] = await Promise.all([session.server.listRoots(), answering])
      expect(answer.roots).toEqual(roots)
    })

    it('is not kept when the app answers another protocol version; weftcut_status and info say how to refresh', async () => {
      const foreign = await startForeignApp('1999-01-01')
      cleanups.push(() => foreign.kill())
      const userData = profile(foreign.port)
      const client = open(target, userData)
      await client.initialize()
      expect(await toolNames(client)).toEqual(SYNTHETIC)
      const said =
        `WeftCut is running at http://127.0.0.1:${foreign.port}/mcp, but it answered MCP protocol 1999-01-01 ` +
        `where this session uses ${LATEST_PROTOCOL_VERSION}: the app and this weftcut CLI come from different versions. ` +
        'Ask the user to open WeftCut once so it refreshes the CLI, then restart this MCP server.'
      expect(textOf(await callTool(client, 'weftcut_status'))).toBe(said)
      // A request that needs the app says the same, not that the app is not running.
      expect((await callTool(client, 'add_marker')).error).toEqual({ code: ErrorCode.InternalError, message: said })
      const info = await run(target, ['info'], shimEnv(userData))
      expect(info.status).toBe(3)
      expect(info.stdout).toMatch(
        new RegExp(`^running:   yes, but it answered MCP protocol 1999-01-01 where this CLI asked for ${LATEST_PROTOCOL_VERSION}; open WeftCut once to refresh the CLI$`, 'm'),
      )
      const listed = await run(target, ['list-tools'], shimEnv(userData))
      expect(listed.status).toBe(3)
      expect(listed.stderr).toContain('Open WeftCut once to refresh the CLI.')
    })

    it('is ended with a DELETE when the client closes stdin, and the process exits 0', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      await callTool(client, 'add_marker')
      client.endInput()
      expect(await client.exited).toBe(0)
      // The DELETE is what releases the work session and the history lock at once.
      await app.seen.when('every session the shim opened was deleted', () => app.sessions.every((s) => s.deleted))
      expect(app.sessions.length).toBeGreaterThan(0)
    })

    // Windows has no SIGTERM a process can catch; stdin closing is what covers it.
    it.skipIf(process.platform === 'win32')('is ended with a DELETE on SIGTERM, and the process exits 0', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      await callTool(client, 'add_marker')
      client.signal('SIGTERM')
      expect(await client.exited).toBe(0)
      await app.seen.when('every session the shim opened was deleted', () => app.sessions.every((s) => s.deleted))
      expect(app.sessions.length).toBeGreaterThan(0)
    })

    it.skipIf(process.platform === 'win32')('a client that stops reading is a client gone: the session is deleted, exit 0', async () => {
      const app = await scriptedApp()
      const client = open(target, profile(app.port))
      await client.initialize()
      await callTool(client, 'add_marker')
      const { session } = app.calls.at(-1)!
      await app.seen.when("the session's standalone stream is open", () => session.streaming)
      await client.stopReading()
      // Something to write: the write is how the shim learns nobody reads.
      await session.server.notification({ method: 'notifications/example/unread' })
      expect(await client.exited).toBe(0)
      await app.seen.when('the session was deleted', () => session.deleted)
    })
  })

  describe('terminal subcommands', () => {
    it('help, --help and -h print one usage text and exit 0', async () => {
      const env = shimEnv(profile(null))
      const [help, long, short] = await Promise.all([run(target, ['help'], env), run(target, ['--help'], env), run(target, ['-h'], env)])
      expect(help.status).toBe(0)
      for (const word of ['usage:', 'info', 'print-config', 'list-tools', 'WEFTCUT_USERDATA']) expect(help.stdout).toContain(word)
      expect(long).toEqual(help)
      expect(short).toEqual(help)
    })

    it('with no arguments prints the usage text and exits 0, serving nothing', async () => {
      const env = shimEnv(profile(null))
      const [bare, help] = await Promise.all([run(target, [], env), run(target, ['help'], env)])
      expect(bare.status).toBe(0)
      expect(bare.stdout).toContain('usage:')
      // The stdio server is a subcommand of its own, listed with the others.
      for (const sub of ['mcp', 'info', 'print-config', 'list-tools', 'help']) {
        expect(bare.stdout, `the usage text lists weftcut ${sub}`).toMatch(new RegExp(`^  weftcut ${sub}\\s`, 'm'))
      }
      expect(bare).toEqual(help)
    })

    it('--version and -V print the version the build was stamped with', async () => {
      const env = shimEnv(profile(null))
      const [long, short] = await Promise.all([run(target, ['--version'], env), run(target, ['-V'], env)])
      expect(long.status).toBe(0)
      expect(long.stdout.trim()).toBe(`weftcut ${target.stamp}`)
      expect(short).toEqual(long)
    })

    it('print-config names the binary itself and the mcp subcommand, with no env and no token', async () => {
      const out = await run(target, ['print-config'], shimEnv(profile(null)))
      expect(out.status).toBe(0)
      const parsed = JSON.parse(out.stdout) as { mcpServers: { weftcut: { command: string; args: string[] } } }
      expect(Object.keys(parsed)).toEqual(['mcpServers'])
      expect(Object.keys(parsed.mcpServers)).toEqual(['weftcut'])
      const entry = parsed.mcpServers.weftcut
      expect(Object.keys(entry).sort()).toEqual(['args', 'command'])
      expect(entry.args).toEqual(['mcp'])
      expect(path.isAbsolute(entry.command)).toBe(true)
      expect(fs.realpathSync(entry.command)).toBe(fs.realpathSync(target.bin))
    })

    it('an unknown command exits 2 and names it', async () => {
      const out = await run(target, ['no-such-command'], shimEnv(profile(null)))
      expect(out.status).toBe(2)
      expect(out.stderr).toContain('unknown command: no-such-command')
    })

    it('info and list-tools reach the running app, and leave no session behind', async () => {
      const app = await scriptedApp()
      const env = shimEnv(profile(app.port))
      const info = await run(target, ['info'], env)
      expect(info.status).toBe(0)
      expect(info.stdout).toContain(`http://127.0.0.1:${app.port}/mcp`)
      expect(info.stdout).toContain(TOKEN)
      expect(info.stdout).toMatch(/^running:\s+yes$/m)
      const listed = await run(target, ['list-tools'], env)
      expect(listed.status).toBe(0)
      // One line per tool: its name and the first line of its description.
      expect(listed.stdout.trim().split(/\r?\n/)).toEqual(['add_marker — Add a marker.'])
      expect(app.sessions.length).toBeGreaterThan(0)
      await app.seen.when('every session the commands opened was deleted', () => app.sessions.every((s) => s.deleted))
    })

    it('info and list-tools exit 3 when the app is not reachable', async () => {
      const port = await unusedPort()
      const env = shimEnv(profile(port))
      const info = await run(target, ['info'], env)
      expect(info.status).toBe(3)
      expect(info.stdout).toMatch(/^running:\s+no$/m)
      const listed = await run(target, ['list-tools'], env)
      expect(listed.status).toBe(3)
      expect(listed.stderr).toContain(`WeftCut is not running (nothing answering at http://127.0.0.1:${port}/mcp)`)
    })

    it('info and list-tools exit 3 on a machine where the app never ran', async () => {
      const env = shimEnv(profile(null))
      const info = await run(target, ['info'], env)
      expect(info.status).toBe(3)
      expect(info.stdout).toContain('launch WeftCut once')
      const listed = await run(target, ['list-tools'], env)
      expect(listed.status).toBe(3)
      expect(listed.stderr).toContain('never been launched')
    })
  })

  // The drift gate: a request method the app learns to answer must answer the
  // same through the shim. Every request the SDK lets a client send goes to the
  // real app session both ways and must come back the same.
  describe('answers every client request as the app does', () => {
    const RUST_CATALOG = fs.readFileSync(path.join(HERE, '../../fixtures/mcp/rust-catalog-snapshot.json'), 'utf8')

    let app: AppHost
    let appData: string

    /// The app session `main/mcp/index.ts` builds, over one project actor shared
    /// by every session as in the app, and a backend that answers from the
    /// committed Rust catalog in place of the native addon. Prompt and resource
    /// reads echo what they were asked, so equal results also mean equal params
    /// reached the app.
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 'parity'), idGen, clock: () => '<TS>' })
    const host = { actor, mcpCall: (n: string, a: string) => actor.mcpCall(n, a), motifTool: () => [] }
    function realAppServer(): Server {
      const backend = {
        mcpCatalog: async () => RUST_CATALOG,
        mcpListPrompts: async () => JSON.stringify(JSON.parse(RUST_CATALOG).prompts),
        mcpGetPrompt: async (name: string, args: string) =>
          JSON.stringify({ ok: true, result: { messages: [{ role: 'user', content: { type: 'text', text: `${name} ${args}` } }] } }),
        mcpReadResource: async (uri: string) =>
          JSON.stringify({ ok: true, result: { contents: [{ uri, mimeType: 'text/plain', text: uri }] } }),
        mcpCallTool: async () => { throw new Error('no native tool is called by this gate') },
      }
      return buildMcpServer(backend as never, { getTsHost: () => host as never })
    }

    async function directClient(): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
      const client = new Client({ name: 'itest', version: '0' }, { capabilities: {} })
      cleanups.push(async () => {
        await transport.terminateSession().catch(() => {})
        await client.close().catch(() => {})
      })
      await client.connect(transport)
      return client
    }

    /// A result, or the JSON-RPC error code: the message is each hop's own
    /// wording, the code is what a client branches on.
    async function outcome(client: Client, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
      try {
        const result = await client.request({ method, ...(params ? { params } : {}) } as never, ResultSchema)
        if (method !== 'tools/list') return { result }
        // The shim's own tools are left out when its tools/list is compared.
        const { tools, ...rest } = result as { tools: { name: string }[] }
        return { result: { ...rest, tools: tools.filter((t) => !SYNTHETIC.includes(t.name)) } }
      } catch (e) {
        if (e instanceof McpError) return { error: e.code }
        throw e
      }
    }

    async function outcomes(client: Client): Promise<Map<string, unknown>> {
      const out = new Map<string, unknown>()
      for (const [method, entry] of Object.entries(CLIENT_REQUESTS)) {
        if ('compare' in entry) out.set(method, await outcome(client, method, entry.compare))
      }
      return out
    }

    beforeAll(async () => {
      app = await hostApp(realAppServer)
      appData = profile(app.port)
    })

    afterAll(() => app.kill())

    it('through the shim, each request answers what HTTP-direct answers', async () => {
      const direct = await outcomes(await directClient())
      const shimmed = await outcomes(await sdkClient(target, appData))
      // The gate compares something only if the app really answers: a real
      // catalog, not two empty sides.
      expect(direct.get('tools/list')).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'read_project' })]) } })
      for (const method of direct.keys()) expect.soft(shimmed.get(method), method).toEqual(direct.get(method))
    })
  })
})

/// Every member of the SDK's ClientRequestSchema, classified. `compare`
/// carries the params it is sent with; a method the SDK adds fails the gate
/// until it is classified here.
const CLIENT_REQUESTS: Record<string, { compare: Record<string, unknown> | undefined } | { skip: string }> = {
  // Each hop answers its own handshake: the shim's capabilities and
  // instructions are its own, and are checked under "initialize" above.
  initialize: { skip: 'answered by each hop itself' },
  ping: { compare: undefined },
  'completion/complete': { compare: { ref: { type: 'ref/prompt', name: 'cut-pauses' }, argument: { name: 'clip', value: '' } } },
  'logging/setLevel': { compare: { level: 'info' } },
  'prompts/get': { compare: { name: 'cut-pauses', arguments: { clip: 'Interview A' } } },
  'prompts/list': { compare: {} },
  'resources/list': { compare: {} },
  'resources/templates/list': { compare: {} },
  'resources/read': { compare: { uri: 'project://settings' } },
  'resources/subscribe': { compare: { uri: 'project://settings' } },
  'resources/unsubscribe': { compare: { uri: 'project://settings' } },
  'tools/call': { compare: { name: 'read_project', arguments: { view: 'tracks' } } },
  'tools/list': { compare: {} },
  'tasks/get': { compare: { taskId: 'task-1' } },
  'tasks/result': { compare: { taskId: 'task-1' } },
  'tasks/list': { compare: {} },
  'tasks/cancel': { compare: { taskId: 'task-1' } },
}

describe('the parity gate covers the SDK', () => {
  it('every client request the SDK defines is classified', () => {
    const sdk = ClientRequestSchema.options.map((s) => s.shape.method.value as string).sort()
    const classified = Object.keys(CLIENT_REQUESTS).sort()
    expect(
      sdk.filter((m) => !classified.includes(m)),
      'the SDK defines client requests this gate does not know: add each to CLIENT_REQUESTS (and see that the shim answers it as the app does)',
    ).toEqual([])
    expect(classified.filter((m) => !sdk.includes(m)), 'CLIENT_REQUESTS names methods the SDK no longer defines').toEqual([])
  })
})
