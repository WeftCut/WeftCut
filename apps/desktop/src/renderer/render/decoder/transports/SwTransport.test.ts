// @vitest-environment jsdom
//
// SwTransport.test.ts — the byte transport over its session port: frame
// wrapping (NV12 → NativeNv12Frame, I420P10 → TenBitFrame), one release per
// frame, request generations, terminal errors, and the open/close calls. The
// session's port is faked (`openDecodeSession` mocked); `window.api` is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodeWireMsg, PreviewDecodeCommand } from "../../../../shared/frameCarrier/wire";
import { isNativeNv12Frame, type NativeNv12Frame } from "../nv12Frame";
import { isTenBitFrame, type TenBitFrame } from "../tenBitFrame";
import { SwTransport } from "./SwTransport";
import { resolveSourceColor } from "../ffprobeColorSpace";

const session = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../../ipc/decodeSession", () => ({ openDecodeSession: session.open }));

const HD = resolveSourceColor({ width: 1920, height: 1080 });

/// The transport's end of its session port; `deliver` stands in for main.
class FakePort {
  onmessage: ((event: MessageEvent<DecodeWireMsg>) => void) | null = null;
  readonly posted: PreviewDecodeCommand[] = [];
  closed = false;
  postMessage(cmd: PreviewDecodeCommand): void {
    this.posted.push(cmd);
  }
  close(): void {
    this.closed = true;
  }
  deliver(msg: DecodeWireMsg): void {
    this.onmessage?.({ data: msg } as MessageEvent<DecodeWireMsg>);
  }
  releases(): number[] {
    return this.posted.flatMap((c) => (c.type === "release" ? [c.lease] : []));
  }
  requests(): Array<{ targetUs: number; requestId: number }> {
    return this.posted.flatMap((c) => (c.type === "request" ? [{ targetUs: c.targetUs, requestId: c.requestId }] : []));
  }
}

interface FakeApi {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/// A page whose opens succeed and hand over `port`.
function installApi(): { api: FakeApi; port: FakePort } {
  const port = new FakePort();
  const api: FakeApi = { open: vi.fn(async () => ({ width: 2, height: 2 })), close: vi.fn() };
  (window as unknown as { api: { previewDecode: FakeApi } }).api = { previewDecode: api };
  session.open.mockImplementation(async (_sessionId: string, open: () => Promise<unknown>) => ({ info: await open(), port }));
  return { api, port };
}

const frame = (lease: number, over: Partial<Extract<DecodeWireMsg, { kind: "bytes" }>> = {}): DecodeWireMsg => ({
  kind: "bytes",
  lease,
  ptsUs: 0,
  durUs: 33_333,
  width: 2,
  height: 2,
  format: "NV12",
  data: new Uint8Array(6), // 2x2 NV12 = 4 Y + 2 UV
  requestId: 1,
  ...over,
});

beforeEach(() => {
  session.open.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe("SwTransport", () => {
  it("returns every frame's lease exactly once: shown, superseded, malformed, refused by the consumer, after dispose", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    const shown = vi.fn();
    t.onFrame(shown);
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.requestFrameAt(500_000);
    t.requestFrameAt(0); // backward: request generation 2
    vi.spyOn(console, "warn").mockImplementation(() => {});
    port.deliver(frame(1, { requestId: 1 })); // superseded
    port.deliver(frame(2, { requestId: 2 })); // shown
    port.deliver(frame(3, { requestId: 2, data: new Uint8Array(0) })); // malformed
    shown.mockImplementationOnce(() => {
      throw new Error("consumer failed");
    });
    expect(() => port.deliver(frame(4, { requestId: 2 }))).toThrow("consumer failed");
    t.dispose();
    port.deliver(frame(5, { requestId: 2 })); // already queued when the port closed
    expect(shown).toHaveBeenCalledTimes(2);
    expect(port.releases()).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps frames from an earlier forward refill, but drops them after a cache flush", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    const shown = vi.fn();
    t.onFrame(shown);
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.requestFrameAt(0);
    t.requestFrameAt(33_333);
    t.requestFrameAt(33_333); // a repeat of the last target is not sent
    expect(port.requests()).toEqual([
      { targetUs: 0, requestId: 1 },
      { targetUs: 33_333, requestId: 1 },
    ]);
    port.deliver(frame(1, { ptsUs: 66_667, requestId: 1 }));
    expect(shown).toHaveBeenCalledOnce();
    t.resetRequestDedup();
    t.requestFrameAt(33_333);
    expect(port.requests().at(-1)).toEqual({ targetUs: 33_333, requestId: 2 });
    port.deliver(frame(2, { ptsUs: 66_667, requestId: 1 }));
    expect(shown, "a frame of the flushed generation is dropped").toHaveBeenCalledOnce();
    expect(port.releases()).toEqual([1, 2]);
    t.dispose();
  });

  it("reports a terminal session error through onError once, and a non-terminal one not at all", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    const errors: string[] = [];
    const shown = vi.fn();
    t.onError((reason) => errors.push(reason));
    t.onFrame(shown);
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.requestFrameAt(0);
    port.deliver({ kind: "error", message: "seek failed", terminal: false });
    port.deliver({ kind: "end" });
    expect(errors).toEqual([]);
    port.deliver({ kind: "error", message: "preview-sw decode panicked: boom", terminal: true });
    port.deliver({ kind: "error", message: "again", terminal: true });
    expect(errors).toEqual(["preview-sw decode panicked: boom"]);
    // The session is over: a frame still in flight goes back, unshown, and
    // no request follows.
    port.deliver(frame(7));
    t.requestFrameAt(500_000);
    expect(shown).not.toHaveBeenCalled();
    expect(port.releases()).toEqual([7]);
    expect(port.requests()).toEqual([{ targetUs: 0, requestId: 1 }]);
    t.dispose();
  });

  it("reports no terminal error after dispose", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    const errors: string[] = [];
    t.onError((reason) => errors.push(reason));
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.dispose();
    port.deliver({ kind: "error", message: "boom", terminal: true });
    expect(errors).toEqual([]);
  });

  it("reports a failed open() only through its rejection, never onError", async () => {
    installApi();
    session.open.mockImplementation(() => Promise.reject(new Error("boom")));
    const t = new SwTransport();
    const errors: string[] = [];
    t.onError((r) => errors.push(r));
    await expect(t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD })).rejects.toThrow("boom");
    expect(errors).toEqual([]);
  });

  it("opens its session under the caller's stream id and listens on the port it gets", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    await t.open({ streamId: "ffmpeg:software:L1:3", path: "C:/x.mov", sourceColor: HD });
    expect(session.open).toHaveBeenCalledWith("ffmpeg:software:L1:3", expect.any(Function));
    expect(port.onmessage).not.toBeNull();
    t.dispose();
  });

  it("closes its session by id on dispose, closes its port, and posts nothing after", async () => {
    const { api, port } = installApi();
    const t = new SwTransport();
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.dispose();
    t.dispose();
    t.requestFrameAt(0);
    expect(api.close.mock.calls).toEqual([[{ sessionId: "s1" }]]);
    expect(port.closed).toBe(true);
    expect(port.requests()).toEqual([]);
  });

  it("disposed while opening: closes the session by id and the port that arrives, and never listens", async () => {
    const { api, port } = installApi();
    let arrive!: () => void;
    session.open.mockImplementation(
      (_id: string, open: () => Promise<unknown>) =>
        new Promise((resolve) => {
          arrive = () => void open().then((info) => resolve({ info, port }));
        }),
    );
    const t = new SwTransport();
    const opening = t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.dispose();
    arrive();
    await opening;
    expect(api.close.mock.calls).toEqual([[{ sessionId: "s1" }]]);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
  });

  it("delivers a frame the session sent before the transport listened", async () => {
    // A real port: it queues what it receives until `onmessage` is set.
    const { port1, port2 } = new MessageChannel();
    (window as unknown as { api: { previewDecode: FakeApi } }).api = {
      previewDecode: { open: vi.fn(async () => ({ width: 2, height: 2 })), close: vi.fn() },
    };
    session.open.mockImplementation(async (_id: string, open: () => Promise<unknown>) => {
      const info = await open();
      port2.postMessage(frame(1, { ptsUs: 42 }));
      return { info, port: port1 };
    });
    const t = new SwTransport();
    const shown = new Promise<number>((resolve) => t.onFrame((_f, ptsUs) => resolve(ptsUs)));
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    t.requestFrameAt(0);
    expect(await shown).toBe(42);
    t.dispose();
    port2.close();
  });

  it("wraps NV12 frames zero-copy as NativeNv12Frame", async () => {
    const { port } = installApi();
    const t = new SwTransport();
    const got: Array<{ frame: unknown; ptsUs: number; durUs: number }> = [];
    t.onFrame((f, ptsUs, durUs) => got.push({ frame: f, ptsUs, durUs }));
    await t.open({ streamId: "s1", path: "C:/x.mov", sourceColor: HD });
    const nv12 = new Uint8Array(2 * 2 + 2);
    port.deliver(frame(1, { data: nv12, ptsUs: 15, durUs: 33 }));
    expect(got).toHaveLength(1);
    expect(got[0]!.ptsUs).toBe(15);
    const f = got[0]!.frame as NativeNv12Frame;
    expect(isNativeNv12Frame(f)).toBe(true);
    expect(f.data).toBe(nv12); // zero-copy adoption, no plane copy
    expect(f.width).toBe(2);
    expect(f.height).toBe(2);
    expect(f.uvOffset).toBe(4);
    expect(f.timestamp).toBe(15);
    expect(f.duration).toBe(33);
    t.dispose();
  });

  it("stamps the open-time sourceColor on every frame, whatever it is", async () => {
    // An untagged SD source's colour: the lane must carry it, not a default
    // of its own.
    const sd = resolveSourceColor({ width: 720, height: 480 });
    const { port } = installApi();
    const t = new SwTransport();
    const frames: NativeNv12Frame[] = [];
    t.onFrame((f) => frames.push(f as NativeNv12Frame));
    await t.open({ streamId: "s1", path: "C:/x.mp4", sourceColor: sd });
    port.deliver(frame(1, { ptsUs: 0 }));
    port.deliver(frame(2, { ptsUs: 33 }));
    expect(frames.map((f) => f.colorSpace)).toEqual([sd, sd]);
    t.dispose();

    const second = installApi();
    const tFull = new SwTransport();
    const fullFrames: NativeNv12Frame[] = [];
    tFull.onFrame((f) => fullFrames.push(f as NativeNv12Frame));
    const full = resolveSourceColor({ width: 1920, height: 1080, color_matrix: "bt709", color_range: "pc" });
    await tFull.open({ streamId: "s2", path: "C:/y.mp4", sourceColor: full });
    second.port.deliver(frame(1));
    expect(fullFrames[0]!.colorSpace).toEqual(full);
    tFull.dispose();
  });

  // I420P10 frames — the 10-bit VideoToolbox-lane sessions — dispatch on the
  // frame's own format into the ten-bit adapter, zero-copy, so both producers
  // (WebCodecs copyToTenBit and this transport) feed one consumer path.
  it("wraps I420P10 frames zero-copy as TenBitFrame", async () => {
    const { port } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: TenBitFrame[] = [];
    t.onFrame((f) => got.push(f as TenBitFrame));
    await t.open({ streamId: "s1", path: "/tmp/x.mov", sourceColor: HD });
    // 2x2 I420P10 = u16LE Y (4 samples) + U + V (1 sample each) = 12 bytes.
    const p10 = new Uint8Array(2 * 2 * 3);
    port.deliver(frame(1, { format: "I420P10", data: p10, ptsUs: 42 }));
    expect(got).toHaveLength(1);
    const f = got[0]!;
    expect(isTenBitFrame(f)).toBe(true);
    expect(f.data).toBe(p10); // zero-copy adoption, no plane copy
    expect(f.yOffset).toBe(0);
    expect(f.uOffset).toBe(8);
    expect(f.vOffset).toBe(10);
    expect(f.timestamp).toBe(42);
    expect(f.colorSpace).toEqual(HD);
    t.dispose();
  });

  it("an NV12-tagged frame on a p10 session still wraps as NativeNv12Frame (per-frame dispatch)", async () => {
    const { port } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: unknown[] = [];
    t.onFrame((f) => got.push(f));
    await t.open({ streamId: "s1", path: "/tmp/x.mov", sourceColor: HD });
    port.deliver(frame(1, { format: "NV12" }));
    expect(got).toHaveLength(1);
    expect(isNativeNv12Frame(got[0])).toBe(true);
    t.dispose();
  });

  it("drops a layout-drifted frame with a warning instead of crashing the stream", async () => {
    const { port } = installApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: number[] = [];
    t.onFrame((_f, ptsUs) => got.push(ptsUs));
    await t.open({ streamId: "s1", path: "/tmp/x.mov", sourceColor: HD });
    // 2x2 expects 12 bytes (I420P10) and 6 (NV12); these have drifted.
    port.deliver(frame(1, { format: "I420P10", data: new Uint8Array(11) }));
    port.deliver(frame(2, { format: "NV12", data: new Uint8Array(5) }));
    port.deliver(frame(3, { ptsUs: 7 }));
    expect(got).toEqual([7]);
    expect(warn).toHaveBeenCalledTimes(2);
    t.dispose();
  });

  describe("open options", () => {
    const opened = async (t: SwTransport, streamId = "s1", path = "/tmp/x.mov") => {
      const { api } = installApi();
      await t.open({ streamId, path, sourceColor: HD });
      t.dispose();
      return api.open.mock.calls[0]![0];
    };

    it("sends nothing but the session and path on the software path at full size", async () => {
      expect(await opened(new SwTransport())).toEqual({ sessionId: "s1", path: "/tmp/x.mov", options: {} });
      // An explicit 1 is the wire default and stays off the wire.
      expect(await opened(new SwTransport(undefined, 1, 1))).toEqual({ sessionId: "s1", path: "/tmp/x.mov", options: {} });
    });

    it("forwards a hardware copy-back lane, with its device only when it has one", async () => {
      expect(await opened(new SwTransport({ lane: "vaapi", device: "/dev/dri/renderD128" }))).toEqual({
        sessionId: "s1",
        path: "/tmp/x.mov",
        options: { lane: "vaapi", device: "/dev/dri/renderD128" },
      });
      expect((await opened(new SwTransport({ lane: "nvdec", device: null }))).options).toEqual({ lane: "nvdec" });
      expect((await opened(new SwTransport({ lane: "videotoolbox", device: null }))).options).toEqual({ lane: "videotoolbox" });
    });

    it("forwards a playback-resolution divisor and a reduced cadence", async () => {
      expect((await opened(new SwTransport(undefined, 2))).options).toEqual({ scaleDiv: 2 });
      expect((await opened(new SwTransport({ lane: "nvdec", device: null }, 4, 2))).options).toEqual({
        lane: "nvdec",
        scaleDiv: 4,
        cadenceDiv: 2,
      });
    });

    it("forwards outFormat only for an I420P10 session", async () => {
      expect((await opened(new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10"))).options).toEqual({
        lane: "videotoolbox",
        outFormat: "I420P10",
      });
      expect((await opened(new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "NV12"))).options).toEqual({
        lane: "videotoolbox",
      });
    });
  });
});
