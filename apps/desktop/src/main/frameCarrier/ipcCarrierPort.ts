// A decode session's port when its far end is a MessagePort the renderer's
// preload holds (preload/decodeSessionPorts.ts): messages go down on
// `decodeSession:msg`, commands come up on `decodeSession:cmd`, and the
// preload closes the session by id with `decodeSession:close`.
//
// LANDMINE: not a `MessagePortMain`. Posting a 4K frame on one costs main 1.6x
// (Windows) to 2.3x (macOS) the time of `webContents.send`, measured with the
// same bytes; a 4K native-decode export ran 10 % slower on Windows with it.
// The cost is in Electron's port send, outside this repo.

import type { IpcMain, WebContents } from 'electron'
import type { DecodeMsg } from '@weftcut/native-decode'
import type { CarrierPort } from './decodeSessionHost'

interface Entry {
  contents: WebContents
  message?: (event: { data: unknown }) => void
  closed?: () => void
}

const ports = new Map<string, Entry>()

/** Routes every `decodeSession:cmd` to its session's port, and every
 * `decodeSession:close` to its port's close; the close answers once the
 * session is closed. A command or close for a session another document opened
 * is dropped. */
export function installDecodeSessionIpc(ipc: Pick<IpcMain, 'on' | 'handle'>): void {
  const owned = (sender: WebContents, sessionId: string) => {
    const entry = ports.get(sessionId)
    return entry?.contents === sender ? entry : undefined
  }
  ipc.on('decodeSession:cmd', (event, sessionId: string, cmd: unknown) => {
    owned(event.sender, sessionId)?.message?.({ data: cmd })
  })
  ipc.handle('decodeSession:close', (event, sessionId: string) => {
    owned(event.sender, sessionId)?.closed?.()
  })
}

/** The port of session `sessionId` in `contents`' preload. Throws when that id
 * already has one. The far end reports closing when the preload closes the
 * session; otherwise the session ends with its document or in main. */
export function ipcCarrierPort(contents: WebContents, sessionId: string): CarrierPort {
  if (ports.has(sessionId)) throw new Error(`Decode session '${sessionId}' already has a port`)
  const entry: Entry = { contents }
  ports.set(sessionId, entry)
  const send = (channel: string, ...args: unknown[]) => {
    if (!contents.isDestroyed()) contents.send(channel, sessionId, ...args)
  }
  return {
    on(event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)) {
      if (event === 'message') entry.message = listener as (event: { data: unknown }) => void
      else entry.closed = listener as () => void
    },
    postMessage(msg: DecodeMsg) { send('decodeSession:msg', msg) },
    start() {},
    close() {
      if (ports.get(sessionId) !== entry) return
      ports.delete(sessionId)
      // The preload closes its end, so the consumer's port goes with the session.
      send('decodeSession:end')
    },
  }
}
