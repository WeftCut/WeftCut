// apps/desktop/bench/proxy/mirror.test.mjs — `node --test bench/proxy/mirror.test.mjs`

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createMirror, emptySnapshot, planSync, scanDir, sftpBatch } from './mirror.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'))
}

test('scanDir skips the top-level .claude (the installed skill)', () => {
  const d = tmp()
  fs.mkdirSync(path.join(d, '.claude', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(d, '.claude', 'skills', 'x'), 'x')
  fs.mkdirSync(path.join(d, 'm', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(d, 'm', 'motif.json'), '{}')
  const s = scanDir(d)
  assert.deepEqual([...s.dirs].sort(), ['m', 'm/assets'])
  assert.deepEqual([...s.files.keys()], ['m/motif.json'])
})

test('planSync: adds, changes, deletions, ordering', () => {
  const prev = { files: new Map([['a/x', '1'], ['a/y', '2'], ['b/c/z', '3']]), dirs: new Set(['a', 'b', 'b/c']) }
  const next = { files: new Map([['a/x', '1'], ['a/y', '9'], ['n/d/w', '4']]), dirs: new Set(['a', 'n', 'n/d']) }
  assert.deepEqual(planSync(prev, next), {
    mkdirs: ['n', 'n/d'],
    puts: ['a/y', 'n/d/w'],
    rmFiles: ['b/c/z'],
    rmDirs: ['b/c', 'b'],
  })
  assert.deepEqual(planSync(next, next), { mkdirs: [], puts: [], rmFiles: [], rmDirs: [] })
})

test('sftpBatch: remote spelling, quoting, tolerant removals', () => {
  const plan = { mkdirs: ['m'], puts: ['m/motif.json'], rmFiles: ['old.txt'], rmDirs: ['gone'] }
  assert.equal(sftpBatch(plan, '/tmp/w', '/C:/bench/runs/r/work'), [
    '-mkdir "/C:/bench/runs/r/work/m"',
    'put "/tmp/w/m/motif.json" "/C:/bench/runs/r/work/m/motif.json"',
    '-rm "/C:/bench/runs/r/work/old.txt"',
    '-rmdir "/C:/bench/runs/r/work/gone"',
  ].join('\n') + '\n')
  assert.equal(sftpBatch(planSync(emptySnapshot(), emptySnapshot()), '/tmp/w', '/C:/x'), '')
  assert.throws(() => sftpBatch({ mkdirs: [], puts: ['a"b'], rmFiles: [], rmDirs: [] }, '/tmp/w', '/C:/x'))
})

test('createMirror pushes only what changed, including deletions', async () => {
  const d = tmp()
  const pushed = []
  const m = createMirror({ localRoot: d, push: async (p) => { pushed.push(p) } })
  assert.equal((await m.sync()).puts.length, 0)
  assert.equal(pushed.length, 0, 'an empty workdir pushes nothing')
  fs.mkdirSync(path.join(d, 'm'))
  fs.writeFileSync(path.join(d, 'm', 'a.js'), '1')
  await m.sync()
  await m.sync()
  assert.equal(pushed.length, 1, 'an unchanged tree is not pushed again')
  assert.deepEqual(pushed[0], { mkdirs: ['m'], puts: ['m/a.js'], rmFiles: [], rmDirs: [] })
  fs.writeFileSync(path.join(d, 'm', 'a.js'), '2')
  fs.rmSync(path.join(d, 'm', 'a.js'))
  fs.writeFileSync(path.join(d, 'm', 'b.js'), '3')
  await m.sync()
  assert.deepEqual(pushed[1], { mkdirs: [], puts: ['m/b.js'], rmFiles: ['m/a.js'], rmDirs: [] })
})
