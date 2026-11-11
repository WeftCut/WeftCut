import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import afterPackCli, { cliPath, GO_LICENSE } from './after-pack-cli.mjs'

const PLATFORMS = ['linux', 'darwin', 'win32']

/// A packed app for `platform` whose resources/cli holds the binary at `mode`
/// (none when null) and, unless `license` is false, the Go licence.
function packed(t, platform, { mode = 0o755, license = true } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  const resources = path.join(appOutDir, 'resources')
  const binary = cliPath(resources, platform)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  if (mode !== null) fs.writeFileSync(binary, 'binary', { mode })
  if (license) fs.writeFileSync(path.join(path.dirname(binary), GO_LICENSE), 'licence')
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { getResourcesDir: (dir) => path.join(dir, 'resources') },
  }
}

test('the binary with its licence passes on every OS', (t) => {
  for (const platform of PLATFORMS) afterPackCli(packed(t, platform))
})

test('a package without the binary fails on every OS, naming the build step', (t) => {
  for (const platform of PLATFORMS) {
    assert.throws(() => afterPackCli(packed(t, platform, { mode: null })), /afterPack\(cli\).*is missing.*npm run build:cli/s)
  }
})

test("another OS's binary does not stand in for this one's", (t) => {
  const context = packed(t, 'linux')
  context.electronPlatformName = 'win32'
  assert.throws(() => afterPackCli(context), /weftcut\.exe is missing/)
})

test('a binary that lost its execute bit fails the pack', { skip: process.platform === 'win32' && 'execute bits are POSIX' }, (t) => {
  for (const platform of ['linux', 'darwin']) {
    assert.throws(() => afterPackCli(packed(t, platform, { mode: 0o644 })), /not executable/)
  }
})

test('a package without the Go licence fails', (t) => {
  for (const platform of PLATFORMS) {
    assert.throws(() => afterPackCli(packed(t, platform, { license: false })), /afterPack\(cli\).*GO-LICENSE\.txt is missing/s)
  }
})
