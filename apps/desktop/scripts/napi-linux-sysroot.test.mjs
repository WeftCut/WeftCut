import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { linuxSysroot } from './napi-linux-sysroot.mjs'

test('only a Linux x64 host builds against the sysroot', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'arm64']]) {
    assert.deepEqual(linuxSysroot({}, { platform, arch }), { args: '', env: {} })
  }
})

// cc-rs ignores TARGET_CC when target == host, so the per-triple names are what
// keep C dependencies off the host compiler.
test('C, C++ and ar are routed to the cross toolchain under the per-triple names', () => {
  const { args, env } = linuxSysroot({}, { platform: 'linux', arch: 'x64' })
  assert.equal(args, '--use-napi-cross --target x86_64-unknown-linux-gnu')
  const tools = ['AR_x86_64_unknown_linux_gnu', 'CC_x86_64_unknown_linux_gnu', 'CXX_x86_64_unknown_linux_gnu']
  assert.deepEqual(Object.keys(env).sort(), [...tools, 'LZMA_API_STATIC'])
  const toolchains = join(homedir(), '.napi-rs', 'cross-toolchain')
  for (const name of tools) assert.ok(env[name].startsWith(toolchains), env[name])
  assert.match(env.CC_x86_64_unknown_linux_gnu, /x86_64-unknown-linux-gnu-gcc$/)
})

// lzma-sys links the build machine's liblzma when pkg-config finds one, which
// puts a host library directory on the cross link line.
test('the cross build compiles liblzma itself instead of linking the host one', () => {
  const { env } = linuxSysroot({}, { platform: 'linux', arch: 'x64' })
  assert.equal(env.LZMA_API_STATIC, '1')
  const chosen = linuxSysroot({ LZMA_API_STATIC: '0' }, { platform: 'linux', arch: 'x64' })
  assert.equal(chosen.env.LZMA_API_STATIC, undefined, 'a value the caller set is left alone')
  assert.deepEqual(linuxSysroot({ WEFTCUT_NATIVE_BUILD: '1' }, { platform: 'linux', arch: 'x64' }).env, {})
})

test('a compiler the caller already chose is left alone', () => {
  const { env } = linuxSysroot({ CC_x86_64_unknown_linux_gnu: '/opt/cc' }, { platform: 'linux', arch: 'x64' })
  assert.equal(env.CC_x86_64_unknown_linux_gnu, undefined)
  assert.ok(env.CXX_x86_64_unknown_linux_gnu)
})

test('explicit native Linux x64 builds return no cross-build arguments or environment overrides', () => {
  const env = { WEFTCUT_NATIVE_BUILD: '1', CC: '/opt/cc', RUSTFLAGS: '-C debuginfo=1' }
  const before = { ...env }
  assert.deepEqual(linuxSysroot(env, { platform: 'linux', arch: 'x64' }), { args: '', env: {} })
  assert.deepEqual(env, before)
})

test('only the exact native opt-in disables the portable Linux x64 default', () => {
  for (const value of [undefined, '', '0', 'false', 'true', 'yes']) {
    const result = linuxSysroot({ WEFTCUT_NATIVE_BUILD: value }, { platform: 'linux', arch: 'x64' })
    assert.equal(result.args, '--use-napi-cross --target x86_64-unknown-linux-gnu')
    assert.ok(result.env.CC_x86_64_unknown_linux_gnu)
  }
})

test('the native opt-in leaves other hosts unchanged', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'arm64']]) {
    assert.deepEqual(linuxSysroot({ WEFTCUT_NATIVE_BUILD: '1' }, { platform, arch }), { args: '', env: {} })
  }
})
