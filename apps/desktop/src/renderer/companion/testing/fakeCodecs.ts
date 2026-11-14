// Stand-ins for what the companion picture's encoder touches in a browser: a
// canvas capture and its track, `MediaStreamTrackProcessor`, `VideoFrame` and
// `VideoEncoder`. They record every call, so a test asserts what was captured
// and encoded, and they encode at once. Installed with `vi.stubGlobal`.

/** Everything the fakes saw, in order. */
export interface CodecLog {
  captures: number;
  tracksStopped: number;
  encoders: FakeVideoEncoder[];
}

export const log: CodecLog = { captures: 0, tracksStopped: 0, encoders: [] };

/** Which codecs `isConfigSupported` answers yes to, and which encoders then
 *  refuse every frame, as Media Foundation does with an odd size. */
export const support = { codecs: new Set<string>(["avc1.42E01F", "vp8"]), refusing: new Set<string>() };

let push: ((frame: FakeVideoFrame) => void) | null = null;

export function resetCodecs(): void {
  log.captures = 0;
  log.tracksStopped = 0;
  log.encoders = [];
  support.codecs = new Set(["avc1.42E01F", "vp8"]);
  support.refusing = new Set();
  push = null;
}

/** Hands the capture's reader a frame, as the canvas painting would. */
export function paint(width: number, height: number, timestamp = 0): void {
  if (push === null) throw new Error("nothing captures the canvas");
  push(new FakeVideoFrame(width, height, timestamp));
}

export class FakeVideoFrame {
  readonly visibleRect: { x: number; y: number; width: number; height: number } | null = null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  closed = false;
  constructor(sourceOrWidth: FakeVideoFrame | number, heightOrInit: number | { visibleRect: FakeVideoFrame["visibleRect"]; displayWidth: number; displayHeight: number }, timestamp = 0) {
    if (typeof sourceOrWidth === "number") {
      this.displayWidth = sourceOrWidth;
      this.displayHeight = heightOrInit as number;
      this.timestamp = timestamp;
    } else {
      const init = heightOrInit as { visibleRect: FakeVideoFrame["visibleRect"]; displayWidth: number; displayHeight: number };
      this.visibleRect = init.visibleRect;
      this.displayWidth = init.displayWidth;
      this.displayHeight = init.displayHeight;
      this.timestamp = sourceOrWidth.timestamp;
    }
  }
  close(): void { this.closed = true; }
}

export class FakeVideoEncoder {
  static async isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }> {
    return { supported: support.codecs.has(config.codec) };
  }
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  config: VideoEncoderConfig | null = null;
  encodeQueueSize = 0;
  readonly encoded: Array<{ width: number; height: number; keyFrame: boolean; timestamp: number }> = [];
  private outputs = 0;
  constructor(private readonly init: VideoEncoderInit) { log.encoders.push(this); }
  configure(config: VideoEncoderConfig): void {
    this.config = config;
    this.state = "configured";
  }
  encode(frame: FakeVideoFrame, options: { keyFrame: boolean }): void {
    this.encoded.push({ width: frame.displayWidth, height: frame.displayHeight, keyFrame: options.keyFrame, timestamp: frame.timestamp });
    if (support.refusing.has(this.config!.codec)) {
      this.state = "closed";
      queueMicrotask(() => this.init.error(new DOMException("Encoding error", "OperationError")));
      return;
    }
    const chunk = {
      type: options.keyFrame ? "key" : "delta",
      timestamp: frame.timestamp,
      byteLength: 3,
      copyTo: (dst: ArrayBuffer) => { new Uint8Array(dst).set([1, 2, 3]); },
    };
    const meta = this.outputs++ === 0
      ? { decoderConfig: { codec: this.config!.codec, codedWidth: this.config!.width, codedHeight: this.config!.height } }
      : undefined;
    this.init.output(chunk as unknown as EncodedVideoChunk, meta as EncodedVideoChunkMetadata | undefined);
  }
  close(): void { this.state = "closed"; }
}

export class FakeTrackProcessor {
  readonly readable: ReadableStream<FakeVideoFrame>;
  constructor(_init: { track: unknown }) {
    this.readable = new ReadableStream<FakeVideoFrame>({
      start: (controller) => { push = (frame) => controller.enqueue(frame); },
    });
  }
}

/** What `canvas.captureStream` answers: one track, stopped by the test's record. */
export function fakeCapture(): MediaStream {
  log.captures++;
  const track = { stop: () => { log.tracksStopped++; } };
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

/** The globals as a browser has them. */
export const codecGlobals = {
  VideoEncoder: FakeVideoEncoder,
  VideoFrame: FakeVideoFrame,
  MediaStreamTrackProcessor: FakeTrackProcessor,
};
