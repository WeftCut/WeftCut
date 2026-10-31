// Owns a file's path-to-pool lifecycle for UI imports and agent file references.
// Reading media://{id} stays a separate, read-only operation.
import type { ActorHandle } from './actor'
import type { Actor } from './history'
import type { MediaItem } from './model'
import { McpArgError, mapCommandError } from './mcp-commands'
import type { ImportTrace } from '../importDiagnostics'
import { absoluteSource, mediaFolderPath, nextImportStep, spelledKey, type FileKey, type Holding } from './importSource'

export type MediaImportDeps = {
  beginImport?: () => ImportTrace
  actor: ActorHandle
  compute: {
    probeMedia(path: string, importId?: string): Promise<string>
    hashMediaSource(path: string, importId?: string): Promise<string>
  }
  /** Kick the existing derivative jobs (proxy/conform/thumb/waveform) for a set
   *  of pool items — thin wrapper over the Backend `enqueueJobsForMedia` napi. */
  enqueueDerivatives: (items: unknown[]) => Promise<void>
  /** Queue the background workspace-copy job for an inserted media item. No-op
   *  napi when no workspace; the copy's path/hash write-back is seam-routed. */
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<void>
  /** Current workspace dir, or null. Gate for the workspace-copy enqueue. */
  workspaceDir: () => string | null
  /** Changes on close/reopen, even when the same project id and path return. */
  importGeneration?: () => number
  canImport?: () => boolean
  /** node:fs stat, folded to what `import_media` refuses on: what the path IS,
   *  and whether this process may read it. `null` when nothing is there. */
  statPath: (p: string) => PathFacts | null
  /** node:fs realpath, answering its input when the path cannot be resolved.
   *  Absent: paths are compared as spelled. */
  realPath?: (p: string) => string
  /** Which file a path names, from a stat (volume + file number); null when
   *  nothing is there. Absent: the real path as spelled stands in. */
  fileKey?: FileKey
  /** Whose path rules compare import sources. Absent: this process's. */
  platform?: NodeJS.Platform
  /** Draws an `.svg` to a PNG and returns its path (svgRaster.ts); the PNG is
   *  what `import_media` imports. Absent: an SVG is refused. */
  rasterizeSvg?: (p: string) => Promise<string>
}

/** What a stat says about a path, in the three words `import_media` cares
 *  about. `other` is a device, socket or the like — a stat succeeded, and it is
 *  still nothing a media file can be. */
export type PathFacts = { kind: 'file' | 'directory' | 'other'; readable: boolean }

/** The import stage is settled; derivative preparation and copying may still
 * run in the background. existing preserves the wire meaning: held at entry. */
export interface ImportOutcome {
  mediaId: string
  disposition: 'added' | 'reused' | 'relinked'
  existing: boolean
  sameContentAs: string[]
}

const errText = (e: unknown): string => e instanceof Error ? e.message : String(e)

/** One project host's imports. Built once per actor, so imports of the same
 *  file from the renderer and from any agent share one in-flight registry. */
export interface MediaImporter {
  /** Match a file to the pool, importing or relinking when necessary. All
   *  waits, session checks and provisional-row cleanup belong to this module.
   *  `by` attributes this call's writes; a call that joins another import in
   *  flight writes nothing under it. */
  ensureImported(asked: string, opts?: { by?: Actor }): Promise<ImportOutcome>
}

export function createMediaImporter(deps: MediaImportDeps): MediaImporter {
  // Each import between its provisional row and its settling, by media id: an
  // import of the same file meanwhile answers what that one does.
  const inFlight = new Map<string, Promise<string>>()
  return {
    ensureImported(asked, { by } = {}) {
      return ensureImported(asked, deps, (command, args) => deps.actor.dispatch(command, args, by), inFlight)
    },
  }
}

/** An actor write attributed to the importing caller. */
type Write = (command: string, args: Record<string, unknown>) => ReturnType<ActorHandle['dispatch']>

async function ensureImported(asked: string, deps: MediaImportDeps, write: Write, inFlight: Map<string, Promise<string>>): Promise<ImportOutcome> {
  if (deps.canImport?.() === false) throw new Error('Project is changing; retry importing after it opens')
  const trace = deps.beginImport?.()
  const priorIds = new Set(Object.keys(deps.actor.snapshot().media_pool))
  const outcome = (mediaId: string, disposition: ImportOutcome['disposition']): ImportOutcome => {
    const pool = deps.actor.snapshot().media_pool
    const hash = pool[mediaId]?.file_hash_blake3
    return { mediaId, disposition, existing: priorIds.has(mediaId), sameContentAs: hash === undefined ? []
      : Object.values(pool).filter(m => m.id !== mediaId && m.file_hash_blake3 === hash).map(m => m.id) }
  }
  try {
    const realPath = deps.realPath ?? ((p: string) => p)
    const platform = deps.platform ?? process.platform
    const fileKey = deps.fileKey ?? spelledKey(realPath, platform)
    const projectDir = deps.workspaceDir()
    const resolved = absoluteSource(projectDir, asked, platform)
    if (resolved === null) throw new McpArgError(`path ${asked} is relative and no project is open to read it from — pass the absolute path of the file`, 'path')
    let path = resolved
    const assertCurrent = captureImportSession(deps)
    // Stat FIRST. The probe is stat-only when ffprobe is absent, so a folder
    // would pass it, land a pool row with null metadata and a pending hash,
    // and only then die in the hash pass with the OS's own locale text. What
    // the path IS is decided here, by name, before any read or write.
    const facts = deps.statPath(path)
    if (facts === null && path !== asked) throw new McpArgError(`path ${asked} names nothing in the project folder ${projectDir} — a relative path is read from there; pass the absolute path of the file`, 'path')
    if (facts === null) throw new McpArgError(`path ${path} does not exist, or is not reachable from this machine — import_media takes the absolute path of ONE media file (project://media lists what is already imported)`, 'path')
    if (facts.kind === 'directory') throw new McpArgError(`path ${path} is a directory — import_media takes ONE media file; call it once per file inside`, 'path')
    if (facts.kind !== 'file') throw new McpArgError(`path ${path} is not a regular file — import_media takes a media file`, 'path')
    if (!facts.readable) throw new McpArgError(`path ${path} is not readable by this process — check its permissions, then retry`, 'path')
    // A drawing comes in as an SVG and goes into the pool as a PNG of it.
    if (/\.svg$/i.test(path)) {
      if (!deps.rasterizeSvg) throw new McpArgError(`path ${path} is an SVG, which this host cannot draw — import a PNG of it`, 'path')
      try { path = await deps.rasterizeSvg(path) }
      catch (e) { throw new McpArgError(`import_media: drawing ${path} failed: ${errText(e)}. Nothing was imported`, 'path') }
    }
    // Insert the probed item FIRST so the clip appears in the timeline
    // immediately. A probe that fails has written nothing; it says so.
    let item: MediaItem
    try { item = JSON.parse(await (trace ? deps.compute.probeMedia(path, trace.id) : deps.compute.probeMedia(path))) as MediaItem }
    catch (e) { throw new Error(`import_media: probing ${path} failed: ${errText(e)}. Nothing was imported`) }
    assertCurrent()
    const hashSource = () => (trace ? deps.compute.hashMediaSource(path, trace.id) : deps.compute.hashMediaSource(path))
    const workspaceDir = deps.workspaceDir()
    const inMedia = workspaceDir ? mediaFolderPath(workspaceDir, path, realPath, fileKey, platform) : null
    // Every await below is followed by a fresh decision over the pool as it
    // is then, so the final one runs in the same turn as its write: two
    // imports racing through their reads still land one row, one relink.
    let hash: string | null = null
    const holdings = new Map<string, Holding>()
    for (;;) {
      const step = nextImportStep({
        pool: deps.actor.snapshot().media_pool, source: path, found: item, fileKey, hash,
        inFlight: id => inFlight.has(id), holding: m => holdings.get(holdingKey(m)),
      })
      if (step.kind === 'add') break
      if (step.kind === 'hash') {
        try { hash = await hashSource() }
        catch (e) { throw new Error(`import_media: reading ${path} for its content hash failed: ${errText(e)}. Nothing was imported`) }
      } else if (step.kind === 'verify') {
        holdings.set(holdingKey(step.item), await holdingOf(step.item, deps))
      } else if (step.kind === 'join') {
        // Not held yet: its hash read may fail and roll it back, so this
        // import answers what that one does.
        await inFlight.get(step.id)
        assertCurrent()
        trace?.held(step.id)
        return outcome(step.id, 'reused')
      } else if (step.kind === 'reuse') {
        trace?.held(step.id)
        return outcome(step.id, 'reused')
      } else {
        const held = deps.actor.snapshot().media_pool[step.id]
        const relinked = relink(held, item, path, workspaceDir, inMedia, assertCurrent, write, deps).then(() => held.id)
        inFlight.set(held.id, relinked)
        try { await relinked }
        finally { inFlight.delete(held.id) }
        assertCurrent()
        trace?.held(held.id)
        return outcome(held.id, 'relinked')
      }
      assertCurrent()
    }
    const r = write('add_media_item', { media: item })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    trace?.bind(item, Boolean(workspaceDir) && !inMedia)
    const settled = settleImport(item, path, hash, { hashSource, workspaceDir, inMedia, assertCurrent, write, trace }, deps)
    inFlight.set(item.id, settled)
    try {
      const mediaId = await settled
      assertCurrent()
      return outcome(mediaId, 'added')
    }
    finally { inFlight.delete(item.id) }
  } catch (error) { trace?.fail(error); throw error }
}

/** A Holding read stands for the item as it was read: moved or rehashed, it
 *  is read again. */
const holdingKey = (m: MediaItem) => `${m.id}\n${m.path_abs}\n${m.file_hash_blake3}`

/** Read whether `item`'s own file still holds the bytes it records. A file the
 *  stat or the read cannot reach is gone, as far as this import can tell.
 *  Neither a file number nor size and second-resolution mtime survive every
 *  overwrite, so the bytes themselves are read. */
async function holdingOf(item: MediaItem, deps: MediaImportDeps): Promise<Holding> {
  const facts = deps.statPath(item.path_abs)
  if (facts?.kind !== 'file' || !facts.readable) return 'gone'
  try { return (await deps.compute.hashMediaSource(item.path_abs)) === item.file_hash_blake3 ? 'holds' : 'replaced' }
  catch { return 'gone' }
}

/** Point `held`, whose own file no longer holds its bytes (gone or
 *  overwritten), at `path`, a file `found` by its probe to hold them: recorded
 *  in place under Media/, else copied in as an import's source is. Its
 *  derivatives regenerate whatever left with the file. */
async function relink(
  held: MediaItem, found: MediaItem, path: string, workspaceDir: string | null, inMedia: string | null,
  assertCurrent: () => void, write: Write, deps: MediaImportDeps,
): Promise<void> {
  const r = write('set_media_workspace_paths', { media: held.id, paths: {
    path_abs: path, path_rel: inMedia, file_hash_blake3: held.file_hash_blake3, file_size: found.file_size, file_mtime: found.file_mtime } })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  await deps.enqueueDerivatives([deps.actor.snapshot().media_pool[held.id]])
  assertCurrent()
  if (workspaceDir && !inMedia) await deps.enqueueWorkspaceCopy(held.id, path)
}

/** The rest of an import once its provisional row is in the pool: the real
 *  hash, derivatives, then the workspace copy. A failed hash read rolls the row
 *  back. Shared with any import of the same file that lands meanwhile. */
async function settleImport(item: MediaItem, path: string, hashed: string | null, ctx: {
  hashSource: () => Promise<string>; workspaceDir: string | null; inMedia: string | null
  assertCurrent: () => void; write: Write; trace: ImportTrace | undefined
}, deps: MediaImportDeps): Promise<string> {
  const { hashSource, workspaceDir, inMedia, assertCurrent, write, trace } = ctx
  let hash = hashed
  // Compute the REAL content hash (a lightweight standalone read pass), set it
  // on the pool item, THEN enqueue derivatives — so every job bakes the final
  // cache key and no derivative ever touches a pending alias. One
  // extra full read of the source, accepted to start
  // derivatives promptly instead of waiting for the workspace copy. Skipped
  // when the source was hashed before the insert.
  if (hash === null) {
    try { hash = await hashSource() }
    catch (e) {
      assertCurrent()
      // The row is provisional until its hash lands, so a read that fails
      // here leaves nothing behind. `force: false`: were a layer already
      // placed on it, the row stays and the error still names the failure.
      const rollback = write('remove_media', { media: item.id, force: false })
      throw new Error(`import_media: reading ${path} for its content hash failed: ${errText(e)}. ${rollback.ok
        ? 'The provisional pool row was rolled back; nothing was imported'
        : `The provisional pool row ${item.id} could not be rolled back (${mapCommandError(rollback.error).message}); it stays with a pending hash — delete_media removes it`}`)
    }
    assertCurrent()
  }
  const hr = write('set_media_hash', { media: item.id, file_hash_blake3: hash })
  // Benign if the media was removed during hashing — nothing left to enqueue.
  if (!hr.ok) { trace?.fail('Media removed during hashing'); return item.id }
  const hashedItem: MediaItem = { ...item, file_hash_blake3: hash }
  // Derivative jobs read the SOURCE (hashedItem.path_abs is still the original);
  // content-addressed by the real hash, so source vs the workspace copy is
  // equivalent.
  await deps.enqueueDerivatives([hashedItem])
  assertCurrent()
  // Workspace copy runs in PARALLEL: copies the source into <workspace>/Media,
  // re-confirms the same hash, and flips path_abs via the media:workspace_paths
  // seam. No-op napi when no workspace. A source already under Media/ is
  // where the copy would land: it is recorded in place instead.
  if (inMedia) {
    const wr = write('set_media_workspace_paths', { media: item.id, paths: {
      path_abs: path, path_rel: inMedia, file_hash_blake3: hash, file_size: item.file_size, file_mtime: item.file_mtime } })
    if (!wr.ok) throw new Error(JSON.stringify(wr.error))
  } else if (workspaceDir) await deps.enqueueWorkspaceCopy(item.id, path)
  assertCurrent()
  trace?.queued()
  return item.id
}

/** A project opening owns each asynchronous import continuation. Checking the
 * generation also covers reopening a copy with the same persisted project id. */
export function captureImportSession(deps: Pick<MediaImportDeps, 'actor' | 'workspaceDir' | 'importGeneration'>): () => void {
  const projectId = deps.actor.snapshot().project_id
  const dir = deps.workspaceDir()
  const generation = deps.importGeneration?.()
  return () => {
    if (deps.actor.snapshot().project_id !== projectId || deps.workspaceDir() !== dir || deps.importGeneration?.() !== generation) {
      throw new Error('Import cancelled because the project was closed or replaced')
    }
  }
}
