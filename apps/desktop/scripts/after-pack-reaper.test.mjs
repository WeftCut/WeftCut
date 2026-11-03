import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import afterPackReaper, { reaperPath } from './after-pack-reaper.mjs'

/// A packed app for `platform`, with the reaper at `mode` (or none).
function packed(t, platform, mode) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  const resources = path.join(appOutDir, 'resources')
  const reaper = reaperPath(resources)
  fs.mkdirSync(path.dirname(reaper), { recursive: true })
  if (mode !== undefined) fs.writeFileSync(reaper, 'ELF', { mode })
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { getResourcesDir: (dir) => path.join(dir, 'resources') },
  }
}

const posix = { skip: process.platform === 'win32' && 'execute bits are POSIX' }

test('an executable reaper beside the addon passes', posix, (t) => {
  for (const platform of ['linux', 'darwin']) afterPackReaper(packed(t, platform, 0o755))
})

test('a missing reaper fails the pack', (t) => {
  assert.throws(() => afterPackReaper(packed(t, 'linux')), /afterPack\(reaper\).*is missing/s)
})

test('a reaper that lost its execute bit fails the pack', posix, (t) => {
  assert.throws(() => afterPackReaper(packed(t, 'darwin', 0o644)), /not executable/)
})

test('Windows ships no reaper', (t) => {
  afterPackReaper(packed(t, 'win32'))
})
