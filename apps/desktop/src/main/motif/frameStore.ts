import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { MotifTextureFrame, StoredMotifFrame } from '../../shared/motifs/frameTransport.js'

async function replaceFile(temp: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, destination); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      // Windows readers / scanners can briefly hold the destination open.
      // Keep the old complete frame visible; never delete it before replacing.
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

export interface FrameCodec {
  motifEncodePng(png: Buffer, compressed: boolean): Promise<Buffer>
  motifReadFrame(path: string): Promise<{ width: number; height: number; rgba: Uint8Array }>
}

export interface FrameWriter {
  png(png: Uint8Array): Promise<void>
  encoded(bytes: Uint8Array): Promise<void>
}

/** Disposable LZ4 frame cache. Native work runs on blocking workers.
 * Callers supply a hash/frame, never a filesystem path. Cache misses render live. */
export class MotifFrameStore {
  constructor(
    private readonly workspace: () => Promise<string | null>,
    private readonly codec: FrameCodec,
  ) {}

  private async stem(hash: string, frame: number): Promise<string | null> {
    if (!/^[0-9a-f]{32}$/.test(hash) || !Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('Invalid Motif cache address')
    }
    const root = await this.workspace()
    return root ? path.join(root, 'Cache', 'raster', hash, String(frame)) : null
  }

  async read(hash: string, frame: number, gpu?: (file: string, width: number, height: number) => Promise<MotifTextureFrame>): Promise<StoredMotifFrame | null> {
    const stem = await this.stem(hash, frame)
    if (!stem) return null
    if (gpu) {
      try {
        const file = await fs.open(`${stem}.wfrm`, 'r')
        const header = Buffer.alloc(16)
        try { await file.read(header, 0, 16, 0) } finally { await file.close() }
        if (header.toString('ascii', 0, 8) === 'WCMFRM01') {
          return await gpu(`${stem}.wfrm`, header.readUInt32LE(8), header.readUInt32LE(12))
        }
      } catch { /* unavailable GPU / bad cache: use the CPU fallback */ }
    }
    try {
      return { kind: 'rgba', ...await this.codec.motifReadFrame(`${stem}.wfrm`) }
    } catch { return null /* absent, corrupt, or unsupported cache: render again */ }
  }

  async write(hash: string, frame: number, png: Uint8Array): Promise<void> {
    const writer = await this.prepareWrite(hash, frame)
    if (writer) await writer.png(png)
  }

  /** Bind the destination BEFORE capture: a project switch cannot redirect a
   * completed frame into the next workspace. Native bytes never cross renderer IPC. */
  async prepareWrite(hash: string, frame: number): Promise<FrameWriter | null> {
    const stem = await this.stem(hash, frame)
    if (!stem) return null
    const encoded = async (bytes: Uint8Array): Promise<void> => {
      await fs.mkdir(path.dirname(stem), { recursive: true })
      const temp = `${stem}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, bytes, { flag: 'wx' })
        await replaceFile(temp, `${stem}.wfrm`)
      } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
    }
    return {
      encoded,
      png: async png => {
        await fs.mkdir(path.dirname(stem), { recursive: true })
        await encoded(await this.codec.motifEncodePng(Buffer.from(png.buffer, png.byteOffset, png.byteLength), true))
      },
    }
  }

  async has(hash: string, frame: number): Promise<boolean> {
    const stem = await this.stem(hash, frame)
    if (!stem) return false
    try { await fs.access(`${stem}.wfrm`); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
}
