const { ipcRenderer } = require('electron');
window.addEventListener('message', event => {
  if (event.data?.type !== 'bench-port') return;
  const port = event.ports[0];
  port.onmessage = async ({ data }) => {
    try {
      const reply = await ipcRenderer.invoke('bench-read', data);
      if (reply.error) throw new Error(reply.error);
      const start = performance.now();
      performance.mark(`bench:${data.mode}:${data.frame}:preload-start`);
      if (reply.kind === 'zstd') {
        port.postMessage({ id: data.id, compressed: reply.bytes, decoderUrl: reply.decoderUrl, width: reply.width, height: reply.height, byteLength: reply.bytes.byteLength, mainMs: reply.mainMs }, [reply.bytes.buffer]);
        return;
      }
      let input;
      if (reply.kind === 'rgba') {
        const pixels = new Uint8ClampedArray(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength);
        input = new ImageData(pixels, reply.width, reply.height);
      } else input = new Blob([reply.bytes], { type: 'image/png' });
      const syncMs = performance.now()-start;
      const bitmap = await createImageBitmap(input);
      port.postMessage({ id: data.id, bitmap, byteLength: reply.bytes.byteLength, mainMs: reply.mainMs, workerMs: reply.workerMs, syncMs, bitmapMs: performance.now()-start-syncMs }, [bitmap]);
    } catch (e) { port.postMessage({ id: data.id, error: String(e.stack) }); }
  };
  port.start();
});
