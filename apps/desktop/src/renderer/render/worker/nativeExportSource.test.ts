// Unit tests for the native export-decode handle. They observe the handle at
// the `ExportDecodeSession` seam (the surface the export Worker drives) and at
// its session port, through a FAKE port — no native component, no real
// VideoFrame pool. The point is to pin the two things unique to this handle:
//   1. every frame's lease goes back exactly once, at the moment that frame
//      leaves the ring, on every path out (evict, the ring's own
//      freeBehindWaiters, a backward flush, dispose) — never held, never twice;
//   2. `decodeRange` is dispatch-then-return (awaiting frames would deadlock the
//      window), and mark / end / error reach the ring in port order.
import { describe, expect, it } from "vitest";
import {
  createNativeDecodeSessions,
  NativeExportSourceHandle,
  type DecodePort,
  type NativeDecodeSessions,
  type OpenScope,
} from "./nativeExportSource";
import type { DecodeWireFrame, DecodeWireMsg, ExportDecodeCommand } from "../../../shared/frameCarrier/wire";
import type { ExportEvent, ExportRequest } from "./protocol";
import type { SourceHandleInit } from "../decoder/session";
import { nativePlaneColor, resolveSourceColor, type SourceColor } from "../decoder/ffprobeColorSpace";
import { isNativeNv12Frame, nv12FrameFromBytes, type NativeNv12Frame } from "../decoder/nv12Frame";
import { isTenBitFrame, tenBitFrameFromBytes, type TenBitFrame } from "../decoder/tenBitFrame";

// No VideoFrame stub: the handle wraps BOTH lanes' bytes in CPU frame objects
// (NativeNv12Frame / TenBitFrame) — deliberately, because Chromium converts a
// buffer-defined NV12 `VideoFrame` as BT.601 regardless of its stamped
// colorSpace. A test that reintroduces `new VideoFrame` here is a regression.

type PortCommand = ExportDecodeCommand;

/// The handle's end of a session port. Records what the handle posts and
/// delivers the session's messages synchronously, in the order given.
class FakePort implements DecodePort {
  onmessage: ((event: MessageEvent<DecodeWireMsg>) => void) | null = null;
  /// What the handle did with its session, in order: the commands it posted,
  /// "end" when it asked main to end the session, "close" when it closed the port.
  log: Array<PortCommand | "end" | "close"> = [];
  postMessage(cmd: PortCommand): void {
    this.log.push(cmd);
  }
  close(): void {
    this.log.push("close");
  }
  get closed(): boolean {
    return this.log.includes("close");
  }
  deliver(msg: DecodeWireMsg): void {
    this.onmessage?.({ data: msg } as MessageEvent<DecodeWireMsg>);
  }
  released(): number[] {
    return this.log.flatMap((c) => (typeof c === "object" && c.type === "release" ? [c.lease] : []));
  }
  ranges(): Array<{ aUs: number; bUs: number }> {
    return this.log.flatMap((c) => (typeof c === "object" && c.type === "range" ? [{ aUs: c.aUs, bUs: c.bUs }] : []));
  }
}

const W = 4;
const H = 2;
const DUR = 33_333;
const WINDOW = 6;

const HD = resolveSourceColor({ width: 1920, height: 1080 });
const BT470BG_FULL = resolveSourceColor({ width: 1920, height: 1080, color_matrix: "bt470bg", color_range: "pc" });

function makeHandle(
  sourceColor: SourceColor = HD,
  outFormat: "NV12" | "I420P10" = "NV12",
): {
  handle: NativeExportSourceHandle;
  port: FakePort;
  opens: Array<Parameters<NativeDecodeSessions["open"]>[0]>;
  /// The session ids the handle asked main to end.
  ended: string[];
} {
  const port = new FakePort();
  const opens: Array<Parameters<NativeDecodeSessions["open"]>[0]> = [];
  const ended: string[] = [];
  const sessions: NativeDecodeSessions = {
    open: (request) => {
      opens.push(request);
      return Promise.resolve({ info: { width: W, height: H, startPtsUs: 0 }, port });
    },
    close: (sessionId) => {
      ended.push(sessionId);
      port.log.push("end");
    },
  };
  const init: SourceHandleInit = {
    layerId: "L0",
    mediaId: "m0",
    handleKey: "m0#0",
    proxyAssetUrl: "weftcut-media://ignored",
    nativeExport: { sourcePath: "C:/orig/tiny.mov", outFormat, window: WINDOW },
    sourceColor,
  };
  return { handle: new NativeExportSourceHandle(init, sessions), port, opens, ended };
}

/// Frame `ptsUs` carries lease `lease` (default: its index on the 33 ms grid).
function frameMsg(ptsUs: number, lease = Math.round(ptsUs / DUR)): DecodeWireFrame {
  return {
    kind: "bytes",
    lease,
    ptsUs,
    durUs: DUR,
    width: W,
    height: H,
    format: "NV12",
    data: new Uint8Array((W * H * 3) / 2),
  };
}

// Tightly-packed I420P10 (u16LE): Y (w*h*2) + U + V ((w>>1)*(h>>1)*2 each).
const P10_BYTES = W * H * 2 + 2 * ((W >> 1) * (H >> 1) * 2);

function p10Msg(ptsUs: number, data = new Uint8Array(P10_BYTES)): DecodeWireFrame {
  return { ...frameMsg(ptsUs), format: "I420P10", data };
}

/// 0, 1, …, n-1: the leases of the first `n` frames on the grid.
const firstLeases = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("NativeExportSourceHandle", () => {
  it("opens the ORIGINAL path once on ensureReady", async () => {
    const { handle, opens } = makeHandle();
    await handle.ensureReady();
    await handle.ensureReady(); // memoized — no second open
    expect(opens).toEqual([
      {
        sessionId: expect.any(String),
        path: "C:/orig/tiny.mov",
        outFormat: "NV12",
        window: WINDOW,
        color: { matrix: HD.matrix, fullRange: HD.fullRange },
      },
    ]);
  });

  it("decodeRange posts the range and resolves without awaiting frames (no window deadlock)", async () => {
    const { handle, port } = makeHandle();
    // Never deliver a frame or mark; the promise must still resolve.
    await handle.decodeRange(0, 100_000);
    expect(port.ranges()).toEqual([{ aUs: 0, bUs: 100_000 }]);
  });

  it("finalizes a quantized target when the native range completes", async () => {
    const { handle, port } = makeHandle();
    await handle.decodeRange(0, 1_999_999);
    port.deliver(frameMsg(1_966_666));

    let settled = false;
    void handle.ring.waitForPts(1_966_667).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    port.deliver({ kind: "mark", aUs: 0, bUs: 1_999_999 });
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(handle.ring.frameAt(1_966_667)?.timestamp).toBe(1_966_666);
  });

  it("holds the leases of resident frames and releases exactly the evicted ones", async () => {
    const { handle, port } = makeHandle();
    await handle.ensureReady();
    for (let i = 0; i < 4; i++) port.deliver(frameMsg(i * DUR));
    expect(port.released()).toEqual([]);
    // Evict past the first two intervals ([0,DUR) and [DUR,2·DUR)).
    handle.evictBefore(2 * DUR);
    expect(handle.ring.size()).toBe(2);
    expect(port.released()).toEqual([0, 1]);
  });

  it("releases each frame by its own lease, whatever order the session granted them in", async () => {
    const { handle, port } = makeHandle();
    await handle.ensureReady();
    port.deliver(frameMsg(0, 40));
    port.deliver(frameMsg(DUR, 7));
    port.deliver(frameMsg(2 * DUR, 19));
    handle.evictBefore(2 * DUR);
    expect(port.released()).toEqual([40, 7]);
  });

  it("releases at once the frames a parking waiter frees, without waiting for another push or evict", async () => {
    // The session filled its window before the consumer parked (several source
    // frames per output step), so it is parked with no lease free. The frames
    // the parking waiter frees are its only way to resume: no push can arrive
    // and the loop's next evict runs only after this wait resolves.
    const { handle, port } = makeHandle();
    await handle.decodeRange(0, 100 * DUR);
    for (let i = 0; i < WINDOW; i++) port.deliver(frameMsg(i * DUR));
    expect(port.released()).toEqual([]);

    const waiting = handle.ring.waitForPts((WINDOW + 1) * DUR);
    const freed = WINDOW - handle.ring.size();
    expect(freed, "the waiter frees frames behind it").toBeGreaterThan(0);
    expect(port.released(), "the freed frames' leases, released before the wait resolves").toEqual(firstLeases(freed));

    // Later departures are released once each, never the freed ones again.
    port.deliver(frameMsg((WINDOW + 2) * DUR));
    await waiting;
    handle.evictBefore((WINDOW + 2) * DUR);
    const released = port.released();
    expect(new Set(released).size, "no lease released twice").toBe(released.length);
    expect(released).toEqual(firstLeases(WINDOW + 1 - handle.ring.size()));
  });

  it("releases a frame a push frees behind a parked waiter in that same push", async () => {
    const { handle, port } = makeHandle();
    await handle.decodeRange(0, 100 * DUR);
    void handle.ring.waitForPts(100 * DUR);
    port.deliver(frameMsg(0));
    port.deliver(frameMsg(DUR)); // frees frame 0 behind the waiter
    expect(port.released()).toEqual([0]);
  });

  it("a backward range releases every frame of the previous generation before asking again", async () => {
    const { handle, port } = makeHandle();
    await handle.decodeRange(1_000_000, 2_000_000);
    port.deliver(frameMsg(1_000_000, 0));
    port.deliver(frameMsg(1_033_333, 1));
    await handle.decodeRange(0, 500_000);
    expect(port.log.slice(1)).toEqual([
      { type: "release", lease: 0 },
      { type: "release", lease: 1 },
      { type: "range", aUs: 0, bUs: 500_000 },
    ]);
  });

  it("dispose releases every frame still held, then ends the session and closes the port, once", async () => {
    const { handle, port, opens, ended } = makeHandle();
    await handle.ensureReady();
    for (let i = 0; i < 3; i++) port.deliver(frameMsg(i * DUR));
    handle.evictBefore(DUR);
    handle.dispose();
    handle.dispose(); // idempotent
    expect(handle.disposed).toBe(true);
    expect(port.log).toEqual([
      { type: "release", lease: 0 },
      { type: "release", lease: 1 },
      { type: "release", lease: 2 },
      "end",
      "close",
    ]);
    expect(ended).toEqual([opens[0]!.sessionId]);
    // Nothing the session still had in flight reaches the disposed handle.
    port.deliver(frameMsg(5 * DUR));
    expect(handle.ring.size()).toBe(0);
  });

  it("a handle disposed while its session opens ends the session at once, and only closes the port that arrives", async () => {
    const { handle, port, opens, ended } = makeHandle();
    const ready = handle.ensureReady();
    handle.dispose();
    // The end is asked for behind the open, not held until the open answers:
    // main must have the session gone before a later open asks for its memory.
    expect(ended).toEqual([opens[0]!.sessionId]);
    await ready;
    expect(port.log).toEqual(["end", "close"]);
    expect(port.onmessage).toBeNull();
  });

  it("a handle that never asked for its session has nothing to end", () => {
    const { handle, opens, ended } = makeHandle();
    handle.dispose();
    expect(opens).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("hands back the lease of a frame it cannot use, and fails the ring", async () => {
    const { handle, port } = makeHandle(HD, "NV12");
    await handle.ensureReady();
    port.deliver(p10Msg(0)); // I420P10 frame into an NV12 session
    expect(port.released()).toEqual([0]);
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/I420P10/);
  });

  it("stamps frames with the source colour it was given, never the session's raw FFmpeg tags", async () => {
    // The open info's tags are raw FFmpeg `.name()` strings (bt2020nc /
    // smpte2084 / …), not WebCodecs enum members — the ingest shaders'
    // coefForMatrix matches WebCodecs enums only.
    const port = new FakePort();
    const handle = new NativeExportSourceHandle(
      {
        layerId: "L0",
        mediaId: "m0",
        proxyAssetUrl: "weftcut-media://ignored",
        nativeExport: { sourcePath: "C:/orig/tiny.mov", outFormat: "NV12", window: WINDOW },
        sourceColor: BT470BG_FULL,
      },
      {
        open: () => Promise.resolve({
          info: { width: W, height: H, startPtsUs: 0, colorMatrix: "bt2020nc", colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorRange: "tv" },
          port,
        }),
        close: () => {},
      },
    );
    await handle.ensureReady();
    port.deliver(frameMsg(0));
    expect((handle.ring.frameAt(0) as NativeNv12Frame).colorSpace).toMatchObject({
      matrix: "bt470bg",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: true,
    });
    expect(handle.firstFrameDiag?.configColor).toMatchObject({ matrix: "bt470bg", fullRange: true });
  });

  it("stamps the colour it was given on an untagged SD source, not a default of its own", async () => {
    const { handle, port } = makeHandle(resolveSourceColor({ width: 720, height: 480 }));
    await handle.ensureReady();
    port.deliver(frameMsg(0));
    const nv = handle.ring.frameAt(0) as NativeNv12Frame;
    expect(nv.colorSpace).toMatchObject({
      matrix: "smpte170m",
      primaries: "smpte170m",
      transfer: "smpte170m",
      fullRange: false,
    });
    expect(handle.firstFrameDiag?.configColor).toEqual(nv.colorSpace);
  });

  it("a backward decodeRange deactivates the ring's EOS clamp", async () => {
    // After EOS the ring clamps any wait target to the last held frame. A
    // backward clip-reuse jump re-arms the native session (frames WILL arrive
    // again), so the clamp must deactivate — else waitForPts hands a stale
    // frame to the consumer while the re-decoded one is still in flight.
    const { handle, port } = makeHandle();
    await handle.decodeRange(1_000_000, 2_000_000);
    port.deliver(frameMsg(1_000_000));
    port.deliver({ kind: "end" });
    // Clamp active: an overrun target resolves against the held frame.
    await expect(handle.ring.waitForPts(5_000_000)).resolves.toBeUndefined();
    // Backward jump: the clamp must deactivate…
    await handle.decodeRange(0, 500_000);
    let resolved = false;
    const wait = handle.ring.waitForPts(5_000_000).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false); // …so the wait parks instead of clamping…
    port.deliver(frameMsg(6_000_000)); // …until a real frame satisfies it.
    await wait;
    expect(resolved).toBe(true);
  });

  it("a backward decodeRange cannot settle from frames in the previous generation", async () => {
    const { handle, port } = makeHandle();
    await handle.decodeRange(1_000_000, 2_000_000);
    port.deliver(frameMsg(1_000_000));
    port.deliver({ kind: "mark", aUs: 1_000_000, bUs: 2_000_000 });

    await handle.decodeRange(0, 500_000);
    let settled = false;
    const waited = handle.ring.waitForPts(100_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    port.deliver(frameMsg(0));
    port.deliver(frameMsg(125_000));
    await waited;
    expect(handle.ring.frameAt(100_000)?.timestamp).toBe(0);
  });

  it("clamps grid-overrun waiters to the last held frame on end of stream", async () => {
    const { handle, port } = makeHandle();
    await handle.ensureReady();
    port.deliver(frameMsg(0));
    port.deliver({ kind: "end" });
    // A target far past the last frame's interval still resolves (clamp), so a
    // composition grid overrunning the video track's end can't hang the export.
    await expect(handle.ring.waitForPts(1_000_000)).resolves.toBeUndefined();
  });

  it("a recoverable error fails the export but leaves the session open and driven", async () => {
    const { handle, port } = makeHandle();
    await handle.decodeRange(0, 100_000);
    port.deliver({ kind: "error", message: "seek failed", terminal: false });
    await expect(handle.ring.waitForPts(0)).rejects.toThrow("seek failed");
    expect(port.closed).toBe(false);
    await handle.decodeRange(200_000, 300_000);
    port.deliver(frameMsg(200_001, 9));
    handle.dispose();
    expect(port.ranges()).toEqual([{ aUs: 0, bUs: 100_000 }, { aUs: 200_000, bUs: 300_000 }]);
    expect(port.released()).toEqual([9]);
  });

  it("a terminal error fails the export and ends the session: its port closes, nothing more is posted", async () => {
    const { handle, port, ended } = makeHandle();
    await handle.decodeRange(0, 100_000);
    port.deliver(frameMsg(0));
    port.deliver({ kind: "error", message: "decode panicked", terminal: true });
    await expect(handle.ring.waitForPts(0)).rejects.toThrow("decode panicked");
    expect(port.closed).toBe(true);
    const posted = port.log.length;
    await handle.decodeRange(200_000, 300_000);
    handle.dispose();
    expect(port.log.length, "no command reaches a session that is gone").toBe(posted);
    expect(ended, "ended once, by the error").toHaveLength(1);
  });
});

describe("createNativeDecodeSessions", () => {
  /// The Worker global's part of the handshake: what it posts, and a way to
  /// play the page's replies into its listener.
  function scope() {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const posted: ExportEvent[] = [];
    const s: OpenScope = {
      addEventListener: (_type, listener) => { listeners.push(listener); },
      postMessage: (message) => { posted.push(message); },
    };
    const reply = (data: ExportRequest) => { for (const l of listeners) l({ data } as MessageEvent); };
    return { s, posted, reply };
  }

  it("posts nd:open with the request and answers each by its reqId, in any order", async () => {
    const { s, posted, reply } = scope();
    const { open } = createNativeDecodeSessions(s);
    const color = { matrix: "bt709", fullRange: false };
    const a = open({ sessionId: "a", path: "C:/orig/a.mov", outFormat: "NV12", window: 6, color });
    const b = open({ sessionId: "b", path: "C:/orig/b.mov", outFormat: "I420P10", window: 3, color });
    expect(posted).toEqual([
      { type: "nd:open", reqId: expect.any(Number), sessionId: "a", path: "C:/orig/a.mov", outFormat: "NV12", window: 6, color },
      { type: "nd:open", reqId: expect.any(Number), sessionId: "b", path: "C:/orig/b.mov", outFormat: "I420P10", window: 3, color },
    ]);
    const [ra, rb] = posted.map((m) => (m as Extract<ExportEvent, { type: "nd:open" }>).reqId);
    expect(ra).not.toBe(rb);
    const info = { width: 4, height: 2, startPtsUs: 0 };
    const port = new FakePort() as unknown as MessagePort;
    // Answer the SECOND open first — correlation is by reqId, not call order.
    reply({ type: "nd:openResult", reqId: rb!, ok: true, info, port });
    await expect(b).resolves.toEqual({ info, port });
    reply({ type: "nd:openResult", reqId: ra!, ok: false, error: "no decoder" });
    await expect(a).rejects.toThrow("no decoder");
  });

  it("asks the page to end a session in the order the Worker asked, between the opens around it", () => {
    const { s, posted } = scope();
    const sessions = createNativeDecodeSessions(s);
    const color = { matrix: "bt709", fullRange: false };
    void sessions.open({ sessionId: "a", path: "C:/orig/a.mov", outFormat: "NV12", window: 6, color });
    sessions.close("a");
    void sessions.open({ sessionId: "b", path: "C:/orig/a.mov", outFormat: "NV12", window: 6, color });
    expect(posted.map((m) => [m.type, (m as { sessionId: string }).sessionId])).toEqual([
      ["nd:open", "a"],
      ["nd:close", "a"],
      ["nd:open", "b"],
    ]);
  });

  it("ignores the Worker's own protocol and replies it is not waiting for", () => {
    const { s, reply } = scope();
    createNativeDecodeSessions(s);
    expect(() => {
      reply({ type: "cancel" });
      reply({ type: "chunk-ack" });
      reply({ type: "nd:openResult", reqId: 999, ok: false, error: "stale" });
    }).not.toThrow();
  });
});

describe("tenBitFrameFromBytes", () => {
  it("wraps the SAME bytes with copyToTenBit's plane offsets (zero-copy)", () => {
    const data = new Uint8Array(P10_BYTES);
    const f = tenBitFrameFromBytes({
      data,
      width: W,
      height: H,
      timestamp: 5,
      duration: 10,
      colorSpace: { matrix: "bt709" },
    });
    expect(f.kind).toBe("p10");
    expect(isTenBitFrame(f)).toBe(true);
    expect(f.width).toBe(W);
    expect(f.height).toBe(H);
    expect(f.yOffset).toBe(0);
    expect(f.uOffset).toBe(W * H * 2);
    expect(f.vOffset).toBe(W * H * 2 + (W >> 1) * (H >> 1) * 2);
    // Zero-copy: the frame views the caller's bytes, not a duplicate.
    expect(f.data).toBe(data);
    expect(f.timestamp).toBe(5);
    expect(f.duration).toBe(10);
    expect(f.colorSpace).toEqual({ matrix: "bt709" });
    expect(() => f.close()).not.toThrow(); // uniform-shape no-op, like copyToTenBit
  });

  it("throws loudly on a byteLength that doesn't match the layout (Rust/TS drift)", () => {
    expect(() =>
      tenBitFrameFromBytes({
        data: new Uint8Array(P10_BYTES - 2),
        width: W,
        height: H,
        timestamp: 0,
        duration: null,
        colorSpace: null,
      }),
    ).toThrow(/I420P10/);
  });
});

describe("NativeExportSourceHandle — I420P10 lane", () => {
  it("pushes a zero-copy TenBitFrame (no VideoFrame round-trip) with the stamped color", async () => {
    const { handle, port } = makeHandle(BT470BG_FULL, "I420P10");
    await handle.ensureReady();
    const bytes = new Uint8Array(P10_BYTES);
    port.deliver(p10Msg(0, bytes));
    expect(handle.ring.size()).toBe(1);
    const f = handle.ring.frameAt(0);
    expect(isTenBitFrame(f)).toBe(true);
    const tb = f as TenBitFrame;
    expect(tb.width).toBe(W);
    expect(tb.height).toBe(H);
    expect(tb.yOffset).toBe(0);
    expect(tb.uOffset).toBe(W * H * 2);
    expect(tb.vOffset).toBe(W * H * 2 + (W >> 1) * (H >> 1) * 2);
    // Zero-copy: the ring's frame views the delivered bytes themselves.
    expect(tb.data).toBe(bytes);
    expect(tb.timestamp).toBe(0);
    expect(tb.duration).toBe(DUR);
    // Same sourceColor stamp as the NV12 branch.
    expect(tb.colorSpace).toMatchObject({
      matrix: "bt470bg",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: true,
    });
    expect(handle.firstFrameDiag?.frameFormat).toBe("I420P10");
  });

  it("releases 10-bit frames' leases on evict exactly like NV12", async () => {
    const { handle, port } = makeHandle(HD, "I420P10");
    await handle.ensureReady();
    for (let i = 0; i < 4; i++) port.deliver(p10Msg(i * DUR));
    expect(port.released()).toEqual([]);
    handle.evictBefore(2 * DUR);
    expect(port.released()).toEqual([0, 1]);
  });

  it("fails the ring loudly on a byteLength that doesn't match the layout", async () => {
    const { handle, port } = makeHandle(HD, "I420P10");
    await handle.ensureReady();
    port.deliver(p10Msg(0, new Uint8Array(P10_BYTES - 2)));
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/I420P10/);
  });

  it("fails the ring when a frame's format contradicts the session's outFormat", async () => {
    const { handle, port } = makeHandle(HD, "NV12");
    await handle.ensureReady();
    port.deliver(p10Msg(0)); // I420P10 frame into an NV12 session
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/I420P10/);
  });
});

// Tightly-packed NV12: Y (w*h) + interleaved CbCr (w*(h>>1)).
const NV12_BYTES = W * H + W * (H >> 1);

describe("nv12FrameFromBytes", () => {
  it("wraps the SAME bytes zero-copy with the interleaved-UV offset", () => {
    const data = new Uint8Array(NV12_BYTES);
    const f = nv12FrameFromBytes({
      data,
      width: W,
      height: H,
      timestamp: 5,
      duration: 10,
      colorSpace: { matrix: "bt709" },
    });
    expect(f.kind).toBe("nv12");
    expect(isNativeNv12Frame(f)).toBe(true);
    expect(f.width).toBe(W);
    expect(f.height).toBe(H);
    expect(f.uvOffset).toBe(W * H);
    // Zero-copy: the frame views the caller's bytes, not a duplicate.
    expect(f.data).toBe(data);
    expect(f.timestamp).toBe(5);
    expect(f.duration).toBe(10);
    expect(f.colorSpace).toEqual({ matrix: "bt709" });
    expect(() => f.close()).not.toThrow(); // uniform-shape no-op, like TenBitFrame
  });

  it("throws loudly on a byteLength that doesn't match the layout (Rust/TS drift)", () => {
    expect(() =>
      nv12FrameFromBytes({
        data: new Uint8Array(NV12_BYTES - 1),
        width: W,
        height: H,
        timestamp: 0,
        duration: null,
        colorSpace: null,
      }),
    ).toThrow(/NV12/);
  });
});

describe("NativeExportSourceHandle — NV12 lane", () => {
  it("pushes a zero-copy NativeNv12Frame (NO VideoFrame) stamped bt709/limited by default", async () => {
    const { handle, port } = makeHandle();
    await handle.ensureReady();
    const bytes = new Uint8Array(NV12_BYTES);
    port.deliver({ ...frameMsg(0), data: bytes });
    expect(handle.ring.size()).toBe(1);
    const f = handle.ring.frameAt(0);
    // The crux of the 601-tint fix: the ring holds OUR CPU frame kind, which
    // the Compositor routes to Nv12Ingest — never a buffer-defined VideoFrame
    // (whose Chromium software conversion runs BT.601 regardless of the tag).
    expect(isNativeNv12Frame(f)).toBe(true);
    const nv = f as NativeNv12Frame;
    expect(nv.width).toBe(W);
    expect(nv.height).toBe(H);
    expect(nv.uvOffset).toBe(W * H);
    // Zero-copy: the ring's frame views the delivered bytes themselves.
    expect(nv.data).toBe(bytes);
    expect(nv.timestamp).toBe(0);
    expect(nv.duration).toBe(DUR);
    expect(nv.colorSpace).toMatchObject({
      matrix: "bt709",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: false,
    });
    expect(handle.firstFrameDiag?.frameFormat).toBe("NV12");
    expect(handle.firstFrameDiag?.frameColor).toEqual(nv.colorSpace);
  });

  it("carries a 601-tagged source's matrix so the ingest selects BT.601", async () => {
    const { handle, port } = makeHandle({
      matrix: "smpte170m",
      primaries: "smpte170m",
      transfer: "smpte170m",
      fullRange: false,
      matrixAssumed: false,
    });
    await handle.ensureReady();
    port.deliver(frameMsg(0));
    const nv = handle.ring.frameAt(0) as NativeNv12Frame;
    expect(nv.colorSpace?.matrix).toBe("smpte170m");
    expect(nv.colorSpace?.fullRange).toBe(false);
  });

  it("reads an RGB-coded source's frames with the YCbCr colour it opened the session with", async () => {
    // The pack converts RGB into the colour the session is opened with, and
    // the ingest reads the planes with the colour stamped on the frame: the
    // two must be one value, and a YCbCr one.
    const rgb = resolveSourceColor({ width: 1920, height: 1080, pix_fmt: "rgb24" });
    const { handle, port, opens } = makeHandle(rgb);
    await handle.ensureReady();
    port.deliver(frameMsg(0));
    const stamped = (handle.ring.frameAt(0) as NativeNv12Frame).colorSpace!;
    expect(stamped.matrix).not.toBe("rgb");
    expect(stamped).toEqual(nativePlaneColor(rgb));
    expect(opens[0]!.color).toEqual({ matrix: stamped.matrix, fullRange: stamped.fullRange });
  });

  it("fails the ring loudly on a byteLength that doesn't match the layout", async () => {
    const { handle, port } = makeHandle();
    await handle.ensureReady();
    port.deliver({ ...frameMsg(0), data: new Uint8Array(NV12_BYTES - 1) });
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/NV12/);
  });
});
