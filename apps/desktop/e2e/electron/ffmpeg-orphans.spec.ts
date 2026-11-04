import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { launchApp, newProject, invokeCmd, tmpDir, forceCloseApp, waitForHook } from './helpers/driver'

// An app that dies with an encoder running takes the encoder with it
// (native/src/ffmpeg/guard.rs): on macOS and Linux the reaper beside the addon
// stops it once the app's end of its pipe closes, on Windows the app's
// kill-on-close job does. The encoder is the E2E build's stalled stand-in
// (WEFTCUT_E2E_STALLED_ENCODER_MS): it reads nothing and runs until stopped,
// so only the guard can end it once the app is gone.
//
// The app is killed outright (SIGKILL / TerminateProcess), so nothing in it
// runs a stop. The check after the kill is synchronous on purpose: it holds
// this worker's event loop, so the harness's own cleanup of the dead app's
// ffmpeg (process-cleanup.mjs, on the 'close' event) cannot run first and
// pass the test for the guard.

/** Marks the stand-in's command line (videosink.rs `stalled_encoder_stand_in`). */
const STAND_IN = 'rate=1/3600'
const GONE_WITHIN_MS = 8_000

/** `pid ppid command line` for every ffmpeg and Electron process on Windows.
 *  Encoded, because the query's quotes do not survive `-Command` parsing. */
const WINDOWS_LISTING = Buffer.from(
  `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' or Name='electron.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }`,
  'utf16le',
).toString('base64')

/** Processes as `pid ppid command line`: all of them, or on Windows every
 *  ffmpeg and Electron process. */
function listing(): string {
  const r =
    process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-EncodedCommand', WINDOWS_LISTING], { encoding: 'utf8', timeout: 15_000 })
      : spawnSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5_000 })
  return `${r.stdout ?? ''}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}${r.error ? `\n[error] ${r.error}` : ''}`
}

/**
 * The stand-in encoder this app spawned, and the process that spawned it: the
 * app's main process, which holds the reaper's pipe or the job. That is the
 * launched process on macOS and Linux; on Windows the launched process is a
 * wrapper and main is its child.
 */
function standInOf(launched: number): { encoder: number; main: number } | undefined {
  const rows = listing().split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : []
  })
  const mains = new Set([launched, ...rows.filter((row) => row.ppid === launched).map((row) => row.pid)])
  const hit = rows.find((row) => mains.has(row.ppid) && row.args.includes(STAND_IN))
  return hit && { encoder: hit.pid, main: hit.ppid }
}

function alive(pid: number): boolean {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 10_000 })
    return new RegExp(`\\b${pid}\\b`).test(r.stdout ?? '')
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4))

test('an app killed mid-export leaves no ffmpeg running', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_E2E_STALLED_ENCODER_MS: '600000' } })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-orphans-'), name: 'Orphans', canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    const trackId = await invokeCmd<string>(page, 'add_track')
    await invokeCmd(page, 'add_color_layer', { trackId, color: { r: 0, g: 0, b: 1, a: 1 }, tStartUs: 0, durationUs: 1_000_000 })
    await waitForHook(page, 'exportTimeline')
    const args = {
      outputAbsPath: path.join(tmpDir('weftcut-orphans-out-'), 'out.mp4'),
      settings: { encoderEngine: 'native', audio: { include: false } },
    }
    // Started, never awaited: the export cannot finish, and the app dies under it.
    await page.evaluate((a) => {
      void (window as any).__weftcutTest.exportTimeline(a).catch(() => {})
    }, args)

    const launched = app.process().pid!
    let found: { encoder: number; main: number } | undefined
    await expect
      .poll(() => (found = standInOf(launched)), { timeout: 30_000, message: 'the stand-in encoder starts' })
      .toBeDefined()
      .catch((error) => {
        const rows = listing().split(/\r?\n/).filter((line) => /ffmpeg|electron|\[/i.test(line)).join('\n')
        throw new Error(`${error}\nlaunched pid ${launched}; processes:\n${rows}`)
      })
    const { encoder, main } = found!

    process.kill(main, 'SIGKILL') // TerminateProcess on Windows: no tree, no stop.

    const killed = Date.now()
    while (alive(encoder) && Date.now() - killed < GONE_WITHIN_MS) Atomics.wait(pause, 0, 0, 100)
    const elapsedMs = Date.now() - killed
    expect(alive(encoder), `ffmpeg ${encoder} still running ${elapsedMs} ms after the app was killed`).toBe(false)
  } finally {
    forceCloseApp(app)
    await app.close().catch(() => {})
  }
})
