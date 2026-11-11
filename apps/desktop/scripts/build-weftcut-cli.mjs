/// Build the `weftcut` binary (apps/desktop/cli, Go, standard library only)
/// into out/cli/. `weftcut mcp` is the stdio MCP server; see docs/adr/0165.
///
/// The app version is linked in here: the binary runs from a profile's `cli/`
/// directory with no package.json in reach, and reports that version in
/// `initialize` and in the instructions it sends. A plain `go build` has no
/// stamp and reports 0.0.0-dev.
///
/// CGO_ENABLED=0: the result is one static file with no libc to match, which is
/// what lets one Linux build run on every distribution the app supports.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const outDir = path.join(ROOT, 'out', 'cli')
const windows = process.platform === 'win32'
const out = path.join(outDir, windows ? 'weftcut.exe' : 'weftcut')
// Windows: linked for the GUI subsystem, so no client's way of spawning it can
// make Windows open a console window. The binary takes its parent's console
// itself (cli/console_windows.go).
const ldflags = `-s -w -X main.version=${version}${windows ? ' -H=windowsgui' : ''}`

mkdirSync(outDir, { recursive: true })
const built = spawnSync(
  'go',
  ['build', '-trimpath', '-ldflags', ldflags, '-o', out, '.'],
  { cwd: path.join(ROOT, 'cli'), env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' },
)
if (built.error) {
  console.error(
    built.error.code === 'ENOENT'
      ? 'build-weftcut-cli: `go` is not on PATH. Install the Go toolchain apps/desktop/cli/go.mod names, then run this again.'
      : `build-weftcut-cli: could not run go: ${built.error.message}`,
  )
  process.exit(1)
}
if (built.status !== 0) process.exit(built.status ?? 1)
console.log(`built ${path.relative(ROOT, out)} (weftcut ${version})`)
