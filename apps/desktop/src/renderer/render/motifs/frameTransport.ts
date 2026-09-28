let port: MessagePort | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (bmp: ImageBitmap | null) => void; reject: (error: Error) => void }>();

export function readStoredMotifFrame(hash: string, frame: number): Promise<ImageBitmap | null> {
  return request({ hash, frame });
}

export async function captureStoredMotifFrame(capture: Record<string, unknown>): Promise<ImageBitmap> {
  const bitmap = await request({ capture });
  if (!bitmap) throw new Error("Motif capture returned no frame");
  return bitmap;
}

function request(args: Record<string, unknown>): Promise<ImageBitmap | null> {
  if (!port) {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = ({ data }: MessageEvent<{ id: number; bitmap?: ImageBitmap | null; error?: string }>) => {
      const request = pending.get(data.id);
      if (!request) { data.bitmap?.close(); return; }
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.bitmap ?? null);
    };
    port.start();
    window.postMessage({ type: "weftcut:motif-frame-port" }, "*", [channel.port2]);
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Motif frame transport timed out"));
    }, 15000);
    pending.set(id, {
      resolve: bmp => { clearTimeout(timeout); resolve(bmp); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    port!.postMessage({ id, ...args });
  });
}
