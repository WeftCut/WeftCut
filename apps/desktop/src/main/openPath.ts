import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'

// Open a file/folder with the OS default handler. Resolves with an error
// string ('' on success), mirroring shell.openPath's contract.
//
// On Linux we bypass Electron's shell.openPath and spawn xdg-open directly,
// the same way the community-standard `open` package does (`detached` +
// `stdio: 'ignore'` + `unref()`). Electron's implementation
// (shell/common/platform_util_linux.cc: XDGOpen → XDGUtil) runs on the main
// thread, spins a NESTED RUN LOOP waiting for an xdg-activation token, then
// launches xdg-open via Chromium's base::LaunchProcess — which wires
// Chromium's internal plumbing fds (mojo sockets, eventfds) into the child's
// stdio. A GTK file manager launched that way can wedge before ever mapping
// its window (observed with nemo on Cinnamon: process alive, main loop idle,
// no window — the desktop reports "not responding"). Detaching and ignoring
// stdio fully decouples the launched app from Electron's process plumbing.
//
// xdg-open normally exits within ~10-30ms (the real handler re-parents to
// init), so we briefly wait for its exit code to preserve the error contract;
// a longer-lived opener (some xdg-open backends exec the handler in the
// foreground) is treated as success after the timeout rather than blocking
// the caller for the handler's whole lifetime.
export function openPathRobust(target: string): Promise<string> {
  if (process.platform !== 'linux') return shell.openPath(target)
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout
    const settle = (err: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(err)
    }
    const child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
    child.once('error', (e) => settle(e.message))
    child.once('exit', (code) =>
      settle(code === 0 || code === null ? '' : `xdg-open exited with code ${code}`))
    child.unref()
    timer = setTimeout(() => settle(''), 2000)
  })
}

// Reveal a file in the OS file manager — selected in Explorer / Finder where
// the platform can do that. Same error-string contract as openPathRobust.
//
// Electron's shell.showItemInFolder returns void and swallows every failure:
// on Windows a missing file fails SHParseDisplayName and nothing opens, on
// macOS `selectFile:` returns NO. The stat here is what turns that silent
// no-op (typically the user moved the file after exporting) into an error the
// caller can report.
//
// On Linux, showItemInFolder tries org.freedesktop.FileManager1.ShowItems over
// D-Bus and, when no file manager answers, falls back to the same in-process
// XDGOpen that openPathRobust exists to avoid — and there is no way to opt out
// of that fallback. So Linux opens the containing folder through the detached
// xdg-open path instead: the file is not selected, but the file manager comes
// up reliably.
export async function revealPathRobust(target: string): Promise<string> {
  const full = path.normalize(target)
  try {
    await stat(full)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return `cannot reveal ${full}: ${err.code ?? err.message}`
  }
  if (process.platform === 'linux') return openPathRobust(path.dirname(full))
  shell.showItemInFolder(full)
  return ''
}
