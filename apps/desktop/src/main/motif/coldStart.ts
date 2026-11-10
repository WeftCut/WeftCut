// Dev-only Motif cold start: drops a closed project's on-disk Motif frame cache
// and retires every capture host, so the project's next open warms the host
// pool and the preview as a first open with an empty cache does. The renderer
// drives the close and reopen (renderer/app/motifColdStart.ts).
import fs from 'node:fs'
import path from 'node:path'

import type { MotifColdStartResult } from '../../shared/ipc'

export interface MotifColdStartDeps {
  /// False outside a dev build; every call is refused.
  enabled: boolean
  /// Folders main has open or is opening. Main holds coverage and bake state
  /// for an open project's cache, so its files are never deleted under it.
  openFolders: () => readonly (string | null | undefined)[]
  /// A project open or close is in flight; its folder is not yet known.
  transitioning: () => boolean
  retireHosts: () => void
  log: (line: string) => void
}

const canonical = (p: string): string => {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

/// Deletes `<dir>/Cache/raster` and nothing else, after retiring every capture
/// host. Refuses a folder that is not a closed WeftCut project, and a raster
/// folder that resolves outside the project (a symlinked `Cache`).
export async function motifColdStart(dir: unknown, deps: MotifColdStartDeps): Promise<MotifColdStartResult> {
  if (!deps.enabled) throw new Error('Motif cold start is available in dev builds only')
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Motif cold start needs an absolute project folder')
  const root = canonical(dir)
  if (!fs.statSync(path.join(root, 'project.json'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Motif cold start needs a WeftCut project folder')
  }
  if (deps.transitioning() || deps.openFolders().some(open => open && canonical(open) === root)) {
    throw new Error('Close the project before dropping its Motif cache')
  }
  const raster = path.join(root, 'Cache', 'raster')
  const cached = fs.existsSync(raster)
  if (cached && path.relative(root, canonical(raster)) !== path.join('Cache', 'raster')) {
    throw new Error('The Motif frame cache resolves outside the project folder')
  }
  deps.retireHosts()
  if (!cached) {
    deps.log('[motif] cold start: no frame cache on disk; capture hosts retired')
    return { files: 0, bytes: 0 }
  }
  const removed = { files: 0, bytes: 0 }
  for (const entry of await fs.promises.readdir(raster, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    removed.files++
    removed.bytes += (await fs.promises.stat(path.join(entry.parentPath, entry.name))).size
  }
  await fs.promises.rm(raster, { recursive: true, force: true })
  deps.log(`[motif] cold start: removed ${removed.files} cached frames (${(removed.bytes / 1048576).toFixed(1)} MiB); capture hosts retired`)
  return removed
}
