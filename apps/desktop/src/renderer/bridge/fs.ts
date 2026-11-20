// Filesystem helpers (write/remove/exists/readDir) via the Electron
// main process. All are invoke wrappers; callers guard with try/catch.

import type { DirEntry } from '../../shared/ipc'

export type { DirEntry }

export async function writeFile(
  path: string,
  data: Uint8Array,
  opts?: { append?: boolean },
): Promise<void> {
  await window.api.fs.writeFile(path, data, opts?.append ?? false)
}

export async function remove(path: string, _opts?: unknown): Promise<void> {
  await window.api.fs.remove(path)
}

export async function exists(path: string, _opts?: unknown): Promise<boolean> {
  return window.api.fs.exists(path)
}

export async function readDir(path: string, _opts?: unknown): Promise<DirEntry[]> {
  return window.api.fs.readDir(path)
}
