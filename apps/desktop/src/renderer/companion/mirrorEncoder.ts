// The companion picture's encoder: the preview canvas, captured and encoded
// while main asks for the picture (`companionBridge.ts`). The canvas already
// holds the final composite (the gizmos are DOM), so nothing is drawn twice:
// the capture hands the encoder the canvas's own frames, and only the
// bitstream leaves for main. This is the only place that captures or encodes.
import { usePlayheadStore } from "../state/playheadStore";
import { usePlaybackStore } from "../state/playbackStore";
import {
  PICTURE_FPS,
  PICTURE_MAX_WIDTH,
  type CompanionMirrorChunk,
  type CompanionMirrorConfig,
} from "../../shared/companion";

/** Paused, the canvas repaints the same picture every tick: the picture then
 *  carries at most this many frames a second. */
export const PAUSED_FPS = 2;
/** After a move while paused, the full rate for this long: the new frame lands
 *  a few ticks after the playhead moves, once it is decoded. */
export const SEEK_FULL_RATE_MS = 600;
/** A page that joins, or dropped frames, waits at most this long for a
 *  picture it can decode. */
export const KEYFRAME_INTERVAL_MS = 2000;
/** Frames waiting in the encoder past which a new one is dropped: the encoder
 *  is not keeping up, and a late frame is worth less than the next one. */
export const ENCODE_QUEUE_MAX = 2;
/** How often the preview's canvas is looked for: while none is mounted, and
 *  while one is captured, in case another replaced it. */
export const CANVAS_RETRY_MS = 500;
/** The bitrate at 960×540, scaled by area for other sizes. */
const BITRATE_960x540 = 2_500_000;

interface Candidate {
  codec: string;
  hardwareAcceleration: HardwareAcceleration;
  avc?: AvcEncoderConfig;
}

/** In order: a hardware H.264 encoder costs the preview nothing visible; VP8
 *  in software works everywhere, CI's runners included. An encoder that fails
 *  hands over to the next for the rest of the run. */
export const CANDIDATES: readonly Candidate[] = [
  { codec: "avc1.42E01F", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } },
  { codec: "vp8", hardwareAcceleration: "no-preference" },
];

export interface MirrorSend {
  config(config: CompanionMirrorConfig): void;
  chunk(chunk: CompanionMirrorChunk): void;
  /** The picture stopped for good: no encoder takes it. Never after `stop`. */
  failed(): void;
}

/** What the encoder reads from the editor; tests hand in their own. */
export interface MirrorEnv {
  canvas(): HTMLCanvasElement | null;
  playing(): boolean;
  /** Calls `cb` on every playhead move; returns the unsubscribe. */
  onPlayheadMove(cb: () => void): () => void;
  now(): number;
  wait(ms: number): Promise<void>;
}

interface TrackProcessor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}

export const editorEnv: MirrorEnv = {
  canvas: () => document.querySelector<HTMLCanvasElement>(".pixi-preview-host canvas"),
  playing: () => usePlaybackStore.getState().playing,
  onPlayheadMove: (cb) => usePlayheadStore.subscribe(cb),
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

export interface Mirror {
  /** Ends the capture's tracks and closes the encoder. */
  stop(): void;
  /** Makes the next frame a keyframe: a viewer just joined, and decodes
   *  nothing before one. */
  requestKey(): void;
}

export function startMirror(send: MirrorSend, env: MirrorEnv = editorEnv): Mirror {
  const mirror = new Encoder(send, env);
  void mirror.run().catch((error: unknown) => { mirror.fail(error); });
  return mirror;
}

/** One capture of one preview canvas. */
interface Capture {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  readonly reader: ReadableStreamDefaultReader<VideoFrame>;
  ended: boolean;
}

class Encoder implements Mirror {
  private stopped = false;
  private capture: Capture | null = null;
  private encoder: VideoEncoder | null = null;
  /** The even source size the encoder was configured for, and its own. */
  private source = { w: 0, h: 0 };
  private coded = { w: 0, h: 0 };
  private candidate = 0;
  private configSent = false;
  private forceKey = true;
  private lastKeyAt = -Infinity;
  private lastEncodeAt = -Infinity;
  private fullRateUntil = -Infinity;
  private readonly unsubscribe: () => void;

  constructor(private readonly send: MirrorSend, private readonly env: MirrorEnv) {
    this.unsubscribe = env.onPlayheadMove(() => {
      if (!env.playing()) this.fullRateUntil = env.now() + SEEK_FULL_RATE_MS;
    });
  }

  requestKey(): void {
    this.forceKey = true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    if (this.capture !== null) endCapture(this.capture);
    this.capture = null;
    this.closeEncoder();
  }

  /** Stops, and tells the bridge the picture is gone; nothing once stopped. */
  fail(error: unknown): void {
    if (this.stopped) return;
    console.warn("[companion] picture stopped:", error);
    this.stop();
    this.send.failed();
  }

  /** Captures whichever canvas the preview shows, until stopped. The editor
   *  and agent mode each mount their own preview, so switching replaces the
   *  canvas, and the old one's capture yields no frame from then on. */
  async run(): Promise<void> {
    while (!this.stopped) {
      const canvas = this.env.canvas();
      if (canvas === null) {
        await this.env.wait(CANVAS_RETRY_MS);
        continue;
      }
      const capture = this.startCapture(canvas);
      void this.watchCanvas(capture);
      while (!this.stopped) {
        const { value: frame, done } = await capture.reader.read();
        if (done) break;
        try {
          await this.take(frame);
        } finally {
          frame.close();
        }
      }
      // A track that ended on its own, on a canvas still shown, is captured
      // again after a wait, not at once.
      const lost = !capture.ended;
      endCapture(capture);
      if (lost && !this.stopped) await this.env.wait(CANVAS_RETRY_MS);
    }
  }

  private startCapture(canvas: HTMLCanvasElement): Capture {
    const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;
    if (Processor === undefined) throw new Error("MediaStreamTrackProcessor is unavailable");
    const stream = canvas.captureStream(PICTURE_FPS);
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("the canvas capture has no video track");
    const capture: Capture = { canvas, stream, reader: new Processor({ track }).readable.getReader(), ended: false };
    this.capture = capture;
    // The new canvas starts on a keyframe: its first picture may differ
    // wholly from the old one's last.
    this.forceKey = true;
    return capture;
  }

  /** Ends `capture` once the preview shows another canvas, or none. */
  private async watchCanvas(capture: Capture): Promise<void> {
    while (!capture.ended) {
      await this.env.wait(CANVAS_RETRY_MS);
      if (!capture.ended && this.env.canvas() !== capture.canvas) endCapture(capture);
    }
  }

  private async take(frame: VideoFrame): Promise<void> {
    // LANDMINE: Media Foundation's hardware H.264 encoder answers every frame
    // of an odd-sized canvas (816×459) with "Encoding error", where software
    // encoders take it. A view one row or column smaller costs no copy.
    const w = frame.displayWidth & ~1;
    const h = frame.displayHeight & ~1;
    if (w < 2 || h < 2) return;
    if (this.encoder === null || w !== this.source.w || h !== this.source.h) await this.configure(w, h);
    const encoder = this.encoder;
    if (this.stopped || encoder === null || encoder.state !== "configured") return;
    if (encoder.encodeQueueSize > ENCODE_QUEUE_MAX) return;
    const now = this.env.now();
    if (!this.env.playing() && !this.forceKey && now >= this.fullRateUntil && now - this.lastEncodeAt < 1000 / PAUSED_FPS) return;
    const keyFrame = this.forceKey || now - this.lastKeyAt >= KEYFRAME_INTERVAL_MS;
    this.forceKey = false;
    this.lastEncodeAt = now;
    if (keyFrame) this.lastKeyAt = now;
    const even = w === frame.displayWidth && h === frame.displayHeight;
    const view = even ? frame : new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: w, height: h }, displayWidth: w, displayHeight: h });
    try {
      encoder.encode(view, { keyFrame });
    } finally {
      if (view !== frame) view.close();
    }
  }

  /** The first candidate from `this.candidate` on that takes the size. */
  private async configure(sourceW: number, sourceH: number): Promise<void> {
    this.closeEncoder();
    const scale = Math.min(1, PICTURE_MAX_WIDTH / sourceW);
    const w = Math.max(2, Math.round((sourceW * scale) / 2) * 2);
    const h = Math.max(2, Math.round((sourceH * scale) / 2) * 2);
    this.source = { w: sourceW, h: sourceH };
    this.coded = { w, h };
    for (; this.candidate < CANDIDATES.length; this.candidate++) {
      const c = CANDIDATES[this.candidate]!;
      const config: VideoEncoderConfig = {
        codec: c.codec, width: w, height: h, framerate: PICTURE_FPS,
        bitrate: Math.round(BITRATE_960x540 * ((w * h) / (960 * 540))),
        latencyMode: "realtime", hardwareAcceleration: c.hardwareAcceleration,
        ...(c.avc ? { avc: c.avc } : {}),
      };
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (this.stopped) return;
      if (support?.supported !== true) continue;
      const encoder: VideoEncoder = new VideoEncoder({
        output: (chunk, meta) => { if (encoder === this.encoder) this.output(chunk, meta, c.codec); },
        error: (error) => {
          if (encoder !== this.encoder) return;
          // A codec can accept the config and still refuse the frames: the
          // next candidate takes over at the next frame.
          console.warn(`[companion] ${c.codec} encoder failed, handing over:`, String(error));
          this.encoder = null;
          this.candidate++;
          // The last one failing ends the picture now, not at a next frame
          // that a still canvas may never paint.
          if (this.candidate >= CANDIDATES.length) this.fail(error);
        },
      });
      encoder.configure(config);
      this.encoder = encoder;
      this.configSent = false;
      this.forceKey = true;
      return;
    }
    throw new Error(`no encoder takes ${w}×${h}`);
  }

  private output(chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined, codec: string): void {
    if (this.stopped) return;
    if (!this.configSent) {
      this.configSent = true;
      this.send.config({
        codec: meta?.decoderConfig?.codec ?? codec,
        coded_width: meta?.decoderConfig?.codedWidth ?? this.coded.w,
        coded_height: meta?.decoderConfig?.codedHeight ?? this.coded.h,
      });
    }
    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);
    this.send.chunk({ key: chunk.type === "key", timestamp_us: chunk.timestamp, data });
  }

  private closeEncoder(): void {
    const encoder = this.encoder;
    this.encoder = null;
    if (encoder !== null && encoder.state !== "closed") encoder.close();
  }
}

/** Stops the capture's tracks; its pending read then answers done. */
function endCapture(capture: Capture): void {
  if (capture.ended) return;
  capture.ended = true;
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.reader.cancel().catch(() => {});
}
