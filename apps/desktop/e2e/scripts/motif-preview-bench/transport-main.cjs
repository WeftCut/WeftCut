const { app, BrowserWindow, ipcMain, contentTracing } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { desktop, output, writeJson, sanitize } = require('./common.cjs');
fs.mkdirSync(path.join(output, '.private'), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, '.private/transport-profile-')));
const { Worker } = require('node:worker_threads');
const nativePath = path.join(desktop, 'native/index.js');
const native = require(nativePath);
const worker = new Worker(path.join(__dirname, 'transport-worker.cjs'), { workerData: { native: nativePath } });
const pending = new Map(); let seq = 0;
worker.on('message', reply => { pending.get(reply.id)?.(reply); pending.delete(reply.id); });
worker.on('error', error => {
  for (const resolve of pending.values()) resolve({ error: sanitize(String(error)) });
  pending.clear();
});
ipcMain.handle('bench-read', async (_event, { mode, frame = 15, width = 3840 }) => {
  const file = path.join(output, `frames-${width}`, `${frame}.wfrm`);
  const start = performance.now(); let result;
  if (mode === 'a') {
    const f = await native.motifReadFrame(file);
    result = { kind: 'rgba', width: f.width, height: f.height, bytes: f.rgba };
  } else if (mode === 'd') {
    const bytes = await fs.promises.readFile(file);
    if (bytes.length < 52 || bytes.toString('ascii', 0, 8) !== 'WCMFRM01' || bytes.readUInt32LE(16) !== 2) throw new Error('Expected a codec-2 Motif frame');
    result = { kind: 'zstd', bytes: new Uint8Array(bytes.subarray(52)), width: bytes.readUInt32LE(8), height: bytes.readUInt32LE(12),
      decoderUrl: pathToFileURL(path.join(output, 'decoder/node_modules/fzstd/esm/index.mjs')).href };
  } else {
    const id = ++seq;
    result = await new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ id, file, mode }); });
  }
  return { ...result, mainMs: performance.now()-start };
});
async function finish(result) {
  writeJson('transport-result.json', { versions: process.versions, ...result });
  await contentTracing.stopRecording(path.join(output, '.private/transport-trace.json'));
  console.log(JSON.stringify(result.summary));
  await worker.terminate(); app.exit(result.error ? 1 : 0);
}
app.whenReady().then(async () => {
  await contentTracing.startRecording({ included_categories: ['toplevel', 'disabled-by-default-devtools.timeline', 'devtools.timeline', 'v8', 'blink.user_timing'] });
  const win = new BrowserWindow({ width: 1100, height: 750, webPreferences: { preload: path.join(__dirname, 'transport-preload.cjs'), sandbox: false, contextIsolation: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(sanitize(event.message)); });
  await win.loadFile(path.join(__dirname, 'transport.html'));
  let finishing = false;
  const interval = setInterval(async () => {
    try {
      if (finishing) return;
      const done = await win.webContents.executeJavaScript('window.__benchResult ?? null');
      if (done) { finishing = true; clearInterval(interval); await finish(done); }
    } catch (e) { console.error(sanitize(String(e))); clearInterval(interval); app.exit(1); }
  }, 1000);
});
