/** The one-frame HW verdict alone does not exercise libva copy-back or seeking. */
export interface FrameProbeBackend {
  previewSwOpen(id: string, path: string, callback: (error: Error | null, frame: {
    receipt: number; requestId: number; format: string; width: number; height: number;
    data: Uint8Array; ptsUs: number;
  }) => void, lane: string, device: string | null, scale: number, cadence: number, format: string): unknown;
  previewSwEnableFlow(id: string): void;
  previewSwRequestFrameAt(id: string, target: number, requestId: number): void;
  previewSwConsume(id: string, receipt: number): void;
  previewSwClose(id: string): void;
}

export async function probeHardwareFrames(backend: FrameProbeBackend, file: string, lane: string, device: string | null, bitDepth: 8 | 10): Promise<void> {
  const id = `hardware-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targets = [600_000, 0, 800_000];
  let opened = false, done = false, index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { if (!done) { done = true; reject(error); } };
      timer = setTimeout(() => fail(new Error('Hardware copy-back/seek test timed out')), 8000);
      backend.previewSwOpen(id, file, (error, frame) => {
        if (error) { fail(error); return; }
        try {
          if (done || frame.requestId !== index + 1) return;
          const expected = bitDepth === 10 ? 'I420P10' : 'NV12';
          const bytes = frame.width * frame.height * (bitDepth === 10 ? 3 : 1.5);
          if (frame.format !== expected || frame.data.length !== bytes || Math.abs(frame.ptsUs - targets[index]!) > 40_000) {
            fail(new Error('Hardware copy-back frame format, size or seek timestamp mismatch')); return;
          }
          index++;
          if (index === targets.length) { done = true; resolve(); }
          else setImmediate(() => { if (!done) { try { backend.previewSwRequestFrameAt(id, targets[index]!, index + 1); } catch (e) { fail(e as Error); } } });
        } finally { if (frame.receipt) backend.previewSwConsume(id, frame.receipt); }
      }, lane, device, 1, 1, bitDepth === 10 ? 'I420P10' : 'NV12');
      opened = true;
      backend.previewSwEnableFlow(id);
      backend.previewSwRequestFrameAt(id, targets[0]!, 1);
    });
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    if (opened) backend.previewSwClose(id);
  }
}
