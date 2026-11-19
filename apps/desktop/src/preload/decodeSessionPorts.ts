// The renderer end of each decode session's port (main/frameCarrier/
// ipcCarrierPort.ts), for preview, export and GPU preview sessions alike. The
// preload holds one end and gives the other to the session's consumer (the
// page's preview transport, or an export Worker): a message from main is
// posted on with its frame transferred, so no frame crosses a context bridge.
// A GPU session's `slot` is read into a bitmap here first (`SlotReader`), and
// that bitmap is what the consumer receives.

import type { DecodeCommand, DecodeWireMsg, DecodeWireSlot, SlotReadMsg, SlotSessionMsg } from '../shared/frameCarrier/wire'
import type { SlotReader } from './slotReader'

export interface DecodeSessionPorts {
  /** Opens session `sessionId` with `invoke` (main's open handler) and, once it
   * resolves, hands the consumer its port through `handOver`. The port exists
   * before main opens the session, and a port queues what it receives until its
   * consumer listens, so no message is lost in between. Rejects at once, and
   * touches nothing, when `sessionId` is already open or opening here. A
   * failed open ends only the session it created, and rejects. */
  openSession<Info>(sessionId: string, invoke: () => Promise<Info>): Promise<Info>
  /** Ends session `sessionId`: nothing more reaches its consumer, and main
   * closes it. Resolves once main has. Goes to main on IPC directly, not up the
   * port, so it arrives before any open the caller starts after it. */
  close(sessionId: string): Promise<void>
  /** One message from main for `sessionId`, in main's order. */
  deliver(sessionId: string, msg: DecodeWireMsg): void
  /** The session is over in main: close the kept end. */
  end(sessionId: string): void
}

interface Kept {
  port: MessagePort
  /** Messages read or waiting behind a read, posted in arrival order. */
  queued: number
  tail: Promise<void>
}

export function createDecodeSessionPorts(
  sendCommand: (sessionId: string, cmd: DecodeCommand) => void,
  closeSession: (sessionId: string) => Promise<void>,
  handOver: (sessionId: string, port: MessagePort) => void,
  slots: Pick<SlotReader, 'read' | 'drop'>,
): DecodeSessionPorts {
  const kept = new Map<string, Kept>()
  const end = (sessionId: string) => {
    kept.get(sessionId)?.port.close()
    kept.delete(sessionId)
    slots.drop(sessionId)
  }
  const post = (sessionId: string, session: Kept, msg: SlotSessionMsg) => {
    if (kept.get(sessionId) !== session) {
      if (msg.kind === 'slot') msg.bitmap?.close()
      return
    }
    if (msg.kind === 'slot') {
      if (!msg.bitmap) { session.port.postMessage(msg); return }
      try { session.port.postMessage(msg, [msg.bitmap]) }
      catch (error) {
        msg.bitmap.close()
        // The consumer still owns the slot and must hand it back.
        const { slot, gen, ptsUs, durUs } = msg
        session.port.postMessage({ kind: 'slot', slot, gen, ptsUs, durUs, error: String(error) } satisfies SlotReadMsg)
      }
      return
    }
    if (msg.kind !== 'bytes') { session.port.postMessage(msg); return }
    // A view over part of a larger buffer cannot hand over just its own
    // bytes; copy those out first.
    const data = msg.data.byteOffset === 0 && msg.data.byteLength === msg.data.buffer.byteLength
      ? msg.data
      : msg.data.slice()
    session.port.postMessage({ ...msg, data }, [data.buffer])
  }
  const readSlot = async (sessionId: string, msg: DecodeWireSlot): Promise<SlotReadMsg> => {
    const start = performance.now()
    try {
      const { bitmap, gvfMs, cibMs } = await slots.read(sessionId, msg.slot)
      return { ...msg, bitmap, timing: { gvfMs, cibMs, residentMs: performance.now() - start } }
    } catch (error) {
      return { ...msg, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    async openSession(sessionId, invoke) {
      // `end` goes by id: a second open under a live id would end the first.
      if (kept.has(sessionId)) throw new Error(`Decode session '${sessionId}' is already open`)
      const { port1, port2 } = new MessageChannel()
      const session: Kept = { port: port1, queued: 0, tail: Promise.resolve() }
      kept.set(sessionId, session)
      port1.onmessage = event => sendCommand(sessionId, event.data as DecodeCommand)
      try {
        const info = await invoke()
        handOver(sessionId, port2)
        return info
      } catch (error) {
        // Main may have ended this session already, and the id opened again.
        if (kept.get(sessionId) === session) end(sessionId)
        port1.close()
        port2.close()
        throw error
      }
    },
    close(sessionId) {
      end(sessionId)
      return closeSession(sessionId)
    },
    deliver(sessionId, msg) {
      const session = kept.get(sessionId)
      if (!session) return
      if (msg.kind !== 'slot' && session.queued === 0) { post(sessionId, session, msg); return }
      // Slots are read concurrently but posted in the session's order: a
      // frame, `end` or `error` never overtakes a slot still being read.
      const ready: Promise<SlotSessionMsg> = msg.kind === 'slot' ? readSlot(sessionId, msg) : Promise.resolve(msg)
      session.queued += 1
      session.tail = session.tail.then(() => ready).then(out => {
        session.queued -= 1
        post(sessionId, session, out)
      })
    },
    end,
  }
}
