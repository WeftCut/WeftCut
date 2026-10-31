import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { notifyResourceCacheWrite } from '../resources'
import { isMotifFrameAddress, isMotifFrameError, motifFrameStem } from './frameAddress'
import { isMotifReaderDiv, type MotifReaderDiv } from '../../shared/motifs/readerProtocol.js'
import type { MotifReadUnavailable, MotifTextureFrame, MotifTextureReadResult } from '../../shared/motifs/frameTransport.js'

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
}

/** Uploads `file` scaled by `div` into a `width × height` texture. Rejects
 * with a `motif-frame: ` error when the file itself cannot be read. */
export type MotifTextureUpload = (file: string, width: number, height: number, div: MotifReaderDiv) => Promise<MotifTextureFrame | MotifReadUnavailable>

const HEADER_MAGIC = 'WCMFRM01'
/** The native core's dimension bounds (`motif_frame.rs`). */
const MAX_DIMENSION = 8192

/** Stored width and height from the `.wfrm` header, or null when the file is
 * absent, short or not a frame. The native read verifies everything else. */
async function readHeaderSize(file: string): Promise<{ width: number; height: number } | null> {
  const header = Buffer.alloc(16)
  try {
    const handle = await fs.open(file, 'r')
    try { if ((await handle.read(header, 0, 16, 0)).bytesRead < 16) return null } finally { await handle.close() }
  } catch { return null /* the native read would fail on the same file */ }
  if (header.toString('ascii', 0, 8) !== HEADER_MAGIC) return null
  const width = header.readUInt32LE(8), height = header.readUInt32LE(12)
  const valid = (n: number): boolean => n > 0 && n <= MAX_DIMENSION
  return valid(width) && valid(height) ? { width, height } : null
}

export interface FrameWriter {
  png(png: Uint8Array): Promise<void>
  encoded(bytes: Uint8Array): Promise<void>
}

/** Disposable zstd frame cache (ADR 0078). Native work runs on blocking workers.
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
    if (!isMotifFrameAddress(hash, frame)) throw new Error('Invalid Motif cache address')
    const root = await this.workspace()
    return root ? motifFrameStem(root, hash, frame) : null
  }

  /** The Windows texture lane (ADR 0154). The header names the stored size;
   * `gpu` uploads the frame scaled by `div` into a pool of the rounded-up size.
   * A file failure is a miss: the frame leaves coverage and null is returned.
   * `unavailable` (no texture, GPU budget, a failed pool or import) keeps it. */
  async readTexture(hash: string, frame: number, div: MotifReaderDiv, gpu: MotifTextureUpload): Promise<MotifTextureReadResult> {
    if (!isMotifReaderDiv(div)) throw new Error('Invalid Motif read divisor')
    const stem = await this.stem(hash, frame)
    if (!stem) return null
    const file = `${stem}.wfrm`
    const size = await readHeaderSize(file)
    if (!size) { this.changed(hash, frame, false); return null }
    try {
      return await gpu(file, Math.ceil(size.width / div), Math.ceil(size.height / div), div)
    } catch (error) {
      // Lifecycle errors (closed consumer, superseded export) are not misses.
      if (!isMotifFrameError(error)) throw error
      this.changed(hash, frame, false)
      return null
    }
  }

  /** The Motif reader utility could not read a stored frame (ADR 0154): drop it
   * from coverage, as a failed `readTexture` does, so a replacement capture is admitted. */
  reportMiss(hash: string, frame: number): void {
    this.changed(hash, frame, false)
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

  /** Stat-only (docs/motifs.md#preparation-l2-baking): opening each file costs
   *  ~6 ms cold under on-access scanning. Header, dimensions and checksum are
   *  verified by the reader, whose miss drops the frame from coverage and
   *  admits a replacement capture. Inventory never follows directory/file links
   *  and ignores interrupted writes. */
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
        let stat
        try { stat = await fs.lstat(path.join(dir, entry.name)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (stat.isFile() && stat.size > 52) frames.push({ frame, bytes: stat.size })
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
