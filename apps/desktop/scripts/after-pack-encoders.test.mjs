import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import afterPackEncoders, { assertSidecarEncoders, REQUIREMENT, sidecarPath } from './after-pack-encoders.mjs'

const PLATFORMS = ['linux', 'darwin', 'win32']

/// `ffmpeg -encoders` output listing `names`, legend included.
function listing(names) {
  const legend = [' V..... = Video', ' A..... = Audio', ' .....D = Supports direct rendering method 1']
  const rows = names.map((name) => ` V....D ${name.padEnd(20)} ${name} encoder`)
  return ['Encoders:', ...legend, ' ------', ...rows, ''].join('\n')
}

/// Every encoder `platform` requires, taking the first of each any-of group.
function complete(platform) {
  return REQUIREMENT[platform].map((group) => group.anyOf[0])
}

test('a sidecar with every required encoder passes on every OS', () => {
  for (const platform of PLATFORMS) assertSidecarEncoders(platform, listing(complete(platform)))
})

test('a missing encoder fails the pack, naming it', () => {
  for (const platform of PLATFORMS) {
    const names = complete(platform).filter((name) => name !== 'libx265')
    assert.throws(() => assertSidecarEncoders(platform, listing(names)), /afterPack\(encoders\).*hevc \(software\): libx265/s)
  }
})

test('a missing hardware encoder fails the pack instead of falling back to software', () => {
  const names = complete('win32').filter((name) => name !== 'hevc_amf')
  assert.throws(() => assertSidecarEncoders('win32', listing(names)), /hevc \(amf\): hevc_amf/)
})

test('either AV1 software library meets the AV1 requirement', () => {
  for (const platform of PLATFORMS) {
    const others = complete(platform).filter((name) => name !== 'libsvtav1')
    assertSidecarEncoders(platform, listing([...others, 'libaom-av1']))
    assertSidecarEncoders(platform, listing([...others, 'libsvtav1']))
    assert.throws(() => assertSidecarEncoders(platform, listing(others)), /av1 \(software\): libsvtav1 or libaom-av1/)
  }
})

test('an encoder name is matched whole, not by prefix', () => {
  const names = complete('darwin').map((name) => ({ libx264: 'libx264rgb', aac: 'aac_at' })[name] ?? name)
  assert.throws(
    () => assertSidecarEncoders('darwin', listing(names)),
    (error) => /h264 \(software\): libx264$/m.test(error.message) && /aac audio: aac$/m.test(error.message),
  )
})

test('output without an encoder table fails rather than passing as empty', () => {
  assert.throws(() => assertSidecarEncoders('linux', 'ffmpeg version n8.1\n'), /printed no encoder table/)
})

/// A packed app for `platform` whose sidecar slot holds `script` (none when null).
function packed(t, platform, script) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  const bin = sidecarPath(path.join(appOutDir, 'resources'), platform)
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  if (script !== null) fs.writeFileSync(bin, script, { mode: 0o755 })
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { getResourcesDir: (dir) => path.join(dir, 'resources') },
  }
}

test('the gate lists the encoders of the binary in the package', { skip: process.platform === 'win32' && 'the stand-in sidecar is a shell script' }, (t) => {
  const listingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-listing-')), 'encoders.txt')
  t.after(() => fs.rmSync(path.dirname(listingFile), { recursive: true, force: true }))
  fs.writeFileSync(listingFile, listing(complete('linux').filter((name) => name !== 'libopus')))
  const context = packed(t, 'linux', `#!/bin/sh\ncat '${listingFile}'\n`)
  assert.throws(() => afterPackEncoders(context), /opus audio: libopus/)
})

test('a package without the sidecar fails the pack', (t) => {
  for (const platform of PLATFORMS) {
    assert.throws(() => afterPackEncoders(packed(t, platform, null)), /could not list the encoders of .*ffmpeg/)
  }
})
