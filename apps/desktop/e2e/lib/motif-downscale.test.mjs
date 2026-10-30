import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { VECTORS_PATH, compareReadback, downscaleReference, encodePng, premultiply, syntheticFrame } from './motif-downscale.mjs'

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))

test('the reference downscale reproduces every native vector', () => {
  assert.ok(vectors.cases.length >= 17)
  for (const c of vectors.cases) {
    const out = downscaleReference(Uint8Array.from(c.rgba), c.width, c.height, c.div)
    assert.equal(out.width, c.expected.width, c.name)
    assert.equal(out.height, c.expected.height, c.name)
    assert.deepEqual([...out.rgba], c.expected.rgba, c.name)
  }
})

test('the output size rounds up and odd frames keep their edge blocks', () => {
  const rgba = syntheticFrame(1001, 563)
  for (const [div, w, h] of [[1, 1001, 563], [2, 501, 282], [4, 251, 141]]) {
    const out = downscaleReference(rgba, 1001, 563, div)
    assert.deepEqual([out.width, out.height], [w, h])
  }
  // The last column at div 4 covers one input column (1000).
  const out = downscaleReference(rgba, 1001, 563, 4)
  const lastColumn = new Uint8Array(563 * 4)
  for (let y = 0; y < 563; y++) lastColumn.set(rgba.subarray((y * 1001 + 1000) * 4, (y * 1001 + 1001) * 4), y * 4)
  const column = downscaleReference(lastColumn, 1, 563, 4)
  for (let y = 0; y < 141; y++) {
    assert.deepEqual([...out.rgba.subarray((y * 251 + 250) * 4, (y * 251 + 251) * 4)], [...column.rgba.subarray(y * 4, y * 4 + 4)])
  }
})

test('the synthetic frame has transparent, opaque and translucent texels', () => {
  const rgba = syntheticFrame(1001, 563)
  const alphas = new Set()
  for (let i = 3; i < rgba.length; i += 4) alphas.add(rgba[i])
  assert.ok(alphas.has(0) && alphas.has(255) && alphas.has(1) && alphas.has(128))
})

test('PNG encoding keeps straight pixels exactly', () => {
  const rgba = syntheticFrame(37, 23)
  const decoded = PNG.sync.read(encodePng(rgba, 37, 23))
  assert.deepEqual([decoded.width, decoded.height], [37, 23])
  assert.deepEqual([...decoded.data], [...rgba])
})

/** What a canvas read-back of a premultiplied surface returns. */
function canvasRoundTrip(rgba, premultiplyRound = premultiply) {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    out[i + 3] = a
    for (let c = 0; c < 3; c++) out[i + c] = a === 0 ? 0 : Math.min(255, Math.round((premultiplyRound(rgba[i + c], a) * 255) / a))
  }
  return out
}

test('a premultiplied read-back passes both rules; real errors fail them', () => {
  const { rgba, width, height } = downscaleReference(syntheticFrame(101, 67), 101, 67, 2)
  const roundTrip = canvasRoundTrip(rgba)
  for (const rule of ['straight', 'premultiplied']) {
    assert.equal(compareReadback({ expected: rgba, actual: roundTrip, width, height, rule }).mismatches, 0, rule)
  }
  // A truncating premultiply is off by at most one.
  const truncated = canvasRoundTrip(rgba, (c, a) => Math.floor((c * a) / 255))
  assert.equal(compareReadback({ expected: rgba, actual: truncated, width, height, rule: 'premultiplied' }).mismatches, 0)

  const opaque = rgba.findIndex((v, i) => i % 4 === 3 && v === 255) - 3
  const translucent = rgba.findIndex((v, i) => i % 4 === 3 && v > 200 && v < 255) - 3
  const shifted = (index, channel, delta) => {
    const copy = Uint8Array.from(roundTrip)
    copy[index + channel] = Math.max(0, Math.min(255, copy[index + channel] + delta))
    return copy
  }
  // Opaque texels are exact on the straight lane, within 2 on the texture lane.
  const opaqueOff = shifted(opaque, 0, opaque >= 0 && roundTrip[opaque] > 0 ? -1 : 1)
  assert.equal(compareReadback({ expected: rgba, actual: opaqueOff, width, height, rule: 'straight' }).mismatches, 1)
  assert.equal(compareReadback({ expected: rgba, actual: opaqueOff, width, height, rule: 'premultiplied' }).mismatches, 0)
  // Alpha is exact on the straight lane.
  const alphaOff = shifted(translucent, 3, -1)
  assert.equal(compareReadback({ expected: rgba, actual: alphaOff, width, height, rule: 'straight' }).mismatches, 1)
  // Three premultiplied steps fail both rules.
  const colourOff = shifted(translucent, 1, roundTrip[translucent + 1] > 128 ? -4 : 4)
  for (const rule of ['straight', 'premultiplied']) {
    const result = compareReadback({ expected: rgba, actual: colourOff, width, height, rule })
    assert.equal(result.mismatches, 1, rule)
    assert.ok(result.maxError >= 3)
    assert.equal(result.first.length, 1)
  }
  assert.equal(compareReadback({ expected: rgba, actual: roundTrip.subarray(4), width, height, rule: 'straight' }).maxError, Infinity)
})
