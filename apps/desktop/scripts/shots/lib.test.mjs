import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findKeys, nameMatcher, prSection, resolveText, shotId, unionBox } from './lib.mjs'

test('unionBox frames every box, padded, inside the viewport', () => {
  const box = unionBox([{ x: 10, y: 20, width: 30, height: 10 }, { x: 100, y: 5, width: 20, height: 50 }], 8, { width: 115, height: 1000 })
  assert.deepEqual(box, { x: 2, y: 0, width: 113, height: 63 })
  assert.equal(unionBox([]), null)
})

test('shotId keeps non-ASCII names apart by position', () => {
  assert.equal(shotId(0, 'Range bar'), '01-range-bar')
  assert.notEqual(shotId(0, '复看'), shotId(1, '复看'))
})

test('resolveText reads a dotted key, else takes the text as given', () => {
  const table = { menu: { view: '视图' }, count: '第 {{n}}/{{total}} 处' }
  assert.equal(resolveText(table, 'menu.view'), '视图')
  assert.equal(resolveText(table, 'Save'), 'Save')
  assert.equal(resolveText(table, 'menu.missing'), 'menu.missing')
  assert.ok(resolveText(table, 'count').test('第 3/15 处'))
})

test('nameMatcher tolerates a trailing shortcut but anchors the start', () => {
  assert.ok(nameMatcher('进入代理模式').test('进入代理模式 Ctrl+Shift+A'))
  assert.ok(!nameMatcher('代理').test('进入代理模式'))
})

test('findKeys lists every key whose text holds the query', () => {
  assert.deepEqual(findKeys({ a: { b: 'Changes' }, c: 'Other' }, 'chan'), ['a.b  Changes'])
})

test('prSection pairs sides per shot and marks what the before side lacks', () => {
  const entry = (side, id, ok) => ({ id, name: id, caption: id, lang: 'zh-CN', file: `${side}-zh-CN-${id}.png`, ok, error: ok ? undefined : 'gone' })
  const before = { label: 'main', languages: ['zh-CN'], entries: [entry('before', '01-a', true), entry('before', '02-b', false)] }
  const after = { label: 'branch', languages: ['zh-CN'], entries: [entry('after', '01-a', true), entry('after', '02-b', true)] }
  const { markdown, files } = prSection({ before, after })
  assert.deepEqual(files, ['./before-zh-CN-01-a.png', './after-zh-CN-01-a.png', './after-zh-CN-02-b.png'])
  assert.match(markdown, /\| not on main \| !\[02-b, after\]/)
  assert.equal(prSection({ after: null }).markdown, '')
  assert.deepEqual(prSection({ after }).files, ['./after-zh-CN-01-a.png', './after-zh-CN-02-b.png'])
})
