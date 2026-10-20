// apps/desktop/bench/templates.test.mjs — `node --test bench/templates.test.mjs`

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, compareBaselines, normalizeBaseline, projectNameFor, templateKey } from './templates.mjs'

const task = {
  id: 'explainer-tighten', fixtures: ['explainer-memory'], project: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
  setup: [{ tool: 'import_media', args: { path: '{fixture:explainer-memory}' }, as: 'media' }],
  prompt: 'tighten it', checklist: [{ id: 'a' }],
}
const base = { task, fixtureHashes: { 'explainer-memory': 'f'.repeat(64) }, app: { revision: 'abc', build: 'b1' }, host: 'local' }

test('templateKey: by setup content, shared across tasks, ignores prompt/checklist and key order', () => {
  const k1 = templateKey(base).key
  assert.match(k1, /^explainer-memory-[0-9a-f]{16}$/)
  // Another task with the same setup lands on the same template.
  assert.equal(templateKey({ ...base, task: { ...task, id: 'explainer-chapter-callouts', prompt: 'other', checklist: [] } }).key, k1)
  const reordered = { setup: task.setup, project: { fps: { den: 1, num: 25 }, height: 1080, width: 1920 }, fixtures: task.fixtures, id: 'x' }
  assert.equal(templateKey({ ...base, task: reordered }).key, k1)
})

test('templateKey: changes with setup, project, fixture output bytes, app build and host', () => {
  const k1 = templateKey(base).key
  assert.notEqual(templateKey({ ...base, task: { ...task, setup: [] } }).key, k1)
  assert.notEqual(templateKey({ ...base, task: { ...task, project: { ...task.project, width: 1280 } } }).key, k1)
  assert.notEqual(templateKey({ ...base, fixtureHashes: { 'explainer-memory': 'e'.repeat(64) } }).key, k1)
  assert.notEqual(templateKey({ ...base, app: { revision: 'abc', build: 'b2' } }).key, k1)
  assert.notEqual(templateKey({ ...base, host: 'remote:PC' }).key, k1)
  assert.throws(() => templateKey({ ...base, fixtureHashes: {} }), /no output hash/)
})

test('projectNameFor: from the fixtures, else the task', () => {
  assert.equal(projectNameFor(task), 'explainer-memory')
  assert.equal(projectNameFor({ id: 't', fixtures: ['b', 'a'] }), 'a--b')
  assert.equal(projectNameFor({ id: 'smoke-title-card', fixtures: [] }), 'smoke-title-card')
})

test('canonicalJson sorts keys at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}')
})

const wire = (dir, sep, extra = {}) => ({
  project_id: 'p1', metadata: { name: 't', modified_at: String(Math.random()) },
  media_pool: { m1: {
    path_abs: [dir, 'Media', 'source.webm'].join(sep), path_rel: 'Media/source.webm',
    waveform_path: [dir, 'Cache', 'waveforms', 'h.v4.peaks'].join(sep),
    decode_route: { route: 'proxied', full_proxy: [dir, 'Cache', 'proxies', 'h.mp4'].join(sep) }, ...extra,
  } },
})

test('compareBaselines: equal modulo project location, separators and modified_at', () => {
  const r = compareBaselines(wire('C:\\bench\\runs\\a\\projects\\t', '\\'), 'C:\\bench\\runs\\a\\projects\\t',
    wire('C:\\bench\\runs\\b\\projects\\t', '\\'), 'C:\\bench\\runs\\b\\projects\\t')
  assert.deepEqual(r, { equivalent: true, differences: [] })
  const posix = compareBaselines(wire('/tmp/a/projects/t', '/'), '/tmp/a/projects/t', wire('/tmp/b/projects/t', '/'), '/tmp/b/projects/t')
  assert.equal(posix.equivalent, true)
})

test('compareBaselines: a derivative still pointing at the old folder is a difference', () => {
  const copy = wire('C:\\b\\t', '\\')
  copy.media_pool.m1.waveform_path = 'C:\\a\\t\\Cache\\waveforms\\h.v4.peaks'
  const r = compareBaselines(wire('C:\\a\\t', '\\'), 'C:\\a\\t', copy, 'C:\\b\\t')
  assert.equal(r.equivalent, false)
  assert.deepEqual(r.differences.map((d) => d.path), ['/media_pool/m1/waveform_path'])
})

test('normalizeBaseline leaves unrelated strings alone', () => {
  assert.deepEqual(normalizeBaseline({ a: 'C:\\x', b: 3 }, 'C:\\proj'), { a: 'C:\\x', b: 3 })
})
