import type { HybridDeps } from './hybrids'
import { captureImportSession } from './hybrids'

/** Resume the durable half of imports interrupted between probe, hash and copy.
 * Generated Cache/ sources are already workspace-owned and must not be copied
 * into Media/. Work is sequential; a large reopen cannot fan out hash readers. */
export async function recoverInterruptedImports(
  deps: HybridDeps,
  report: (mediaId: string, error: unknown) => void,
): Promise<void> {
  const dir = deps.workspaceDir()
  if (!dir) return
  const assertCurrent = captureImportSession(deps)
  const normalized = (p: string) => p.replaceAll('\\', '/').replace(/\/$/, '')
  const cachePrefix = normalized(dir) + '/Cache/'
  const items = Object.values(deps.actor.snapshot().media_pool)
    .filter(item => item.file_hash_blake3.startsWith('pending-') || item.path_rel === null)
  for (const item of items) {
    assertCurrent()
    try {
      const facts = deps.statPath(item.path_abs)
      if (!facts || facts.kind !== 'file' || !facts.readable) continue
      let current = deps.actor.snapshot().media_pool[item.id]
      if (!current || current.path_abs !== item.path_abs) continue
      if (current.file_hash_blake3.startsWith('pending-')) {
        const hash = await deps.compute.hashMediaSource(item.path_abs)
        assertCurrent()
        current = deps.actor.snapshot().media_pool[item.id]
        if (!current || current.path_abs !== item.path_abs) continue
        const result = deps.actor.dispatch('set_media_hash', { media: item.id, file_hash_blake3: hash })
        if (!result.ok) continue
        await deps.enqueueDerivatives([{ ...current, file_hash_blake3: hash }])
        assertCurrent()
      }
      // A producer may have completed the copy while the hash was running.
      current = deps.actor.snapshot().media_pool[item.id]
      if (current?.path_rel === null && !normalized(current.path_abs).startsWith(cachePrefix)) {
        await deps.enqueueWorkspaceCopy(item.id, current.path_abs)
      }
    } catch (error) {
      assertCurrent()
      report(item.id, error)
    }
  }
}
