// The renderer end of each decode session's port (main/frameCarrier/
// ipcCarrierPort.ts). The preload holds one end and gives the other to the
// session's consumer, usually a Worker: a message from main is posted on with
// its frame buffer transferred, so the bytes cross no context bridge and no
// page code handles them.

import type { DecodeCommand, DecodeWireMsg } from '../shared/frameCarrier/wire'

export interface DecodeSessionPorts {
  /** Creates the session's port pair, keeps one end and returns the other for
   * the consumer. Commands the consumer posts go to `sendCommand`. */
  open(sessionId: string): MessagePort
  /** One message from main for `sessionId`, in main's order. */
  deliver(sessionId: string, msg: DecodeWireMsg): void
  /** The session is over in main: close the kept end. */
  end(sessionId: string): void
}

export function createDecodeSessionPorts(
  sendCommand: (sessionId: string, cmd: DecodeCommand) => void,
): DecodeSessionPorts {
  const kept = new Map<string, MessagePort>()
  return {
    open(sessionId) {
      const { port1, port2 } = new MessageChannel()
      kept.set(sessionId, port1)
      port1.onmessage = event => sendCommand(sessionId, event.data as DecodeCommand)
      return port2
    },
    deliver(sessionId, msg) {
      const port = kept.get(sessionId)
      if (!port) return
      if (msg.kind !== 'bytes') { port.postMessage(msg); return }
      // A view over part of a larger buffer cannot hand over just its own
      // bytes; copy those out first.
      const data = msg.data.byteOffset === 0 && msg.data.byteLength === msg.data.buffer.byteLength
        ? msg.data
        : msg.data.slice()
      port.postMessage({ ...msg, data }, [data.buffer])
    },
    end(sessionId) {
      kept.get(sessionId)?.close()
      kept.delete(sessionId)
    },
  }
}
