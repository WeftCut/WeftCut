// Fair transport comparison for one cached 4K Motif frame (#62). Every lane
// runs in this one app on the same frames and verifies the pixel hash, so the
// lanes differ only in where the work happens and what crosses IPC:
//   a   native read in main, full RGBA over IPC (macOS / Linux today)
//   e   the Windows texture lane, replicated from main/motif/gpuTransport.ts;
//       at 1/2 the native pool downscales before premultiply and upload
//   b   main worker: native read + JS downscale, scaled RGBA over IPC
//   c   main worker: native read + JS downscale + PNG (#89)
//   d1  compressed file to a renderer worker: fzstd + BLAKE3 + downscale
//   d2  as d1 with zstddec (WASM)
//   h   native read + native downscale in main, scaled RGBA over today's IPC
//   f   as h, but posted through a MessagePortMain straight to a renderer worker
//   g   as f, from a utility process, so main's thread never touches pixels
const { app, BrowserWindow, ipcMain, contentTracing, sharedTexture, MessageChannelMain, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { desktop, output, writeJson, sanitize } = require('./common.cjs');

fs.mkdirSync(path.join(output, '.private'), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, '.private/fair-profile-')));
const nativePath = path.join(desktop, 'native/index.js');
const native = require(nativePath);
const WIDTH = 3840, HEIGHT = 2160;
const CONTENTS = ['sparse', 'typical', 'dense'];
const directories = { sparse: 'frames-3840', typical: 'frames-typical-3840', dense: 'frames-dense-3840' };

// A frame whose payload has one flipped byte: every lane must reject it.
const corruptFile = path.join(output, '.private/corrupt.wfrm');
{
  const bytes = fs.readFileSync(path.join(output, directories.typical, '0.wfrm'));
  bytes[52 + Math.floor((bytes.length - 52) / 2)] ^= 0x40;
  fs.writeFileSync(corruptFile, bytes);
}
const frameFile = (content, frame) => content === 'corrupt' ? corruptFile
  : path.join(output, directories[content], `${frame % 8}.wfrm`);

let downscale;
const loaded = import(pathToFileURL(path.join(__dirname, 'downscale.mjs')).href).then(m => { downscale = m.downscale; });

// Lanes b and c: two main-process workers, as in the #89 prototype.
const workers = [0, 1].map(() => ({ worker: new Worker(path.join(__dirname, 'fair-main-worker.mjs'), { workerData: { native: nativePath } }), job: null }));
const queue = [];
function pump() {
  for (const slot of workers) {
    if (slot.job || !queue.length) continue;
    slot.job = queue.shift();
    slot.worker.postMessage(slot.job.message);
  }
}
for (const slot of workers) {
  slot.worker.on('message', reply => { const job = slot.job; slot.job = null; job.resolve(reply); pump(); });
  slot.worker.on('error', error => { slot.job?.resolve({ error: String(error) }); slot.job = null; pump(); });
}
const inMainWorker = message => new Promise(resolve => { queue.push({ message, resolve }); pump(); });

// Lane e: three persistent slots per size, each imported and shared once,
// leased per read and released by the renderer after its read barrier (as
// production).
const gpu = process.platform === 'win32' && native.MotifGpuPool ? { 1: { slots: [], waiters: [] }, 2: { slots: [], waiters: [] } } : null;
async function shareSlots(win, div) {
  const width = WIDTH / div, height = HEIGHT / div;
  for (let i = 0; i < 3; i++) {
    const pool = new native.MotifGpuPool(width, height, 1, false);
    const key = `slot-${div}-${i}`;
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width, height }, pixelFormat: 'rgba',
        colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
        handle: { ntHandle: pool.handles()[0] },
      },
      allReferencesReleased: () => pool.close(),
    });
    win.webContents.send('fair-slot', key);
    await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported });
    gpu[div].slots.push({ key, div, pool, imported, busy: false });
  }
}
function acquireSlot(div) {
  const free = gpu[div].slots.find(slot => !slot.busy);
  if (free) { free.busy = true; return Promise.resolve(free); }
  return new Promise(resolve => gpu[div].waiters.push(resolve));
}
function releaseSlot(key) {
  const slot = gpu && [...gpu[1].slots, ...gpu[2].slots].find(s => s.key === key);
  if (!slot) return;
  const next = gpu[slot.div].waiters.shift();
  if (next) next(slot); else slot.busy = false;
}

// Lanes f and g: the renderer worker asks over its port; pixels come back on
// the same port, so the page's main thread never deserializes them. Main
// records how long its own thread spends serializing each reply.
const postMs = { f: [] };
function serve(port, lane) {
  port.on('message', async ({ data }) => {
    const { id, content, frame, div } = data;
    try {
      const f = await native.motifReadFrameScaled(frameFile(content, frame), div);
      const start = performance.now();
      port.postMessage({ id, width: f.width, height: f.height, rgba: f.rgba, native: f.timing });
      postMs[lane].push(performance.now() - start);
    } catch (error) { port.postMessage({ id, error: String(error?.message ?? error) }); }
  });
  port.start();
}
let utility = null;
async function startUtility() {
  const child = utilityProcess.fork(path.join(__dirname, 'fair-utility.cjs'), [], { serviceName: 'motif-fair-reader', stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('exit', code => reject(new Error(`utility exited ${code}`))); });
  child.postMessage({ init: { native: nativePath, directories: Object.fromEntries(CONTENTS.map(c => [c, path.join(output, directories[c])])), corruptFile } });
  return child;
}
function sharePort(win, lane, attach) {
  const { port1, port2 } = new MessageChannelMain();
  attach(port1);
  win.webContents.postMessage('fair-lane-port', lane, [port2]);
}
ipcMain.on('fair-ack', (_event, key) => releaseSlot(key));

ipcMain.handle('fair-read', async (_event, { lane, content, frame, div = 1 }) => {
  const file = frameFile(content, frame);
  const start = performance.now();
  let result;
  if (lane === 'ref') {
    const f = await native.motifReadFrame(file);
    const s = downscale(f.rgba, f.width, f.height, div);
    result = { kind: 'ref', width: s.width, height: s.height, bytes: s.rgba };
  } else if (lane === 'a') {
    const f = await native.motifReadFrame(file);
    result = { kind: 'rgba', width: f.width, height: f.height, bytes: f.rgba };
  } else if (lane === 'e') {
    if (!gpu) throw new Error('Texture lane unavailable');
    const slot = await acquireSlot(div);
    let timing;
    try { timing = await slot.pool.uploadFile(file, 0, div); } catch (error) { releaseSlot(slot.key); throw error; }
    result = { kind: 'texture', key: slot.key, width: WIDTH / div, height: HEIGHT / div, native: timing };
  } else if (lane === 'h') {
    const f = await native.motifReadFrameScaled(file, div);
    result = { kind: 'rgba', width: f.width, height: f.height, bytes: f.rgba, native: f.timing };
  } else if (lane === 'b' || lane === 'c') {
    const reply = await inMainWorker({ file, div, png: lane === 'c' });
    if (reply.error) throw new Error(reply.error);
    result = { kind: lane === 'c' ? 'png' : 'rgba', width: reply.width, height: reply.height, bytes: reply.bytes,
      workerMs: { readMs: reply.readMs, scaleMs: reply.scaleMs, encodeMs: reply.encodeMs } };
  } else if (lane === 'd1' || lane === 'd2') {
    const bytes = await fs.promises.readFile(file);
    result = { kind: 'wfrm', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  } else throw new Error(`Unknown lane ${lane}`);
  return { ...result, mainMs: performance.now() - start };
});

const decoderUrl = entry => pathToFileURL(path.join(output, 'decoder/node_modules', entry)).href;
ipcMain.handle('fair-config', () => ({
  platform: process.platform, texture: !!gpu, contents: CONTENTS, portLanes: utility ? ['f', 'g'] : ['f'],
  decoders: { fzstd: decoderUrl('fzstd/esm/index.mjs'), zstddec: decoderUrl('zstddec/dist/zstddec.mjs'), hash: decoderUrl('hash-wasm/dist/index.esm.js') },
}));
ipcMain.handle('fair-trace', async (_event, on) => {
  if (on) await contentTracing.startRecording({ included_categories: ['toplevel', 'disabled-by-default-devtools.timeline', 'devtools.timeline', 'v8', 'blink.user_timing'] });
  else await contentTracing.stopRecording(path.join(output, '.private/fair-trace.json'));
});

function fileSizes() {
  return Object.fromEntries(CONTENTS.map(content => {
    const sizes = [...Array(8).keys()].map(frame => fs.statSync(frameFile(content, frame)).size);
    return [content, { meanBytes: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), maxBytes: Math.max(...sizes) }];
  }));
}

app.whenReady().then(async () => {
  await loaded;
  const win = new BrowserWindow({ width: 1100, height: 750, webPreferences: { preload: path.join(__dirname, 'fair-preload.cjs'), sandbox: false, contextIsolation: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(sanitize(event.message)); });
  await win.loadFile(path.join(__dirname, 'fair.html'));
  if (gpu) { await shareSlots(win, 1); await shareSlots(win, 2); }
  sharePort(win, 'f', port => serve(port, 'f'));
  try {
    utility = await startUtility();
    sharePort(win, 'g', port => utility.postMessage({ port: true }, [port]));
  } catch (error) { console.error(`utility lane unavailable: ${sanitize(String(error))}`); }
  await win.webContents.executeJavaScript('window.__fairStart?.()');
  const interval = setInterval(async () => {
    try {
      const result = await win.webContents.executeJavaScript('window.__fairResult ?? null');
      if (!result) return;
      clearInterval(interval);
      const mainPost = Object.fromEntries(Object.entries(postMs).map(([lane, values]) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return [lane, { count: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null }];
      }));
      writeJson('fair-result.json', { versions: process.versions, gpu: app.getGPUFeatureStatus(), files: fileSizes(), mainPost, ...result });
      console.log(JSON.stringify(result.error ?? result.summary, null, 1));
      for (const slot of workers) await slot.worker.terminate();
      utility?.kill();
      app.exit(result.error ? 1 : 0);
    } catch (error) { console.error(sanitize(String(error))); clearInterval(interval); app.exit(1); }
  }, 2000);
});
