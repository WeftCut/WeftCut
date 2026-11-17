import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml } from '../../shared/motifs/catalog'
import { ProjectMotifStore, type MotifState } from './projectStore'
import { DEBOUNCE_QUIET_MS, Debouncer, spawnMotifWatcher, watchProjectMotifs } from './watcher'

describe('Debouncer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst into one fire, then fires again on a later burst', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    for (let i = 0; i < 5; i++) d.signal()
    expect(fired).not.toHaveBeenCalled()       // still inside the quiet window
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(1)      // burst coalesced to one
    d.signal()
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(2)      // a later burst fires again
  })

  it('cancel() suppresses a pending fire', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    d.signal()
    d.cancel()
    vi.advanceTimersByTime(60)
    expect(fired).not.toHaveBeenCalled()
  })
})

/** How long a real OS watch gets to report a write. */
const WATCH_REPORTS_MS = 20_000

// Drive the real OS watch at `root`: attach, write a file under it, wait for
// the debounced onChange. `root` is passed through verbatim so each case below
// controls exactly how the directory is spelled.
async function expectFiresOnWrite(root: string): Promise<void> {
  const fired = vi.fn()
  const w = spawnMotifWatcher(root, fired)
  try {
    mkdirSync(path.join(root, 'm1'), { recursive: true })
    // The OS watch attaches some time after the spawn, and a write before that
    // is never reported: write again until one is. The writes are further apart
    // than the debounce's quiet time, or they would hold it open.
    let writes = 0
    await vi.waitFor(() => {
      if (fired.mock.calls.length === 0) writeFileSync(path.join(root, 'm1', 'index.html'), `<html>${writes++}`)
      expect(fired).toHaveBeenCalled()
    }, { timeout: WATCH_REPORTS_MS, interval: 2 * DEBOUNCE_QUIET_MS })
  } finally {
    w.close()
  }
}

describe('spawnMotifWatcher', () => {
  it('fires onChange on a real file write under the root', async () => {
    await expectFiresOnWrite(mkdtempSync(path.join(tmpdir(), 'motifwatch-')))
  }, 2 * WATCH_REPORTS_MS)

  // An 8.3 short name is how GitHub's Windows runners spell os.tmpdir()
  // (C:\Users\RUNNER~1\...), and attaching the watch under that spelling trips a
  // libuv assertion that takes the whole process down — see spawnMotifWatcher.
  // On volumes with 8.3 generation disabled `%~sI` returns the long name, which
  // just collapses this case into the one above.
  it.runIf(process.platform === 'win32')('survives a root spelled as an 8.3 short name', async () => {
    const long = mkdtempSync(path.join(tmpdir(), 'motifwatch-long-name-for-8dot3-'))
    // Verbatim + `/s`: Node's own cmd.exe quoting would double the inner quotes.
    const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).stdout.trim()
    await expectFiresOnWrite(short)
  }, 2 * WATCH_REPORTS_MS)
})

describe('watchProjectMotifs', () => {
  const page = (id: string, n: number) => composeMotifHtml(
    { id, name: id, version: 1, size: [320, 180], default_duration_s: 2, props_schema: {} },
    `<html><head></head><body><script>motif.define({frame(t){ /* ${n} */ }})</script></body></html>`)
  const write = (project: ProjectMotifStore, id: string, n: number) => {
    mkdirSync(path.join(project.root(), id), { recursive: true })
    writeFileSync(path.join(project.root(), id, 'index.html'), page(id, n))
  }
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('tells only the Motif whose folder was edited, with its new revision', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'project-watch-'))
    const project = new ProjectMotifStore(dir)
    write(project, 'edited', 0)
    write(project, 'untouched', 0)
    const told: Array<[string, MotifState]> = []
    const w = watchProjectMotifs(project, (id, state) => told.push([id, state]))
    try {
      // Written until the attached watch reports one, each write a new revision.
      let writes = 1
      await vi.waitFor(() => {
        if (told.length === 0) write(project, 'edited', writes++)
        expect(told.length).toBeGreaterThan(0)
      }, { timeout: WATCH_REPORTS_MS, interval: 2 * DEBOUNCE_QUIET_MS })
      expect(told.map(([id]) => id).every(id => id === 'edited')).toBe(true)
      expect(told.at(-1)![1]).toEqual(project.status('edited'))
      expect(told.at(-1)![1].status).toBe('ok')
    } finally {
      w.close()
    }
  }, 2 * WATCH_REPORTS_MS)

  it('attaches when the project gains its Motifs folder', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'project-watch-'))
    const project = new ProjectMotifStore(dir)
    const told: string[] = []
    const w = watchProjectMotifs(project, id => told.push(id))
    try {
      let writes = 0
      await vi.waitFor(() => {
        if (told.length === 0) write(project, 'late', writes++)
        expect(told).toContain('late')
      }, { timeout: WATCH_REPORTS_MS, interval: 2 * DEBOUNCE_QUIET_MS })
    } finally {
      w.close()
    }
  }, 2 * WATCH_REPORTS_MS)
})
