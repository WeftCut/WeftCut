// The viewer a side-panel view polls: where a view starts, what it is told
// it missed, how long a poll is held, and how long it counts as watching.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_BUFFER_EVENTS, POLL_HOLD_MS, POLL_LEASE_MS, PolledViewer, type PollAnswer } from './polledViewer'

let sink: { send(name: string, data: unknown): void } | null
let watches: number
let closes: number

function viewer() {
  return new PolledViewer((v) => {
    sink = v as typeof sink
    watches++
    return () => { closes++; sink = null }
  })
}

/** Settles `p` if it is ready; null while it is still held. */
async function settled(p: Promise<PollAnswer>): Promise<PollAnswer | null> {
  let out: PollAnswer | null = null
  void p.then((a) => { out = a })
  await vi.advanceTimersByTimeAsync(0)
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  sink = null
  watches = 0
  closes = 0
})
afterEach(() => { vi.useRealTimers() })

describe('PolledViewer', () => {
  it('starts a view at once from where the stream stands, and counts it as watching from that first poll', async () => {
    const v = viewer()
    expect(watches).toBe(0)
    const first = await v.poll(undefined, undefined)
    expect(first).toMatchObject({ seq: 0, events: [], reset: true })
    expect(watches).toBe(1)
    sink!.send('transport', { t_us: 1, playing: true })
    sink!.send('project', {})
    expect(await v.poll(first.seq, first.stream)).toEqual({
      stream: first.stream, seq: 2, events: [{ name: 'transport', data: { t_us: 1, playing: true } }, { name: 'project', data: {} }],
    })
  })

  it('holds a poll with nothing new until the next event, or answers it empty after the hold', async () => {
    const v = viewer()
    const { stream, seq } = await v.poll(undefined, undefined)
    const held = v.poll(seq, stream)
    expect(await settled(held)).toBeNull()
    sink!.send('export', { state: 'rendering' })
    expect(await settled(held)).toMatchObject({ seq: 1, events: [{ name: 'export' }] })

    const idle = v.poll(1, stream)
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS - 1)
    expect(await settled(idle)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(idle)).toEqual({ stream, seq: 1, events: [] })
  })

  it('tells a view from another stream, or one further behind than it keeps, to read the state again', async () => {
    const v = viewer()
    const { stream } = await v.poll(undefined, undefined)
    // An app that restarted is another stream, whatever the number.
    expect(await v.poll(0, 'another-run')).toMatchObject({ stream, reset: true })
    expect(await v.poll(5, stream)).toMatchObject({ seq: 0, reset: true })
    for (let i = 0; i < POLL_BUFFER_EVENTS + 1; i++) sink!.send('transport', { t_us: i, playing: true })
    expect(await v.poll(0, stream)).toMatchObject({ seq: POLL_BUFFER_EVENTS + 1, events: [], reset: true })
    const kept = await v.poll(1, stream)
    expect(kept.reset).toBeUndefined()
    expect(kept.events).toHaveLength(POLL_BUFFER_EVENTS)
  })

  it('stops counting as watching once nobody polled it for the lease, and starts a returning view afresh', async () => {
    const v = viewer()
    const { stream } = await v.poll(undefined, undefined)
    await vi.advanceTimersByTimeAsync(POLL_LEASE_MS - 1)
    // A poll renews the lease, from when its hold answers.
    const held = v.poll(0, stream)
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS)
    expect(await settled(held)).toEqual({ stream, seq: 0, events: [] })
    await vi.advanceTimersByTimeAsync(POLL_LEASE_MS - 1)
    expect(closes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(closes).toBe(1)
    // What happened meanwhile was not recorded: the view starts over.
    const back = await v.poll(0, stream)
    expect(back.reset).toBe(true)
    expect(back.stream).not.toBe(stream)
    expect(watches).toBe(2)
  })
})
