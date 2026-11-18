import { captureImportSession, type MediaImportDeps } from './mediaImport'
import type { MediaItem } from './model'

/** Resume the durable half of imports interrupted between probe, hash and copy:
 * an item still provisional is hashed when its file is there, and an item
 * outside the project folder is copied in. Work is sequential; a large reopen
 * cannot fan out hash readers. */
export async function recoverInterruptedImports(
  deps: MediaImportDeps,
  report: (mediaId: string, error: unknown) => void,
  /** Whether the item's file still holds its bytes; a copy of other bytes
   *  would be discarded anyway (ADR 0153). Absent: every file is copied. */
  holds?: (item: MediaItem) => Promise<boolean>,
): Promise<void> {
  const dir = deps.workspaceDir()
  if (!dir) return
  const assertCurrent = captureImportSession(deps)
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
      if (current?.path_rel === null) {
        if (holds && !(await holds(current))) continue
        assertCurrent()
        await deps.enqueueWorkspaceCopy(item.id, current.path_abs)
      }
    } catch (error) {
      assertCurrent()
      report(item.id, error)
    }
  }
}
