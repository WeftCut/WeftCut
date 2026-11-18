// Carries one native decode session on one MessagePort: messages down, commands
// up, one close. Transport: docs/export-ipc-transport.md § Decode-in.

import type { DecodeMsg } from '@weftcut/native-decode'
import type { DecodeCommand } from '../../shared/frameCarrier/wire'
import type { DocumentOwner } from './documentOwner'

/** The part of Electron's `MessagePortMain` a session host uses. */
export interface CarrierPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(message: DecodeMsg): void
  start(): void
  close(): void
}

export interface DecodeSessionSpec<Info> {
  port: CarrierPort
  /** The document that asked for the session; the session ends with it. */
  owner: DocumentOwner
  /** Opens the native session, delivering its messages to `onMsg` in the order
   * the session produced them. Throws to refuse the session. */
  open(onMsg: (msg: DecodeMsg) => void): Info
  command(cmd: DecodeCommand): void
  /** Closes the native session. Called once, and only after `open` returned. */
  close(): void
}

/** Opens `spec`'s session and serves it on its port until the port closes or
 * the owner goes away, whichever comes first; either closes the session once.
 * A failed open registers nothing and closes the port. */
export function hostDecodeSession<Info>(spec: DecodeSessionSpec<Info>): Info {
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
    const cmd = decodeCommand(data)
    if (!cmd) { console.warn('[main] decode session: unknown command', data); return }
    // The session may already be gone natively (a terminal error); a command
    // racing that must not throw out of the port's listener.
    try { spec.command(cmd) }
    catch (error) { console.warn('[main] decode session command failed', cmd.type, error) }
  })
  // The far end closed: the consumer disposed, its Worker was terminated, or
  // its renderer is gone.
  port.on('close', shutdown)
  port.start()
  return info
}

function decodeCommand(data: unknown): DecodeCommand | null {
  if (typeof data !== 'object' || data === null) return null
  const cmd = data as Record<string, unknown>
  if (cmd.type === 'range' && Number.isFinite(cmd.aUs) && Number.isFinite(cmd.bUs))
    return { type: 'range', aUs: cmd.aUs as number, bUs: cmd.bUs as number }
  if (cmd.type === 'release' && Number.isInteger(cmd.lease) && (cmd.lease as number) >= 0)
    return { type: 'release', lease: cmd.lease as number }
  return null
}
