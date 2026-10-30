import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MotifReaderService, type MotifReaderWorkspace } from './readerService'
import { createMotifConsumers } from './consumers'

const hash = 'b'.repeat(32)

class Child extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn(() => true)
}
class Port { constructor(readonly name: string) {} close = vi.fn() }
class Contents extends EventEmitter {
  destroyed = false
  isDestroyed = () => this.destroyed
  postMessage = vi.fn()
  send = vi.fn()
}

function fixture() {
  vi.useFakeTimers()
  const children: Child[] = []
  const fork = vi.fn(() => { const child = new Child(); children.push(child); return child })
  const channels: { port1: Port; port2: Port }[] = []
  const channel = vi.fn(() => {
    const pair = { port1: new Port(`port1-${channels.length}`), port2: new Port(`port2-${channels.length}`) }
    channels.push(pair)
    return pair
  })
  let workspace: MotifReaderWorkspace = { generation: 1, root: 'root-1' }
  const reportMiss = vi.fn()
  const log = vi.fn()
  const service = new MotifReaderService({ fork, channel, workspace: () => workspace, reportMiss, log })
  const controls = (child: Child) => child.postMessage.mock.calls.map(([message]) => message)
  return {
    service, fork, children, channels, reportMiss, log, controls,
    setWorkspace(next: MotifReaderWorkspace) { workspace = next; service.workspaceChanged() },
  }
}
afterEach(() => vi.useRealTimers())

describe('MotifReaderService', () => {
  it('starts the utility on the first connect and hands each side one end', () => {
    const f = fixture()
    f.setWorkspace({ generation: 1, root: 'root-1' })
    expect(f.fork).not.toHaveBeenCalled()
    const owner = new Contents()
    f.service.connect(owner)
    expect(f.fork).toHaveBeenCalledTimes(1)
    expect(owner.postMessage).toHaveBeenCalledWith('motif:reader-port', null, [f.channels[0].port2])
    // Nothing reaches the process before it has spawned.
    expect(f.children[0].postMessage).not.toHaveBeenCalled()
    f.children[0].emit('spawn')
    expect(f.children[0].postMessage.mock.calls).toEqual([
      [{ type: 'workspace', generation: 1, root: 'root-1' }, undefined],
      [{ type: 'port', id: 1 }, [f.channels[0].port1]],
    ])
    f.service.connect(new Contents())
    expect(f.fork).toHaveBeenCalledTimes(1)
    expect(f.children[0].postMessage).toHaveBeenLastCalledWith({ type: 'port', id: 2 }, [f.channels[1].port1])
  })

  it('pushes the root and generation on each change, with no root in a transition', () => {
    const f = fixture()
    f.service.connect(new Contents())
    const child = f.children[0]
    child.emit('spawn')
    f.setWorkspace({ generation: null, root: null })
    f.setWorkspace({ generation: 2, root: 'root-2' })
    f.setWorkspace({ generation: null, root: null })
    f.setWorkspace({ generation: 3, root: null })
    expect(f.controls(child).filter(m => m.type === 'workspace')).toEqual([
      { type: 'workspace', generation: 1, root: 'root-1' },
      { type: 'workspace', generation: null, root: null },
      { type: 'workspace', generation: 2, root: 'root-2' },
      { type: 'workspace', generation: null, root: null },
      { type: 'workspace', generation: 3, root: null },
    ])
  })

  it('drops a miss from an older generation and reports a current one', () => {
    const f = fixture()
    f.service.connect(new Contents())
    const child = f.children[0]
    child.emit('spawn')
    f.setWorkspace({ generation: 2, root: 'root-2' })
    child.emit('message', { type: 'miss', generation: 1, hash, frame: 4 })
    expect(f.reportMiss).not.toHaveBeenCalled()
    child.emit('message', { type: 'miss', generation: 2, hash, frame: 4 })
    expect(f.reportMiss).toHaveBeenCalledWith(hash, 4)

    f.setWorkspace({ generation: null, root: null })
    child.emit('message', { type: 'miss', generation: 2, hash, frame: 5 })
    child.emit('message', { type: 'miss', generation: null, hash, frame: 5 })
    f.setWorkspace({ generation: 2, root: 'root-2' })
    child.emit('message', { type: 'miss', generation: 2, hash: '../x', frame: 5 })
    child.emit('message', { type: 'miss', generation: 2, hash, frame: -1 })
    expect(f.reportMiss).toHaveBeenCalledTimes(1)
    // A store that cannot take the report does not break the service.
    f.reportMiss.mockImplementationOnce(() => { throw new Error('No workspace open for Motif preparation') })
    expect(() => child.emit('message', { type: 'miss', generation: 2, hash, frame: 6 })).not.toThrow()
  })

  it('restarts after a crash with backoff, resets live documents, and calms after a stable minute', async () => {
    const f = fixture()
    const a = new Contents()
    const b = new Contents()
    const gone = new Contents()
    f.service.connect(a)
    f.service.connect(b)
    f.service.connect(gone)
    f.children[0].emit('spawn')
    gone.destroyed = true

    f.children[0].emit('exit', 1)
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/exited \(code 1\); restarting in 250 ms/))
    expect(a.send).toHaveBeenCalledWith('motif:reader-reset')
    expect(b.send).toHaveBeenCalledWith('motif:reader-reset')
    expect(gone.send).not.toHaveBeenCalled()
    // The documents reconnect at once; the process waits for its backoff.
    f.service.connect(a)
    expect(f.fork).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(f.fork).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.fork).toHaveBeenCalledTimes(2)
    f.children[1].emit('spawn')
    expect(f.controls(f.children[1])).toEqual([
      { type: 'workspace', generation: 1, root: 'root-1' },
      { type: 'port', id: 4 },
    ])

    // Repeated crashes double the wait up to 8 s.
    const delays: number[] = []
    for (let i = 1; i <= 7; i++) {
      f.children[i].emit('exit', 1)
      const delay = Number(/restarting in (\d+) ms/.exec(f.log.mock.lastCall![0])![1])
      delays.push(delay)
      f.service.connect(a)
      await vi.advanceTimersByTimeAsync(delay)
      expect(f.fork).toHaveBeenCalledTimes(i + 2)
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000])

    // A process that ran a stable minute restarts quickly again.
    f.children[8].emit('spawn')
    await vi.advanceTimersByTimeAsync(60_000)
    f.children[8].emit('exit', 1)
    expect(f.log.mock.lastCall![0]).toMatch(/restarting in 250 ms/)
  })

  it('waits out the backoff on the next connect when no document was live', async () => {
    const f = fixture()
    const owner = new Contents()
    f.service.connect(owner)
    f.children[0].emit('spawn')
    owner.destroyed = true
    f.children[0].emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.fork).toHaveBeenCalledTimes(1)
    f.service.connect(new Contents())
    expect(f.fork).toHaveBeenCalledTimes(2)
  })

  it('treats a failed fork like a crash', async () => {
    const f = fixture()
    f.fork.mockImplementationOnce(() => { throw new Error('spawn failed') })
    const owner = new Contents()
    f.service.connect(owner)
    expect(f.channels[0].port1.close).toHaveBeenCalled()
    expect(owner.send).toHaveBeenCalledWith('motif:reader-reset')
    f.service.connect(owner)
    await vi.advanceTimersByTimeAsync(250)
    expect(f.fork).toHaveBeenCalledTimes(2)
  })

  it('retires a document port on navigation, reload, crash or destroy', () => {
    const f = fixture()
    const track = createMotifConsumers(owner => f.service.retire(owner))
    const owner = new Contents()
    const frame = { detached: false } as Electron.WebFrameMain
    const asContents = owner as unknown as Electron.WebContents
    const connect = () => { track(asContents, frame); f.service.connect(owner) }

    connect()
    const child = f.children[0]
    child.emit('spawn')
    // Same-document and subframe navigations keep the port.
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(f.controls(child)).not.toContainEqual({ type: 'retire', id: 1 })
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.controls(child)).toContainEqual({ type: 'retire', id: 1 })

    connect()
    owner.emit('render-process-gone')
    expect(f.controls(child)).toContainEqual({ type: 'retire', id: 2 })
    connect()
    owner.emit('destroyed')
    expect(f.controls(child)).toContainEqual({ type: 'retire', id: 3 })
    // A retired document is not reset after a crash.
    child.emit('exit', 1)
    expect(owner.send).not.toHaveBeenCalled()
  })

  it('supersedes a document port on reconnect and closes an undelivered one', () => {
    const f = fixture()
    const owner = new Contents()
    f.service.connect(owner)
    f.service.connect(owner)
    expect(f.channels[0].port1.close).toHaveBeenCalled()
    f.children[0].emit('spawn')
    expect(f.controls(f.children[0])).toEqual([
      { type: 'workspace', generation: 1, root: 'root-1' },
      { type: 'port', id: 2 },
    ])
    f.service.connect(owner)
    expect(f.controls(f.children[0])).toContainEqual({ type: 'retire', id: 2 })
  })

  it('stops on quit without restarting', async () => {
    const f = fixture()
    const owner = new Contents()
    f.service.connect(owner)
    f.service.stop()
    expect(f.children[0].kill).toHaveBeenCalled()
    expect(f.channels[0].port1.close).toHaveBeenCalled()
    f.children[0].emit('exit', 0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.log).not.toHaveBeenCalled()
    expect(owner.send).not.toHaveBeenCalled()
    f.service.connect(owner)
    expect(f.fork).toHaveBeenCalledTimes(1)
  })
})
