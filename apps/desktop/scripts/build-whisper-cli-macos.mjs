// Builds the WeftCut-published macOS arm64 `whisper-cli` content artifact.
//
// whisper.cpp publishes no macOS CLI — v1.9.1's only Apple asset is an
// xcframework, a library for apps to link, which the whisper.cpp speech backend
// (it spawns `whisper-cli` by configured path) cannot use. So on macOS the
// runtime is built here, from the pinned upstream commit, and published on
// this repo's own release (.github/workflows/content-whisper-cli.yml).
//
// The binary is one self-contained Mach-O: ggml/whisper linked statically, the
// Metal shader library embedded, and only system libraries and frameworks
// (libSystem, libc++, Accelerate, Metal, Foundation) left dynamic — so the
// archive needs no `@rpath` dylibs and no symlinks survive or break.
//
// The tarball is deterministic where that is cheap: source paths are mapped out
// of the object files, entries are listed in a fixed order with fixed owner and
// mtime, macOS metadata is left out, and gzip writes no name or timestamp. The
// ad-hoc signature carries no timestamp, so it is a pure function of the bytes.
//
//   node scripts/build-whisper-cli-macos.mjs [--out <dir>] [--work <dir>]
//
// Needs Xcode command-line tools, git and cmake (override with $CMAKE).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WHISPER_TAG = 'v1.9.1'
// The commit the tag names (a lightweight tag). Fetched by SHA and re-checked,
// so a moved tag cannot change what is built.
const WHISPER_COMMIT = 'f049fff95a089aa9969deb009cdd4892b3e74916'
const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp.git'
// Matches the app's own floor (electron-builder.yml `mac.minimumSystemVersion`).
const DEPLOYMENT_TARGET = '13.0'
const NAME = `whisper-cli-${WHISPER_TAG}-macos-arm64`
// 2026-01-01T00:00:00Z — any fixed instant; only its constancy matters.
const FIXED_MTIME = 1767225600

const CMAKE_FLAGS = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_OSX_ARCHITECTURES=arm64',
  `-DCMAKE_OSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET}`,
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  // Upstream's Apple default; Accelerate is a system framework.
  '-DGGML_BLAS=ON',
  // A distributed binary must not be tuned to the build host's CPU.
  '-DGGML_NATIVE=OFF',
  '-DGGML_CCACHE=OFF',
  '-DWHISPER_COREML=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
]

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('build-whisper-cli-macos: runs on macOS arm64 only')
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : fallback
}
const outDir = flag('--out', join(tmpdir(), 'weftcut-whisper-cli', 'out'))
const workDir = flag('--work', join(tmpdir(), 'weftcut-whisper-cli'))
const cmake = process.env.CMAKE || 'cmake'

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
const read = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', ...opts }).trim()

// ── source at the pinned commit ──────────────────────────────────────────────
const src = join(workDir, 'whisper.cpp')
if (!existsSync(join(src, '.git'))) {
  mkdirSync(src, { recursive: true })
  run('git', ['init', '-q', src])
  run('git', ['-C', src, 'remote', 'add', 'origin', WHISPER_REPO])
}
run('git', ['-C', src, 'fetch', '-q', '--depth', '1', 'origin', WHISPER_COMMIT])
run('git', ['-C', src, 'checkout', '-q', '--force', WHISPER_COMMIT])
const head = read('git', ['-C', src, 'rev-parse', 'HEAD'])
if (head !== WHISPER_COMMIT) throw new Error(`checked out ${head}, expected ${WHISPER_COMMIT}`)

// ── build ────────────────────────────────────────────────────────────────────
const build = join(workDir, 'build')
rmSync(build, { recursive: true, force: true })
// Strip the checkout and build paths from __FILE__ and debug info, so the
// bytes do not depend on where the work dir happens to be.
const prefixMap = `-ffile-prefix-map=${src}=. -ffile-prefix-map=${build}=.`
run(cmake, [
  '-S', src, '-B', build, ...CMAKE_FLAGS,
  `-DCMAKE_C_FLAGS=${prefixMap}`, `-DCMAKE_CXX_FLAGS=${prefixMap}`,
])
run(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j'])

// ── stage, sign, check ───────────────────────────────────────────────────────
const stage = join(workDir, 'stage')
rmSync(stage, { recursive: true, force: true })
const root = join(stage, NAME)
mkdirSync(root, { recursive: true })
const bin = join(root, 'whisper-cli')
copyFileSync(join(build, 'bin', 'whisper-cli'), bin)
run('chmod', ['0755', bin])
run('strip', ['-x', bin])
run('codesign', ['--force', '--sign', '-', bin])
run('codesign', ['--verify', '--strict', bin])

// Anything outside /usr/lib and /System would have to travel in the archive.
const deps = read('otool', ['-L', bin]).split('\n').slice(1).map((l) => l.trim().split(' ')[0])
const foreign = deps.filter((d) => !d.startsWith('/usr/lib/') && !d.startsWith('/System/Library/'))
if (foreign.length) throw new Error(`whisper-cli links non-system libraries: ${foreign.join(', ')}`)

copyFileSync(join(src, 'LICENSE'), join(root, 'LICENSE'))
writeFileSync(join(root, 'BUILD-INFO.txt'), [
  `whisper.cpp ${WHISPER_TAG} (${WHISPER_COMMIT})`,
  `source: ${WHISPER_REPO}`,
  `built by: apps/desktop/scripts/build-whisper-cli-macos.mjs`,
  `cmake flags: ${CMAKE_FLAGS.join(' ')}`,
  '',
].join('\n'))

// ── package ──────────────────────────────────────────────────────────────────
const entries = [NAME, `${NAME}/BUILD-INFO.txt`, `${NAME}/LICENSE`, `${NAME}/whisper-cli`]
for (const e of entries) utimesSync(join(stage, e), FIXED_MTIME, FIXED_MTIME)
mkdirSync(outDir, { recursive: true })
const tarPath = join(workDir, `${NAME}.tar`)
run('tar', [
  '-c', '-f', tarPath, '-C', stage, '--format', 'ustar', '-n',
  '--uid', '0', '--gid', '0', '--uname', '', '--gname', '',
  '--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', ...entries,
])
const outPath = join(outDir, `${NAME}.tar.gz`)
writeFileSync(outPath, execFileSync('gzip', ['-n', '-9', '-c', tarPath], { maxBuffer: 1 << 30 }))
rmSync(tarPath)

const bytes = readFileSync(outPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
console.log(JSON.stringify({ path: outPath, bytes: bytes.byteLength, sha256, entryPath: `${NAME}/whisper-cli` }, null, 2))
