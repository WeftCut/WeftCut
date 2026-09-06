import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateVersion, planRelease, setVersion, readVersion, validateAssets } from './release.mjs'

test('only increasing stable versions become releases; unpublished versions retry', () => {
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
  // Per-target arch names, as electron-builder writes them (release.mjs).
  const files = [['exe', 'x64'], ['AppImage', 'x86_64'], ['deb', 'amd64']].map(([ext, arch]) => ({ url: `WeftCut-0.1.1-${arch}.${ext}`, size: data.length, sha512 }))
  for (const file of files) await fs.writeFile(path.join(dir, file.url), data)
  await fs.writeFile(path.join(dir, 'WeftCut-0.1.1-x64.exe.blockmap'), 'blockmap fixture')
  for (const [name, subset] of [['latest.yml', files.slice(0, 1)], ['latest-linux.yml', files.slice(1)]]) {
    await fs.writeFile(path.join(dir, name), JSON.stringify({ version: '0.1.1', files: subset }))
  }
  return dir
}

test('release validation accepts complete Windows/Linux output', async t => {
  assert.equal((await validateAssets(await assets(t), '0.1.1')).length, 6)
})
test('release validation refuses missing Linux output', async t => {
  const dir = await assets(t)
  await fs.unlink(path.join(dir, 'latest-linux.yml'))
  await assert.rejects(validateAssets(dir, '0.1.1'), /Missing release asset/)
})
test('release validation refuses corrupt installer bytes', async t => {
  const dir = await assets(t)
  await fs.writeFile(path.join(dir, 'WeftCut-0.1.1-x64.exe'), 'corrupted fixture')
  await assert.rejects(validateAssets(dir, '0.1.1'), /Checksum mismatch/)
})
test('release validation refuses stale manifests and unexpected assets', async t => {
  const dir = await assets(t)
  await fs.writeFile(path.join(dir, 'latest.yml'), JSON.stringify({ version: '0.1.0', files: [] }))
  await assert.rejects(validateAssets(dir, '0.1.1'), /Invalid version/)
  await fs.writeFile(path.join(dir, 'WeftCut-0.1.1.dmg'), '')
  await assert.rejects(validateAssets(dir, '0.1.1'), /Unexpected release asset/)
})
