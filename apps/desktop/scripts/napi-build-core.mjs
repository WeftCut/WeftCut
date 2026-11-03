// Builds @weftcut/core: the addon, and on macOS and Linux the ffmpeg reaper
// that ships beside it (native/reaper; the addon finds it next to its own
// .node). A wrapper rather than a bare `napi build` for Linux: there both are
// linked against an old glibc sysroot and held to the glibc floor
// (napi-linux-sysroot.mjs, glibc-floor.mjs).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { linuxSysroot } from './napi-linux-sysroot.mjs'
import { assertGlibcFloor } from './glibc-floor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..') // apps/desktop
const sysroot = linuxSysroot()
const build = (args) =>
  execSync(`napi build --release ${sysroot.args} ${args} --output-dir native`, {
    stdio: 'inherit',
    env: { ...process.env, ...sysroot.env },
    cwd: root,
  })

build('--platform --manifest-path native/Cargo.toml')
// Windows has no reaper: a kill-on-close job ends the children there
// (native/src/ffmpeg/guard.rs).
if (process.platform !== 'win32') build('--manifest-path native/reaper/Cargo.toml --bin weftcut-reaper')

if (sysroot.args) {
  assertGlibcFloor(
    [join(root, 'native', 'index.linux-x64-gnu.node'), join(root, 'native', 'weftcut-reaper')],
    { label: 'napi:build —' },
  )
}
