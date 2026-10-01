import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Manifest } from '../../shared/motifs/catalog'
import { motifPosterTime } from '../../shared/motifs/poster'
import type { CaptureArgs } from './capture'

export interface CoverSource { manifest: Manifest; contentHash: string }
interface CoverDeps {
  resolve: (id: string) => CoverSource
  renderVersion: () => string
  capture: (args: CaptureArgs) => Promise<Buffer>
  /** Validate and downsample AFTER capture; changing the viewport changes layout. */
  thumbnail: (png: Buffer) => Buffer
  valid: (png: Buffer) => boolean
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Application-wide derived covers, independent of projects and frame bakes.
 * One atomic slot per identity bounds storage across edits. Failed writes still
 * return the captured image; corrupt/missing slots regenerate. No failed promise
 * or full-size pixel buffer is retained. */
export class MotifCovers {
  private jobs = new Map<string, Promise<Buffer>>()
  constructor(private readonly root: string, private readonly deps: CoverDeps) {}

  /** At startup, before admitting requests, reclaim removed identities and
   * interrupted writes. Source packages are never touched. */
  async prune(ids: readonly string[]): Promise<void> {
    const keep = new Set(ids.map(id => `${digest(id)}.json`))
    const files = await readdir(this.root).catch(() => [])
    await Promise.all(files.filter(file => !keep.has(file) && /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(file))
      .map(file => rm(path.join(this.root, file), { force: true }).catch(() => {})))
  }

  get(id: string, expectedHash: string): Promise<Buffer> {
    try {
      const source = this.deps.resolve(id)
      if (source.contentHash !== expectedHash) throw new Error('Motif changed; reload the catalog')
      const version = this.deps.renderVersion()
      const key = digest(JSON.stringify(['cover-v1', source.contentHash, version]))
      const jobKey = `${id}:${key}`
      const pending = this.jobs.get(jobKey)
      if (pending) return pending
      const job = this.load(id, source, key, version).finally(() => this.jobs.delete(jobKey))
      this.jobs.set(jobKey, job)
      return job
    } catch (error) { return Promise.reject(error) }
  }

  private async load(id: string, source: CoverSource, key: string, version: string): Promise<Buffer> {
    const file = path.join(this.root, `${digest(id)}.json`)
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { key: string; png: string }
      if (saved.key === key && typeof saved.png === 'string') {
        const png = Buffer.from(saved.png, 'base64')
        if (this.deps.valid(png)) return png
      }
    } catch { /* Cache misses and corrupt files are regenerable. */ }
    const { manifest, contentHash } = source
    const png = this.deps.thumbnail(await this.deps.capture({
      motifId: id, contentHash, width: manifest.size[0], height: manifest.size[1],
      propsJson: JSON.stringify(Object.fromEntries(Object.entries(manifest.props_schema).map(([k, v]) => [k, v.default]))),
      tSec: motifPosterTime(manifest), settleRafs: manifest.settle_rafs ?? null,
      fpsNum: 30, fpsDen: 1,
    }))
    // Edits/deletion during capture must not publish old pixels as a new cover.
    if (this.deps.resolve(id).contentHash !== contentHash || this.deps.renderVersion() !== version)
      throw new Error('Motif changed while generating its cover')
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(this.root, { recursive: true })
      await writeFile(temp, JSON.stringify({ key, png: png.toString('base64') }))
      await rename(temp, file)
    } catch { /* A read-only/full cache must not hide an otherwise valid cover. */ }
    finally { await rm(temp, { force: true }).catch(() => {}) }
    return png
  }
}
