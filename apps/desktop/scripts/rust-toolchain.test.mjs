import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const root = new URL('../../../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')

// A release must compile and lint with one version, even when a new stable
// compiler ships between jobs. The workflow action's input overrides rustup's
// default, so changing only the local toolchain file does not guarantee this.
test('local builds, CI artifacts and CI lints use the same exact Rust version', () => {
  const channel = read('rust-toolchain.toml').match(/^channel\s*=\s*"([^"]+)"/m)?.[1]
  assert.match(channel ?? '', /^\d+\.\d+\.\d+$/, 'pin an exact Rust release')
  for (const file of [
    '.github/actions/rust-artifacts/action.yml',
    '.github/workflows/electron-ci.yml',
  ]) {
    const config = parse(read(file))
    const steps = config.runs?.steps ?? Object.values(config.jobs).flatMap(job => job.steps ?? [])
    const installs = steps.filter(step => step.uses?.startsWith('dtolnay/rust-toolchain@'))
    assert.ok(installs.length > 0, `${file} must install the pinned toolchain`)
    for (const step of installs) assert.equal(step.with?.toolchain, channel, file)
  }
})
