import test from 'node:test';
import assert from 'node:assert/strict';
import { downscale, premultipliedDiff } from './downscale.mjs';

const px = (...values) => new Uint8Array(values);

test('a transparent block stays transparent black', () => {
  assert.deepEqual([...downscale(new Uint8Array(16), 2, 2, 2).rgba], [0, 0, 0, 0]);
});

test('transparent texels do not darken an opaque one', () => {
  const { rgba } = downscale(px(255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 2, 2, 2);
  assert.deepEqual([...rgba], [255, 0, 0, 64]);
});

test('colour is weighted by alpha', () => {
  const { rgba } = downscale(px(255, 0, 0, 255, 0, 0, 255, 85, 0, 0, 0, 0, 0, 0, 0, 0), 2, 2, 2);
  // r = 255·255/340, b = 255·85/340, a = 340/4.
  assert.deepEqual([...rgba], [191, 0, 64, 85]);
});

test('a uniform image is unchanged in colour at divisor 4', () => {
  const src = new Uint8Array(8 * 4 * 4);
  for (let p = 0; p < src.length; p += 4) src.set([10, 20, 30, 200], p);
  const out = downscale(src, 8, 4, 4);
  assert.deepEqual([out.width, out.height], [2, 1]);
  assert.deepEqual([...out.rgba], [10, 20, 30, 200, 10, 20, 30, 200]);
});

test('divisor 1 returns the input', () => {
  const src = px(1, 2, 3, 4);
  assert.equal(downscale(src, 1, 1, 1).rgba, src);
});

test('premultiplied comparison ignores colour lost at zero alpha', () => {
  assert.deepEqual(premultipliedDiff(px(200, 100, 50, 0), px(0, 0, 0, 0)), { max: 0, alphaMax: 0, over: 0 });
  assert.deepEqual(premultipliedDiff(px(200, 100, 50, 255), px(197, 100, 50, 255)), { max: 3, alphaMax: 0, over: 1 });
});
