const { parentPort, workerData } = require('node:worker_threads');
const native = require(workerData.native);
const { PNG } = require('pngjs');
parentPort.on('message', async ({ id, file, mode }) => {
  try {
    const start = performance.now();
    const frame = await native.motifReadFrame(file);
    const width = frame.width / 2, height = frame.height / 2;
    const pixels = new Uint8Array(width * height * 4);
    const src = new Uint32Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.width * frame.height);
    const dst = new Uint32Array(pixels.buffer);
    // Fixed nearest-neighbour scaler: deliberately the same for b/c/d.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) dst[y*width+x] = src[y*2*frame.width+x*2];
    const scaledAt = performance.now();
    const bytes = mode === 'c' ? PNG.sync.write({ width, height, data: pixels }, { deflateLevel: 1, deflateStrategy: 3, filterType: 0 }) : pixels;
    parentPort.postMessage({ id, width, height, bytes, kind: mode === 'c' ? 'png' : 'rgba', workerMs: performance.now()-start, scaleReadMs: scaledAt-start });
  } catch (e) { parentPort.postMessage({ id, error: String(e.stack) }); }
});
