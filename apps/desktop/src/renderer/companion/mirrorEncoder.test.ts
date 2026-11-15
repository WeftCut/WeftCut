// The companion picture's encoder over fake codecs and a fake clock: what it
// captures, which encoder it settles on, and which frames it encodes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANDIDATES,
  ENCODE_QUEUE_MAX,
  KEYFRAME_INTERVAL_MS,
  PAUSED_FPS,
  SEEK_FULL_RATE_MS,
  startMirror,
  type MirrorEnv,
} from "./mirrorEncoder";
import { PICTURE_FPS, PICTURE_MAX_WIDTH, type CompanionMirrorChunk, type CompanionMirrorConfig } from "../../shared/companion";
import { codecGlobals, fakeCapture, log, paint, resetCodecs, support } from "./testing/fakeCodecs";

const FRAME_MS = 1000 / PICTURE_FPS;

const fakeCanvas = () => ({ captureStream: fakeCapture }) as unknown as HTMLCanvasElement;
/** Lets whatever microtasks are queued (a read, a configure, an encode) settle. */
const settle = () => new Promise<void>((r) => { setImmediate(r); });

function harness(initialCanvas: HTMLCanvasElement | null = fakeCanvas()) {
  const clock = { now: 0 };
  const player = { playing: false, moved: null as (() => void) | null };
  const preview = { canvas: initialCanvas };
  const sent = { configs: [] as CompanionMirrorConfig[], chunks: [] as CompanionMirrorChunk[], failed: 0 };
  /** The encoder's pending waits; each ends only when the test says time passed. */
  const waits: Array<() => void> = [];
  const env: MirrorEnv = {
    canvas: () => preview.canvas,
    playing: () => player.playing,
    onPlayheadMove: (cb) => { player.moved = cb; return () => { player.moved = null; }; },
    now: () => clock.now,
    wait: () => new Promise<void>((r) => { waits.push(r); }),
  };
  const mirror = startMirror({
    config: (c) => sent.configs.push(c),
    chunk: (c) => sent.chunks.push(c),
    failed: () => { sent.failed++; },
  }, env);
  const encoder = () => log.encoders.at(-1)!;
  const encodedCount = () => log.encoders.reduce((n, e) => n + e.encoded.length, 0);
  /** Paints a frame at `at` ms and waits until the encoder took or skipped it. */
  const frameAt = async (at: number, size: [number, number] = [640, 360]) => {
    clock.now = at;
    const before = encodedCount();
    paint(size[0], size[1], at * 1000);
    await settle();
    return encodedCount() > before;
  };
  /** Ends every wait pending now, as `CANVAS_RETRY_MS` passing would. */
  const elapse = async () => {
    for (const end of waits.splice(0)) end();
    await settle();
  };
  return { mirror, clock, player, preview, sent, encoder, frameAt, elapse };
}

beforeEach(() => {
  resetCodecs();
  for (const [name, value] of Object.entries(codecGlobals)) vi.stubGlobal(name, value);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("startMirror", () => {
  it("keeps one capture while the preview keeps its canvas, and stop ends its track and closes the encoder", async () => {
    const { mirror, frameAt, encoder, elapse, sent } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    expect(await frameAt(0)).toBe(true);
    await elapse();
    await elapse();
    expect(log.captures).toBe(1);
    mirror.stop();
    expect(log.tracksStopped).toBe(1);
    expect(encoder().state).toBe("closed");
    expect(sent.failed).toBe(0);
  });

  it("follows the preview to the canvas that replaced its own, starting it on a keyframe", async () => {
    const { mirror, frameAt, encoder, elapse, player, preview } = harness();
    player.playing = true;
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0);
    await frameAt(FRAME_MS);
    expect(encoder().encoded.map((e) => e.keyFrame)).toEqual([true, false]);

    // Agent mode and the editor each mount their own preview.
    preview.canvas = fakeCanvas();
    await elapse();
    await vi.waitFor(() => expect(log.captures).toBe(2));
    expect(log.tracksStopped).toBe(1);
    expect(await frameAt(2 * FRAME_MS)).toBe(true);
    expect(encoder().encoded.at(-1)!.keyFrame).toBe(true);
    mirror.stop();
  });

  it("waits while the preview has no canvas, and captures the one mounted next", async () => {
    const { mirror, frameAt, elapse, preview } = harness(null);
    await elapse();
    expect(log.captures).toBe(0);
    preview.canvas = fakeCanvas();
    await elapse();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    expect(await frameAt(0)).toBe(true);

    preview.canvas = null;
    await elapse();
    expect(log.tracksStopped).toBe(1);
    await elapse();
    expect(log.captures).toBe(1);
    mirror.stop();
  });

  it("tells the bridge once, and ends the capture, when every encoder refuses the frames", async () => {
    for (const c of CANDIDATES) support.refusing.add(c.codec);
    const { frameAt, sent, mirror } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0);
    await frameAt(FRAME_MS);
    expect(log.encoders.map((e) => e.config!.codec)).toEqual(CANDIDATES.map((c) => c.codec));
    await vi.waitFor(() => expect(sent.failed).toBe(1));
    expect(log.tracksStopped).toBe(1);
    mirror.stop();
    expect(sent.failed).toBe(1);
  });

  it("prefers hardware H.264 and hands over to VP8 when that encoder refuses the frames", async () => {
    support.refusing.add(CANDIDATES[0]!.codec);
    const { frameAt, sent, mirror } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0);
    expect(log.encoders[0]!.config).toMatchObject({ codec: CANDIDATES[0]!.codec, hardwareAcceleration: "prefer-hardware" });
    await frameAt(FRAME_MS);
    expect(log.encoders.map((e) => e.config!.codec)).toEqual([CANDIDATES[0]!.codec, "vp8"]);
    // Pages hear of the encoder that works, from its first frame, a keyframe.
    expect(sent.configs.map((c) => c.codec)).toEqual(["vp8"]);
    expect(sent.chunks[0]?.key).toBe(true);
    mirror.stop();
  });

  it("takes VP8 where no hardware H.264 encoder exists, as on CI", async () => {
    support.codecs.delete(CANDIDATES[0]!.codec);
    const { frameAt, sent, mirror } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0);
    expect(sent.configs).toEqual([{ codec: "vp8", coded_width: 640, coded_height: 360 }]);
    mirror.stop();
  });

  it("encodes an odd-sized canvas at an even size, no wider than the picture", async () => {
    const { frameAt, encoder, mirror } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0, [817, 459]);
    expect(encoder().encoded[0]).toMatchObject({ width: 816, height: 458 });
    await frameAt(FRAME_MS, [3841, 2161]);
    const { width, height } = encoder().config!;
    expect([width % 2, height % 2]).toEqual([0, 0]);
    expect(width).toBeLessThanOrEqual(PICTURE_MAX_WIDTH);
    mirror.stop();
  });

  it("while paused, encodes at most PAUSED_FPS frames a second, and every frame for a while after a seek", async () => {
    const { frameAt, encoder, player, clock, mirror } = harness();
    await vi.waitFor(() => expect(log.captures).toBe(1));
    let t = 0;
    for (; t < 2000; t += FRAME_MS) await frameAt(t);
    const paused = encoder().encoded.map((e) => e.timestamp / 1000);
    for (let i = 1; i < paused.length; i++) expect(paused[i]! - paused[i - 1]!).toBeGreaterThanOrEqual(1000 / PAUSED_FPS);

    clock.now = t;
    player.moved!();
    const seekAt = t;
    const after: boolean[] = [];
    for (; t < seekAt + SEEK_FULL_RATE_MS; t += FRAME_MS) after.push(await frameAt(t));
    expect(after.every(Boolean)).toBe(true);
    mirror.stop();
  });

  it("encodes every frame while playing, with a keyframe at least every KEYFRAME_INTERVAL_MS", async () => {
    const { frameAt, encoder, player, mirror } = harness();
    player.playing = true;
    await vi.waitFor(() => expect(log.captures).toBe(1));
    const taken: boolean[] = [];
    for (let t = 0; t < 3 * KEYFRAME_INTERVAL_MS; t += FRAME_MS) taken.push(await frameAt(t));
    expect(taken.every(Boolean)).toBe(true);
    const keys = encoder().encoded.filter((e) => e.keyFrame).map((e) => e.timestamp / 1000);
    expect(keys[0]).toBe(0);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeLessThanOrEqual(KEYFRAME_INTERVAL_MS + FRAME_MS);
    expect(keys.length).toBeGreaterThan(1);
    mirror.stop();
  });

  it("drops a frame while the encoder is behind", async () => {
    const { frameAt, encoder, player, mirror } = harness();
    player.playing = true;
    await vi.waitFor(() => expect(log.captures).toBe(1));
    await frameAt(0);
    encoder().encodeQueueSize = ENCODE_QUEUE_MAX + 1;
    expect(await frameAt(FRAME_MS)).toBe(false);
    encoder().encodeQueueSize = ENCODE_QUEUE_MAX;
    expect(await frameAt(2 * FRAME_MS)).toBe(true);
    mirror.stop();
  });
});
