// The explicit-cancel vs disconnect rule an MCP tool call is held to (ADR
// 0121), and the progress it sends — the same rule the shim keeps
// (`cli/shim.ts` `explicitCancel`).
import { describe, expect, it, vi } from 'vitest'
import { mcpComputeCaller, splitAbort } from './computeCaller'
import type { ComputeJob } from '../../shared/compute-jobs'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('splitAbort', () => {
  it('reads an abort with the transport still open as a cancel', async () => {
    const ac = new AbortController()
    const { cancel, disconnected } = splitAbort(ac.signal, () => false)
    ac.abort()
    await flush()
    expect([cancel.aborted, disconnected.aborted]).toEqual([true, false])
  })

  it('reads an abort whose transport is gone after a microtask as a disconnect', async () => {
    const ac = new AbortController()
    let closed = false
    const { cancel, disconnected } = splitAbort(ac.signal, () => closed)
    // The SDK's close: abort every handler, then clear the transport — in the
    // same turn, so the check after a microtask sees it gone.
    ac.abort()
    closed = true
    await flush()
    expect([cancel.aborted, disconnected.aborted]).toEqual([false, true])
  })

  it('classifies a signal that was already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { cancel } = splitAbort(ac.signal, () => false)
    await flush()
    expect(cancel.aborted).toBe(true)
  })
})

describe('mcpComputeCaller', () => {
  const job = (phase: ComputeJob['phase']) => ({ phase }) as ComputeJob

  it('sends monotonic progress with the phase text when the request has a token', async () => {
    const sendNotification = vi.fn(async (_n: { params: unknown }) => {})
    const hook = vi.fn()
    const caller = mcpComputeCaller({ extra: { sendNotification, _meta: { progressToken: 7 } }, closed: () => false, client: 'claude', onPhase: hook })
    expect(caller.client).toBe('claude')
    caller.onPhase!(job({ kind: 'queued', reason: 'memory' }), 'attach')
    caller.onPhase!(job({ kind: 'queued', reason: 'memory' }), 'heartbeat')
    caller.onPhase!(job({ kind: 'extracting', done: 2, total: 5 }), 'phase')
    await flush()
    expect(sendNotification.mock.calls.map(([n]) => n.params)).toEqual([
      { progressToken: 7, progress: 1, message: 'Queued: waiting for memory' },
      { progressToken: 7, progress: 2, message: 'Queued: waiting for memory' },
      { progressToken: 7, progress: 3, message: 'Extracting 2/5' },
    ])
    expect(hook).toHaveBeenCalledTimes(3)
  })

  it('sends nothing without a progress token, and survives a failed send', async () => {
    const sendNotification = vi.fn(async () => { throw new Error('stream gone') })
    const quiet = mcpComputeCaller({ extra: { sendNotification }, closed: () => false, client: 'c' })
    quiet.onPhase!(job({ kind: 'normalizing' }), 'phase')
    const loud = mcpComputeCaller({ extra: { sendNotification, _meta: { progressToken: 't' } }, closed: () => false, client: 'c' })
    loud.onPhase!(job({ kind: 'normalizing' }), 'phase')
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})
