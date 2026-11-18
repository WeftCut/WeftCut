import { expect, it, vi } from 'vitest'
import { createActor } from './actor'
import { blankProject } from './model'
import { seededGen } from './ids'
import { mediaItemTemplate } from './mutations/media'
import { recoverInterruptedImports } from './importRecovery'
import type { HybridDeps } from './hybrids'
import { parseProjectPath } from '../../shared/projectPath'

function setup() {
  const idGen = seededGen()
  const project = blankProject(idGen, 'recovery')
  const pending = { ...mediaItemTemplate(idGen(), 'Audio', 1_000_000, true),
    file_hash_blake3: 'pending-interrupted', path_abs: '/source/clip.wav', path_rel: null }
  const inProject = { ...mediaItemTemplate(idGen(), 'Audio', 1_000_000, true),
    file_hash_blake3: 'copied-content', path_abs: '/workspace/Media/clip.wav', path_rel: parseProjectPath('Media/clip.wav') }
  project.media_pool = { [pending.id]: pending, [inProject.id]: inProject }
  const actor = createActor({ initial: project, idGen })
  const hash = vi.fn(async () => 'content-hash')
  const enqueue = vi.fn(async () => {})
  const copy = vi.fn(async () => {})
  let generation = 0
  const deps: HybridDeps = { actor, compute: { probeMedia: vi.fn(), hashMediaSource: hash, parseSubtitles: vi.fn(), synthesizeSpeechCompute: vi.fn() },
    enqueueDerivatives: enqueue, enqueueWorkspaceCopy: copy, workspaceDir: () => '/workspace', importGeneration: () => generation,
    readFile: vi.fn(), statPath: () => ({ kind: 'file', readable: true }), snapshotComposition: () => ({ width: 16, height: 16, duration_us: 0 }) }
  return { deps, pending, hash, enqueue, copy, invalidate: () => { generation++ } }
}

it('recovers a provisional hash before derivatives and copies in only the item outside the project', async () => {
  const { deps, pending, hash, enqueue, copy } = setup()
  const report = vi.fn()
  await recoverInterruptedImports(deps, report)
  expect(hash).toHaveBeenCalledExactlyOnceWith('/source/clip.wav')
  expect(deps.actor.snapshot().media_pool[pending.id].file_hash_blake3).toBe('content-hash')
  expect(enqueue).toHaveBeenCalledWith([expect.objectContaining({ id: pending.id, file_hash_blake3: 'content-hash' })])
  expect(copy).toHaveBeenCalledExactlyOnceWith(pending.id, '/source/clip.wav')
  expect(report).not.toHaveBeenCalled()
})

it('does not rehash a completed identity while resuming the interrupted copy', async () => {
  const { deps, pending, hash, enqueue, copy } = setup()
  deps.actor.dispatch('set_media_hash', { media: pending.id, file_hash_blake3: 'already-hashed' })
  await recoverInterruptedImports(deps, vi.fn())
  expect(hash).not.toHaveBeenCalled()
  expect(enqueue).not.toHaveBeenCalled()
  expect(copy).toHaveBeenCalledExactlyOnceWith(pending.id, '/source/clip.wav')
})

it('cannot publish a recovered hash after the same project is reopened', async () => {
  const { deps, pending, hash, enqueue, copy, invalidate } = setup()
  let resolve!: (hash: string) => void
  hash.mockImplementation(() => new Promise<string>(r => { resolve = r }))
  const recovery = recoverInterruptedImports(deps, vi.fn())
  invalidate()
  resolve('too-late')
  await expect(recovery).rejects.toThrow(/cancelled/i)
  expect(deps.actor.snapshot().media_pool[pending.id].file_hash_blake3).toBe('pending-interrupted')
  expect(enqueue).not.toHaveBeenCalled()
  expect(copy).not.toHaveBeenCalled()
})

it('keeps the provisional row retryable when its source cannot be hashed', async () => {
  const { deps, pending, hash, enqueue } = setup()
  const error = new Error('source disconnected')
  hash.mockRejectedValue(error)
  const report = vi.fn()
  await recoverInterruptedImports(deps, report)
  expect(report).toHaveBeenCalledWith(pending.id, error)
  expect(deps.actor.snapshot().media_pool[pending.id].file_hash_blake3).toBe('pending-interrupted')
  expect(enqueue).not.toHaveBeenCalled()
})

// Its source was overwritten before the copy ran: a copy now would hold other
// bytes and be discarded, so none is queued.
it('does not resume the copy of a source that no longer holds the item bytes', async () => {
  const { deps, pending, copy } = setup()
  deps.actor.dispatch('set_media_hash', { media: pending.id, file_hash_blake3: 'already-hashed' })
  const holds = vi.fn(async () => false)
  await recoverInterruptedImports(deps, vi.fn(), holds)
  expect(holds).toHaveBeenCalledWith(expect.objectContaining({ id: pending.id }))
  expect(copy).not.toHaveBeenCalled()
})

// An upgrade moves a voiceover from the app cache into Media/ with its hash
// still to read: it is hashed where it now lies and, being in the project
// already, never copied.
it('hashes a provisional item inside the project folder without copying it', async () => {
  const { deps, copy, hash } = setup()
  const voiceover = { ...mediaItemTemplate(seededGen(100)(), 'Audio', 1_000_000, true), file_hash_blake3: 'pending-voiceover',
    path_abs: '/workspace/Media/Voiceover/voiceover-0a1b2c3d.mp3', path_rel: parseProjectPath('Media/Voiceover/voiceover-0a1b2c3d.mp3') }
  expect(deps.actor.dispatch('add_media_item', { media: voiceover }).ok).toBe(true)
  await recoverInterruptedImports(deps, vi.fn())
  expect(hash).toHaveBeenCalledWith(voiceover.path_abs)
  expect(deps.actor.snapshot().media_pool[voiceover.id].file_hash_blake3).toBe('content-hash')
  expect(copy).not.toHaveBeenCalledWith(voiceover.id, expect.anything())
})
