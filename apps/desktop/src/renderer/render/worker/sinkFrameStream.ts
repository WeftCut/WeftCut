// The export Worker's side of the native sink's frame port: packed frames go
// out in order, at most `window` of them unanswered (main/exportSinkPort.ts),
// and their buffers come back once main has its copy, so an export reuses the
// same few buffers instead of leaving one per frame to the garbage collector.

import type { SinkPortReply } from "../../../shared/exportSinkPort";

/** What comes back on the frame port: main's replies, and each sent frame's
 * buffer once main has its copy (worker/sinkSender.ts). */
export type SinkStreamMessage = SinkPortReply | { recycled: Uint8Array };

export interface SinkFramePort {
  postMessage(message: Uint8Array, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SinkStreamMessage>) => void) | null;
}

export class SinkFrameStream {
  private waiting: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private inFlight: Promise<void>[] = [];
  private failure: Error | null = null;
  private returned: Uint8Array[] = [];

  constructor(private readonly port: SinkFramePort, private readonly window: number) {
    port.onmessage = ({ data }) => {
      if ("recycled" in data) { this.returned.push(data.recycled); return; }
      if ("error" in data) { this.fail(new Error(data.error)); return; }
      this.waiting.shift()?.resolve();
    };
  }

  /// Hands `frame` over (its buffer is transferred) once fewer than `window`
  /// frames are unanswered. Rejects with main's error once a write failed.
  async send(frame: Uint8Array): Promise<void> {
    while (this.inFlight.length >= this.window) await this.inFlight.shift();
    if (this.failure) throw this.failure;
    const written = new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    // Observed by a later send() or settle(); never an unhandled rejection.
    written.catch(() => { });
    this.inFlight.push(written);
    this.port.postMessage(frame, [frame.buffer]);
  }

  /// A buffer for the next frame: a sent frame's, once returned, else a new one.
  readonly buffer = (bytes: number): Uint8Array => {
    const reused = this.returned.pop();
    return reused?.byteLength === bytes ? reused : new Uint8Array(bytes);
  };

  /// Resolves once every frame sent so far is written.
  async settle(): Promise<void> {
    while (this.inFlight.length > 0) await this.inFlight.shift();
    if (this.failure) throw this.failure;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const w of this.waiting.splice(0)) w.reject(error);
  }
}
