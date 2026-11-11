// Runs after packaging, on the unpacked app electron-builder left in release/:
// the two facts about the stdio MCP entry that only a packaged app has (ADR
// 0165). An unpackaged Electron keeps its default fuses and still runs as
// Node, so neither can be seen by the unit or e2e suites.
//
//  (a) The RunAsNode fuse reads off.
//  (b) A client config written before the `weftcut` binary is still served:
//      started as that config starts it, the app answers `initialize` as
//      `weftcut mcp` does, opens no window, and exits 0 when its input closes.
//
// Usage: node scripts/check-packaged-cli.mjs [release dir]
// Linux needs a display (CI: xvfb-run -a).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_NAME, devToolsPort, legacyInvocation, packagedApp, runAsNodeFuse } from './check-packaged-cli-lib.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const app = packagedApp(process.platform, path.resolve(process.argv[2] ?? path.join(ROOT, 'release')))
assert.ok(fs.existsSync(app.executable), `Packaged executable missing: ${app.executable}`)

/// How long a step may take before it is reported as never having happened.
/// A liveness bound: a cold start on a shared runner, not an expected duration.
const WITNESS_MS = 90_000

const fuse = runAsNodeFuse(fs.readFileSync(app.fuseFile))
assert.ok(fuse.length > 0, `No fuse wire in ${app.fuseFile}`)
assert.deepEqual(
  fuse.filter((state) => state !== 'off'),
  [],
  `The RunAsNode fuse of ${app.fuseFile} is not off (electron-builder.yml electronFuses)`,
)
console.log(`RunAsNode fuse: off (${app.fuseFile})`)

/// Starts the app as an old config does and holds it to (b). With `inspect`
/// the start also carries Chromium's remote-debugging switch, the one view
/// into which windows a packaged app has that is the same on every OS.
async function serveLegacyConfig({ inspect }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-legacy-config-'))
  const { args, env } = legacyInvocation(process.platform, profile)
  const switches = []
  // LANDMINE: GitHub's Ubuntu runner cannot start Chromium's sandbox and kills
  // the process with SIGTRAP before the app's code runs (the e2e launches pass
  // the same switch; see single-instance.spec.ts).
  if (process.platform === 'linux') switches.push('--no-sandbox')
  if (inspect) switches.push('--remote-debugging-port=0')
  const child = spawn(app.executable, [...switches, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  /// What the process has done so far; `seen` fires whenever any of it grows.
  const seen = new EventEmitter()
  const lines = []
  let partial = ''
  let stderr = ''
  let exit = null
  const diagnose = () =>
    `exit: ${exit ? JSON.stringify(exit) : 'still running'}\nstdout: ${JSON.stringify([...lines, partial]).slice(-2000)}\nstderr: ${stderr.slice(-4000)}`
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    const pieces = (partial + chunk).split('\n')
    partial = pieces.pop()
    lines.push(...pieces.filter((line) => line.trim()))
    seen.emit('more')
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
    seen.emit('more')
  })
  child.stdin.on('error', () => {})
  child.once('exit', (code, signal) => {
    exit = { code, signal }
    seen.emit('more')
  })

  /// Resolves with what `look` returns once it returns something; rejects
  /// naming `what` when the process ends first or it never does.
  const when = (what, look) =>
    new Promise((resolve, reject) => {
      const again = () => {
        const got = look()
        if (!got && !exit) return
        clearTimeout(timer)
        seen.off('more', again)
        if (got) resolve(got)
        else reject(new Error(`the app ended before: ${what}\n${diagnose()}`))
      }
      const timer = setTimeout(() => {
        seen.off('more', again)
        reject(new Error(`never happened within ${WITNESS_MS} ms: ${what}\n${diagnose()}`))
      }, WITNESS_MS)
      seen.on('more', again)
      again()
    })

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-packaged-cli', version: '0' } },
      })}\n`,
    )
    // The first line, whatever it is: a client parses every line of stdout,
    // so nothing but the protocol may be written there.
    const first = await when('a line on stdout', () => lines[0])
    let reply
    assert.doesNotThrow(() => {
      reply = JSON.parse(first)
    }, `stdout carries something that is not JSON-RPC\n${diagnose()}`)
    assert.equal(reply.id, 1, `the first message is not the answer to initialize\n${diagnose()}`)
    assert.deepEqual(
      reply.result?.serverInfo,
      { name: SERVER_NAME, version },
      `initialize was not answered by this version's weftcut mcp\n${diagnose()}`,
    )
    if (inspect) {
      const port = await when('the DevTools endpoint is announced', () => devToolsPort(stderr))
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      assert.deepEqual(
        targets.filter((target) => target.type === 'page').map((target) => target.url),
        [],
        'the app serving an old config opened a window',
      )
    }
    child.stdin.end()
    // Here the exit is the thing awaited, so it is not a failure of the wait.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`never happened within ${WITNESS_MS} ms: the app exits after its input closed\n${diagnose()}`)),
        WITNESS_MS,
      )
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      if (exit) done()
      else child.once('exit', done)
    })
    assert.deepEqual(exit, { code: 0, signal: null }, `the app did not exit 0\n${diagnose()}`)
  } finally {
    if (!exit) child.kill('SIGKILL')
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

await serveLegacyConfig({ inspect: false })
console.log(`Legacy config: served by ${SERVER_NAME} ${version}, exit 0 on end of input`)
await serveLegacyConfig({ inspect: true })
console.log('Legacy config: no window while served')
