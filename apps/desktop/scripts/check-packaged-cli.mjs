// Runs after packaging, on the unpacked app electron-builder left in release/:
// the two facts about the stdio MCP entry that only a packaged app has (ADR
// 0165). An unpackaged Electron keeps its default fuses and still runs as
// Node, so neither can be seen by the unit or e2e suites.
//
//  (a) The RunAsNode fuse reads off.
//  (b) A client config written for the JS shim of 0.7.x is refused: started as
//      that config starts it, the app writes one line on stderr naming the
//      binary the new config runs, answers nothing on stdout, opens no window,
//      and exits non-zero.
//
// Usage: node scripts/check-packaged-cli.mjs [release dir]
// Linux needs a display (CI: xvfb-run -a).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devToolsPort, legacyInvocation, packagedApp, runAsNodeFuse } from './check-packaged-cli-lib.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop
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

/// The URLs of the page targets behind a DevTools endpoint, or 'unreachable'.
async function pageTargets(port) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.filter((target) => target.type === 'page').map((target) => target.url)
  } catch {
    return 'unreachable'
  }
}

/// Starts the app as an old config does and holds it to (b); resolves with the
/// refusal line. The start carries Chromium's remote-debugging switch, the one
/// view into which windows a packaged app has that is the same on every OS.
async function refuseLegacyConfig() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-legacy-config-'))
  const { args, env, binary } = legacyInvocation(process.platform, profile)
  // LANDMINE: GitHub's Ubuntu runner cannot start Chromium's sandbox and kills
  // the process with SIGTRAP before the app's code runs (the e2e launches pass
  // the same switch; see single-instance.spec.ts).
  const switches = process.platform === 'linux' ? ['--no-sandbox'] : []
  switches.push('--remote-debugging-port=0')
  const child = spawn(app.executable, [...switches, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  /// The look at the page targets, taken as soon as Chromium announces its
  /// DevTools endpoint; null when it never did before the app ended.
  let windows = null
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
    const port = windows === null ? devToolsPort(stderr) : null
    if (port !== null) windows = pageTargets(port)
  })
  child.stdin.on('error', () => {})
  const diagnose = () => `stdout: ${JSON.stringify(stdout.slice(-2000))}\nstderr: ${stderr.slice(-4000)}`

  try {
    // What a client sends first. Nothing may answer it.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-packaged-cli', version: '0' } },
      })}\n`,
    )
    // 'close': the exit, with everything it wrote read.
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`never happened within ${WITNESS_MS} ms: the app ends on an old config\n${diagnose()}`)),
        WITNESS_MS,
      )
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    assert.equal(exit.signal, null, `the app was killed rather than exiting\n${diagnose()}`)
    assert.notEqual(exit.code, 0, `the app exited 0 on a config it does not serve\n${diagnose()}`)
    assert.equal(stdout, '', `stdout carries something, and a client parses every line of it\n${diagnose()}`)
    const refusal = stderr.split(/\r?\n/).filter((line) => line.includes(`${binary} mcp`))
    assert.equal(refusal.length, 1, `stderr has no one line naming ${binary} mcp\n${diagnose()}`)
    const pages = await windows
    // 'unreachable': the app ended between announcing the endpoint and the
    // look, and had nothing to show by then.
    if (Array.isArray(pages)) assert.deepEqual(pages, [], 'the app refusing an old config opened a window')
    return refusal[0]
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

const refusal = await refuseLegacyConfig()
console.log(`Legacy config: refused with a non-zero exit and no window: ${refusal}`)
