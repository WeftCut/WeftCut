// The renderer end of each decode session's port (main/frameCarrier/
// ipcCarrierPort.ts), for preview and export sessions alike. The preload holds
// one end and gives the other to the session's consumer (the page's preview
// transport, or an export Worker): a message from main is posted on with its
// frame buffer transferred, so the bytes cross no context bridge.

import type { DecodeCommand, DecodeWireMsg } from '../shared/frameCarrier/wire'

export interface DecodeSessionPorts {
  /** Opens session `sessionId` with `invoke` (main's open handler) and, once it
   * resolves, hands the consumer its port through `handOver`. The port exists
   * before main opens the session, and a port queues what it receives until its
   * consumer listens, so no message is lost in between. A failed open closes
   * the port and rejects. */
  openSession<Info>(sessionId: string, invoke: () => Promise<Info>): Promise<Info>
  /** Ends session `sessionId` in main. Sent on IPC directly, not up the port,
   * so it reaches main before any open the caller starts after it. */
  close(sessionId: string): void
  /** One message from main for `sessionId`, in main's order. */
  deliver(sessionId: string, msg: DecodeWireMsg): void
  /** The session is over in main: close the kept end. */
  end(sessionId: string): void
}

export function createDecodeSessionPorts(
  sendCommand: (sessionId: string, cmd: DecodeCommand) => void,
  handOver: (sessionId: string, port: MessagePort) => void,
): DecodeSessionPorts {
  const kept = new Map<string, MessagePort>()
  const end = (sessionId: string) => {
    kept.get(sessionId)?.close()
    kept.delete(sessionId)
  }
  return {
    async openSession(sessionId, invoke) {
      const { port1, port2 } = new MessageChannel()
      kept.set(sessionId, port1)
      port1.onmessage = event => sendCommand(sessionId, event.data as DecodeCommand)
      try {
        const info = await invoke()
        handOver(sessionId, port2)
        return info
      } catch (error) {
        end(sessionId)
        port2.close()
        throw error
      }
    },
    close(sessionId) { sendCommand(sessionId, { type: 'close' }) },
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
    end,
  }
}
