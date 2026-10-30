// Preload half of the fair comparison. Lanes a/b/c finish here exactly as
// preload/motifFrames.ts does today; lane e replicates the texture import,
// `createImageBitmap(VideoFrame)` and the worker read barrier of
// preload/motifReadBarrier.ts; lanes d1/d2 pass the file bytes to the page;
// lanes f/g only hand their port to the page, which gives it to a worker.
const { ipcRenderer, sharedTexture } = require('electron');

ipcRenderer.on('fair-lane-port', (event, lane) => window.postMessage({ type: 'fair-lane-port', lane }, '*', event.ports));

const slotQueue = [], imported = new Map();
ipcRenderer.on('fair-slot', (_event, key) => slotQueue.push(key));
sharedTexture?.setSharedTextureReceiver?.(async data => {
  const key = slotQueue.shift();
  if (key) imported.set(key, data.importedSharedTexture);
  else data.importedSharedTexture.release();
});

// Same source as preload/motifReadBarrier.ts.
const BARRIER = `
let ctx;
self.onmessage = ({data: {id, bitmap}}) => {
  let error;
  try {
    ctx ??= new OffscreenCanvas(1, 1).getContext('2d', {willReadFrequently: true});
    if (!ctx) throw new Error('Motif read barrier unavailable');
    ctx.drawImage(bitmap, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
  } catch (e) { error = String(e); }
  self.postMessage({id, bitmap, error}, [bitmap]);
};`;
let barrierWorker = null, barrierSeq = 0;
const barrierPending = new Map();
function barrier(bitmap) {
  if (!barrierWorker) {
    const url = URL.createObjectURL(new Blob([BARRIER], { type: 'text/javascript' }));
    barrierWorker = new Worker(url);
    URL.revokeObjectURL(url);
    barrierWorker.onmessage = ({ data }) => {
      const request = barrierPending.get(data.id);
      barrierPending.delete(data.id);
      if (data.error) { data.bitmap.close(); request.reject(new Error(data.error)); } else request.resolve(data.bitmap);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++barrierSeq;
    barrierPending.set(id, { resolve, reject });
    barrierWorker.postMessage({ id, bitmap }, [bitmap]);
  });
}

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'fair-port') return;
  const port = event.ports[0];
  port.onmessage = async ({ data }) => {
    if (data.config) { port.postMessage({ id: data.id, config: await ipcRenderer.invoke('fair-config') }); return; }
    if (data.trace !== undefined) { await ipcRenderer.invoke('fair-trace', data.trace); port.postMessage({ id: data.id }); return; }
    let bitmap = null;
    try {
      const reply = await ipcRenderer.invoke('fair-read', data);
      const start = performance.now();
      if (reply.kind === 'wfrm' || reply.kind === 'ref') {
        port.postMessage({ id: data.id, kind: reply.kind, bytes: reply.bytes, width: reply.width, height: reply.height, mainMs: reply.mainMs }, [reply.bytes.buffer]);
        return;
      }
      if (reply.kind === 'texture') {
        const frame = imported.get(reply.key).getVideoFrame();
        try { bitmap = await createImageBitmap(frame); } finally { frame.close(); }
        const raw = bitmap;
        bitmap = null;
        try { bitmap = await barrier(raw); } finally { ipcRenderer.send('fair-ack', reply.key); }
      } else if (reply.kind === 'rgba') {
        const pixels = new Uint8ClampedArray(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength);
        bitmap = await createImageBitmap(new ImageData(pixels, reply.width, reply.height));
      } else if (reply.kind === 'png') {
        bitmap = await createImageBitmap(new Blob([reply.bytes], { type: 'image/png' }));
      }
      port.postMessage({ id: data.id, bitmap, mainMs: reply.mainMs, workerMs: reply.workerMs, native: reply.native, preloadMs: performance.now() - start }, [bitmap]);
      bitmap = null;
    } catch (error) {
      bitmap?.close();
      port.postMessage({ id: data.id, error: String(error?.message ?? error) });
    }
  };
  port.start();
});
