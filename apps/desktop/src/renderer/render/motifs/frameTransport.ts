import type { MotifCaptureControl } from '../../../shared/motifs/frameTransport';

export interface CapturedFrame { bitmap: ImageBitmap; persisted: boolean }
interface FrameReply { bitmap: ImageBitmap | null; persisted: boolean }
let port: MessagePort | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (frame: FrameReply) => void; reject: (error: Error) => void }>();

export async function readStoredMotifFrame(hash: string, frame: number): Promise<ImageBitmap | null> {
  return (await request({ hash, frame })).bitmap;
}

export async function captureStoredMotifFrame(capture: Record<string, unknown>): Promise<ImageBitmap> {
  return (await captureMotifResult(capture)).bitmap;
}

export async function captureMotifResult(capture: Record<string, unknown>): Promise<CapturedFrame> {
  const { bitmap, persisted } = await request({ capture });
  if (!bitmap) throw new Error("Motif capture returned no frame");
  return { bitmap, persisted };
}

// Same port as capture admission, so promote/cancel cannot overtake its request.
export function controlStoredMotifCapture(control: MotifCaptureControl): void {
  port?.postMessage({ control });
}

function request(args: Record<string, unknown>): Promise<FrameReply> {
  if (!port) {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = ({ data }: MessageEvent<{ id: number; bitmap?: ImageBitmap | null; persisted?: boolean; error?: string }>) => {
      const request = pending.get(data.id);
      if (!request) { data.bitmap?.close(); return; }
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve({ bitmap: data.bitmap ?? null, persisted: data.persisted === true });
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
      resolve: frame => { clearTimeout(timeout); resolve(frame); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    port!.postMessage({ id, ...args });
  });
}
