// apps/desktop/bench/fixtures/fixtures.test.mjs — `node --test bench/fixtures/fixtures.test.mjs`

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadManifest, transcodeArgs } from './fixtures.mjs'

test('manifest: transcode recipe and per-fixture pins are well-formed', () => {
  const m = loadManifest()
  assert.equal(m.transcode.container, 'mp4')
  for (const f of m.fixtures) {
    assert.equal(f.media.video_codec, 'h264')
    assert.equal(f.media.audio_codec, 'aac')
  }
  assert.ok(m.fixtures.find((f) => f.id === 'explainer-memory').trim.sha256)
})

test('transcodeArgs: source frame rate, fixed GOP, no scene-cut keyframes, AAC 48 kHz stereo, faststart', () => {
  const m = loadManifest()
  const byId = (id) => m.fixtures.find((f) => f.id === id)
  const a = transcodeArgs('IN', 'OUT', byId('talking-head-interview'), m.transcode)
  const after = (flag) => a[a.indexOf(flag) + 1]
  assert.deepEqual([a[4], a[5], a.at(-1)], ['-i', 'IN', 'OUT'])
  assert.equal(after('-c:v'), 'libx264')
  assert.equal(after('-pix_fmt'), 'yuv420p')
  assert.equal(after('-r'), '24000/1001')
  assert.equal(after('-g'), '48')
  assert.equal(after('-keyint_min'), '48')
  assert.equal(after('-sc_threshold'), '0')
  assert.equal(after('-c:a'), 'aac')
  assert.equal(after('-ar'), '48000')
  assert.equal(after('-ac'), '2')
  assert.equal(after('-movflags'), '+faststart')
  const e = transcodeArgs('IN', 'OUT', byId('explainer-memory'), m.transcode)
  assert.equal(e[e.indexOf('-r') + 1], '25/1')
  assert.equal(e[e.indexOf('-g') + 1], '50')
})
