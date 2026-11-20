// Path helpers (documentDir / join) backed by the Electron main process.

export async function documentDir(): Promise<string> {
  return window.api.path.documentDir()
}

export async function join(...paths: string[]): Promise<string> {
  return window.api.path.join(paths)
}
