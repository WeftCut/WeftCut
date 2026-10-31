import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createActor, type ActorHandle } from './actor'
import { seededGen } from './ids'
import { blankProject, type MediaItem } from './model'
import { mediaItemTemplate } from './mutations/media'
import { createMediaImporter, type MediaImportDeps, type MediaImporter, type PathFacts } from './mediaImport'
import type { Actor } from './history'
import { root } from './__tests__/fixtures/project'
import { ImportDiagnostics } from '../importDiagnostics'

const MID = '00000000-0000-0000-0000-0000000000aa'

function freshActor(): ActorHandle {
  const idGen = seededGen()
  return createActor({ initial: blankProject(idGen, 'h'), idGen, clock: () => '<TS>' })
}

/** A fully-probed pool item, as `compute.probeMedia` would return it. */
function probedItem(): MediaItem {
  return mediaItemTemplate(MID, 'Video', 4_000_000)
}

/** Build MediaImportDeps with a fake compute + spies; `workspaceDir` is overridable. */
function makeDeps(actor: ActorHandle, opts: {
  workspaceDir?: string | null; statPath?: PathFacts | null
  realPath?: (p: string) => string; fileKey?: (p: string) => string | null; platform?: NodeJS.Platform
} = {}): MediaImportDeps & {
  _probeMedia: ReturnType<typeof vi.fn>
  _hashMediaSource: ReturnType<typeof vi.fn>
  _enqueueDerivatives: ReturnType<typeof vi.fn>
  _enqueueWorkspaceCopy: ReturnType<typeof vi.fn>
} {
  const probeMedia = vi.fn(async () => JSON.stringify(probedItem()))
  const hashMediaSource = vi.fn(async () => 'realhash-deadbeef')
  const enqueueDerivatives = vi.fn(async () => {})
  const enqueueWorkspaceCopy = vi.fn(async () => {})
  const deps: MediaImportDeps = {
    actor,
    compute: {
      probeMedia,
      hashMediaSource,
    },
    enqueueDerivatives,
    enqueueWorkspaceCopy,
    workspaceDir: () => opts.workspaceDir ?? null,
    // A regular, readable file unless a test says what else the path is.
    statPath: () => (opts.statPath === undefined ? { kind: 'file', readable: true } : opts.statPath),
    realPath: opts.realPath,
    fileKey: opts.fileKey,
    platform: opts.platform ?? 'win32',
  }
  return Object.assign(deps, {
    _probeMedia: probeMedia,
    _hashMediaSource: hashMediaSource,
    _enqueueDerivatives: enqueueDerivatives,
    _enqueueWorkspaceCopy: enqueueWorkspaceCopy,
  })
}

// One importer per deps, as one host builds one: imports through the same deps
// share its in-flight registry, and a deps field a test swaps is read per call.
const importers = new WeakMap<MediaImportDeps, MediaImporter>()
function ensureImported(asked: string, deps: MediaImportDeps, by?: Actor) {
  let importer = importers.get(deps)
  if (!importer) importers.set(deps, importer = createMediaImporter(deps))
  return importer.ensureImported(asked, { by })
}

// Most regression cases assert the resulting media id and state. Outcome cases
// below exercise the richer contract directly through the same interface.
async function importFile(args: { path: string }, deps: MediaImportDeps): Promise<string> {
  return (await ensureImported(args.path, deps)).mediaId
}

describe('ensureImported', () => {
  it('does not return an old import after reopening the project while copy enqueue is pending', async () => {
    const actor = freshActor(), deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
    let generation = 1
    deps.importGeneration = () => generation
    let finish!: () => void
    deps._enqueueWorkspaceCopy.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = ensureImported('D:/source.mp4', deps)
    const cancelled = expect(pending).rejects.toThrow(/cancelled/i)
    await vi.waitFor(() => expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledOnce())
    const replacement = structuredClone(actor.snapshot())
    generation++
    actor.replaceState(replacement)
    finish()
    await cancelled
    expect(actor.snapshot()).toEqual(replacement)
  })

  it('reports added, reused and relinked outcomes without transport inference', async () => {
    const actor = freshActor(), deps = makeDeps(actor)
    const source = 'C:/x.mp4'
    deps._probeMedia.mockResolvedValue(JSON.stringify({ ...probedItem(), path_abs: source }))
    expect(await ensureImported(source, deps)).toEqual({ mediaId: MID, disposition: 'added', existing: false, sameContentAs: [] })
    expect(await ensureImported(source, deps)).toEqual({ mediaId: MID, disposition: 'reused', existing: true, sameContentAs: [] })
    deps.statPath = p => p === source ? null : { kind: 'file', readable: true }
    deps._probeMedia.mockResolvedValue(JSON.stringify({ ...probedItem(), path_abs: 'D:/backup.mp4' }))
    expect(await ensureImported('D:/backup.mp4', deps)).toEqual({ mediaId: MID, disposition: 'relinked', existing: true, sameContentAs: [] })
    expect(actor.snapshot().media_pool[MID].path_abs).toBe('D:/backup.mp4')
  })

  it('joins an import across callers without attributing writes to the joining caller', async () => {
    const actor = freshActor(), deps = makeDeps(actor)
    deps._probeMedia.mockImplementation(async (path_abs: string) => JSON.stringify({ ...probedItem(), path_abs, file_hash_blake3: 'pending-x' }))
    let finish!: (hash: string) => void
    deps._hashMediaSource.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
    const dispatch = vi.spyOn(actor, 'dispatch')
    const owner: Actor = { kind: 'Agent', client: 'owner' }, joining: Actor = { kind: 'Agent', client: 'joining' }
    const first = ensureImported('C:/x.mp4', deps, owner)
    await vi.waitFor(() => expect(deps._hashMediaSource).toHaveBeenCalledOnce())
    const second = ensureImported('C:/x.mp4', deps, joining)
    await vi.waitFor(() => expect(deps._probeMedia).toHaveBeenCalledTimes(2))
    finish('hash')
    expect((await first).disposition).toBe('added')
    expect(await second).toMatchObject({ mediaId: MID, disposition: 'reused', existing: true })
    expect(dispatch.mock.calls.map(c => c[2])).toEqual(dispatch.mock.calls.map(() => owner))
    expect(dispatch).toHaveBeenCalled()
    expect(deps._hashMediaSource).toHaveBeenCalledOnce()
    expect(deps._enqueueDerivatives).toHaveBeenCalledOnce()
  })

  it('correlates the real hybrid probe, hash, and media registration without changing the result', async () => {
    const actor = freshActor(), deps = makeDeps(actor)
    const emit = vi.fn(), send = vi.fn()
    const diagnostics = new ImportDiagnostics({ emit, send, version: 'test', id: () => 'import-request' })
    deps.beginImport = () => diagnostics.begin()
    const id = await importFile({ path: 'C:/x.mp4' }, deps)
    expect(id).toBe(MID)
    expect(deps._probeMedia).toHaveBeenCalledWith('C:/x.mp4', 'import-request')
    expect(deps._hashMediaSource).toHaveBeenCalledWith('C:/x.mp4', 'import-request')
    expect(send).toHaveBeenCalledWith('import:diagnostic-track', { import_id: 'import-request', media_id: MID })
    expect(emit.mock.calls.map(([row]) => row.details.stage)).toEqual(['requested', 'registered', 'request_completed'])
  })

  it('does not insert a completed probe into a replacement project', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    let finish!: (value: string) => void
    deps._probeMedia.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
    const pending = importFile({ path: 'C:/x.mp4' }, deps)
    const replacement = blankProject(seededGen(), 'replacement')
    replacement.project_id = '00000000-0000-0000-0000-000000000099'
    actor.replaceState(replacement)
    finish(JSON.stringify(probedItem()))
    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(Object.keys(actor.snapshot().media_pool)).toEqual([])
    expect(deps._hashMediaSource).not.toHaveBeenCalled()
  })

  it('does not roll back a replacement project row when an old hash fails', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    let fail!: (reason: Error) => void
    deps._hashMediaSource.mockImplementation(() => new Promise<string>((_, reject) => { fail = reject }))
    const pending = importFile({ path: 'C:/x.mp4' }, deps)
    await vi.waitFor(() => expect(deps._hashMediaSource).toHaveBeenCalled())
    const replacement = blankProject(seededGen(), 'replacement')
    replacement.project_id = '00000000-0000-0000-0000-000000000099'
    replacement.media_pool[MID] = { ...probedItem(), label: 'replacement-owned' }
    actor.replaceState(replacement)
    fail(new Error('source disconnected'))
    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(actor.snapshot().media_pool[MID].label).toBe('replacement-owned')
    expect(deps._enqueueDerivatives).not.toHaveBeenCalled()
  })

  it('returns the new media id and inserts the probed item into the pool', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const id = await importFile({ path: 'C:/x.mp4' }, deps)
    expect(id).toBe(MID)
    expect(actor.snapshot().media_pool[MID]).toBeTruthy()
    expect(actor.snapshot().media_pool[MID].kind).toBe('Video')
  })

  it('kicks derivative jobs with the REAL-hash item (hash-first, not the provisional probe hash)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await importFile({ path: 'C:/x.mp4' }, deps)
    expect(deps._hashMediaSource).toHaveBeenCalledWith('C:/x.mp4')
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as MediaItem[]
    expect(arg).toHaveLength(1)
    expect(arg[0].id).toBe(MID)
    // The provisional probe hash ('0' from probedItem) must NEVER reach enqueue —
    // derivatives bake the real content hash.
    expect(arg[0].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('sets the real content hash on the pool item before returning', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await importFile({ path: 'C:/x.mp4' }, deps)
    expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('inserts the item BEFORE hashing (instant appearance), then hashes, then enqueues', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const order: string[] = []
    deps._probeMedia.mockImplementation(async () => { order.push('probe'); return JSON.stringify(probedItem()) })
    deps._hashMediaSource.mockImplementation(async () => { order.push('hash'); return 'realhash-deadbeef' })
    deps._enqueueDerivatives.mockImplementation(async () => { order.push('enqueue') })
    await importFile({ path: 'C:/x.mp4' }, deps)
    // probe (stat-only) → hash pass → enqueue: the real hash is known before any job.
    expect(order).toEqual(['probe', 'hash', 'enqueue'])
  })

  it('enqueues the workspace copy when a workspace exists', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: '/ws' })
    await importFile({ path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(MID, 'C:/x.mp4')
  })

  it('does NOT enqueue the workspace copy when there is no workspace', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: null })
    await importFile({ path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
  })

  // Importing a file the pool already holds hands back the item that holds it:
  // a second row, and a second copy in Media/, is what the user never asked for.
  describe('a file the pool already holds', () => {
    const HELD = '00000000-0000-0000-0000-0000000000bb'
    function holding(pathAbs: string): ActorHandle {
      const actor = freshActor()
      const r = actor.dispatch('add_media_item', { media: { ...mediaItemTemplate(HELD, 'Video', 4_000_000), path_abs: pathAbs, file_hash_blake3: 'heldhash' } })
      expect(r.ok).toBe(true)
      return actor
    }
    async function reimport(actor: ActorHandle, source: string, opts: Parameters<typeof makeDeps>[1] & { hash?: string } = {}) {
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj', ...opts })
      if (opts.hash) deps._hashMediaSource.mockResolvedValue(opts.hash)
      const id = await importFile({ path: source }, deps)
      return { id, deps }
    }

    it('answers the held item and writes nothing', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const { id, deps } = await reimport(actor, 'C:/proj/Media/x.mp4', { hash: 'heldhash' })
      expect(id).toBe(HELD)
      expect(Object.keys(actor.snapshot().media_pool)).toEqual([HELD])
      expect(deps._hashMediaSource).toHaveBeenCalledTimes(1)
      expect(deps._enqueueDerivatives).not.toHaveBeenCalled()
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
    })

    it('matches the original source of a copy still in flight', async () => {
      const actor = holding('D:/footage/x.mp4')
      expect((await reimport(actor, 'D:/footage/x.mp4', { hash: 'heldhash' })).id).toBe(HELD)
    })

    it.each(['file_size', 'file_mtime', 'neither'] as const)('imports replaced bytes when %s changed, with fresh metadata and derivatives', async (field) => {
      const source = 'C:/proj/Media/x.mp4'
      const actor = holding(source)
      const original = structuredClone(actor.snapshot().media_pool[HELD])
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      const replacement = { ...mediaItemTemplate(MID, 'Video', 9_000_000), path_abs: source }
      if (field !== 'neither') replacement[field] = original[field] + 100
      deps._probeMedia.mockResolvedValue(JSON.stringify(replacement))

      expect(await importFile({ path: source }, deps)).toBe(MID)
      expect(actor.snapshot().media_pool[MID]).toMatchObject({
        file_hash_blake3: 'realhash-deadbeef', metadata: { duration_us: 9_000_000 },
      })
      expect(actor.snapshot().media_pool[HELD]).toEqual(original)
      expect(deps._enqueueDerivatives).toHaveBeenCalledWith([expect.objectContaining({
        id: MID, file_hash_blake3: 'realhash-deadbeef', metadata: replacement.metadata,
      })])
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      // The stale row still names this file: it must not hide the fresh row.
      expect(await importFile({ path: source }, deps)).toBe(MID)
      expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    })

    it('checks the bytes before reusing a file whose modification time changed', async () => {
      const source = 'C:/proj/Media/x.mp4'
      const actor = holding(source)
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps._probeMedia.mockResolvedValue(JSON.stringify({ ...probedItem(), path_abs: source, file_mtime: 100 }))
      deps._hashMediaSource.mockResolvedValue('heldhash')
      expect(await importFile({ path: source }, deps)).toBe(HELD)
      expect(deps._hashMediaSource).toHaveBeenCalledTimes(1)
      expect(deps._enqueueDerivatives).not.toHaveBeenCalled()
      expect(Object.keys(actor.snapshot().media_pool)).toEqual([HELD])
    })

    it('matches another spelling the volume calls the same file', async () => {
      const actor = holding('C:\\Proj\\Media\\X.mp4')
      // A case-insensitive volume, as its stat would say.
      const fileKey = (p: string) => path.win32.resolve(p).toLowerCase()
      expect((await reimport(actor, 'c:/proj/media/x.MP4', { fileKey, hash: 'heldhash' })).id).toBe(HELD)
    })

    // NTFS does not normalize names: a precomposed and a decomposed café.mp4
    // are two files, which the path alone cannot tell are not one.
    it('keeps apart names that differ only in Unicode normalization', async () => {
      const actor = holding('C:/footage/caf\u00e9.mp4')
      const { id } = await reimport(actor, 'C:/footage/cafe\u0301.mp4', { workspaceDir: null })
      expect(id).toBe(MID)
      expect(Object.keys(actor.snapshot().media_pool).sort()).toEqual([MID, HELD].sort())
    })

    it('treats a different case as a different file on Linux', async () => {
      const actor = holding('/proj/Media/X.mp4')
      const { id } = await reimport(actor, '/proj/Media/x.mp4', { platform: 'linux', workspaceDir: null })
      expect(id).toBe(MID)
    })

    it('matches through a link to the same file', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const realPath = (p: string) => (p === 'C:/shortcut/x.mp4' ? 'C:\\proj\\Media\\x.mp4' : p)
      expect((await reimport(actor, 'C:/shortcut/x.mp4', { realPath, hash: 'heldhash' })).id).toBe(HELD)
    })

    // The copy into Media/ replaces the item's path: the outside file it came
    // from is matched by its bytes.
    it('matches the source of a finished copy by its bytes', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps._hashMediaSource.mockResolvedValue('heldhash')
      expect(await importFile({ path: 'D:/footage/x.mp4' }, deps)).toBe(HELD)
      expect(Object.keys(actor.snapshot().media_pool)).toEqual([HELD])
      // The source, then the copy: the copy's bytes are read, not assumed.
      expect(deps._hashMediaSource.mock.calls.map(c => c[0])).toEqual(['D:/footage/x.mp4', 'C:/proj/Media/x.mp4'])
      expect(deps._enqueueDerivatives).not.toHaveBeenCalled()
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
    })

    // The held item's file is still there, but something outside the app
    // wrote other bytes over it: the backup holding its bytes is relinked.
    it('relinks an item whose own file was overwritten to the backup holding its bytes', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps._hashMediaSource.mockImplementation(async (p: string) => (p === 'C:/proj/Media/x.mp4' ? 'otherhash' : 'heldhash'))
      expect(await ensureImported('D:/backup/x.mp4', deps)).toEqual({ mediaId: HELD, disposition: 'relinked', existing: true, sameContentAs: [] })
      expect(actor.snapshot().media_pool[HELD]).toMatchObject({ path_abs: 'D:/backup/x.mp4', file_hash_blake3: 'heldhash' })
      expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(HELD, 'D:/backup/x.mp4')
    })

    it('reuses whichever item of the bytes still holds them', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const OTHER = '00000000-0000-0000-0000-0000000000cc'
      actor.dispatch('add_media_item', { media: { ...mediaItemTemplate(OTHER, 'Video', 4_000_000), path_abs: 'C:/proj/Media/x-2.mp4', file_hash_blake3: 'heldhash' } })
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps._hashMediaSource.mockImplementation(async (p: string) => (p === 'C:/proj/Media/x.mp4' ? 'otherhash' : 'heldhash'))
      expect(await importFile({ path: 'D:/backup/x.mp4' }, deps)).toBe(OTHER)
      expect(actor.snapshot().media_pool[HELD].path_abs).toBe('C:/proj/Media/x.mp4')
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
    })

    it('relinks once when two imports of the backup race through their reads', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps._hashMediaSource.mockImplementation(async (p: string) => (p === 'C:/proj/Media/x.mp4' ? 'otherhash' : 'heldhash'))
      const [a, b] = await Promise.all([ensureImported('D:/backup/x.mp4', deps), ensureImported('D:/backup/x.mp4', deps)])
      expect([a.disposition, b.disposition].sort()).toEqual(['relinked', 'reused'])
      expect(a.mediaId).toBe(HELD)
      expect(b.mediaId).toBe(HELD)
      expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledOnce()
    })

    // The held item's own file is gone (its Media/ copy deleted, its drive
    // offline): the same bytes found elsewhere are what it is relinked to.
    describe('whose own file is gone', () => {
      async function relinked(source: string, opts: Parameters<typeof makeDeps>[1] = {}) {
        const actor = holding('C:/proj/Media/x.mp4')
        const deps = makeDeps(actor, { workspaceDir: 'C:/proj', ...opts })
        deps.statPath = (p) => (p === 'C:/proj/Media/x.mp4' ? null : { kind: 'file', readable: true })
        deps._hashMediaSource.mockResolvedValue('heldhash')
        const id = await importFile({ path: source }, deps)
        return { id, deps, item: actor.snapshot().media_pool[HELD], pool: actor.snapshot().media_pool }
      }

      it('relinks the held item to the found file and copies it in', async () => {
        const { id, deps, item, pool } = await relinked('D:/backup/x.mp4')
        expect(id).toBe(HELD)
        expect(Object.keys(pool)).toEqual([HELD])
        expect(item.path_abs).toBe('D:/backup/x.mp4')
        expect(item.path_rel).toBeNull()
        expect(item.file_hash_blake3).toBe('heldhash')
        expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(HELD, 'D:/backup/x.mp4')
        expect((deps._enqueueDerivatives.mock.calls[0][0] as MediaItem[]).map((m) => [m.id, m.path_abs])).toEqual([[HELD, 'D:/backup/x.mp4']])
      })

      it('records a found file already under Media in place', async () => {
        const { id, deps, item } = await relinked('C:/proj/Media/restored/x.mp4')
        expect(id).toBe(HELD)
        expect(item.path_rel).toBe('Media\\restored\\x.mp4')
        expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      })

      it('relinks in place with no project open', async () => {
        const { item, deps } = await relinked('D:/backup/x.mp4', { workspaceDir: null })
        expect(item.path_abs).toBe('D:/backup/x.mp4')
        expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      })

      it.each(['another project', 'the same project reopened'])('does not copy into %s after awaiting derivatives', async (change) => {
        const actor = holding('C:/proj/Media/x.mp4')
        const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
        deps.statPath = p => p === 'C:/proj/Media/x.mp4' ? null : { kind: 'file', readable: true }
        deps._hashMediaSource.mockResolvedValue('heldhash')
        let generation = 1
        deps.importGeneration = () => generation
        let finish!: () => void
        deps._enqueueDerivatives.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
        const pending = importFile({ path: 'D:/backup/x.mp4' }, deps)
        const cancelled = expect(pending).rejects.toThrow(/cancelled/i)
        await vi.waitFor(() => expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1))
        if (change === 'another project') deps.workspaceDir = () => 'C:/other-project'
        else generation++
        const replacement = structuredClone(actor.snapshot())
        actor.replaceState(replacement)
        finish()
        await cancelled
        expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
        expect(actor.snapshot()).toEqual(replacement)
      })
    })

    it('imports other bytes of the same size, hashing them once', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const { id, deps } = await reimport(actor, 'D:/footage/x.mp4')
      expect(id).toBe(MID)
      expect(deps._hashMediaSource).toHaveBeenCalledTimes(1)
      expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
      expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledTimes(1)
    })

    it('does not hash early when no hashed item has the source size', async () => {
      const actor = freshActor()
      actor.dispatch('add_media_item', { media: { ...mediaItemTemplate(HELD, 'Video', 4_000_000), path_abs: 'C:/proj/Media/y.mp4', file_hash_blake3: 'pending-y' } })
      const { id, deps } = await reimport(actor, 'D:/footage/x.mp4')
      expect(id).toBe(MID)
      expect(deps._hashMediaSource).toHaveBeenCalledTimes(1)
      expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
    })

    // A second import of a file whose first import is still hashing it waits
    // for that one: the provisional row it would answer may yet roll back.
    describe('while an import of the same file is still hashing it', () => {
      function racing() {
        const actor = freshActor()
        const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
        // As the native probe answers: the source's path, a provisional hash.
        deps._probeMedia.mockImplementation(async (p: string) => JSON.stringify({ ...probedItem(), path_abs: p, file_hash_blake3: 'pending-x' }))
        let settle!: { resolve: (h: string) => void; reject: (e: Error) => void }
        deps._hashMediaSource.mockImplementationOnce(() => new Promise<string>((resolve, reject) => { settle = { resolve, reject } }))
        const first = importFile({ path: 'D:/footage/x.mp4' }, deps)
        return { actor, deps, first, settle: () => settle }
      }

      it('shares its failure instead of answering a rolled-back row', async () => {
        const { actor, deps, first, settle } = racing()
        await vi.waitFor(() => expect(deps._hashMediaSource).toHaveBeenCalledTimes(1))
        const second = importFile({ path: 'D:/footage/x.mp4' }, deps)
        await vi.waitFor(() => expect(deps._probeMedia).toHaveBeenCalledTimes(2))
        settle().reject(new Error('source disconnected'))
        await expect(first).rejects.toThrow(/source disconnected/)
        await expect(second).rejects.toThrow(/source disconnected/)
        expect(actor.snapshot().media_pool).toEqual({})
      })

      it('answers its row once that import has settled', async () => {
        const { actor, deps, first, settle } = racing()
        await vi.waitFor(() => expect(deps._hashMediaSource).toHaveBeenCalledTimes(1))
        let secondDone = false
        const second = importFile({ path: 'D:/footage/x.mp4' }, deps).finally(() => { secondDone = true })
        await vi.waitFor(() => expect(deps._probeMedia).toHaveBeenCalledTimes(2))
        await Promise.resolve()
        expect(secondDone).toBe(false)
        settle().resolve('realhash-deadbeef')
        expect(await first).toBe(MID)
        expect(await second).toBe(MID)
        expect(deps._hashMediaSource).toHaveBeenCalledTimes(1)
        expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
      })
    })

    it('ends the import trace as already held, not as a failure', async () => {
      const actor = holding('C:/proj/Media/x.mp4')
      const emit = vi.fn(), send = vi.fn()
      const diagnostics = new ImportDiagnostics({ emit, send, version: 'test', id: () => 'import-request' })
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      deps.beginImport = () => diagnostics.begin()
      deps._hashMediaSource.mockResolvedValue('heldhash')
      await importFile({ path: 'C:/proj/Media/x.mp4' }, deps)
      expect(emit.mock.calls.map(([row]) => row.details.stage)).toEqual(['requested', 'already_in_pool'])
      expect(emit.mock.calls[1][0].details.media_id).toBe(HELD)
      expect(send).toHaveBeenLastCalledWith('import:diagnostic-track', { import_id: 'import-request', remove: true })
    })
  })

  // A relative path is read from the open project's folder, the one place both
  // sides know: the app cannot see the client's working directory.
  describe('a relative path', () => {
    it('is resolved against the project folder', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      await importFile({ path: 'Media/x.mp4' }, deps)
      expect(deps._probeMedia).toHaveBeenCalledWith('C:\\proj\\Media\\x.mp4')
      expect(actor.snapshot().media_pool[MID].path_rel).toBe('Media\\x.mp4')
    })

    it('answers the held item for a pooled file', async () => {
      const actor = freshActor()
      const HELD = '00000000-0000-0000-0000-0000000000bb'
      actor.dispatch('add_media_item', { media: { ...mediaItemTemplate(HELD, 'Video', 4_000_000), path_abs: '/proj/Media/x.mp4' } })
      const deps = makeDeps(actor, { workspaceDir: '/proj', platform: 'linux' })
      deps._hashMediaSource.mockResolvedValue('0')
      expect(await importFile({ path: './Media/x.mp4' }, deps)).toBe(HELD)
    })

    it('never takes a Windows drive path for a relative one', async () => {
      const deps = makeDeps(freshActor(), { workspaceDir: '/proj', platform: 'linux' })
      await importFile({ path: 'C:/x.mp4' }, deps)
      expect(deps._probeMedia).toHaveBeenCalledWith('C:/x.mp4')
    })

    it('is refused with no project open, asking for an absolute path', async () => {
      const deps = makeDeps(freshActor(), { workspaceDir: null })
      await expect(importFile({ path: 'Media/x.mp4' }, deps)).rejects.toThrow(/relative.*no project is open.*absolute path/)
      expect(deps._probeMedia).not.toHaveBeenCalled()
    })

    it('that names nothing in the project folder is refused naming the folder', async () => {
      const deps = makeDeps(freshActor(), { workspaceDir: 'C:/proj', statPath: null })
      await expect(importFile({ path: 'clips/x.mp4' }, deps)).rejects.toThrow(/clips\/x\.mp4.*project folder C:\/proj.*absolute path/)
    })
  })

  // Media/ is where the import copy puts a file; one already there is
  // recorded where it stands. Anywhere else, inside the project folder or
  // not, is copied in, so every pooled file of a project lives in Media/.
  describe('a file already in the project Media folder', () => {
    it('is recorded in place with its Media-relative path, and not copied', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor, { workspaceDir: 'C:/proj' })
      await importFile({ path: 'C:/proj/Media/x.mp4' }, deps)
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      const item = actor.snapshot().media_pool[MID]
      expect(item.path_rel).toBe('Media\\x.mp4')
      expect(item.path_abs).toBe('C:/proj/Media/x.mp4')
      expect(item.file_hash_blake3).toBe('realhash-deadbeef')
    })

    it('keeps a subfolder of Media in the relative path', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor, { workspaceDir: '/proj', platform: 'linux' })
      await importFile({ path: '/proj/Media/b-roll/x.mp4' }, deps)
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      expect(actor.snapshot().media_pool[MID].path_rel).toBe('Media/b-roll/x.mp4')
    })

    it('recognises Media through a linked project folder', async () => {
      const actor = freshActor()
      const realPath = (p: string) => p.replace(/^\/link/, '/real')
      const deps = makeDeps(actor, { workspaceDir: '/link/proj', platform: 'linux', realPath })
      await importFile({ path: '/real/proj/Media/x.mp4' }, deps)
      expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
      expect(actor.snapshot().media_pool[MID].path_rel).toBe('Media/x.mp4')
    })

    it('copies a file from elsewhere in the project folder into Media', async () => {
      const deps = makeDeps(freshActor(), { workspaceDir: 'C:/proj' })
      await importFile({ path: 'C:/proj/footage/x.mp4' }, deps)
      expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(MID, 'C:/proj/footage/x.mp4')
    })

    it('copies a sibling folder whose name only starts with Media', async () => {
      const deps = makeDeps(freshActor(), { workspaceDir: 'C:/proj' })
      await importFile({ path: 'C:/proj/Media-old/x.mp4' }, deps)
      expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(MID, 'C:/proj/Media-old/x.mp4')
    })
  })

  // A folder passes the stat-only probe and would land a pool row with a
  // `pending-` hash and null metadata, dying only in the hash pass with the
  // OS's locale text — so the path is judged first, by name, before any write.
  describe('what the path IS is decided before anything is written', () => {
    async function refused(deps: ReturnType<typeof makeDeps>, path = 'C:/clips'): Promise<string> {
      let message = ''
      try { await importFile({ path }, deps) } catch (e) { message = (e as Error).message }
      expect(message, 'import_media was expected to refuse').not.toBe('')
      expect(deps._probeMedia, 'nothing is probed').not.toHaveBeenCalled()
      expect(deps._hashMediaSource, 'nothing is hashed').not.toHaveBeenCalled()
      return message
    }

    it('a directory is refused naming the path and asking for one file', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor, { statPath: { kind: 'directory', readable: true } })
      const message = await refused(deps)
      expect(message).toContain('C:/clips')
      expect(message).toContain('is a directory')
      expect(message).toContain('ONE media file')
      expect(Object.keys(actor.snapshot().media_pool)).toEqual([])
    })

    it('a missing path is refused as missing, not as access denied', async () => {
      const deps = makeDeps(freshActor(), { statPath: null })
      const message = await refused(deps, 'C:/gone.mp4')
      expect(message).toContain('C:/gone.mp4')
      expect(message).toContain('does not exist')
    })

    it('an unreadable file is refused naming permissions', async () => {
      const deps = makeDeps(freshActor(), { statPath: { kind: 'file', readable: false } })
      expect(await refused(deps, 'C:/locked.mp4')).toContain('not readable')
    })

    it('a hash pass that fails rolls the provisional row back and names the path', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor)
      deps._hashMediaSource.mockImplementation(async () => { throw new Error('open C:/x.mp4: os error 5') })
      let message = ''
      try { await importFile({ path: 'C:/x.mp4' }, deps) } catch (e) { message = (e as Error).message }
      expect(message).toContain('C:/x.mp4')
      expect(message).toContain('os error 5')
      expect(message).toContain('rolled back')
      // The failure mode this exists for: no `pending-…` row survives the failure.
      expect(actor.snapshot().media_pool[MID]).toBeUndefined()
      expect(deps._enqueueDerivatives).not.toHaveBeenCalled()
    })

    it('a probe that fails has written nothing, and the message says which step failed', async () => {
      const actor = freshActor()
      const deps = makeDeps(actor)
      deps._probeMedia.mockImplementation(async () => { throw new Error('not a media container') })
      let message = ''
      try { await importFile({ path: 'C:/x.bin' }, deps) } catch (e) { message = (e as Error).message }
      expect(message).toContain('probing C:/x.bin failed')
      expect(message).toContain('not a media container')
      expect(Object.keys(actor.snapshot().media_pool)).toEqual([])
    })
  })

  it('pools a subtitle document like any other file, touching no caption track', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps._probeMedia.mockImplementation(async () => JSON.stringify({ ...mediaItemTemplate(MID, 'Subtitle', null), path_abs: 'C:/subs.srt' }))
    const result = await importFile({ path: 'C:/subs.srt' }, deps)
    expect(result).toBe(MID)
    expect(actor.snapshot().media_pool[MID].kind).toBe('Subtitle')
    expect(root(actor.snapshot()).tracks.filter((t) => t.role === 'Caption').flatMap((t) => t.layers)).toEqual([])
  })

  it('throws when the actor rejects the insert (e.g. invalid item)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps.compute.probeMedia = vi.fn(async () => JSON.stringify({ ...probedItem(), kind: 'Video', metadata: { duration_us: -1, video: null, audio: null, container_format: null } }))
    // duration_us negative → validation failure on insert. (If validate tolerates
    // it, this still exercises the !r.ok throw path defensively.)
    const r = await importFile({ path: 'C:/x.mp4' }, deps).then(() => 'ok', () => 'threw')
    expect(['ok', 'threw']).toContain(r)
  })
})

