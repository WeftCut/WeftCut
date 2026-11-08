import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { notifyResourceCacheWrite } from '../resources'
import { isMotifFrameAddress, motifFrameStem } from './frameAddress'
import { MotifError, motifErrorCode } from '../../shared/motifs/errors.js'
import { isMotifReaderDiv, type MotifReaderDiv } from '../../shared/motifs/readerProtocol.js'
import { fitsMotifFrame } from '../../shared/motifs/limits.js'
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
  motifEncodePng(png: Buffer): Promise<Buffer>
}

/** The texture lane as one document finds it when its read arrives. */
export interface MotifTextureLane {
  /** `MotifGpuTransport.generation` of the document. */
  generation: number
  /** False while the lane is off for the document: the read answers `lane`
   * without opening the file. */
  available: boolean
  /** Uploads `file` scaled by `div` into a `width × height` texture. Rejects
   * with a `miss` when the file itself cannot be read. */
  upload(file: string, width: number, height: number, div: MotifReaderDiv): Promise<MotifTextureFrame | MotifReadUnavailable>
}

/** The native frame layout (`motif_frame.rs`): magic, width, height, then the
 * checksummed zstd payload. */
const HEADER_MAGIC = 'WCMFRM03'
const HEADER_BYTES = 16

/** Stored width and height from the `.wfrm` header. An absent, short or
 * foreign file is a `miss`; a file another process holds open (a writer
 * replacing it, an on-access scanner) is `transient`. The native read
 * verifies everything else. */
async function readHeaderSize(file: string): Promise<{ width: number; height: number }> {
  const header = Buffer.alloc(HEADER_BYTES)
  let bytesRead: number
  try {
    const handle = await fs.open(file, 'r')
    try { ({ bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)) } finally { await handle.close() }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const held = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    throw new MotifError(held ? 'transient' : 'miss', `Motif frame header unreadable: ${code ?? String(error)}`, { cause: error })
  }
  if (bytesRead < HEADER_BYTES || header.toString('ascii', 0, 8) !== HEADER_MAGIC) throw new MotifError('miss', 'not a Motif frame')
  const width = header.readUInt32LE(8), height = header.readUInt32LE(12)
  if (!fitsMotifFrame(width, height)) throw new MotifError('miss', `invalid Motif frame size ${width}x${height}`)
  return { width, height }
}

/** ENOSPC as `disk`, the code the bake pauses on. */
const diskCoded = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
  ? new MotifError('disk', String((error as Error).message), { cause: error }) : error

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
    /** +1 when a file is about to be written, -1 when that write ended. */
    private readonly writing: (hash: string, delta: 1 | -1) => void = () => {},
  ) {}

  private async stem(hash: string, frame: number): Promise<string | null> {
    if (!isMotifFrameAddress(hash, frame)) throw new Error('Invalid Motif cache address')
    const root = await this.workspace()
    return root ? motifFrameStem(root, hash, frame) : null
  }

  /** The Windows texture lane (ADR 0154). The header names the stored size;
   * `lane` uploads the frame scaled by `div` into a pool of the rounded-up
   * size. A `miss` leaves coverage and returns null. A `transient` header
   * read, like `unavailable`, keeps the frame and sends the read to the
   * utility lane. */
  async readTexture(hash: string, frame: number, div: MotifReaderDiv, lane: MotifTextureLane): Promise<MotifTextureReadResult> {
    if (!isMotifReaderDiv(div)) throw new Error('Invalid Motif read divisor')
    const { generation } = lane
    if (!lane.available) return { kind: 'unavailable', reason: 'lane', generation }
    const stem = await this.stem(hash, frame)
    if (!stem) return null
    const file = `${stem}.wfrm`
    let size: { width: number; height: number }
    try { size = await readHeaderSize(file) } catch (error) {
      if (motifErrorCode(error) === 'transient') return { kind: 'unavailable', reason: 'read', generation }
      this.changed(hash, frame, false)
      return null
    }
    try {
      return await lane.upload(file, Math.ceil(size.width / div), Math.ceil(size.height / div), div)
    } catch (error) {
      // Lifecycle errors (closed consumer, superseded export) are not misses.
      if (motifErrorCode(error) !== 'miss') throw error
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
      this.writing(hash, 1)
      const write = this.writeTail.then(async () => {
        this.admitWrite(hash, frame, bytes.byteLength)
        const temp = `${stem}.${randomUUID()}.tmp`
        try {
          await fs.mkdir(path.dirname(stem), { recursive: true })
          await fs.writeFile(temp, bytes, { flag: 'wx' })
          await replaceFile(temp, `${stem}.wfrm`)
          this.changed(hash, frame, true, bytes.byteLength)
          notifyResourceCacheWrite()
        } catch (error) { throw diskCoded(error) }
        finally { await fs.rm(temp, { force: true }).catch(() => {}) }
      }).finally(() => this.writing(hash, -1))
      this.writeTail = write.catch(() => {})
      return write
    }
    return {
      encoded,
      png: async png => {
        await fs.mkdir(path.dirname(stem), { recursive: true }).catch(error => { throw diskCoded(error) })
        await encoded(await this.codec.motifEncodePng(Buffer.from(png.buffer, png.byteOffset, png.byteLength)))
      },
    }
  }

  /** False when the next write of any size would be refused, so a frame that
   * can be skipped costs no readback or encoding at the budget. */
  hasRoom(hash: string, frame: number): boolean {
    try { this.admitWrite(hash, frame, 1); return true }
    catch { return false }
  }

  async has(hash: string, frame: number): Promise<boolean> {
    const stem = await this.stem(hash, frame)
    if (!stem) return false
    try { await fs.access(`${stem}.wfrm`); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }

  /** Stat-only (docs/motifs.md#preparation-l2-baking): opening each file costs
   *  ~6 ms cold under on-access scanning. Header, dimensions and the content
   *  checksum are verified by the reader, whose miss drops the frame from coverage and
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
        if (stat.isFile() && stat.size > HEADER_BYTES) frames.push({ frame, bytes: stat.size })
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
