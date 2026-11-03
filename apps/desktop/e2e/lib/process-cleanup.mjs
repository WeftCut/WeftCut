import { spawnSync } from 'node:child_process'

const FFMPEG_NAMES = new Set(['ffmpeg', 'ffprobe'])
const FFMPEG_GRACE_MS = 2000
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

/** Capture ownership while the leader is alive. Electron is detached on POSIX;
 * its isolated group survives leader exit while children still hold pipes. */
export function ownProcessTree(child) {
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
    for (const deadline = Date.now() + FFMPEG_GRACE_MS; ffmpeg.length > 0 && Date.now() < deadline; ffmpeg = live()) Atomics.wait(pause, 0, 0, 50)
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
 * rather than strand worker teardown until CI kills the entire job. */
export async function closeProcessTree(owner, gracefulClose, timeoutMs = 10_000) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(gracefulClose),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Electron graceful close timed out; terminated its test-owned process tree')), timeoutMs)
      }),
    ])
  } catch (error) {
    owner.force()
    let reapTimer
    try {
      await Promise.race([owner.reaped, new Promise(resolve => { reapTimer = setTimeout(resolve, 3000) })])
    } finally { clearTimeout(reapTimer) }
    throw error
  } finally { clearTimeout(timer) }
}
