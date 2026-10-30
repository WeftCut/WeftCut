import { isMotifFrameAddress, isMotifFrameError, motifFrameStem } from './frameAddress'
import { isMotifReaderDiv, type MotifReadReply, type MotifReaderControl, type MotifReaderReport, type MotifReadTiming } from '../../shared/motifs/readerProtocol'

export interface MotifReaderHostPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(message: unknown): void
  start(): void
  close(): void
}

interface Dependencies {
  read(path: string, div: number): Promise<{ width: number; height: number; rgba: Uint8Array; timing: MotifReadTiming }>
  /** To main: miss reports and port acknowledgements. */
  report(message: MotifReaderReport): void
}

/** The Motif reader utility process (ADR 0154), without Electron. Main owns
 * the raster root and generation; requests name `(hash, frame, div)` only and
 * are checked like `MotifFrameStore` addresses before any path is built. */
export function createMotifReaderHost(deps: Dependencies) {
  let workspace: { generation: number | null; root: string | null } = { generation: null, root: null }
  const ports = new Map<number, MotifReaderHostPort>()

  async function read(request: unknown): Promise<MotifReadReply | null> {
    if (!request || typeof request !== 'object') return null
    const { id, hash, frame, div } = request as Record<string, unknown>
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null
    if (!isMotifFrameAddress(hash, frame) || !isMotifReaderDiv(div)) return { id, miss: true }
    // Bind the root at admission: a switch mid-read reports against the
    // generation that named the file, which main then ignores.
    const { generation, root } = workspace
    if (!root || generation === null) return { id, miss: true }
    try {
      const { width, height, rgba, timing } = await deps.read(`${motifFrameStem(root, hash, frame as number)}.wfrm`, div)
      return { id, frame: { width, height, rgba, timing } }
    } catch (error) {
      if (!isMotifFrameError(error)) return { id, error: String((error as Error)?.message ?? error).slice(0, 512) }
      deps.report({ type: 'miss', generation, hash, frame: frame as number })
      return { id, miss: true }
    }
  }

  function retire(id: number) {
    const port = ports.get(id)
    ports.delete(id)
    try { port?.close() } catch { /* already closed by the document */ }
  }

  function attach(id: number, port: MotifReaderHostPort) {
    retire(id)
    ports.set(id, port)
    port.on('message', event => {
      void read(event.data).then(reply => {
        // MessagePortMain transfers only ports: the pixels are cloned once
        // here, off main's and the page's threads.
        if (reply && ports.get(id) === port) {
          try { port.postMessage(reply) } catch { retire(id) }
        }
      })
    })
    // The document's end closes on navigation, reload or crash.
    port.on('close', () => { if (ports.get(id) === port) ports.delete(id) })
    port.start()
    // Main hands the document its end only once this one is attached here.
    deps.report({ type: 'port-ready', id })
  }

  return {
    read,
    get ports() { return ports.size },
    control(message: unknown, transferred: readonly MotifReaderHostPort[] = []) {
      const m = message as MotifReaderControl | null
      if (!m || typeof m !== 'object') return
      if (m.type === 'workspace') {
        const valid = (m.generation === null || Number.isSafeInteger(m.generation))
          && (m.root === null || typeof m.root === 'string')
        workspace = valid && m.generation !== null && m.root ? { generation: m.generation, root: m.root } : { generation: null, root: null }
      } else if (m.type === 'port' && Number.isSafeInteger(m.id) && transferred[0]) {
        attach(m.id, transferred[0])
      } else if (m.type === 'retire' && Number.isSafeInteger(m.id)) {
        retire(m.id)
      }
    },
  }
}
