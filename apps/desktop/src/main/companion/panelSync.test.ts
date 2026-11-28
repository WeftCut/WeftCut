// `side_preview_sync`'s ops: each is the hub's answer to the route a page
// would fetch, and an outcome the view acts on is an answer, not an error.
import { describe, expect, it, vi } from 'vitest'
import { PanelSyncArgError, runPanelSync } from './panelSync'

function hub() {
  return {
    state: vi.fn(() => ({ project: null })),
    poll: vi.fn(async (since: number | undefined, stream: string | undefined) => ({ stream: stream ?? 's', seq: since ?? 0, events: [] })),
    control: vi.fn((body: unknown) => ((body as { action?: unknown }).action === 'play' ? 'not_ready' as const : 'invalid' as const)),
    signal: vi.fn(async () => ({ outcome: 'not_ready' as const })),
  }
}

describe('runPanelSync', () => {
  it('answers each op with what the hub says', async () => {
    const h = hub()
    expect(await runPanelSync(h as never, { op: 'state' })).toEqual({ project: null })
    expect(await runPanelSync(h as never, { op: 'events', since: 3, stream: 'abc' })).toEqual({ stream: 'abc', seq: 3, events: [] })
    expect(h.poll).toHaveBeenLastCalledWith(3, 'abc')
    expect(await runPanelSync(h as never, { op: 'events' })).toMatchObject({ seq: 0 })
    expect(h.poll).toHaveBeenLastCalledWith(undefined, undefined)
    expect(await runPanelSync(h as never, { op: 'control', action: 'play' })).toEqual({ outcome: 'not_ready' })
    expect(await runPanelSync(h as never, { op: 'control', action: 'seek', t_us: 'soon' })).toEqual({ outcome: 'invalid' })
    expect(h.control).toHaveBeenLastCalledWith({ action: 'seek', t_us: 'soon' })
    expect(await runPanelSync(h as never, { op: 'signal', offer: 'v=0' })).toEqual({ outcome: 'not_ready' })
  })

  it('refuses an op the view never sends, and a place in the stream that is none', async () => {
    const h = hub()
    await expect(runPanelSync(h as never, { op: 'delete' })).rejects.toBeInstanceOf(PanelSyncArgError)
    await expect(runPanelSync(h as never, {})).rejects.toBeInstanceOf(PanelSyncArgError)
    for (const since of [-1, 1.5, 'x']) {
      await expect(runPanelSync(h as never, { op: 'events', since }), String(since)).rejects.toBeInstanceOf(PanelSyncArgError)
    }
  })
})
