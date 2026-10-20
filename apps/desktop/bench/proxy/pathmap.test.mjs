// apps/desktop/bench/proxy/pathmap.test.mjs — `node --test bench/proxy/pathmap.test.mjs`

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPathMap } from './pathmap.mjs'

const LOCAL = '/tmp/weftcut-bench-AbC/work'
const REMOTE = 'C:\\Users\\iClass\\weftcut-bench\\runs\\r1\\work'
const map = createPathMap({ localRoot: LOCAL, remoteRoot: REMOTE })

test('toRemote: a workdir path, nested, in a tool argument', () => {
  const { value, rewrites, outside } = map.toRemote({ source: { kind: 'directory', path: `${LOCAL}/callout/` } })
  assert.deepEqual(value, { source: { kind: 'directory', path: `${REMOTE}\\callout` } })
  assert.deepEqual(rewrites, [{ dir: 'to-remote', from: `${LOCAL}/callout/`, to: `${REMOTE}\\callout` }])
  assert.deepEqual(outside, [])
})

test('toRemote: the root itself, deep files, arrays', () => {
  const { value } = map.toRemote([LOCAL, `${LOCAL}/`, `${LOCAL}/a/b/c.json`, `${LOCAL}/./a//b`])
  assert.deepEqual(value, [REMOTE, REMOTE, `${REMOTE}\\a\\b\\c.json`, `${REMOTE}\\a\\b`])
})

test('toRemote: paths outside the workdir pass through and are reported', () => {
  const { value, rewrites, outside } = map.toRemote({ a: '/home/me/clip.mp4', b: `${LOCAL}/../escape.json`, c: `${LOCAL}-sibling/x`, d: 'not a path', e: '/' })
  assert.deepEqual(value, { a: '/home/me/clip.mp4', b: `${LOCAL}/../escape.json`, c: `${LOCAL}-sibling/x`, d: 'not a path', e: '/' })
  assert.deepEqual(rewrites, [])
  assert.deepEqual(outside.map((o) => o.value), ['/home/me/clip.mp4', `${LOCAL}/../escape.json`, `${LOCAL}-sibling/x`])
})

test('toRemote: keys, numbers, booleans and null are untouched', () => {
  const input = { [`${LOCAL}/k`]: 1, n: 2, t: true, z: null }
  assert.deepEqual(map.toRemote(input).value, input)
})

test('toRemote: a path embedded in longer text is not rewritten', () => {
  const s = `see ${LOCAL}/x.json`
  assert.equal(map.toRemote(s).value, s)
})

test('toLocal: a whole remote path, raw', () => {
  const { value, rewrites } = map.toLocal({ path: `${REMOTE}\\callout\\motif.json` })
  assert.deepEqual(value, { path: `${LOCAL}/callout/motif.json` })
  assert.equal(rewrites.length, 1)
})

test('toLocal: embedded in prose and in JSON-escaped text', () => {
  const prose = `Opened ${REMOTE}\\callout as draft d1.`
  assert.equal(map.toLocal(prose).value, `Opened ${LOCAL}/callout as draft d1.`)
  const jsonText = JSON.stringify({ dir: `${REMOTE}\\callout`, files: [`${REMOTE}\\callout\\a.js`] })
  const back = map.toLocal(jsonText).value
  assert.deepEqual(JSON.parse(back), { dir: `${LOCAL}/callout`, files: [`${LOCAL}/callout/a.js`] })
})

test('toLocal: case and separator variants of the root', () => {
  const lower = REMOTE.toLowerCase().replace(/\\/g, '/')
  assert.equal(map.toLocal(`${lower}/m/x.json`).value, `${LOCAL}/m/x.json`)
  assert.equal(map.toLocal(`${REMOTE}\\`).value, LOCAL)
})

test('toLocal: a sibling of the root is not the root', () => {
  const s = `${REMOTE}2\\x`
  assert.equal(map.toLocal(s).value, s)
  assert.equal(map.toLocal('C:\\Users\\iClass\\weftcut-bench\\runs\\r1\\projects\\t\\project.json').rewrites.length, 0)
})

test('round trip: toLocal(toRemote(p)) === p for workdir paths', () => {
  for (const p of [`${LOCAL}/a`, `${LOCAL}/a/b-c_d.e/f.json`]) {
    const r = map.toRemote(p).value
    assert.equal(map.toLocal(r).value, p)
  }
})

test('known limit: toLocal stops a path at whitespace (prose cannot be told apart)', () => {
  // `x y\z` maps forward fine; back, only the root and `x` are recognised.
  const r = map.toRemote(`${LOCAL}/x y/z`).value
  assert.equal(r, `${REMOTE}\\x y\\z`)
  assert.equal(map.toLocal(r).value, `${LOCAL}/x y\\z`)
})

test('constructor rejects relative roots', () => {
  assert.throws(() => createPathMap({ localRoot: 'work', remoteRoot: REMOTE }))
  assert.throws(() => createPathMap({ localRoot: LOCAL, remoteRoot: 'work' }))
})
