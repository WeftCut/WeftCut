import { describe, expect, it, vi } from 'vitest'
import { ImportDiagnostics } from './importDiagnostics'
import { mediaItemTemplate } from './state/mutations/media'
import type { ImportStageEvent } from '../shared/import-diagnostics'

function harness() {
  let ms = 0, id = 0
  const emit = vi.fn(), send = vi.fn()
  const diagnostics = new ImportDiagnostics({ emit, send, version: 'test', now: () => ms, id: () => `request-${++id}` })
  const stage = (importId: string, name: string, over: Partial<ImportStageEvent> = {}) => diagnostics.native('import:diagnostic', {
    import_id: importId, stage: name, status: 'completed', queue_ms: 30, work_ms: 70, total_ms: 100, cache: 'miss', ...over,
  })
  return { diagnostics, emit, send, stage, time: (n: number) => { ms = n },
    rows: (name: string) => emit.mock.calls.map(([row]) => row).filter(row => row.details.stage === name) }
}
describe('import diagnostics', () => {
  it('keeps concurrent same-source imports separate and preserves native queue/work durations', () => {
    const h = harness(), a = h.diagnostics.begin(), b = h.diagnostics.begin()
    a.bind(mediaItemTemplate('a', 'Video', 100), true)
    b.bind(mediaItemTemplate('b', 'Video', 100), true)
    h.time(1000)
    h.stage(a.id, 'probe')
    h.diagnostics.native('import:diagnostic', { media_id: 'b', stage: 'copy', status: 'completed', queue_ms: 600, work_ms: 200, total_ms: 800, cache: 'miss' })
    expect(h.rows('probe')[0].details).toMatchObject({ import_id: a.id, elapsed_ms: 1000, queue_ms: 30, work_ms: 70, app_version: 'test' })
    expect(h.rows('copy')[0].details).toMatchObject({ import_id: b.id, media_id: 'b', queue_ms: 600, work_ms: 200 })
  })
  it('waits for routing, copy and chained export work, independently of editability', () => {
    const h = harness(), trace = h.diagnostics.begin()
    trace.bind(mediaItemTemplate('m', 'Video', 100), true)
    trace.queued()
    h.stage(trace.id, 'probe'); h.stage(trace.id, 'hash')
    h.diagnostics.native('import:diagnostic-plan', { media_id: 'm', stages: ['thumbnails'], decision_pending: true })
    h.stage(trace.id, 'thumbnails', { cache: 'hit', queue_ms: 0, work_ms: 0 })
    h.stage(trace.id, 'copy')
    h.diagnostics.native('media:job_complete', { media_id: 'm', kind: 'thumbnails' })
    h.diagnostics.native('import:complete', { mediaId: 'm' })
    h.diagnostics.milestone({ import_id: trace.id, media_id: 'm', milestone: 'editable' })
    expect(h.rows('background_settled')).toHaveLength(0)
    h.diagnostics.native('import:diagnostic-plan', { media_id: 'm', stages: ['quick_proxy', 'proxy'], decision_pending: false })
    h.stage(trace.id, 'quick_proxy')
    h.diagnostics.native('media:job_complete', { media_id: 'm', kind: 'quick_proxy' })
    expect(h.rows('background_settled')).toHaveLength(0)
    h.stage(trace.id, 'proxy', { status: 'failed', error: 'encoder unavailable' })
    expect(h.rows('background_settled')).toHaveLength(0)
    h.diagnostics.native('media:job_error', { media_id: 'm', kind: 'proxy', error: 'encoder unavailable' })
    expect(h.rows('background_settled')).toHaveLength(1)
    expect(h.rows('background_settled')[0].details.status).toBe('incomplete')
    h.stage(trace.id, 'proxy')
    expect(h.rows('background_settled')).toHaveLength(1)
  })
  it('milestones are once per import and late events cannot cross a workspace reset', () => {
    const h = harness(), trace = h.diagnostics.begin()
    trace.bind(mediaItemTemplate('m', 'Video', 100), false)
    h.time(200)
    h.diagnostics.milestone({ import_id: trace.id, media_id: 'm', milestone: 'editable' })
    h.time(900)
    const frame = { import_id: trace.id, media_id: 'm', milestone: 'first_frame_submitted', engine: 'ffmpeg' }
    h.diagnostics.milestone(frame); h.diagnostics.milestone(frame)
    expect(h.rows('first_frame_submitted')).toHaveLength(1)
    expect(h.rows('first_frame_submitted')[0].details).toMatchObject({ engine: 'ffmpeg', since_editable_ms: 700 })
    h.diagnostics.reset()
    const next = h.diagnostics.begin()
    next.bind(mediaItemTemplate('m', 'Video', 100), false)
    h.diagnostics.milestone(frame)
    h.stage(trace.id, 'hash')
    expect(h.rows('first_frame_submitted')).toHaveLength(1)
    expect(h.rows('hash')).toHaveLength(0)
    expect(h.rows('tracking_ended')[0].details.background_completed).toBe(false)
  })
  it('keeps late native timing for failed requests and logging failures never escape', () => {
    const h = harness(), trace = h.diagnostics.begin()
    trace.fail(new Error('probe timeout'))
    h.stage(trace.id, 'probe', { status: 'failed' })
    expect(h.rows('request_failed')).toHaveLength(1)
    expect(h.rows('probe')).toHaveLength(1)
    const broken = new ImportDiagnostics({ emit: () => { throw Error('closed') }, send: () => { throw Error('closed') }, version: 'test' })
    expect(() => { const t = broken.begin(); t.bind(mediaItemTemplate('m', 'Audio', 100), false); t.fail('read error'); broken.reset() }).not.toThrow()
  })
})
