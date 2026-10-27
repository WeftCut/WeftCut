import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import afterPackGlibc, { linuxLibraries } from './after-pack-glibc.mjs'

/// A packed Linux app whose unpacked addon directories hold the named files.
/// A name mapped to a string is a symlink to that target, as the SONAME chain is.
function packed(t, files = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  const modules = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@weftcut')
  for (const addon of ['core', 'native-decode']) fs.mkdirSync(path.join(modules, addon), { recursive: true })
  for (const [name, link] of Object.entries(files)) {
    const file = path.join(modules, name)
    if (typeof link === 'string') fs.symlinkSync(link, file)
    else fs.writeFileSync(file, 'ELF')
  }
  const context = {
    appOutDir,
    electronPlatformName: 'linux',
    packager: { getResourcesDir: (dir) => path.join(dir, 'resources') },
  }
  return { context, resources: path.join(appOutDir, 'resources'), modules }
}

const names = (files, modules) => files.map((f) => path.relative(modules, f).split(path.sep).join('/'))

test('both addons and every co-located real library are checked; SONAME links are not', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
  const { resources, modules } = packed(t, {
    'core/index.linux-x64-gnu.node': true,
    'core/index.js': true,
    'native-decode/index.linux-x64-gnu.node': true,
    'native-decode/libavutil.so.60.26.103': true,
    'native-decode/libavutil.so.60': 'libavutil.so.60.26.103',
    'native-decode/libavutil.so': 'libavutil.so.60',
    'native-decode/libva.so.2.2200.0': true,
    'native-decode/libva-drm.so.2.2200.0': true,
    'native-decode/LICENSE.txt': true,
  })
  assert.deepEqual(names(linuxLibraries(resources), modules), [
    'core/index.linux-x64-gnu.node',
    'native-decode/index.linux-x64-gnu.node',
    'native-decode/libavutil.so.60.26.103',
    'native-decode/libva-drm.so.2.2200.0',
    'native-decode/libva.so.2.2200.0',
  ])
})

test('an addon that was not unpacked stops the build rather than passing an empty check', (t) => {
  const { context, modules } = packed(t)
  fs.rmSync(path.join(modules, 'native-decode'), { recursive: true })
  assert.throws(() => afterPackGlibc(context, () => {}), /afterPack\(glibc\).*native-decode is missing/s)
})

test('the check receives the libraries and its failure fails the pack', (t) => {
  const { context } = packed(t, { 'core/index.linux-x64-gnu.node': true })
  let seen
  afterPackGlibc(context, (files, { label }) => {
    seen = { count: files.length, label }
  })
  assert.deepEqual(seen, { count: 1, label: 'afterPack(glibc):' })
  assert.throws(
    () => afterPackGlibc(context, () => { throw new Error('too new') }),
    /too new/,
  )
})

test('Windows and macOS packages are not ELF and are skipped', (t) => {
  for (const platform of ['win32', 'darwin']) {
    const { context } = packed(t)
    context.electronPlatformName = platform
    assert.doesNotThrow(() => afterPackGlibc(context, () => assert.fail('checked a non-Linux package')))
  }
})
