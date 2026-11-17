import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateVersion, planRelease, releaseCandidate, setVersion, readVersion, validateAssets, releaseNotes, readUpgradeNotes } from './release.mjs'

test('only increasing, unpublished stable versions can be released', () => {
  for (const bad of ['0.1.001', 'v0.1.1', '0.1.1-beta.1', '0.1.1+001', '1.2', null]) {
    assert.throws(() => validateVersion(bad))
  }
  assert.equal(planRelease('0.0.0', []), false)
  assert.equal(planRelease('0.1.1', []), true)
  assert.equal(planRelease('0.1.1', [{ tagName: 'v0.1.1', isDraft: true }]), true)
  assert.equal(planRelease('0.1.1', [{ tagName: 'v0.1.1', isDraft: false }]), false)
  assert.equal(planRelease('0.1.10', [{ tagName: 'v0.1.9', isDraft: false }]), true)
  assert.throws(() => planRelease('0.1.1', [{ tagName: 'v0.1.2', isDraft: false }]))
})

test('only the push that changes the version is a release candidate', () => {
  assert.equal(releaseCandidate('0.1.1', [], '0.1.0'), true)
  // A later push on an unpublished version does not retry it, with or without
  // a draft left by the failed attempt.
  assert.equal(releaseCandidate('0.1.1', [], '0.1.1'), false)
  assert.equal(releaseCandidate('0.1.1', [{ tagName: 'v0.1.1', isDraft: true }], '0.1.1'), false)
  assert.equal(releaseCandidate('0.1.1', [{ tagName: 'v0.1.1', isDraft: false }], '0.1.0'), false)
  assert.equal(releaseCandidate('0.1.1', [], null), false)
  // A push that does not bump still refuses a version below a published one.
  assert.throws(() => releaseCandidate('0.1.1', [{ tagName: 'v0.1.2', isDraft: false }], '0.1.1'))
})

test('version command keeps both packages and all lockfile version entries in sync', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-version-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'apps/desktop'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }))
  await fs.writeFile(path.join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '0.0.0' }))
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.0.0', packages: {
    '': { version: '0.0.0' }, 'apps/desktop': { version: '0.0.0' },
  } }))
  await setVersion('0.1.1', root)
  assert.equal(await readVersion(root), '0.1.1')
  await assert.rejects(setVersion('0.1.1', root))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.2' }))
  await assert.rejects(readVersion(root), /versions differ/)
})

async function assets(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-release-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const data = Buffer.from('installer fixture')
  const sha512 = createHash('sha512').update(data).digest('base64')
  // Per-target os/arch names, as electron-builder writes them (release.mjs INSTALLERS).
  const files = [['win', 'x64', 'exe'], ['linux', 'x86_64', 'AppImage'], ['linux', 'amd64', 'deb'], ['mac', 'arm64', 'zip'], ['mac', 'arm64', 'dmg']].map(([os, arch, ext]) => ({ url: `WeftCut-${os}-${arch}.${ext}`, size: data.length, sha512 }))
  for (const file of files) await fs.writeFile(path.join(dir, file.url), data)
  await fs.writeFile(path.join(dir, 'WeftCut-win-x64.exe.blockmap'), 'blockmap fixture')
  await fs.writeFile(path.join(dir, 'WeftCut-mac-arm64.dmg.blockmap'), 'blockmap fixture')
  await fs.writeFile(path.join(dir, 'WeftCut-mac-arm64.zip.blockmap'), 'blockmap fixture')
  for (const [name, subset] of [['latest.yml', files.slice(0, 1)], ['latest-linux.yml', files.slice(1, 3)], ['latest-mac.yml', files.slice(3)]]) {
    await fs.writeFile(path.join(dir, name), JSON.stringify({ version: '0.1.1', files: subset }))
  }
  return dir
}

test('release validation accepts complete Windows/Linux/macOS output', async t => {
  const dir = await assets(t)
  assert.deepEqual((await validateAssets(dir, '0.1.1')).sort(), (await fs.readdir(dir)).map(name => path.join(dir, name)).sort())
})
test('release validation refuses missing Linux output', async t => {
  const dir = await assets(t)
  await fs.unlink(path.join(dir, 'latest-linux.yml'))
  await assert.rejects(validateAssets(dir, '0.1.1'), /Missing release asset/)
})
test('release validation refuses missing macOS output', async t => {
  // The DMG and its manifest are each required on their own: a leg that packaged
  // but never uploaded, and a manifest that lists a DMG that is not there, both
  // stop the release before a draft exists.
  const withoutDmg = await assets(t)
  await fs.unlink(path.join(withoutDmg, 'WeftCut-mac-arm64.dmg'))
  await assert.rejects(validateAssets(withoutDmg, '0.1.1'), /Missing release asset: WeftCut-mac-arm64.dmg/)
  const withoutManifest = await assets(t)
  await fs.unlink(path.join(withoutManifest, 'latest-mac.yml'))
  await assert.rejects(validateAssets(withoutManifest, '0.1.1'), /Missing release asset: latest-mac.yml/)
})
test('a macOS release carries what its self-update downloads', async t => {
  // Squirrel.Mac updates from the zip, never the DMG, and electron-updater
  // ranges over the zip's blockmap for a differential download.
  for (const file of ['WeftCut-mac-arm64.zip', 'WeftCut-mac-arm64.zip.blockmap']) {
    const dir = await assets(t)
    await fs.unlink(path.join(dir, file))
    await assert.rejects(validateAssets(dir, '0.1.1'), new RegExp(`Missing release asset: ${file.replaceAll('.', '\\.')}`))
  }
  const unlisted = await assets(t)
  const manifest = JSON.parse(await fs.readFile(path.join(unlisted, 'latest-mac.yml'), 'utf8'))
  manifest.files = manifest.files.filter(file => !file.url.endsWith('.zip'))
  await fs.writeFile(path.join(unlisted, 'latest-mac.yml'), JSON.stringify(manifest))
  await assert.rejects(validateAssets(unlisted, '0.1.1'), /Incomplete latest-mac.yml/)
})
test('release notes name every installer the validator requires', () => {
  const notes = releaseNotes()
  // Version-less on purpose: releases/latest/download/<asset> must stay a stable
  // link (electron-builder.yml artifactName), so a version creeping back in here
  // is a regression, not a naming preference.
  for (const file of ['WeftCut-win-x64.exe', 'WeftCut-linux-x86_64.AppImage', 'WeftCut-linux-amd64.deb', 'WeftCut-mac-arm64.dmg']) {
    assert.ok(notes.includes(file), `notes omit ${file}`)
  }
  assert.doesNotMatch(notes, /WeftCut-\d+\.\d+\.\d+/)
  assert.match(notes, /signed with Developer ID and notarized by Apple/)
  assert.doesNotMatch(notes, /xattr|Open Anyway|ad-hoc|do not self-update/)
})
test('a version\'s upgrade notes come first, and a version without them gets the install steps alone', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'docs', 'release-notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs', 'release-notes', '2.0.0.md'), '## Upgrading\n\nCopy the new config.\n')
  const upgrade = await readUpgradeNotes('2.0.0', root)
  assert.equal(upgrade, '## Upgrading\n\nCopy the new config.')
  const notes = releaseNotes(upgrade)
  assert.ok(notes.indexOf('## Upgrading') < notes.indexOf('## Install'))
  assert.equal(await readUpgradeNotes('2.0.1', root), null)
  assert.ok(releaseNotes(null).startsWith('## Install'))
})
test('release validation refuses corrupt installer bytes', async t => {
  const dir = await assets(t)
  await fs.writeFile(path.join(dir, 'WeftCut-win-x64.exe'), 'corrupted fixture')
  await assert.rejects(validateAssets(dir, '0.1.1'), /Checksum mismatch/)
})
test('release validation refuses stale manifests and unexpected assets', async t => {
  const dir = await assets(t)
  await fs.writeFile(path.join(dir, 'latest.yml'), JSON.stringify({ version: '0.1.0', files: [] }))
  await assert.rejects(validateAssets(dir, '0.1.1'), /Invalid version/)
  // An Intel DMG has no leg that builds it; one appearing means a stray file.
  await fs.writeFile(path.join(dir, 'WeftCut-mac-x64.dmg'), '')
  await assert.rejects(validateAssets(dir, '0.1.1'), /Unexpected release asset/)
})
