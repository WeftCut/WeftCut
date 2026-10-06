// Ownership spans the reader, postMessage transfer and worker consumption.
// Credits return only after the worker closes a packet's bitmaps.
export interface InjectedMotifFrame { frame: number; bitmap: ImageBitmap }
export type InjectedMotifFrames = readonly ImageBitmap[] | InjectedMotifFrame;
export interface MotifFramePacket {
  index: number;
  frames: Record<string, InjectedMotifFrame>;
}

export function closeMotifPacket(packet: MotifFramePacket): void {
  const bitmaps = new Set(Object.values(packet.frames).map(frame => frame.bitmap));
  for (const bitmap of bitmaps) bitmap.close();
}

export interface MotifReadTask {
  layerId: string;
  frame: number;
  bytes: number;
  read(signal: AbortSignal): Promise<ImageBitmap>;
}

export class MotifFrameProducer {
  private controller = new AbortController();
  private outstanding = new Map<number, number>();
  private next = 0;
  private bytes = 0;
  private pumping = false;
  readonly stats = { peakBytes: 0, framesRead: 0 };

  constructor(private readonly deps: {
    totalFrames: number;
    plan(index: number): MotifReadTask[];
    send(packet: MotifFramePacket): void;
    fail(error: unknown): void;
    maxBytes?: number;
    maxFrames?: number;
  }) {}

  start(): void { this.pump(); }

  release(index: number): void {
    const bytes = this.outstanding.get(index);
    if (bytes === undefined) return;
    this.outstanding.delete(index);
    this.bytes -= bytes;
    this.pump();
  }

  dispose(): void { this.controller.abort(); }

  private pump(): void {
    if (this.pumping || this.controller.signal.aborted) return;
    this.pumping = true;
    try {
      while (!this.controller.signal.aborted && this.next < this.deps.totalFrames &&
        this.outstanding.size < (this.deps.maxFrames ?? 3)) {
        const index = this.next;
        const tasks = this.deps.plan(index);
        // Reserve a second pixel surface for readback / cache persistence too.
        const bytes = tasks.reduce((n, task) => n + task.bytes * 2, 0);
        const limit = this.deps.maxBytes ?? 128 * 1024 * 1024;
        if (bytes > limit) throw new Error('This frame needs more memory. Increase the memory target in Settings and retry export.');
        if (this.bytes + bytes > limit) break;
        this.next++;
        this.bytes += bytes;
        this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
        this.outstanding.set(index, bytes);
        void this.load(index, tasks);
      }
    } catch (error) {
      this.dispose();
      this.deps.fail(error);
    } finally { this.pumping = false; }
  }

  private async load(index: number, tasks: MotifReadTask[]): Promise<void> {
    const packet: MotifFramePacket = { index, frames: {} };
    try {
      for (const task of tasks) {
        if (this.controller.signal.aborted) break;
        const bitmap = await task.read(this.controller.signal);
        packet.frames[task.layerId] = { frame: task.frame, bitmap };
        this.stats.framesRead++;
      }
      if (this.controller.signal.aborted) closeMotifPacket(packet);
      else this.deps.send(packet); // transfers ownership; keep credit reserved
    } catch (error) {
      closeMotifPacket(packet);
      if (!this.controller.signal.aborted) {
        this.dispose();
        this.deps.fail(error);
      }
    }
  }
}

/** Worker inbox. Arrival may be out of order; rendering may never skip a frame. */
export class MotifFrameInbox {
  private packets = new Map<number, MotifFramePacket>();
  private waiting = new Map<number, { resolve: (p: MotifFramePacket) => void; reject: (e: Error) => void }>();
  private error: Error | null = null;

  push(packet: MotifFramePacket): void {
    if (this.error) { closeMotifPacket(packet); return; }
    const waiter = this.waiting.get(packet.index);
    if (waiter) { this.waiting.delete(packet.index); waiter.resolve(packet); }
    else this.packets.set(packet.index, packet);
  }

  take(index: number): Promise<MotifFramePacket> {
    if (this.error) return Promise.reject(this.error);
    const packet = this.packets.get(index);
    if (packet) { this.packets.delete(index); return Promise.resolve(packet); }
    return new Promise((resolve, reject) => this.waiting.set(index, { resolve, reject }));
  }

  dispose(error = new Error("export cancelled")): void {
    this.error = error;
    for (const packet of this.packets.values()) closeMotifPacket(packet);
    this.packets.clear();
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }
}
