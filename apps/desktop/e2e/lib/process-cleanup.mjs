import { spawnSync } from 'node:child_process'

function processGroup(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
  const group = Number(result.stdout?.trim())
  return result.status === 0 && Number.isSafeInteger(group) && group > 0 ? group : null
}

/** Capture ownership while the leader is alive. Electron is detached on POSIX;
 * its isolated group survives leader exit while children still hold pipes. */
export function ownProcessTree(child) {
  const pid = child.pid
  const group = process.platform === 'win32' || !pid ? null : processGroup(pid)
  const workerGroup = process.platform === 'win32' ? null : processGroup(process.pid)
  const isolated = group === pid && workerGroup !== null && group !== workerGroup
  let closed = false
  const killOwnedGroup = () => {
    if (!isolated || workerGroup === group) return
    // After close the leader is gone. If its PID has already been reused,
    // ownership no longer follows from that number; leave the new process alone.
    if (closed && processGroup(pid) !== null) return
    try { process.kill(-group, 'SIGKILL') } catch { /* Already gone. */ }
  }
  const reaped = new Promise(resolve => {
    child.once('close', () => {
      closed = true
      // Native FFmpeg children have separate stdio. They do not delay 'close'
      // but can still run after Electron exits, contaminating the next test.
      killOwnedGroup()
      resolve()
    })
  })
  return {
    reaped,
    force() {
      if (!pid || closed) return
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
      } else if (isolated && workerGroup !== group) {
        // Only the group verified to belong to this child; never our worker's.
        killOwnedGroup()
      } else {
        // Non-detached callers: enumerate only descendants of our live child.
        const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
        const rows = (result.stdout ?? '').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
        const descendants = [pid]
        for (let i = 0; i < descendants.length; i++) {
          for (const [candidate, parent] of rows) if (parent === descendants[i] && candidate !== process.pid && !descendants.includes(candidate)) descendants.push(candidate)
        }
        for (const candidate of descendants.reverse()) {
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
