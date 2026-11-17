// The native sink's frame port: an export's packed frames reach ffmpeg's stdin
// over one MessagePort from the renderer (docs/export-ipc-transport.md).

import type { SinkPortReply } from '../shared/exportSinkPort'

/** The part of Electron's `MessagePortMain` the sink uses. */
export interface SinkPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(message: SinkPortReply): void
  start(): void
}

/** Writes every frame the port carries, in arrival order, answering each with
 * the count written so far. The first failure is answered once and every later
 * frame is dropped unwritten: a frame must never take a failed one's place. */
export function serveSinkPort(port: SinkPort, write: (frame: Buffer) => Promise<void>): void {
  let tail = Promise.resolve()
  let failed = false
  let written = 0
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    port.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
  port.on('message', ({ data }) => {
    if (failed) return
    if (!(data instanceof Uint8Array)) { fail(new Error('A sink frame must be bytes')); return }
    const frame = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    tail = tail.then(async () => {
      if (failed) return
      try {
        await write(frame)
        port.postMessage({ written: ++written })
      } catch (error) { fail(error) }
    })
  })
  // The renderer side closed (export done, cancelled or its process gone).
  port.on('close', () => { failed = true })
  port.start()
}
