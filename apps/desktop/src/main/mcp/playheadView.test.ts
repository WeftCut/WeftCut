// The playhead read's two halves in main: the round trip to the editor
// (`PlayheadReader`) and the record built from its answer (`playheadView`).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EditorNotReadyError, PlayheadReader, playheadView } from './playheadView'
import { groupedProject, root } from '../state/__tests__/fixtures/project'
import type { EditorPlayheadReport, PlayheadReadMessage } from '../../shared/editorPlayhead'

function report(over: Partial<EditorPlayheadReport> & Pick<EditorPlayheadReport, 'root_id' | 'composition_id'>): EditorPlayheadReport {
  return { t_us: 500_000, timecode: '00:00:00:15', playing: false, range: null, selection: [], ...over }
}

afterEach(() => { vi.useRealTimers() })

describe('PlayheadReader', () => {
  it('asks the editor once per read and resolves with its answer', async () => {
    const asked: PlayheadReadMessage[] = []
    const reader = new PlayheadReader({ ask: (m) => { asked.push(m); return true } })
    expect(asked).toEqual([])
    const read = reader.read()
    expect(asked).toHaveLength(1)
    const answer = report({ root_id: 'r', composition_id: 'r' })
    reader.answer({ request_id: asked[0]!.request_id, report: answer })
    await expect(read).resolves.toEqual(answer)
  })

  it('refuses at once when there is no editor window to ask', async () => {
    const reader = new PlayheadReader({ ask: () => false })
    await expect(reader.read()).rejects.toBeInstanceOf(EditorNotReadyError)
  })

  it("passes the editor's own reason through when it has no report", async () => {
    let id = ''
    const reader = new PlayheadReader({ ask: (m) => { id = m.request_id; return true } })
    const read = reader.read()
    reader.answer({ request_id: id, error: 'not loaded yet' })
    await expect(read).rejects.toThrow('not loaded yet')
  })

  it('refuses a read the editor never answers, and drops the late answer', async () => {
    vi.useFakeTimers()
    let id = ''
    const reader = new PlayheadReader({ ask: (m) => { id = m.request_id; return true }, timeoutMs: 50 })
    const read = reader.read()
    const settled = expect(read).rejects.toBeInstanceOf(EditorNotReadyError)
    vi.advanceTimersByTime(50)
    await settled
    expect(() => reader.answer({ request_id: id, report: report({ root_id: 'r', composition_id: 'r' }) })).not.toThrow()
  })

  it('answers each read with its own request', async () => {
    const ids: string[] = []
    const reader = new PlayheadReader({ ask: (m) => { ids.push(m.request_id); return true } })
    const first = reader.read(), second = reader.read()
    reader.answer({ request_id: ids[1]!, report: report({ root_id: 'r', composition_id: 'r', t_us: 2 }) })
    reader.answer({ request_id: ids[0]!, report: report({ root_id: 'r', composition_id: 'r', t_us: 1 }) })
    expect((await first).t_us).toBe(1)
    expect((await second).t_us).toBe(2)
  })

  it('rejects a malformed answer instead of resolving a read with it', () => {
    const reader = new PlayheadReader({ ask: () => true })
    expect(() => reader.answer({ request_id: 'x', report: { t_us: 'soon' } })).toThrow()
  })
})

describe('playheadView', () => {
  it("lists the layers the playhead is over in the editor's composition, as track envelopes", () => {
    const { p, groupId, refLayerId, innerId, innerTrackId } = groupedProject()
    const inRoot = playheadView(p, report({ root_id: p.root_id, composition_id: p.root_id, selection: [refLayerId] }))
    const refTrack = root(p).tracks.find((t) => t.layers.some((l) => l.id === refLayerId))!
    expect(inRoot).toMatchObject({ composition_id: p.root_id, t_us: 500_000, timecode: '00:00:00:15', playing: false, range: null, selection: [refLayerId] })
    expect(inRoot.under_playhead).toEqual([expect.objectContaining({ track_id: refTrack.id, layer_id: refLayerId, kind: 'CompositionRef', composition_id: groupId, t_start_us: 0, t_end_us: 1_000_000 })])

    const inGroup = playheadView(p, report({ root_id: p.root_id, composition_id: groupId, range: { t_start_us: 0, t_end_us: 250_000 } }))
    expect(inGroup).toMatchObject({ composition_id: groupId, range: { t_start_us: 0, t_end_us: 250_000 } })
    expect(inGroup.under_playhead).toEqual([expect.objectContaining({ track_id: innerTrackId, layer_id: innerId, kind: 'Color' })])
  })

  it('takes a span as half-open: nothing is under the playhead at its end', () => {
    const { p, groupId } = groupedProject()
    expect(playheadView(p, report({ root_id: p.root_id, composition_id: groupId, t_us: 1_000_000 })).under_playhead).toEqual([])
  })

  it('refuses an answer about another project or a composition it no longer holds', () => {
    const { p } = groupedProject()
    expect(() => playheadView(p, report({ root_id: 'another', composition_id: p.root_id }))).toThrow(EditorNotReadyError)
    expect(() => playheadView(p, report({ root_id: p.root_id, composition_id: 'gone' }))).toThrow(EditorNotReadyError)
  })
})
