import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Debouncer, spawnMotifWatcher } from './watcher'

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

// Drive the real OS watch at `root`: attach, write a file under it, wait for
// the debounced onChange. `root` is passed through verbatim so each case below
// controls exactly how the directory is spelled.
async function expectFiresOnWrite(root: string): Promise<void> {
  const fired = vi.fn()
  const w = spawnMotifWatcher(root, fired)
  try {
    await new Promise((r) => setTimeout(r, 200)) // let the OS watch attach
    mkdirSync(path.join(root, 'm1'), { recursive: true })
    writeFileSync(path.join(root, 'm1', 'index.html'), '<html>')
    const deadline = Date.now() + 5000
    while (fired.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(fired.mock.calls.length).toBeGreaterThanOrEqual(1)
  } finally {
    w.close()
  }
}

describe('spawnMotifWatcher', () => {
  it('fires onChange on a real file write under the root', async () => {
    await expectFiresOnWrite(mkdtempSync(path.join(tmpdir(), 'motifwatch-')))
  })

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
  })
})
