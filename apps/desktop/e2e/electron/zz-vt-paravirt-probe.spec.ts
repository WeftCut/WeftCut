// Temporary CI diagnosis (diagnose/macos-export-stall): does killing a
// VideoToolbox client mid-session wedge the runner VM's paravirtualized
// VideoToolbox? No Electron; only the bundled ffmpeg. Select one mode per
// dispatch with `-g vt-probe-<mode>` so each runs on a fresh VM.
import { test } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const ROUNDS = 40

/** One short VT encode. A healthy VM finishes 10 frames in well under a second. */
async function health(dir: string, round: number): Promise<number | null> {
  const started = Date.now()
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-frames:v', '10', '-c:v', 'h264_videotoolbox', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.resume()
  const done = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const timer = new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 15_000))
  const result = await Promise.race([done, timer])
  if (result !== 'hung') return Date.now() - started
  try {
    await exec('/usr/bin/sample', [String(child.pid), '1', '1', '-file', `${dir}/hung-health-${round}.txt`], { timeout: 10_000 })
  } catch (error) { fs.appendFileSync(`${dir}/errors.log`, `${String(error)}\n`) }
  child.kill('SIGKILL')
  return null
}

for (const mode of ['graceful', 'sigkill'] as const) test(`vt-probe-${mode}`, async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'paravirtualized VideoToolbox is a macOS runner question')
  test.setTimeout(30 * 60_000)
  const dir = testInfo.outputPath('vt-probe')
  fs.mkdirSync(dir, { recursive: true })
  const log = (line: string) => { console.log(`[vt-probe:${mode}] ${line}`); fs.appendFileSync(`${dir}/rounds.log`, `${line}\n`) }
  log(`baseline health ${await health(dir, 0)} ms`)
  for (let round = 1; round <= ROUNDS; round++) {
    // Same shape as an export: raw frames on stdin, VT encode to a file.
    const out = `${dir}/round-${round}.mp4`
    const child = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-c:v', 'h264_videotoolbox', '-b:v', '8M', out], { stdio: ['pipe', 'ignore', 'pipe'] })
    child.stderr.resume()
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    // Let the compression session open and encode for a while.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const stopStarted = Date.now()
    if (mode === 'sigkill') child.kill('SIGKILL')
    else child.stdin.end('q')
    const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))])
    if (!stopped) child.kill('SIGKILL')
    fs.rmSync(out, { force: true })
    const ms = await health(dir, round)
    log(`round ${round}: stop ${stopped ? Date.now() - stopStarted : 'timeout'} ms, health ${ms ?? 'HUNG'}`)
    if (ms === null) {
      log(`wedged after ${round} ${mode} stops; retrying health once after 20 s`)
      await new Promise(resolve => setTimeout(resolve, 20_000))
      log(`late health ${(await health(dir, round + 1000)) ?? 'HUNG'}`)
      return
    }
  }
  log(`no wedge after ${ROUNDS} ${mode} stops`)
})
