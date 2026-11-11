import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosave, autosaveMaxWaitMs, BACKUPS_DIR, type AutosaveFs, type AutosaveDeps, type AutosaveSaveState } from '../autosave'
import { AUTOSAVE_INTERVAL_DEFAULT_SECS, AUTOSAVE_INTERVAL_MAX_SECS, AUTOSAVE_INTERVAL_MIN_SECS } from '../../../shared/save-status'
import { createActor, type ActorHandle, type ChangeEvent } from '../actor'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { blankProject, type Project } from '../model'
import { seededGen } from '../ids'
import { EDIT_TRACE_PREFIX, runEditTrace } from '../../../shared/editTrace'
import { ATOMIC_TEMP_SUFFIX, writeFileAtomic } from '../../atomicWrite'
import { errno, memAtomicIo, type MemAtomicIo } from './fixtures/memAtomicIo'

/** In-memory fs: files map + dirs set, with copyFile/readdir for Backups. */
function memFs(): AutosaveFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files, dirs,
    writeFile: (p, t) => { files.set(p, t) },
    exists: (p) => files.has(p) || dirs.has(p),
    copyFile: (s, d) => { const t = files.get(s); if (t === undefined) throw new Error(`ENOENT ${s}`); files.set(d, t) },
    mkdirp: (d) => { dirs.add(d) },
    readdir: (d) => [...files.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1)),
    rm: (p) => { files.delete(p) },
  }
}

const posixJoin = (...p: string[]) => p.join('/')

function setup(over: Partial<AutosaveDeps> = {}) {
  const fs = (over.fs as ReturnType<typeof memFs>) ?? memFs()
  const idGen = seededGen()
  const actor: ActorHandle = createActor({ initial: blankProject(idGen, 'auto'), idGen })
  const deps: AutosaveDeps = {
    actor, fs, workspaceDir: () => '/ws', join: posixJoin, serialize: serializeProjectToJson,
    now: () => new Date('2026-06-23T12:00:00.000Z'), ...over,
  }
  return { fs, actor, deps, ctl: createAutosave(deps) }
}

describe('autosave forceFlush', () => {
  it('writes project.json and a Backups snapshot', async () => {
    const { fs, ctl } = setup()
    ctl.start()
    await ctl.forceFlush()
    ctl.stop()
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)
    // a snapshot landed in Backups/ with the colon-free timestamp form.
    const backups = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toBe(`/ws/${BACKUPS_DIR}/20260623T120000000Z.json`)
  })

  it('is a no-op when no workspace is set', async () => {
    const { fs, ctl } = setup({ workspaceDir: () => null })
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    expect(fs.files.size).toBe(0)
  })
})

describe('autosave debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('attributes separate serialization and write costs to the latest traced commit', async () => {
    let tick = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fs = memFs()
    const write = fs.writeFile
    fs.writeFile = (path, text) => { tick += 23; write(path, text) }
    const { actor, ctl } = setup({ fs, serialize: p => { tick += 17; return serializeProjectToJson(p) } })
    ctl.start()
    try {
      runEditTrace('first', 'test', () => actor.dispatch('add_track', {}))
      runEditTrace('latest', 'test', () => actor.dispatch('add_track', {}))
      log.mockClear()
      tick += 500
      await vi.advanceTimersByTimeAsync(500)
      const rows = log.mock.calls.map(([line]) => JSON.parse(String(line).slice(EDIT_TRACE_PREFIX.length + 1)))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ traceId: 'latest', phase: 'main.autosave', timerLateMs: 0,
        spans: [{ stage: 'serialize', durationMs: 17 }, { stage: 'write_file', durationMs: 23 }] })
      expect(fs.files.has('/ws/project.json')).toBe(true)
      // An unrelated edit must not inherit the preceding gesture's ID.
      actor.dispatch('add_track', {})
      log.mockClear()
      await vi.advanceTimersByTimeAsync(500)
      expect(log).not.toHaveBeenCalled()
    } finally { ctl.stop(); log.mockRestore(); clock.mockRestore() }
  })

  it('coalesces a flurry of commits into ONE write after 500ms quiet', async () => {
    const { fs, actor, ctl } = setup()
    ctl.start()
    for (let i = 0; i < 5; i++) actor.dispatch('add_track', {})  // 5 commits in quick succession
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(false)       // nothing written yet (debouncing)
    await vi.advanceTimersByTimeAsync(500)
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)        // exactly one write after quiet
    ctl.stop()
  })
})

describe('Backups gc + snapshot interval', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('caps retained snapshots at 20 (oldest dropped)', async () => {
    const fs = memFs()
    // 25 pre-existing snapshots with sortable names.
    for (let i = 0; i < 25; i++) fs.files.set(`/ws/${BACKUPS_DIR}/200001${String(i).padStart(2, '0')}T000000000Z.json`, '{}')
    fs.files.set(`/ws/${PROJECT_FILE}`, '{}')
    // step `now` forward so each forceFlush mints a distinct backup name.
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { ctl } = setup({ fs, now: () => new Date((t += 1000)) })
    // 25 pre-seeded + 1 minted by forceFlush = 26 total → gc keeps the newest 20.
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    const remaining = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`) && k.endsWith('.json'))
    expect(remaining).toHaveLength(20)
  })

  it('debounced writes snapshot only every 50 commits or 5 minutes', async () => {
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { fs, actor, ctl } = setup({ now: () => new Date(t) })
    ctl.start()
    // one debounced write at t0 → no snapshot (last_snapshot_at starts now → 0 elapsed and
    // commits_since=1 < 50, so neither the 50-commit nor the 5-minute trigger fires). Assert no backup yet.
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(false)
    // advance wall clock past 5 min, one more debounced write → snapshot fires.
    t += 5 * 60_000 + 1
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(true)
    ctl.stop()
  })
})

/** AutosaveFs whose writeFile is the production atomic write over an in-memory
 *  io, so a test can fail one step of it. */
function atomicMemFs(io: MemAtomicIo): AutosaveFs {
  const { files } = io
  return {
    writeFile: (p, t) => writeFileAtomic(io, p, t),
    exists: (p) => files.has(p),
    copyFile: (s, d) => { const t = files.get(s); if (t === undefined) throw new Error(`ENOENT ${s}`); files.set(d, t) },
    mkdirp: () => {},
    readdir: (d) => [...files.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1)),
    rm: (p) => { files.delete(p) },
  }
}

describe('autosave write failures', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const target = `/ws/${PROJECT_FILE}`
  const GOOD = '{"previous":"good"}'
  const debounceMs = 500

  it.each(['open', 'write', 'fsync', 'close', 'rename'] as const)(
    'a write failing at %s keeps the last good project.json and saves the edit on a later cycle',
    async (step) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const io = memAtomicIo(new Map([[target, GOOD]]))
      const { actor, ctl } = setup({ fs: atomicMemFs(io), debounceMs })
      ctl.start()
      try {
        io.fail(step, errno('ENOSPC'), 1)
        actor.dispatch('add_track', {})
        // A throw out of the timer callback would surface here.
        await vi.advanceTimersByTimeAsync(debounceMs)
        expect(io.files.get(target)).toBe(GOOD)
        expect(io.files.has(target + ATOMIC_TEMP_SUFFIX)).toBe(false)
        expect(warn).toHaveBeenCalled()
        // No further edit: the retry comes from autosave itself, within the interval.
        await vi.advanceTimersByTimeAsync(autosaveMaxWaitMs(actor.snapshot().settings))
        expect(io.files.get(target)).toBe(serializeProjectToJson(actor.snapshot()))
        expect(io.files.has(target + ATOMIC_TEMP_SUFFIX)).toBe(false)
      } finally { ctl.stop(); warn.mockRestore() }
    },
  )

  it('an explicit save that fails rejects to its caller, keeps project.json, and the edit is saved later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const io = memAtomicIo(new Map([[target, GOOD]]))
    const { actor, ctl } = setup({ fs: atomicMemFs(io) })
    ctl.start()
    try {
      actor.dispatch('add_track', {})
      const failure = errno('EACCES')
      io.fail('rename', failure)
      await expect(ctl.forceFlush()).rejects.toBe(failure)
      expect(io.files.get(target)).toBe(GOOD)
      expect(io.files.has(target + ATOMIC_TEMP_SUFFIX)).toBe(false)
      io.heal()
      await vi.advanceTimersByTimeAsync(autosaveMaxWaitMs(actor.snapshot().settings))
      expect(io.files.get(target)).toBe(serializeProjectToJson(actor.snapshot()))
    } finally { ctl.stop(); warn.mockRestore() }
  })
})

/** An actor stand-in whose edits cost nothing, so a test can stream thousands. */
function streamingActor(autosaveIntervalSecs: unknown) {
  const base = blankProject(seededGen(), 'stream')
  const project: Project = { ...base, settings: { ...base.settings, autosave_interval_secs: autosaveIntervalSecs as number | null } }
  let listener: ((e: ChangeEvent) => void) | null = null
  let revision = 0
  const edits: number[] = []
  return {
    edits,
    revision: () => revision,
    actor: {
      subscribe: (cb: (e: ChangeEvent) => void) => { listener = cb; return () => { listener = null } },
      snapshot: () => project,
    },
    edit: () => { revision += 1; edits.push(Date.now()); listener?.({} as ChangeEvent) },
  }
}

function streamingSetup(autosaveIntervalSecs: unknown) {
  const stream = streamingActor(autosaveIntervalSecs)
  const writes: { at: number; revision: number }[] = []
  const debounceMs = 500
  const ctl = createAutosave({
    actor: stream.actor,
    fs: { ...memFs(), writeFile: () => { writes.push({ at: Date.now(), revision: stream.revision() }) } },
    workspaceDir: () => '/ws', join: posixJoin, serialize: () => '{}', debounceMs,
  })
  const maxWaitMs = autosaveMaxWaitMs(stream.actor.snapshot().settings)
  // Faster than the quiet window, so only the interval can force a write.
  const editEveryMs = debounceMs / 5
  const editFor = async (ms: number) => {
    for (let t = 0; t < ms; t += editEveryMs) { stream.edit(); await vi.advanceTimersByTimeAsync(editEveryMs) }
  }
  return { ...stream, ctl, writes, debounceMs, maxWaitMs, editEveryMs, editFor }
}

describe('autosave under continuous edits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes within the interval of the first unsaved edit, and again within each interval after', async () => {
    const s = streamingSetup(AUTOSAVE_INTERVAL_MIN_SECS)
    s.ctl.start()
    try {
      await s.editFor(s.maxWaitMs * 3.5)
      expect(s.writes.length).toBeGreaterThanOrEqual(3)
      let windowOpenedAt = s.edits[0]
      for (const write of s.writes) {
        expect(write.at, 'write later than the interval allows').toBeLessThanOrEqual(windowOpenedAt + s.maxWaitMs)
        // The next window opens at the first edit the write did not include.
        windowOpenedAt = s.edits[write.revision]
      }
    } finally { s.ctl.stop() }
  })

  it('still writes after the quiet window once the edits stop', async () => {
    const s = streamingSetup(AUTOSAVE_INTERVAL_MIN_SECS)
    s.ctl.start()
    try {
      await s.editFor(s.maxWaitMs / 2)
      const lastEdit = s.edits.at(-1)!
      await vi.advanceTimersByTimeAsync(s.debounceMs)
      expect(s.writes).toEqual([{ at: lastEdit + s.debounceMs, revision: s.revision() }])
    } finally { s.ctl.stop() }
  })

  it('an explicit save opens a new interval instead of keeping the old deadline', async () => {
    const s = streamingSetup(AUTOSAVE_INTERVAL_MIN_SECS)
    s.ctl.start()
    try {
      await s.editFor(s.maxWaitMs / 2)
      await s.ctl.forceFlush()
      const flushed = s.writes.length
      await s.editFor(s.maxWaitMs * 1.5)
      const firstEditAfter = s.edits[s.writes[flushed - 1].revision]
      const timerWrites = s.writes.slice(flushed)
      expect(timerWrites.length).toBeGreaterThan(0)
      expect(timerWrites[0].at, 'the pre-flush deadline still fired').toBeGreaterThanOrEqual(firstEditAfter + s.maxWaitMs)
      expect(timerWrites[0].at).toBeLessThanOrEqual(firstEditAfter + s.maxWaitMs)
    } finally { s.ctl.stop() }
  })

  it.each([AUTOSAVE_INTERVAL_MIN_SECS, AUTOSAVE_INTERVAL_MIN_SECS * 2, null])(
    'honours autosave_interval_secs = %s as the bound, not a shorter one',
    async (secs) => {
      const s = streamingSetup(secs)
      s.ctl.start()
      try {
        await s.editFor(s.maxWaitMs + s.editEveryMs * 2)
        expect(s.writes.length).toBeGreaterThan(0)
        expect(s.writes[0].at).toBeGreaterThanOrEqual(s.edits[0] + s.maxWaitMs)
        expect(s.writes[0].at).toBeLessThanOrEqual(s.edits[0] + s.maxWaitMs)
      } finally { s.ctl.stop() }
    },
  )
})

describe('autosaveMaxWaitMs', () => {
  const ms = (secs: unknown) => autosaveMaxWaitMs({ autosave_interval_secs: secs as number | null })

  it('takes an in-range interval as written', () => {
    const inRange = Math.round((AUTOSAVE_INTERVAL_MIN_SECS + AUTOSAVE_INTERVAL_MAX_SECS) / 2)
    expect(ms(inRange)).toBe(inRange * 1000)
  })

  it.each([null, undefined, NaN, Infinity, -Infinity, 0, -30, '30', {}])('falls back to the default for %s', (value) => {
    expect(ms(value)).toBe(AUTOSAVE_INTERVAL_DEFAULT_SECS * 1000)
  })

  it('clamps an interval outside the allowed range', () => {
    expect(ms(AUTOSAVE_INTERVAL_MIN_SECS / 10)).toBe(AUTOSAVE_INTERVAL_MIN_SECS * 1000)
    expect(ms(AUTOSAVE_INTERVAL_MAX_SECS * 10)).toBe(AUTOSAVE_INTERVAL_MAX_SECS * 1000)
  })
})

describe('autosave save state', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Every write fails with `code` until `heal`; the clock is the fake one, so
   *  report and attempt times share it. */
  function failingSetup(code = 'ENOSPC') {
    const fs = memFs()
    const write = fs.writeFile
    let failure: string | null = code
    const attempts: { at: number; ok: boolean }[] = []
    fs.writeFile = (p, t) => {
      attempts.push({ at: Date.now(), ok: failure === null })
      if (failure !== null) throw errno(failure)
      write(p, t)
    }
    const reports: { at: number; state: AutosaveSaveState }[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = setup({ fs, now: () => new Date(), onSaveState: (state) => reports.push({ at: Date.now(), state }) })
    const maxWaitMs = autosaveMaxWaitMs(s.actor.snapshot().settings)
    return {
      ...s, attempts, reports, maxWaitMs,
      fail: (next: string) => { failure = next },
      heal: () => { failure = null },
      done: () => { s.ctl.stop(); warn.mockRestore() },
    }
  }

  it('reports failing at the first failed attempt once the edits have waited the interval, and only once', async () => {
    const s = failingSetup()
    s.ctl.start()
    try {
      const editAt = Date.now()
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 3)
      const failedEarly = s.attempts.filter((a) => a.at - editAt < s.maxWaitMs)
      const overdue = s.attempts.filter((a) => a.at - editAt >= s.maxWaitMs)
      expect(failedEarly.length, 'an attempt inside the interval failed too').toBeGreaterThan(0)
      expect(overdue.length, 'autosave kept retrying past the interval').toBeGreaterThan(1)
      expect(s.reports).toHaveLength(1)
      expect(s.reports[0].at).toBe(overdue[0].at)
      expect(s.reports[0].state).toEqual({
        kind: 'failing', since: new Date(editAt), lastSavedAt: null, code: 'ENOSPC', path: `/ws/${PROJECT_FILE}`, dir: '/ws',
      })
    } finally { s.done() }
  })

  it('says nothing about a failure that a later cycle fixes', async () => {
    const s = failingSetup()
    s.ctl.start()
    try {
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs / 2)
      expect(s.attempts.some((a) => !a.ok)).toBe(true)
      s.heal()
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
      expect(s.attempts.at(-1)?.ok).toBe(true)
      expect(s.reports).toEqual([])
    } finally { s.done() }
  })

  it('a failure fixed at the interval itself says nothing either', async () => {
    const s = failingSetup()
    s.ctl.start()
    try {
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs / 2)
      s.heal()
      await vi.advanceTimersByTimeAsync(s.maxWaitMs)
      expect(s.attempts.at(-1)).toMatchObject({ ok: true })
      expect(s.reports).toEqual([])
    } finally { s.done() }
  })

  it('carries the last successful write, and reports a changed reason', async () => {
    const s = failingSetup()
    s.heal()
    s.ctl.start()
    try {
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs / 10)
      const savedAt = s.attempts.at(-1)!
      expect(savedAt.ok).toBe(true)
      s.fail('EACCES')
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
      expect(s.reports.map((r) => r.state)).toEqual([expect.objectContaining({ kind: 'failing', code: 'EACCES', lastSavedAt: new Date(savedAt.at) })])
      s.fail('EROFS')
      await expect(s.ctl.forceFlush()).rejects.toMatchObject({ code: 'EROFS' })
      expect(s.reports.map((r) => r.state)).toEqual([
        expect.objectContaining({ code: 'EACCES' }),
        expect.objectContaining({ kind: 'failing', code: 'EROFS', lastSavedAt: new Date(savedAt.at) }),
      ])
    } finally { s.done() }
  })

  it('recovers with the next successful write, timer or explicit', async () => {
    for (const recover of ['timer', 'explicit'] as const) {
      const s = failingSetup()
      s.ctl.start()
      try {
        s.actor.dispatch('add_track', {})
        await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
        expect(s.reports.map((r) => r.state.kind)).toEqual(['failing'])
        s.heal()
        if (recover === 'timer') await vi.advanceTimersByTimeAsync(s.maxWaitMs)
        else await s.ctl.forceFlush()
        expect(s.reports.map((r) => r.state), recover).toEqual([expect.objectContaining({ kind: 'failing' }), { kind: 'ok', cause: 'saved' }])
        expect(s.ctl.unsaved()).toBe(false)
      } finally { s.done() }
    }
  })

  it('a new project withdraws the failing state and starts its own interval', async () => {
    const s = failingSetup()
    s.ctl.start()
    try {
      s.actor.dispatch('add_track', {})
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
      expect(s.reports.map((r) => r.state.kind)).toEqual(['failing'])
      const switchedAt = Date.now()
      s.ctl.beginProject()
      expect(s.reports.at(-1)!.state).toEqual({ kind: 'ok', cause: 'reset' })
      // Still failing in the new folder: told again, but only after its own interval.
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
      const again = s.reports.slice(2)
      expect(again.map((r) => r.state)).toEqual([expect.objectContaining({ kind: 'failing', since: new Date(switchedAt), lastSavedAt: null })])
      expect(again[0].at - switchedAt).toBeGreaterThanOrEqual(s.maxWaitMs)
    } finally { s.done() }
  })

  it('nothing unsaved is nothing to report, even when an explicit save fails', async () => {
    const s = failingSetup()
    s.ctl.start()
    try {
      await vi.advanceTimersByTimeAsync(s.maxWaitMs * 2)
      await expect(s.ctl.forceFlush()).rejects.toMatchObject({ code: 'ENOSPC' })
      expect(s.ctl.unsaved()).toBe(false)
      expect(s.reports).toEqual([])
    } finally { s.done() }
  })
})
