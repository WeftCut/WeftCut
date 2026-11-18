// Carries one native decode session on one port: messages down, commands up,
// one close. Transport: docs/export-ipc-transport.md § Decode-in.

import type { DecodeMsg } from '@weftcut/native-decode'
import type { DocumentOwner } from './documentOwner'

/** The port a session is served on, as its host sees it. `ipcCarrierPort`
 * reaches a port the renderer's preload holds; Electron's `MessagePortMain`
 * fits as it is. `close` fires when the consumer closed the session. */
export interface CarrierPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(message: DecodeMsg): void
  start(): void
  close(): void
}

/** One session for the host to carry. `Cmd` is the pipeline's own command
 * set; the host routes it without knowing it. */
export interface DecodeSessionSpec<Info, Cmd> {
  port: CarrierPort
  /** The document that asked for the session; the session ends with it. */
  owner: DocumentOwner
  /** Opens the native session, delivering its messages to `onMsg` in the order
   * the session produced them. Throws to refuse the session. */
  open(onMsg: (msg: DecodeMsg) => void): Info
  /** One message from the port as this pipeline's command, or null when it is
   * not one. */
  parse(data: Record<string, unknown>): Cmd | null
  command(cmd: Cmd): void
  /** Closes the native session. Called once, and only after `open` returned. */
  close(): void
}

/** A session the host serves: its open info, and the close main uses when it
 * ends the session itself. */
export interface HostedDecodeSession<Info> {
  info: Info
  close(): void
}

/** Opens `spec`'s session and serves it on its port until the port closes,
 * the owner goes away or main closes it, whichever comes first; each closes
 * the session once. A failed open registers nothing and closes the port. */
export function hostDecodeSession<Info, Cmd extends { type: string }>(spec: DecodeSessionSpec<Info, Cmd>): HostedDecodeSession<Info> {
  const { port } = spec
  let closed = false
  let info: Info
  // One port carries frames and control alike, posted in delivery order: a
  // `mark` or `end` must never overtake the frames before it.
  try { info = spec.open(msg => { if (!closed) port.postMessage(msg) }) }
  catch (error) {
    closed = true
    port.close()
    throw error
  }
  const shutdown = () => {
    if (closed) return
    closed = true
    stopOwner()
    try { spec.close() }
    catch (error) { console.warn('[main] decode session close failed', error) }
    port.close()
  }
  const stopOwner = spec.owner.onGone(shutdown)
  port.on('message', ({ data }) => {
    if (closed) return
    if (typeof data !== 'object' || data === null) { console.warn('[main] decode session: unknown command', data); return }
    const cmd = spec.parse(data as Record<string, unknown>)
    if (!cmd) { console.warn('[main] decode session: unknown command', data); return }
    // The session may already be gone natively (a terminal error); a command
    // racing that must not throw out of the port's listener.
    try { spec.command(cmd) }
    catch (error) { console.warn('[main] decode session command failed', cmd.type, error) }
  })
  // The far end closed: the consumer closed the session, its Worker was
  // terminated, or its renderer is gone.
  port.on('close', shutdown)
  port.start()
  return { info, close: shutdown }
}

/** A `release` command, the one every byte pipeline takes, or null. */
export function parseRelease(data: Record<string, unknown>): { type: 'release'; lease: number } | null {
  return data.type === 'release' && Number.isInteger(data.lease) && (data.lease as number) >= 0
    ? { type: 'release', lease: data.lease as number }
    : null
}
