// Open a target (path / URL) in the OS default handler, via the Electron main
// process.

export async function open(target: string): Promise<void> {
  await window.api.shell.open(target)
}

// Reveal a file in the OS file manager — selected in Explorer / Finder; on
// Linux the containing folder opens instead (see main/openPath.ts for why).
// Rejects when the file no longer exists.
export async function reveal(target: string): Promise<void> {
  await window.api.shell.reveal(target)
}
