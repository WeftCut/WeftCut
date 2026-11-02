import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { checkPlan } from './check.mjs'

const workflow = readFileSync(new URL('../../../.github/workflows/electron-ci.yml', import.meta.url), 'utf8')

const step = (plan, name) => plan.find((candidate) => candidate.name === name)

for (const [platform, root] of [
  ['linux', '/repo/apps/desktop'],
  ['darwin', '/repo/apps/desktop'],
  ['win32', 'C:\\repo\\apps\\desktop'],
]) {
  test(`every cargo command on ${platform} is one CI runs`, () => {
    const cargo = checkPlan({ platform, root }).filter((candidate) => candidate.command === 'cargo')
    assert.ok(cargo.length > 0)
    for (const { args } of cargo) {
      const line = `cargo ${args.join(' ')}`
      assert.ok(workflow.includes(line), `electron-ci.yml does not run: ${line}`)
    }
  })
}

test('the decode tests get the loader path their binary has no RPATH for', () => {
  const linux = step(checkPlan({ platform: 'linux', root: '/d' }), 'rust: decode')
  assert.equal(linux.env.FFMPEG_DIR, '/d/resources/ffmpeg-lgpl/linux')
  assert.equal(linux.env.LD_LIBRARY_PATH, '/d/resources/ffmpeg-lgpl/linux/lib')

  const mac = step(checkPlan({ platform: 'darwin', root: '/d' }), 'rust: decode')
  assert.equal(mac.env.DYLD_FALLBACK_LIBRARY_PATH, '/d/resources/ffmpeg-lgpl/mac/lib')
})

test('macOS alone runs the decode tests serially', () => {
  const threads = (platform) =>
    step(checkPlan({ platform, root: '/d' }), 'rust: decode').args.includes('--test-threads=1')
  assert.equal(threads('darwin'), true)
  assert.equal(threads('linux'), false)
  assert.equal(threads('win32'), false)
})

test('Windows keeps its own PATH key and puts both ffmpeg sets on it', () => {
  const plan = checkPlan({
    platform: 'win32',
    root: 'C:\\d',
    env: { Path: 'C:\\Windows', LIBCLANG_PATH: 'D:\\llvm' },
  })
  const { env } = step(plan, 'rust: decode')
  assert.equal(env.Path, 'C:\\d\\resources\\ffmpeg\\win;C:\\d\\resources\\ffmpeg-lgpl\\win\\bin;C:\\Windows')
  assert.equal(env.PATH, undefined)
  assert.equal(env.FFMPEG_DIR, 'C:/d/resources/ffmpeg-lgpl/win')
  assert.equal(env.LIBCLANG_PATH, 'D:\\llvm')
})

test('--skip-rust leaves the TypeScript gates and no cargo step', () => {
  const plan = checkPlan({ platform: 'linux', root: '/d', skipRust: true })
  assert.deepEqual(
    plan.map(({ name }) => name),
    ['typecheck', 'test:scripts', 'mcp:catalog:check', 'test'],
  )
})

test('an unknown platform is refused', () => {
  assert.throws(() => checkPlan({ platform: 'freebsd', root: '/d' }), /Unsupported platform/)
})
