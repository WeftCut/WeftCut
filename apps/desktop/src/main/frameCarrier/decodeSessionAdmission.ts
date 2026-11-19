// Admission for native decode sessions, preview and export alike: one session
// per id, and whatever the session reserves is held until it closes. The
// admitted session is served by `hostDecodeSession`.

import type { WebContents } from 'electron'
import { documentOwner } from './documentOwner'
import { hostDecodeSession, type CarrierPort, type DecodeSessionSpec, type HostedDecodeSession } from './decodeSessionHost'

/** Creates the port session `sessionId` is served on in `owner`'s document:
 * `ipcCarrierPort`, or a test's. */
export type ConnectCarrier = (owner: WebContents, sessionId: string) => CarrierPort

/** One session asking to be admitted: the host's spec, with the document that
 * asked as its `WebContents` and the way to create its port. */
export interface DecodeSessionAdmission<Info, Cmd> extends Omit<DecodeSessionSpec<Info, Cmd>, 'owner' | 'port'> {
  sessionId: string
  /** The contents whose document asked; the session ends with that document. */
  owner: WebContents
  connect: ConnectCarrier
  /** Reserves what the session holds while open (its decoder memory) and
   * returns the release. Throws to refuse the session. */
  reserve(): () => void
}

const sessions = new Set<string>()

/** Admits and serves one session. Refuses an id that is already open before
 * reserving anything. The port is created here, once the session holds its id
 * and reservation, so nothing an open handler evaluates first (a token it
 * resolves, a request it parses) can leave a port registered behind a throw.
 * The reservation is released once: when the session closes, or when its open
 * fails; a failed open closes its port. */
export function admitDecodeSession<Info, Cmd extends { type: string }>(admission: DecodeSessionAdmission<Info, Cmd>): HostedDecodeSession<Info> {
  const { sessionId } = admission
  let forget = () => {}
  let port: CarrierPort | undefined
  try {
    if (sessions.has(sessionId)) throw new Error(`Decode session '${sessionId}' is already open`)
    const release = admission.reserve()
    sessions.add(sessionId)
    forget = () => { sessions.delete(sessionId); release() }
    port = admission.connect(admission.owner, sessionId)
    return hostDecodeSession({
      port,
      owner: documentOwner(admission.owner),
      open: admission.open,
      parse: admission.parse,
      command: admission.command,
      close: () => {
        try { admission.close() }
        finally { forget() }
      },
    })
  } catch (error) {
    forget()
    port?.close()
    throw error
  }
}
