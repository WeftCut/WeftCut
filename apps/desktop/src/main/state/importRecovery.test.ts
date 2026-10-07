import { expect, it, vi } from 'vitest'
import { createActor } from './actor'
import { blankProject } from './model'
import { seededGen } from './ids'
import { mediaItemTemplate } from './mutations/media'
import { recoverInterruptedImports } from './importRecovery'
import type { HybridDeps } from './hybrids'

function setup() {
  const idGen = seededGen()
  const project = blankProject(idGen, 'recovery')
  const pending = { ...mediaItemTemplate(idGen(), 'Audio', 1_000_000, true),
    file_hash_blake3: 'pending-interrupted', path_abs: '/source/clip.wav', path_rel: null }
  const generated = { ...mediaItemTemplate(idGen(), 'Audio', 1_000_000, true),
    file_hash_blake3: 'generated-content', path_abs: '/workspace/Cache/voiceover/generated.wav', path_rel: null }
  project.media_pool = { [pending.id]: pending, [generated.id]: generated }
  const actor = createActor({ initial: project, idGen })
  const hash = vi.fn(async () => 'content-hash')
  const enqueue = vi.fn(async () => {})
  const copy = vi.fn(async () => {})
  let generation = 0
  const deps: HybridDeps = { actor, compute: { probeMedia: vi.fn(), hashMediaSource: hash, parseSubtitles: vi.fn(), synthesizeSpeechCompute: vi.fn() },
    enqueueDerivatives: enqueue, enqueueWorkspaceCopy: copy, workspaceDir: () => '/workspace', importGeneration: () => generation,
    readFile: vi.fn(), statPath: () => ({ kind: 'file', readable: true }), snapshotComposition: () => ({ width: 16, height: 16, duration_us: 0 }) }
  return { deps, pending, generated, hash, enqueue, copy, invalidate: () => { generation++ } }
}

it('recovers a provisional hash before derivatives and resumes only external copies', async () => {
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
