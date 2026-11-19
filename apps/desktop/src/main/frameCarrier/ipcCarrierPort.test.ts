import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { DecodeMsg } from '@weftcut/native-decode'
import { installDecodeSessionIpc, ipcCarrierPort } from './ipcCarrierPort'

function fakeContents() {
  const sent: unknown[][] = []
  const state = { destroyed: false }
  const contents = {
    isDestroyed: () => state.destroyed,
    send: (...args: unknown[]) => { sent.push(args) },
  } as unknown as WebContents
  return { contents, sent, state }
}

/** The renderer side: sends `decodeSession:cmd` as `sender`. */
function installed() {
  return installedIpc().command
}

/** The renderer side: `decodeSession:cmd` sends and `decodeSession:close` invokes as `sender`. */
function installedIpc() {
  let command!: (event: { sender: WebContents }, sessionId: string, cmd: unknown) => void
  let close!: (event: { sender: WebContents }, sessionId: string) => unknown
  installDecodeSessionIpc({
    on: ((_channel: string, listener: typeof command) => { command = listener }) as never,
    handle: ((_channel: string, listener: typeof close) => { close = listener }) as never,
  })
  return {
    command: (sender: WebContents, sessionId: string, cmd: unknown) => command({ sender }, sessionId, cmd),
    close: (sender: WebContents, sessionId: string) => close({ sender }, sessionId),
  }
}

const frame: DecodeMsg = { kind: 'bytes', lease: 1, ptsUs: 0, durUs: 1, width: 2, height: 2, format: 'NV12', data: Buffer.alloc(6) }

describe('ipcCarrierPort', () => {
  it('sends each message to its document, tagged with its session', () => {
    const { contents, sent } = fakeContents()
    const port = ipcCarrierPort(contents, 'msg-a')
    port.postMessage(frame)
    port.postMessage({ kind: 'end' })
    expect(sent).toEqual([
      ['decodeSession:msg', 'msg-a', frame],
      ['decodeSession:msg', 'msg-a', { kind: 'end' }],
    ])
    port.close()
  })

  it('hands a command to the port of the session it names', () => {
    const command = installed()
    const { contents } = fakeContents()
    const a = ipcCarrierPort(contents, 'cmd-a')
    const b = ipcCarrierPort(contents, 'cmd-b')
    const gotA = vi.fn()
    const gotB = vi.fn()
    a.on('message', gotA)
    b.on('message', gotB)
    command(contents, 'cmd-b', { type: 'release', lease: 4 })
    expect(gotA).not.toHaveBeenCalled()
    expect(gotB.mock.calls).toEqual([[{ data: { type: 'release', lease: 4 } }]])
    a.close()
    b.close()
  })

  it('drops a command from a document that does not own the session', () => {
    const command = installed()
    const owner = fakeContents()
    const other = fakeContents()
    const port = ipcCarrierPort(owner.contents, 'own-a')
    const got = vi.fn()
    port.on('message', got)
    command(other.contents, 'own-a', { type: 'release', lease: 0 })
    expect(got).not.toHaveBeenCalled()
    port.close()
  })

  it('reports the far end closing when its own document closes the session, and answers after it', () => {
    const ipc = installedIpc()
    const owner = fakeContents()
    const other = fakeContents()
    const port = ipcCarrierPort(owner.contents, 'close-a')
    const order: string[] = []
    port.on('close', () => { order.push('closed') })
    ipc.close(other.contents, 'close-a')
    expect(order, 'another document cannot close it').toEqual([])
    ipc.close(owner.contents, 'close-a')
    order.push('answered')
    expect(order).toEqual(['closed', 'answered'])
    port.close()
  })

  // The preload ended its side before asking, and may already hold the id
  // again for its next open: an end by id would cut that one.
  it('sends no end back for a close the preload asked for', () => {
    const ipc = installedIpc()
    const { contents, sent } = fakeContents()
    const port = ipcCarrierPort(contents, 'asked-a')
    port.on('close', () => port.close())
    ipc.close(contents, 'asked-a')
    expect(sent).toEqual([])
    ipcCarrierPort(contents, 'asked-a').close()
  })

  it('refuses a second port for a live session and leaves the first serving', () => {
    const command = installed()
    const { contents } = fakeContents()
    const port = ipcCarrierPort(contents, 'dup-a')
    const got = vi.fn()
    port.on('message', got)
    expect(() => ipcCarrierPort(contents, 'dup-a')).toThrow(/already has a port/)
    command(contents, 'dup-a', { type: 'release', lease: 0 })
    expect(got).toHaveBeenCalledOnce()
    port.close()
  })

  it('on close tells the preload to end its port once, routes nothing more and frees the id', () => {
    const command = installed()
    const { contents, sent } = fakeContents()
    const port = ipcCarrierPort(contents, 'end-a')
    const got = vi.fn()
    port.on('message', got)
    port.close()
    port.close()
    command(contents, 'end-a', { type: 'release', lease: 0 })
    expect(sent).toEqual([['decodeSession:end', 'end-a']])
    expect(got).not.toHaveBeenCalled()
    ipcCarrierPort(contents, 'end-a').close()
  })

  it('sends nothing to a destroyed document', () => {
    const { contents, sent, state } = fakeContents()
    const port = ipcCarrierPort(contents, 'gone-a')
    state.destroyed = true
    port.postMessage({ kind: 'end' })
    port.close()
    expect(sent).toEqual([])
  })
})
