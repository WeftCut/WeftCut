import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectPublicationReply, ProjectVersion } from '../../shared/projectPublication'
import { ProjectPublicationClient, ProjectPublicationError, attachProjectPublication, awaitProjectPublication, refreshActiveProjectPublication, settleActiveProjectPublication } from './projectPublication'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const version = (revision: number, session = 1): ProjectVersion => ({ session, revision })
const publication = (revision: number, summary: string | null = `view-${revision}`, session = 1): ProjectPublicationReply<string> => ({ version: version(revision, session), viewId: revision + 1000, summary })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const clients: ProjectPublicationClient<string>[] = []
afterEach(() => { for (const client of clients.splice(0)) client.stop() })
function fixture() {
  const requests: ReturnType<typeof deferred<ProjectPublicationReply<string>>>[] = []
  const read = vi.fn((_trace?: string) => {
    const request = deferred<ProjectPublicationReply<string>>()
    requests.push(request)
    return request.promise
  })
  const apply = vi.fn()
  const onError = vi.fn()
  const client = new ProjectPublicationClient({ read, apply, onError })
  clients.push(client)
  return { client, read, apply, onError, requests }
}

describe('project publication client', () => {
  it('coalesces 100 events into one active read and one newest read, without publishing the obsolete view', async () => {
    const f = fixture()
    for (let i = 1; i <= 100; i++) f.client.observe(version(i), `trace-${i}`)
    expect(f.read).toHaveBeenCalledTimes(1)
    const done = f.client.waitFor(version(100))
    f.requests[0]!.resolve(publication(1))
    await flush()
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.read.mock.calls).toEqual([['trace-1', null], ['trace-100', null]])
    f.requests[1]!.resolve(publication(100))
    await done
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.apply).toHaveBeenCalledWith('view-100', { version: version(100), summary: 'view-100' }, 'trace-100')
  })

  it('a receipt before its event fetches once; satisfied or reordered events do no work', async () => {
    const f = fixture()
    const done = f.client.waitFor(version(3))
    expect(f.read).toHaveBeenCalledTimes(1)
    f.client.observe(version(2))
    f.client.observe(version(3))
    f.requests[0]!.resolve(publication(3))
    await done
    f.client.observe(version(1))
    f.client.observe(version(3))
    await f.client.waitFor(version(2))
    await f.client.settle()
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('an event before its receipt shares the same publication barrier', async () => {
    const f = fixture()
    f.client.observe(version(2))
    const first = f.client.waitFor(version(2))
    const second = f.client.waitFor(version(2))
    f.requests[0]!.resolve(publication(2))
    await Promise.all([first, second])
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('settle follows a replacement session instead of rejecting like an obsolete command receipt', async () => {
    const f = fixture()
    const initial = f.client.waitFor(version(1))
    f.requests[0]!.resolve(publication(1))
    await initial
    f.client.observe(version(2))
    const receipt = f.client.waitFor(version(2)).catch((error) => error)
    const settled = f.client.settle()
    let completed = false
    void settled.then(() => { completed = true })
    await flush()
    expect(completed).toBe(false)
    f.client.observe(version(0, 2))
    f.requests[1]!.resolve(publication(2))
    await flush()
    expect(completed).toBe(false)
    f.requests[2]!.resolve(publication(0, 'replacement', 2))
    await settled
    expect(completed).toBe(true)
    expect(await receipt).toMatchObject({ reason: 'superseded-session' })
  })

  it('suppresses old session responses, publishes closed null, then reopens', async () => {
    const f = fixture()
    const old = f.client.waitFor(version(9)).catch((error) => error)
    f.client.observe(version(0, 2))
    f.requests[0]!.resolve(publication(9))
    await flush()
    expect(f.apply).not.toHaveBeenCalled()
    const closed = f.client.waitFor(version(0, 2))
    f.requests[1]!.resolve(publication(0, null, 2))
    await closed
    expect(await old).toMatchObject({ reason: 'superseded-session' })
    expect(f.apply.mock.calls[0]?.[0]).toBeNull()
    const reopened = f.client.waitFor(version(0, 3))
    f.requests[2]!.resolve(publication(0, 'reopened', 3))
    await reopened
    expect(f.apply.mock.calls.at(-1)?.[0]).toBe('reopened')
    await expect(f.client.waitFor(version(9))).rejects.toMatchObject({ reason: 'superseded-session' })
    expect(f.read).toHaveBeenCalledTimes(3)
  })

  it('preserves last good data on read failure and retries only when requested', async () => {
    const f = fixture()
    const initial = f.client.waitFor(version(1))
    f.requests[0]!.resolve(publication(1))
    await initial
    const failed = f.client.waitFor(version(2))
    const assertion = expect(failed).rejects.toMatchObject({ reason: 'read-failed', cause: expect.any(Error) })
    f.requests[1]!.reject(new Error('offline'))
    await assertion
    expect(f.apply.mock.calls.map(([summary]) => summary)).toEqual(['view-1'])
    expect(f.onError).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenCalledTimes(2)
    const retry = f.client.waitFor(version(2))
    f.requests[2]!.resolve(publication(2))
    await retry
    expect(f.apply.mock.calls.map(([summary]) => summary)).toEqual(['view-1', 'view-2'])
  })

  it('limits backend stale-version retries and reports the view failure', async () => {
    const f = fixture()
    const done = f.client.waitFor(version(4))
    const assertion = expect(done).rejects.toMatchObject({ reason: 'stale-response' })
    f.requests[0]!.resolve(publication(3))
    await flush()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.requests[1]!.resolve(publication(3))
    await assertion
    await flush()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.onError.mock.calls[0]?.[0]).toBeInstanceOf(ProjectPublicationError)
  })

  it('a requested retry after stale responses receives its own bounded recovery attempt', async () => {
    const f = fixture()
    const first = f.client.waitFor(version(4)).catch((error) => error)
    f.requests[0]!.resolve(publication(3))
    await flush()
    f.requests[1]!.resolve(publication(3))
    expect(await first).toMatchObject({ reason: 'stale-response' })
    const retry = f.client.waitFor(version(4))
    f.requests[2]!.resolve(publication(3))
    await flush()
    expect(f.read).toHaveBeenCalledTimes(4)
    f.requests[3]!.resolve(publication(4))
    await retry
  })

  it('refresh forces same-version external data to be reread; settle is free when caught up', async () => {
    const f = fixture()
    const initial = f.client.settle()
    f.requests[0]!.resolve(publication(1))
    await initial
    await f.client.settle()
    expect(f.read).toHaveBeenCalledTimes(1)
    const refresh = f.client.refresh()
    f.requests[1]!.resolve(publication(1, 'files-changed'))
    await refresh
    expect(f.apply.mock.calls.map(([summary]) => summary)).toEqual(['view-1', 'files-changed'])
  })

  it('coalesces forced refresh requests behind one active read', async () => {
    const f = fixture()
    const refreshes = Array.from({ length: 100 }, () => f.client.refresh())
    expect(f.read).toHaveBeenCalledTimes(1)
    f.requests[0]!.resolve(publication(1, 'old-external-data'))
    await flush()
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.requests[1]!.resolve(publication(1, 'new-external-data'))
    await Promise.all(refreshes)
    expect(f.apply.mock.calls.map(([summary]) => summary)).toEqual(['new-external-data'])
  })

  it('stop rejects barriers and prevents a late read from applying', async () => {
    const f = fixture()
    const done = f.client.waitFor(version(1))
    const assertion = expect(done).rejects.toMatchObject({ reason: 'stopped' })
    f.client.stop()
    await assertion
    f.requests[0]!.resolve(publication(1))
    await flush()
    expect(f.apply).not.toHaveBeenCalled()
    f.client.observe(version(2))
    await expect(f.client.refresh()).rejects.toMatchObject({ reason: 'stopped' })
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('background failures and throwing error reporters do not reject an unobserved promise', async () => {
    const f = fixture()
    f.onError.mockImplementation(() => { throw new Error('reporter') })
    f.client.observe(version(1))
    f.requests[0]!.reject(new Error('offline'))
    await flush()
    expect(f.onError).toHaveBeenCalledTimes(1)
    expect(f.apply).not.toHaveBeenCalled()
  })
})

describe('active publication registration', () => {
  it('preserves the edit trace when a command receipt arrives before its event', async () => {
    const f = fixture()
    const detach = attachProjectPublication(f.client)
    try {
      const done = awaitProjectPublication(version(3), false, 'receipt-trace')
      f.client.observe(version(3), 'receipt-trace')
      expect(f.read.mock.calls).toEqual([['receipt-trace', null]])
      f.requests[0]!.resolve(publication(3))
      await done
      expect(f.apply).toHaveBeenCalledWith('view-3', { version: version(3), summary: 'view-3' }, 'receipt-trace')
    } finally { detach() }
  })

  it('replacing the active owner stops an old in-flight read before its delayed cleanup', async () => {
    const old = fixture()
    const next = fixture()
    const detachOld = attachProjectPublication(old.client)
    const obsolete = old.client.settle().catch((error) => error)
    const detachNext = attachProjectPublication(next.client)
    const current = awaitProjectPublication(version(1, 2))
    next.requests[0]!.resolve(publication(1, 'new-owner', 2))
    await current
    old.requests[0]!.resolve(publication(9, 'old-owner'))
    await flush()
    expect(await obsolete).toMatchObject({ reason: 'stopped' })
    expect(old.apply).not.toHaveBeenCalled()
    expect(next.apply.mock.calls.map(([summary]) => summary)).toEqual(['new-owner'])
    detachOld()
    await settleActiveProjectPublication()
    detachNext()
  })

  it('reattaching the same owner does not stop its pending work', async () => {
    const f = fixture()
    const detach = attachProjectPublication(f.client)
    const done = awaitProjectPublication(version(1))
    attachProjectPublication(f.client)
    f.requests[0]!.resolve(publication(1))
    await done
    expect(f.apply).toHaveBeenCalledTimes(1)
    detach()
  })

  it('only explicitly allowed startup lifecycle barriers succeed without a mounted owner', async () => {
    const f = fixture()
    attachProjectPublication(f.client)()
    await expect(awaitProjectPublication(version(1), true)).resolves.toBeUndefined()
    await expect(awaitProjectPublication(version(1))).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(settleActiveProjectPublication()).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(refreshActiveProjectPublication()).rejects.toMatchObject({ reason: 'unavailable' })
    const detach = attachProjectPublication(f.client)
    const done = awaitProjectPublication(version(1), true)
    expect(f.read).toHaveBeenCalledTimes(1)
    f.requests[0]!.resolve(publication(1))
    await done
    detach()
  })

  it('old cleanup cannot detach a new client, and unavailable barriers fail explicitly', async () => {
    const old = fixture()
    const next = fixture()
    const detachOld = attachProjectPublication(old.client)
    const detachNext = attachProjectPublication(next.client)
    detachOld()
    const done = awaitProjectPublication(version(1))
    expect(old.read).not.toHaveBeenCalled()
    next.requests[0]!.resolve(publication(1))
    await done
    await settleActiveProjectPublication()
    const refresh = refreshActiveProjectPublication()
    next.requests[1]!.resolve(publication(1))
    await refresh
    detachNext()
    await expect(awaitProjectPublication(version(1))).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('project publication client differences', () => {
  const start = () => {
    const replies: ReturnType<typeof deferred<ProjectPublicationReply<{ n: number; kept: object }>>>[] = []
    const read = vi.fn((_trace: string | undefined, _base: number | null) => {
      const reply = deferred<ProjectPublicationReply<{ n: number; kept: object }>>()
      replies.push(reply)
      return reply.promise
    })
    const apply = vi.fn()
    const onError = vi.fn()
    const client = new ProjectPublicationClient({ read, apply, onError })
    clients.push(client as unknown as ProjectPublicationClient<string>)
    return { client, read, apply, onError, replies }
  }
  const kept = {}
  const seeded = async () => {
    const f = start()
    f.client.observe(version(1))
    f.replies[0]!.resolve({ version: version(1), viewId: 10, summary: { n: 1, kept } })
    await flush()
    return f
  }

  it('asks for the whole projection first, then names what it holds', async () => {
    const f = await seeded()
    expect(f.read).toHaveBeenLastCalledWith(undefined, null)
    f.client.observe(version(2))
    expect(f.read).toHaveBeenLastCalledWith(undefined, 10)
    f.replies[1]!.resolve({ version: version(2), viewId: 11, base: 10, patches: [{ path: ['n'], value: 2 }] })
    await flush()
    const summary = f.apply.mock.lastCall![0]
    expect(summary).toEqual({ n: 2, kept })
    expect(summary.kept).toBe(kept)
    f.client.observe(version(3))
    expect(f.read).toHaveBeenLastCalledWith(undefined, 11)
  })

  it('a reply behind the newest event is not applied and leaves the base where it was', async () => {
    const f = await seeded()
    f.client.observe(version(2))
    f.client.observe(version(3))
    f.replies[1]!.resolve({ version: version(2), viewId: 11, base: 10, patches: [{ path: ['n'], value: 2 }] })
    await flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenLastCalledWith(undefined, 10)
    f.replies[2]!.resolve({ version: version(3), viewId: 12, base: 10, patches: [{ path: ['n'], value: 3 }] })
    await flush()
    expect(f.apply.mock.lastCall![0]).toEqual({ n: 3, kept })
  })

  it('a difference that does not fit reads the whole projection, and no waiter hears of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const f = await seeded()
      const waiting = f.client.waitFor(version(2))
      f.replies[1]!.resolve({ version: version(2), viewId: 11, base: 10, patches: [{ path: ['n', 'deep', 'er'], value: 2 }] })
      await flush()
      expect(f.apply).toHaveBeenCalledTimes(1)
      expect(f.read).toHaveBeenLastCalledWith(undefined, null)
      f.replies[2]!.resolve({ version: version(2), viewId: 12, summary: { n: 2, kept } })
      await waiting
      expect(f.onError).not.toHaveBeenCalled()
      expect(f.apply.mock.lastCall![0]).toEqual({ n: 2, kept })
    } finally { warn.mockRestore() }
  })

  it('a difference from some other base is refused the same way', async () => {
    const f = await seeded()
    f.client.observe(version(2))
    f.replies[1]!.resolve({ version: version(2), viewId: 11, base: 9, patches: [] })
    await flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenLastCalledWith(undefined, null)
  })

  it('a reply dropped for a newer forced refresh does not move the base', async () => {
    const f = await seeded()
    const first = f.client.refresh()
    expect(f.read).toHaveBeenLastCalledWith(undefined, 10)
    const second = f.client.refresh()
    f.replies[1]!.resolve({ version: version(1), viewId: 11, base: 10, patches: [{ path: ['n'], value: 50 }] })
    await flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenLastCalledWith(undefined, 10)
    f.replies[2]!.resolve({ version: version(1), viewId: 12, base: 10, patches: [{ path: ['n'], value: 99 }] })
    await Promise.all([first, second])
    expect(f.apply.mock.lastCall![0]).toEqual({ n: 99, kept })
  })

  it('a whole projection passes through adopt with the held view', async () => {
    const adopt = vi.fn((_held: string | null, next: string | null) => `adopted:${next}`)
    const reply = deferred<ProjectPublicationReply<string>>()
    const apply = vi.fn()
    const client = new ProjectPublicationClient<string>({ read: () => reply.promise, apply, adopt })
    clients.push(client)
    client.observe(version(1))
    reply.resolve({ version: version(1), viewId: 1, summary: 'view' })
    await flush()
    expect(adopt).toHaveBeenCalledWith(null, 'view')
    expect(apply.mock.lastCall![0]).toBe('adopted:view')
  })
})
