import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEBOUNCE_QUIET_MS, Debouncer, spawnMotifWatcher } from './watcher'

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
