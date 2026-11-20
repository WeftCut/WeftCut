// The open project's `Fonts/` watch: a non-recursive twin of
// `watchProjectMotifs` (../motif/watcher.ts). It only tells that the folder
// changed; the project font store re-indexes and never copies on it (a file
// deleted by hand is copied again at the next reconcile, ADR 0176).
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { Debouncer, DEBOUNCE_QUIET_MS } from '../motif/watcher'

export interface FontsWatcher { close(): void }

/** See `canonicalDir` in ../motif/watcher.ts: libuv wants the long-name
 *  spelling of a watched directory on Windows. */
function canonicalDir(dir: string): string {
  try { return realpathSync.native(dir) } catch { return dir }
}

/** Calls `onChange` once per quiet window after anything in `fontsDir`
 *  changed, including the folder appearing or going. A project without
 *  `Fonts/` is watched for the folder to appear. */
export function watchProjectFonts(fontsDir: string, onChange: () => void): FontsWatcher {
  const deb = new Debouncer(DEBOUNCE_QUIET_MS, onChange)
  let folder: FSWatcher | null = null
  let closed = false
  const detach = () => { folder?.close(); folder = null }
  const attach = () => {
    // Checked, not left to `watch` to throw, as in watchProjectMotifs.
    if (folder || closed || !existsSync(fontsDir)) return
    try { folder = watch(canonicalDir(fontsDir)) } catch { return }
    folder.on('change', () => deb.signal())
    folder.on('error', () => { detach(); attach(); deb.signal() })
  }
  let parent: FSWatcher | null = null
  try {
    parent = watch(canonicalDir(path.dirname(fontsDir)), (_event, name) => {
      if (name !== null && String(name) !== path.basename(fontsDir)) return
      const present = existsSync(fontsDir)
      if (folder && present) return
      if (folder) detach()
      else if (present) attach()
      deb.signal()
    })
    parent.on('error', () => { parent?.close(); parent = null })
  } catch { /* the project folder is gone */ }
  attach()
  return {
    close() {
      closed = true
      deb.cancel()
      detach()
      parent?.close()
    },
  }
}
