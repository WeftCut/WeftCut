// Page half of the fair comparison: correctness, latency (traced) and
// throughput for every lane × divisor × content. See fair-main.cjs.
import { premultipliedDiff } from './downscale.mjs';

let begin;
const started = new Promise(resolve => { begin = resolve; });
// Main shares the texture slots first, then starts the run.
window.__fairStart = () => begin();
const status = text => { document.querySelector('#status').textContent = text; };
// Lanes f/g: main posts each lane's port through the preload before the start.
const lanePorts = new Map(), portWaiters = new Map();
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'fair-lane-port') return;
  lanePorts.set(event.data.lane, event.ports[0]);
  portWaiters.get(event.data.lane)?.(event.ports[0]);
});
const lanePort = lane => lanePorts.get(lane) ?? new Promise(resolve => portWaiters.set(lane, resolve));

const channel = new MessageChannel(), pending = new Map();
let nextId = 0;
window.postMessage({ type: 'fair-port' }, '*', [channel.port2]);
channel.port1.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  pending.delete(data.id);
  data.error ? request.reject(new Error(data.error)) : request.resolve(data);
};
const call = message => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  channel.port1.postMessage({ id, ...message });
});

// A pool of renderer workers; one job per worker at a time.
function workerPool(count, url) {
  const slots = Array.from({ length: count }, () => ({ worker: new Worker(url, { type: 'module' }), job: null }));
  const queue = [], pending = new Map();
  let seq = 0;
  const pump = () => {
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      slot.job = queue.shift();
      slot.worker.postMessage(slot.job.message, slot.job.transfer);
    }
  };
  for (const slot of slots) {
    slot.worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      pending.delete(data.id);
      slot.job = null;
      pump();
      data.error ? request.reject(new Error(data.error)) : request.resolve(data);
    };
    slot.worker.onerror = event => { window.__fairResult = { error: `worker: ${event.message}` }; };
  }
  const run = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    queue.push({ message: { id, ...message }, transfer });
    pump();
  });
  return { slots, run };
}
// Two renderer workers for lanes d1/d2, matching the two main workers of b/c.
const decoders = workerPool(2, new URL('./fair-renderer-worker.mjs', import.meta.url));
const inWorker = decoders.run;
// One renderer worker per port lane; it only turns pixels into a bitmap, and
// takes several requests at once (the native side reads in parallel).
const portWorkers = new Map();
function portWorker(lane) {
  const worker = new Worker(new URL('./fair-port-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    data.error ? request.reject(new Error(data.error)) : request.resolve(data);
  };
  const run = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message }, transfer);
  });
  portWorkers.set(lane, run);
  return run;
}

async function read(lane, content, frame, div) {
  const start = performance.now();
  if (portWorkers.has(lane)) {
    const reply = await portWorkers.get(lane)({ content, frame, div });
    return { bitmap: reply.bitmap, ms: performance.now() - start, stages: reply.stages, native: reply.native };
  }
  const reply = await call({ lane, content, frame, div });
  if (lane === 'd1' || lane === 'd2') {
    const bytes = reply.bytes.byteLength;
    const decoded = await inWorker({ bytes: reply.bytes, decoder: lane === 'd1' ? 'fzstd' : 'zstddec', div }, [reply.bytes.buffer]);
    return { bitmap: decoded.bitmap, ms: performance.now() - start, mainMs: reply.mainMs, stages: decoded.stages, bytes };
  }
  return { bitmap: reply.bitmap, ms: performance.now() - start, mainMs: reply.mainMs, workerMs: reply.workerMs, preloadMs: reply.preloadMs, native: reply.native };
}

function readback(bitmap) {
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

// What preview does next with the bitmap: a WebGPU upload, timed to completion.
const device = await (await navigator.gpu?.requestAdapter())?.requestDevice();
const textures = new Map();
async function upload(bitmap) {
  if (!device) return null;
  const key = `${bitmap.width}x${bitmap.height}`;
  let texture = textures.get(key);
  if (!texture) {
    texture = device.createTexture({ size: [bitmap.width, bitmap.height], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    textures.set(key, texture);
  }
  const start = performance.now();
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [bitmap.width, bitmap.height]);
  const submitMs = performance.now() - start;
  await device.queue.onSubmittedWorkDone();
  return { submitMs, doneMs: performance.now() - start };
}

const percentile = (values, q) => values.length ? values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)] : null;

await started;
try {
  const { config } = await call({ config: true });
  await Promise.all(decoders.slots.map(() => inWorker({ init: config.decoders })));
  for (const lane of config.portLanes) {
    const port = await lanePort(lane);
    await portWorker(lane)({ port }, [port]);
  }
  // b, c and d1 were settled by the first run (JS downscale and fzstd lose);
  // d2 stays as the renderer-WASM reference.
  const portCombos = config.portLanes.flatMap(lane => [{ lane, div: 1 }, { lane, div: 2 }]);
  const combos = [
    { lane: 'a', div: 1 }, ...(config.texture ? [{ lane: 'e', div: 1 }, { lane: 'e', div: 2 }] : []),
    { lane: 'h', div: 2 }, { lane: 'd2', div: 2 }, ...portCombos,
  ];
  const label = combo => `${combo.lane}@${combo.div}`;

  // 1. Correctness: full image against the native reader + the shared downscale.
  status('correctness');
  const correctness = [];
  for (const content of config.contents) {
    const refs = {};
    for (const div of [1, 2]) refs[div] = await call({ lane: 'ref', content, frame: 3, div });
    for (const combo of combos) {
      const { bitmap } = await read(combo.lane, content, 3, combo.div);
      const ref = refs[combo.div];
      const sizeOk = bitmap.width === ref.width && bitmap.height === ref.height;
      const diff = sizeOk ? premultipliedDiff(ref.bytes, readback(bitmap)) : null;
      bitmap.close();
      correctness.push({ combo: label(combo), content, sizeOk, ...diff });
    }
  }
  for (const combo of combos) {
    let rejected = false, message = null;
    try { (await read(combo.lane, 'corrupt', 0, combo.div)).bitmap.close(); } catch (error) { rejected = true; message = error.message; }
    correctness.push({ combo: label(combo), content: 'corrupt', rejected, message });
  }

  // 2. Latency, interleaved and traced: 3 warm-up + 30 measured rounds.
  const pairs = config.contents.flatMap(content => combos.map(combo => ({ combo, content })));
  const samples = [];
  await call({ trace: true });
  for (let round = -3; round < 30; round++) {
    status(`latency round ${round}`);
    const shift = ((round % pairs.length) + pairs.length) % pairs.length;
    for (const { combo, content } of pairs.slice(shift).concat(pairs.slice(0, shift))) {
      const mark = `fair:${label(combo)}:${content}:${round}`;
      performance.mark(`${mark}:start`);
      const result = await read(combo.lane, content, round + 8, combo.div);
      performance.mark(`${mark}:end`);
      const uploaded = await upload(result.bitmap);
      result.bitmap.close();
      if (round >= 0) samples.push({ combo: label(combo), content, round, ms: result.ms, mainMs: result.mainMs, workerMs: result.workerMs, preloadMs: result.preloadMs, stages: result.stages, native: result.native, bytes: result.bytes, upload: uploaded });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await call({ trace: false });

  // 3. Throughput: 45 frames, 3 in flight, as preview prefetch and export do.
  const throughput = [];
  for (const content of ['typical', 'dense']) {
    for (const combo of combos) {
      status(`throughput ${label(combo)} ${content}`);
      let next = 0;
      const latencies = [], start = performance.now();
      const runner = async () => {
        while (next < 45) {
          const frame = next++, s = performance.now();
          const result = await read(combo.lane, content, frame, combo.div);
          latencies.push(performance.now() - s);
          result.bitmap.close();
        }
      };
      await Promise.all([runner(), runner(), runner()]);
      throughput.push({ combo: label(combo), content, fps: 45 / ((performance.now() - start) / 1000), medianMs: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) });
    }
  }

  const summary = pairs.map(({ combo, content }) => {
    const s = samples.filter(x => x.combo === label(combo) && x.content === content);
    const pick = f => percentile(s.map(f).filter(v => v != null), 0.5);
    return { combo: label(combo), content, medianMs: pick(x => x.ms), p95Ms: percentile(s.map(x => x.ms), 0.95),
      mainMs: pick(x => x.mainMs), preloadMs: pick(x => x.preloadMs), decodeMs: pick(x => x.stages?.decodeMs), hashMs: pick(x => x.stages?.hashMs),
      scaleMs: pick(x => x.stages?.scaleMs ?? x.workerMs?.scaleMs), uploadMs: pick(x => x.upload?.doneMs),
      bitmapMs: pick(x => x.stages?.bitmapMs),
      native: s.some(x => x.native) ? {
        readMs: pick(x => (x.native?.read ?? x.native)?.readMs), decodeMs: pick(x => (x.native?.read ?? x.native)?.decodeMs),
        hashMs: pick(x => (x.native?.read ?? x.native)?.hashMs), scaleMs: pick(x => (x.native?.read ?? x.native)?.scaleMs),
        premultiplyMs: pick(x => x.native?.premultiplyMs), acquireMs: pick(x => x.native?.acquireMs),
        acquireP95Ms: percentile(s.map(x => x.native?.acquireMs).filter(v => v != null), 0.95), gpuMs: pick(x => x.native?.gpuMs),
      } : null };
  });
  window.__fairResult = { config, correctness, summary, throughput, samples };
  status('done');
} catch (error) {
  window.__fairResult = { error: String(error?.stack ?? error) };
  status(`failed: ${error}`);
}
