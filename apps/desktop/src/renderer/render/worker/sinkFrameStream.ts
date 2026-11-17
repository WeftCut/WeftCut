// The export Worker's side of the native sink's frame port: packed frames go
// out in order, at most `window` of them unanswered (main/exportSinkPort.ts).

import type { SinkPortReply } from "../../../shared/exportSinkPort";

export interface SinkFramePort {
  postMessage(message: Uint8Array, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SinkPortReply>) => void) | null;
}

export class SinkFrameStream {
  private waiting: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private inFlight: Promise<void>[] = [];
  private failure: Error | null = null;

  constructor(private readonly port: SinkFramePort, private readonly window: number) {
    port.onmessage = ({ data }) => {
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
