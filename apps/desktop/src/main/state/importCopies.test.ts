import { describe, expect, it } from 'vitest'
import { createImportCopies, type ImportQueueEntry } from './importCopies'

const entry = (media_id: string, kind: string): ImportQueueEntry => ({ media_id, status: { kind } })

/** Settles `p` against the microtask queue: 'resolved', 'rejected' or 'pending'. */
async function state(p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  let s: 'resolved' | 'rejected' | 'pending' = 'pending'
  p.then(() => { s = 'resolved' }, () => { s = 'rejected' })
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  return s
}

describe('import copies', () => {
  it('ends at once when the queue holds no copy and its snapshots are current', async () => {
    const copies = createImportCopies(async () => [entry('a', 'Completed')])
    copies.observe([entry('a', 'Completed')])
    expect(await state(copies.settled(new AbortController().signal))).toBe('resolved')
  })

  it('waits for a running copy until a snapshot shows it ended', async () => {
    const copies = createImportCopies(async () => [entry('a', 'Copying')])
    copies.observe([entry('a', 'Copying')])
    const wait = copies.settled(new AbortController().signal)
    expect(await state(wait)).toBe('pending')
    copies.observe([entry('a', 'Completed')])
    expect(await state(wait)).toBe('resolved')
  })

  it('waits for the snapshot of a copy the queue answered before its snapshot arrived', async () => {
    // The queue already ended the copy, but its snapshots, which carry the
    // copy's result to the pool in order, have not shown the copy at all.
    const copies = createImportCopies(async () => [entry('a', 'Completed')])
    const wait = copies.settled(new AbortController().signal)
    expect(await state(wait)).toBe('pending')
    copies.observe([entry('a', 'Pending')])
    expect(await state(wait)).toBe('pending')
    copies.observe([entry('a', 'Completed')])
    expect(await state(wait)).toBe('resolved')
  })

  it('ends for a copy that failed or was cancelled', async () => {
    const copies = createImportCopies(async () => [entry('a', 'Copying'), entry('b', 'Pending')])
    copies.observe([entry('a', 'Copying'), entry('b', 'Pending')])
    const wait = copies.settled(new AbortController().signal)
    copies.observe([entry('a', 'Failed'), entry('b', 'Pending')])
    expect(await state(wait)).toBe('pending')
    copies.observe([entry('a', 'Failed'), entry('b', 'Cancelled')])
    expect(await state(wait)).toBe('resolved')
  })

  it('ends when the workspace changes, whose queue is gone', async () => {
    const copies = createImportCopies(async () => [entry('a', 'Copying')])
    copies.observe([entry('a', 'Copying')])
    const wait = copies.settled(new AbortController().signal)
    expect(await state(wait)).toBe('pending')
    copies.reset()
    expect(await state(wait)).toBe('resolved')
  })

  it('rejects with the reason when the signal aborts first', async () => {
    const copies = createImportCopies(async () => [entry('a', 'Copying')])
    copies.observe([entry('a', 'Copying')])
    const abort = new AbortController()
    const wait = copies.settled(abort.signal)
    expect(await state(wait)).toBe('pending')
    abort.abort(new Error('cancelled'))
    await expect(wait).rejects.toThrow('cancelled')
  })
})
