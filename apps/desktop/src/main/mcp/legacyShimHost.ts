// The process an old client config starts (`legacyShim.ts`): no window, no
// profile lock, no MCP host. It runs `weftcut mcp` on its own stdio and ends
// with it.
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/// Hands this process's stdio and environment to the first of `candidates`
/// that starts, and exits with its exit code.
export function serveLegacyShim(candidates: readonly string[]): void {
  // macOS shows a dock icon for any app that boots; this one has nothing to show.
  app.dock?.hide()

  let child: ChildProcess | null = null
  const end = (signal: NodeJS.Signals): void => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  // LANDMINE: a termination signal has two possible owners here. Chromium
  // installs its own handlers for these and turns the signal into a quit;
  // Node's replace them when they are registered later. Whichever receives
  // it, the binary is told to end (it closes its app session), and this
  // process exits with it rather than on its own.
  for (const signal of TERMINATION_SIGNALS) process.on(signal, () => end(signal))
  app.on('before-quit', (event) => {
    event.preventDefault()
    end('SIGTERM')
  })

  const attempt = (at: number): void => {
    const file = candidates[at]
    if (file === undefined) {
      // stderr: stdout belongs to the protocol.
      console.error(
        'WeftCut: this MCP config was written by an earlier version, and the weftcut CLI that serves it is missing. ' +
          'Open WeftCut once, then copy a fresh config from Settings → Agent.',
      )
      app.exit(1)
      return
    }
    const started = spawn(file, ['mcp'], { stdio: 'inherit', windowsHide: true })
    child = started
    // Not started (replaced under us, quarantined): the next copy may be.
    started.once('error', () => {
      if (started.pid === undefined) attempt(at + 1)
    })
    // A signal's exit has no code; the client asked for the end either way.
    started.once('exit', (code) => app.exit(code ?? 1))
  }
  attempt(0)
}
