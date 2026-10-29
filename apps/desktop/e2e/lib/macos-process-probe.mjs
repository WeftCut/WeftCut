// Temporary CI diagnosis: observe the test-owned Electron tree from the worker,
// so an unresponsive Electron main thread cannot block collection.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export function startMacProcessProbe(child, directory) {
  if (process.platform !== 'darwin') return
  fs.mkdirSync(directory, { recursive: true })
  let closed = false, pending = false, dumps = 0, bytes = 0
  const started = Date.now()
  const append = (name, value) => {
    try { fs.appendFileSync(path.join(directory, name), value) } catch {}
  }
  const stderr = data => {
    if (bytes >= 2 * 1024 * 1024) return
    bytes += data.length
    append('electron-stderr.log', data)
  }
  child.stderr?.on('data', stderr)
  const collect = async () => {
    if (closed || pending) return
    pending = true
    try {
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,stat=,%cpu=,rss=,etime=,command='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })
      const rows = stdout.trim().split('\n').map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
        return match && { pid: Number(match[1]), parent: Number(match[2]), line: line.trim() }
      }).filter(Boolean)
      const owned = new Set([child.pid])
      for (let changed = true; changed;) {
        changed = false
        for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
      }
      const tree = rows.filter(row => owned.has(row.pid))
      append('process-tree.log', `\n${new Date().toISOString()}\n${tree.map(row => row.line).join('\n')}\n`)
      // Two bounded samples catch both preparation and the subsequent stall.
      if (!closed && dumps < 2 && Date.now() - started >= (dumps === 0 ? 12_000 : 40_000)) {
        const round = ++dumps
        const targets = tree.filter(row => row.pid === child.pid || /ffmpeg|ffprobe/.test(row.line)).slice(0, 5)
        await Promise.all(targets.map(async row => {
          try {
            await exec('/usr/bin/sample', [String(row.pid), '1', '1', '-file', path.join(directory, `sample-${round}-${row.pid}.txt`)], { timeout: 8000, maxBuffer: 1024 * 1024 })
          } catch (error) { append('probe-errors.log', `${String(error)}\n`) }
        }))
      }
    } catch (error) { append('probe-errors.log', `${String(error)}\n`) }
    finally { pending = false }
  }
  const timer = setInterval(() => void collect(), 3000)
  timer.unref()
  void collect()
  child.once('close', () => { closed = true; clearInterval(timer); child.stderr?.off('data', stderr) })
}
