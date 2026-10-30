// Lanes b and c of the fair comparison: native read + downscale (+ PNG) in a
// main-process worker.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { downscale } from './downscale.mjs';

const require = createRequire(import.meta.url);
const native = require(workerData.native);
const { PNG } = require('pngjs');

parentPort.on('message', async ({ file, div, png }) => {
  try {
    const t0 = performance.now();
    const frame = await native.motifReadFrame(file);
    const t1 = performance.now();
    const scaled = downscale(frame.rgba, frame.width, frame.height, div);
    const t2 = performance.now();
    let bytes = scaled.rgba;
    // Same encoder settings as the first transport harness: deflate 1, no filter, RLE.
    if (png) bytes = PNG.sync.write({ width: scaled.width, height: scaled.height, data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) }, { deflateLevel: 1, deflateStrategy: 3, filterType: 0 });
    const t3 = performance.now();
    // Only a view that owns its whole buffer is transferable.
    const out = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes);
    parentPort.postMessage({ width: scaled.width, height: scaled.height, bytes: out, readMs: t1 - t0, scaleMs: t2 - t1, encodeMs: t3 - t2 }, [out.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message ?? error) });
  }
});
