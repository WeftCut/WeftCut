import { spawn, spawnSync } from 'node:child_process'

const FFMPEG_NAMES = new Set(['ffmpeg', 'ffprobe'])
/** How long an owned ffmpeg or ffprobe has to end on SIGTERM before the group kill. */
export const FFMPEG_GRACE_MS = 2000
const pause = new Int32Array(new SharedArrayBuffer(4))

function processGroup(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
  const group = Number(result.stdout?.trim())
  return result.status === 0 && Number.isSafeInteger(group) && group > 0 ? group : null
}

/** Every process as { pid, pgid, ppid, state, name }. These keywords exist in
 * both procps and BSD ps; macOS prints comm as a full path, maybe with spaces. */
function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,ppid=,stat=,comm='], { encoding: 'utf8', timeout: 1000 })
  return (result.stdout ?? '').split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/)
    if (!match) return []
    const [, pid, pgid, ppid, state, comm] = match
    return [{ pid: Number(pid), pgid: Number(pgid), ppid: Number(ppid), state, name: comm.slice(comm.lastIndexOf('/') + 1) }]
  })
}

/** Every process as { pid, ppid, command }, the command line in full: a
 * Chromium child is told apart only by its `--type=` switch. */
function processCommands() {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    try {
      return [JSON.parse(result.stdout)].flat().map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine || row.Name || '' }))
    } catch { return [] }
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024 * 1024 })
  return (result.stdout ?? '').split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

/** The executable's name and the switches that say which child it is. */
function brief(command) {
  const executable = command.match(/^"([^"]+)"|^(\S+)/)
  const name = (executable?.[1] ?? executable?.[2] ?? '').split(/[\\/]/).pop()
  const role = command.match(/--(?:type|utility-sub-type)=\S+/g)
  return role ? `${name} ${role.join(' ')}` : command.length > 120 ? `${command.slice(0, 120)}…` : command
}

/** Runs `WEFTCUT_E2E_CLOSE_HANG_CMD` (a shell command) against a close that
 * timed out, before the kill: the place to take a dump or a stack sample.
 * `WEFTCUT_E2E_HUNG_PID` is the app's main process, set only while it lives. */
function runHangCommand(mainPid) {
  const command = process.env.WEFTCUT_E2E_CLOSE_HANG_CMD
  if (!command) return Promise.resolve()
  return new Promise(resolve => {
    const env = { ...process.env }
    if (mainPid) env.WEFTCUT_E2E_HUNG_PID = String(mainPid)
    else delete env.WEFTCUT_E2E_HUNG_PID
    const hook = spawn(command, { shell: true, stdio: 'ignore', env, timeout: 60_000, windowsHide: true })
    hook.once('error', resolve)
    hook.once('exit', resolve)
  })
}

/** Capture ownership while the leader is alive. Electron is detached on POSIX;
 * its isolated group survives leader exit while children still hold pipes.
 * `ffmpegGraceMs` is for this module's own tests, which need a grace long
 * enough to tell from an early end. */
export function ownProcessTree(child, { ffmpegGraceMs = FFMPEG_GRACE_MS } = {}) {
  // Keep output flowing even when no caller prints it. A full pipe can block
  // Electron/native work and then prevent the same process from quitting.
  child.stdout?.resume()
  child.stderr?.resume()
  const pid = child.pid
  const group = process.platform === 'win32' || !pid ? null : processGroup(pid)
  const workerGroup = process.platform === 'win32' ? null : processGroup(process.pid)
  const isolated = group === pid && workerGroup !== null && group !== workerGroup
  let closed = false
  // After close the leader is gone. If its PID has already been reused,
  // ownership no longer follows from that number; leave the new process alone.
  const ownsGroup = () => isolated && workerGroup !== group && !(closed && processGroup(pid) !== null)
  // Only the group verified to belong to this child, else (non-detached
  // callers) only descendants of our live child; never our worker.
  const ownedPids = rows => {
    if (isolated) return ownsGroup() ? rows.filter(row => row.pgid === group).map(row => row.pid) : []
    if (closed) return []
    const descendants = [pid]
    for (let i = 0; i < descendants.length; i++) {
      for (const { pid: candidate, ppid } of rows) if (ppid === descendants[i] && candidate !== process.pid && !descendants.includes(candidate)) descendants.push(candidate)
    }
    return descendants
  }
  // A SIGKILLed VideoToolbox encoder can wedge the next export on the macOS CI
  // VM (docs/notes/macos-runner-videotoolbox-kill-2026-10-31.md), so owned
  // ffmpeg/ffprobe get SIGTERM and a short grace first. Never Electron: its
  // SIGTERM runs the quit path and the "export unfinished" dialog. The wait is
  // synchronous so force() stays usable from 'exit' handlers, and our worker
  // cannot reap the leader (freeing its PID for reuse) during it.
  const stopFfmpeg = () => {
    if (process.platform === 'win32' || !pid) return
    const live = () => {
      const rows = processRows()
      const owned = new Set(ownedPids(rows))
      return rows.filter(row => owned.has(row.pid) && row.pid !== pid && !row.state.startsWith('Z') && FFMPEG_NAMES.has(row.name)).map(row => row.pid)
    }
    let ffmpeg = live()
    for (const candidate of ffmpeg) {
      try { process.kill(candidate, 'SIGTERM') } catch { /* Already gone. */ }
    }
    for (const deadline = Date.now() + ffmpegGraceMs; ffmpeg.length > 0 && Date.now() < deadline; ffmpeg = live()) Atomics.wait(pause, 0, 0, 50)
  }
  const killOwnedGroup = () => {
    if (!ownsGroup()) return
    try { process.kill(-group, 'SIGKILL') } catch { /* Already gone. */ }
  }
  const reaped = new Promise(resolve => {
    child.once('close', () => {
      closed = true
      // Native FFmpeg children have separate stdio. They do not delay 'close'
      // but can still run after Electron exits, contaminating the next test.
      // Electron's exit gave them stdin EOF; let them end before the kill.
      try {
        stopFfmpeg()
        killOwnedGroup()
      } finally { resolve() }
    })
  })
  return {
    reaped,
    /** What a close that has not finished is still waiting for, as
     * `{ report, mainPid }`; `mainPid` is null once the main process is gone.
     * Playwright's close needs the leader gone AND its stdio pipes shut, so a
     * main process stuck in its own teardown and a helper keeping a dead
     * one's pipes read the same from outside. On Windows Playwright starts
     * Electron through a shell: the leader is cmd.exe and the main process
     * its child. Read this before force(): afterwards all are gone. */
    evidence() {
      if (!pid) return { report: 'leader: never started', mainPid: null }
      const rows = processCommands()
      const owned = new Set(ownedPids(processRows()))
      const family = [pid]
      for (let i = 0; i < family.length; i++) {
        for (const row of rows) if (row.ppid === family[i] && row.pid !== process.pid && !family.includes(row.pid)) family.push(row.pid)
      }
      // The leader's own exit, apart from 'close': that one also waits for the pipes.
      const running = child.exitCode === null && child.signalCode === null
      const state = running ? 'still running' : `exited (${child.signalCode ?? `code ${child.exitCode}`}), its stdio ${closed ? 'closed' : 'still open'}`
      const shell = process.platform === 'win32' && /(^|[\\/"])cmd(\.exe)?(["\s]|$)/i.test(rows.find(row => row.pid === pid)?.command ?? '')
      const main = shell ? rows.find(row => row.ppid === pid && !/\bconhost(\.exe)?\b/i.test(row.command))?.pid ?? null : pid
      const lines = shell
        ? [`shell ${pid}: ${state}`, main ? `main process ${main}: still running` : 'main process: gone']
        : [`main process ${pid}: ${state}`]
      const left = rows.filter(row => row.pid !== pid && row.pid !== main && (owned.has(row.pid) || family.includes(row.pid)))
      for (const row of left) lines.push(`  left ${row.pid} (parent ${row.ppid}): ${brief(row.command)}`)
      if (left.length === 0) lines.push('  left: no other process')
      return { report: lines.join('\n'), mainPid: shell ? main : running ? pid : null }
    },
    force() {
      if (!pid || closed) return
      if (process.platform === 'win32') {
        // No SIGTERM on Windows: taskkill /F is the only stop there.
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
        return
      }
      stopFfmpeg()
      if (isolated) killOwnedGroup()
      else {
        for (const candidate of ownedPids(processRows()).reverse()) {
          try { process.kill(candidate, 'SIGKILL') } catch { /* Already gone. */ }
        }
      }
    },
  }
}

/** A failed graceful quit must fail the test and release Playwright's stdio,
 * rather than strand worker teardown until CI kills the entire job.
 *
 * LANDMINE: the limit has to stay well above 10 s. After `quit` Chromium
 * itself waits on its GPU and network-service processes, the latter for up to
 * 10 s, and several apps closing at once on one GPU take that long to leave. */
export const CLOSE_LIMIT_MS = 30_000

export async function closeProcessTree(owner, gracefulClose, timeoutMs = CLOSE_LIMIT_MS) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(gracefulClose),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Electron graceful close timed out; terminated its test-owned process tree')), timeoutMs)
      }),
    ])
  } catch (error) {
    // Evidence is a courtesy: a failure to gather it never replaces the error.
    try {
      const { report, mainPid } = owner.evidence()
      if (error instanceof Error) error.message += `\n${report}`
      await runHangCommand(mainPid)
    } catch { /* The kill below still runs. */ }
    owner.force()
    let reapTimer
    try {
      await Promise.race([owner.reaped, new Promise(resolve => { reapTimer = setTimeout(resolve, 3000) })])
    } finally { clearTimeout(reapTimer) }
    throw error
  } finally { clearTimeout(timer) }
}
