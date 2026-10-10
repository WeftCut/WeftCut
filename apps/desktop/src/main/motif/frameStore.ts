import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { notifyResourceCacheWrite } from '../resources'
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
  private writeTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly workspace: () => Promise<string | null>,
    private readonly codec: FrameCodec,
    private readonly changed: (hash: string, frame: number, present: boolean, bytes?: number) => void = () => {},
    private readonly admitWrite: (hash: string, frame: number, encodedBytes: number) => void = () => {},
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
    } catch { this.changed(hash, frame, false); return null /* absent, corrupt, or unsupported cache: render again */ }
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
    const encoded = (bytes: Uint8Array): Promise<void> => {
      // Admission and commit form one serial transaction for this workspace.
      // Concurrent export/background writers cannot both spend the same free
      // bytes before their successful-write callbacks update accounting.
      const write = this.writeTail.then(async () => {
        this.admitWrite(hash, frame, bytes.byteLength)
        await fs.mkdir(path.dirname(stem), { recursive: true })
        const temp = `${stem}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temp, bytes, { flag: 'wx' })
          await replaceFile(temp, `${stem}.wfrm`)
          this.changed(hash, frame, true, bytes.byteLength)
          notifyResourceCacheWrite()
        } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
      })
      this.writeTail = write.catch(() => {})
      return write
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

  /** Inventory never follows directory/file links and ignores interrupted writes. */
  async inventory(hash: string): Promise<{ frame: number; bytes: number }[]> {
    const stem = await this.stem(hash, 0)
    if (!stem) return []
    const dir = path.dirname(stem)
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return []
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const frames: { frame: number; bytes: number }[] = []
      for (const entry of entries) {
        if (!entry.isFile() || !/^(0|[1-9]\d*)\.wfrm$/.test(entry.name)) continue
        const frame = Number(entry.name.slice(0, -5))
        if (!Number.isSafeInteger(frame)) continue
        let file
        try { file = await fs.open(path.join(dir, entry.name), 'r') }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        try {
          const header = Buffer.alloc(20)
          const { bytesRead } = await file.read(header, 0, header.length, 0)
          const stat = await file.stat()
          const width = header.readUInt32LE(8), height = header.readUInt32LE(12), codec = header.readUInt32LE(16)
          const raw = width * height * 4
          // Match the native decoder's bounds. Checksums are verified on read;
          // startup inventory does not decompress the entire project cache.
          if (bytesRead === 20 && header.toString('ascii', 0, 8) === 'WCMFRM01'
            && width > 0 && height > 0 && width <= 8192 && height <= 8192 && raw <= 256 * 1048576
            && ((codec === 0 && stat.size === 52 + raw)
              || (codec === 1 && stat.size > 52 && stat.size <= 52 + raw + Math.ceil(raw / 255) + 32))) {
            frames.push({ frame, bytes: stat.size })
          }
        } finally { await file.close() }
      }
      return frames
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async collect(live: ReadonlySet<string>, isCurrent: () => boolean): Promise<void> {
    const workspace = await this.workspace()
    if (!workspace || !isCurrent()) return
    const root = path.resolve(workspace, 'Cache', 'raster')
    let entries
    try {
      if (!(await fs.lstat(root)).isDirectory()) return
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      // The former PNG cache used eight-hex hashes. They cannot be read by
      // the current store, but still need collection after live discovery.
      if (!entry.isDirectory() || !/^(?:[0-9a-f]{8}|[0-9a-f]{32})$/.test(entry.name) || live.has(entry.name)) continue
      const target = path.resolve(root, entry.name)
      if (path.dirname(target) !== root) throw new Error('Invalid Motif collection path')
      if (!isCurrent()) return
      await fs.rm(target, { recursive: true, force: true })
    }
  }
}
