// What makes a macOS binary portable to every Mac the app says it supports:
// it loads only libraries the OS provides or that ship beside it, and it was
// built for a macOS no newer than the app's declared minimum. Both properties
// are invisible on the machine that built the binary — a CI runner has its
// Homebrew libraries and its own new macOS — so they are read from the
// Mach-O load commands instead of tested by running it.
//
// Used by the from-source LGPL ffmpeg build (fetch-ffmpeg-lgpl.mjs) right
// after it builds, and by the afterPack gate over the whole packaged app.
import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/// Load paths a shipped binary may reference: the OS's own libraries and
/// frameworks, or a path relative to the bundle.
const ALLOWED = ['/usr/lib/', '/System/Library/', '@loader_path/', '@rpath/', '@executable_path/']
const LOADS = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB'])

/// The app's declared macOS floor, from electron-builder.yml `mac.minimumSystemVersion`:
/// the one home of that number, so a native build and the package gate cannot drift from it.
export function macMinimumSystemVersion() {
  const config = readFileSync(fileURLToPath(new URL('../electron-builder.yml', import.meta.url)), 'utf8')
  const match = config.match(/^\s+minimumSystemVersion:\s*["']?(\d+(?:\.\d+)*)["']?\s*$/m)
  if (!match) throw new Error('electron-builder.yml declares no mac.minimumSystemVersion')
  return match[1]
}

function versionAbove(version, floor) {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/// Where an `@rpath/` load may be searched for: inside the bundle or the OS.
const RPATH_ALLOWED = ['/usr/lib/', '/System/Library/', '@loader_path', '@executable_path']

/// The loaded libraries, the run-path search list and the highest minimum
/// macOS among the slices of one binary, from `otool -l`-shaped text. A
/// binary's own LC_ID_DYLIB is not a load.
export function parseLoadCommands(text) {
  const deps = new Set()
  const rpaths = new Set()
  let minos = null
  let command = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const cmd = line.match(/^cmd (\S+)/)
    if (cmd) { command = cmd[1]; continue }
    const name = line.match(/^name (.+) \(offset \d+\)$/)
    if (name && LOADS.has(command)) deps.add(name[1])
    const rpath = command === 'LC_RPATH' && line.match(/^path (.+) \(offset \d+\)$/)
    if (rpath) rpaths.add(rpath[1])
    const version = (command === 'LC_BUILD_VERSION' && line.match(/^minos (\S+)/)) ||
      (command === 'LC_VERSION_MIN_MACOSX' && line.match(/^version (\S+)/))
    if (version && (minos === null || versionAbove(version[1], minos))) minos = version[1]
  }
  return { deps: [...deps], rpaths: [...rpaths], minos }
}

/// Every problem that would stop `file` loading on a Mac at `floor`.
export function portabilityProblems(file, { deps, rpaths = [], minos }, floor) {
  const problems = deps.filter(dep => !ALLOWED.some(prefix => dep.startsWith(prefix)))
    .map(dep => `${file} loads ${dep}, which no user's Mac provides`)
  // An `@rpath/` load is only as portable as the places it is searched for:
  // a run path into the build host (Homebrew, a build tree) finds nothing on
  // a user's Mac, or finds that user's own copy of the library.
  if (deps.some(dep => dep.startsWith('@rpath/'))) {
    for (const rpath of rpaths.filter(r => !RPATH_ALLOWED.some(prefix => r.startsWith(prefix)))) {
      problems.push(`${file} searches ${rpath} for its @rpath libraries, which no user's Mac provides`)
    }
  }
  if (minos === null) problems.push(`${file} declares no minimum macOS`)
  else if (versionAbove(minos, floor)) problems.push(`${file} requires macOS ${minos}; the app supports ${floor}`)
  return problems
}

// LANDMINE — llvm-objdump, not otool: otool reads a path ending in "(name)" as
// an archive member, and Electron's helper apps are "<App> Helper (GPU)" etc.
// The output has otool -l's shape, which parseLoadCommands reads.
const loadCommands = file => execFileSync('xcrun', ['objdump', '--macho', '--private-headers', file],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

export function assertMacPortable(files, { floor = macMinimumSystemVersion(), label, read = loadCommands } = {}) {
  const problems = files.flatMap(file => portabilityProblems(file, parseLoadCommands(read(file)), floor))
  if (problems.length) throw new Error(`${label} ${problems.length} portability problems:\n  ${problems.join('\n  ')}`)
}

const MACHO_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}

/// Every Mach-O file under `dir`, not following symlinks (a framework's
/// Versions/Current and top-level aliases point at files counted once).
export function machOFiles(dir) {
  const found = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) found.push(...machOFiles(path))
    else if (stat.isFile() && stat.size >= 4 && isMachO(path)) found.push(path)
  }
  return found
}
