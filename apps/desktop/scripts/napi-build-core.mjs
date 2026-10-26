// Builds @weftcut/core. A wrapper rather than a bare `napi build` for Linux
// only: there the addon is linked against an old glibc sysroot and the result
// is held to the glibc floor (napi-linux-sysroot.mjs, glibc-floor.mjs).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { linuxSysroot } from './napi-linux-sysroot.mjs'
import { assertGlibcFloor } from './glibc-floor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..') // apps/desktop
const sysroot = linuxSysroot()

execSync(
  `napi build --platform --release ${sysroot.args} --manifest-path native/Cargo.toml --output-dir native`,
  { stdio: 'inherit', env: { ...process.env, ...sysroot.env }, cwd: root },
)

if (sysroot.args) {
  assertGlibcFloor([join(root, 'native', 'index.linux-x64-gnu.node')], { label: 'napi:build —' })
}
