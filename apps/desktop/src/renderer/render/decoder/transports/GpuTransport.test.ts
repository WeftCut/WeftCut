// @vitest-environment jsdom
//
// GpuTransport.test.ts — the slot transport over its session port: one
// release per slot on every path, the open/close calls, requests and errors.
// The session's port is faked (`openDecodeSession` mocked), `window.api` is
// faked, and the slot fence's device is a stand-in whose completion signal the
// test controls (the real one comes from the Pixi Application).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewGpuCommand, SlotSessionMsg } from "../../../../shared/frameCarrier/wire";
import { GpuTransport } from "./GpuTransport";
import { nativePlaneColor, resolveSourceColor } from "../ffprobeColorSpace";
import { hydratePerformanceSettings } from "../../../../shared/performance-settings";
import { setSlotFenceBackend, sharedSlotFenceQueue, type SlotFenceBackend } from "./slotFenceQueue";

const session = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../../ipc/decodeSession", () => ({ openDecodeSession: session.open }));

const HD = resolveSourceColor({ width: 1920, height: 1080 });

/// The transport's end of its session port; `deliver` stands in for the preload.
class FakePort {
  onmessage: ((event: MessageEvent<SlotSessionMsg>) => void) | null = null;
  readonly posted: PreviewGpuCommand[] = [];
  closed = false;
  postMessage(cmd: PreviewGpuCommand): void {
    this.posted.push(cmd);
  }
  close(): void {
    this.closed = true;
  }
  deliver(msg: SlotSessionMsg): void {
    this.onmessage?.({ data: msg } as MessageEvent<SlotSessionMsg>);
  }
  releases(): Array<[number, number]> {
    return this.posted.flatMap((c) => (c.type === "release" ? [[c.slot, c.gen] as [number, number]] : []));
  }
  requests(): number[] {
    return this.posted.flatMap((c) => (c.type === "request" ? [c.targetUs] : []));
  }
}

interface FakeApi {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/// A page whose opens succeed and hand over `port`.
function installApi(): { api: FakeApi; port: FakePort } {
  const port = new FakePort();
  const api: FakeApi = {
    open: vi.fn(async () => ({ width: 2, height: 2, poolSize: 3 })),
    close: vi.fn(async () => {}),
  };
  (window as unknown as { api: { previewGpu: FakeApi } }).api = { previewGpu: api };
  session.open.mockImplementation(async (_sessionId: string, open: () => Promise<unknown>) => ({ info: await open(), port }));
  return { api, port };
}

/// A device stand-in for the shared slot-fence queue, with the completion
/// signal under the test's control.
function installFakeSlotFenceDevice(): { signalAll: () => void } {
  const signals: (() => void)[] = [];
  const backend: SlotFenceBackend = {
    submit(_bmp, onSignal) {
      let done = false;
      signals.push(() => {
        done = true;
        onSignal();
      });
      return { signalled: () => done, dispose: () => {} };
    },
  };
  setSlotFenceBackend(backend);
  return {
    signalAll: () => {
      for (const s of signals.splice(0)) s();
    },
  };
}

const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

/// A slot the preload read, filled with generation `gen`.
const slot = (n: number, gen = 7, ptsUs = n * 33_333): SlotSessionMsg => ({
  kind: "slot",
  slot: n,
  gen,
  ptsUs,
  durUs: 33_333,
  bitmap: bitmap(),
  timing: { gvfMs: 0.1, cibMs: 0.2, residentMs: 0.4 },
});

async function opened(streamId = "s1"): Promise<{ t: GpuTransport; api: FakeApi; port: FakePort }> {
  const { api, port } = installApi();
  const t = new GpuTransport();
  await t.open({ streamId, path: "C:/x.mp4", sourceColor: HD });
  return { t, api, port };
}

beforeEach(() => {
  session.open.mockReset();
});

afterEach(() => {
  hydratePerformanceSettings(undefined);
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  setSlotFenceBackend(null);
});

describe("GpuTransport", () => {
  it("returns every slot exactly once, after its read completed: shown, never painted, failed read", async () => {
    const device = installFakeSlotFenceDevice();
    const { t, port } = await opened();
    const shown: number[] = [];
    const errors: string[] = [];
    t.onError((reason) => errors.push(reason));
    port.deliver(slot(0, 3));
    // Nothing subscribed to frames yet: this one is never painted.
    t.onFrame((_b, ptsUs) => shown.push(ptsUs));
    port.deliver(slot(1, 4));
    port.deliver({ kind: "slot", slot: 2, gen: 5, ptsUs: 0, durUs: 33_333, error: "getVideoFrame failed" });
    expect(port.releases(), "a failed read holds nothing and goes back at once; read slots wait").toEqual([[2, 5]]);
    device.signalAll();
    sharedSlotFenceQueue().drain();
    sharedSlotFenceQueue().drain();
    expect(port.releases().sort()).toEqual([[0, 3], [1, 4], [2, 5]]);
    expect(shown).toEqual([33_333]);
    expect(errors, "a failed read is a transport failure").toEqual(["getVideoFrame failed"]);
    await t.dispose();
  });

  it("drops a disposed session's unreleased slots without releasing them, and releases nothing after", async () => {
    const device = installFakeSlotFenceDevice();
    const { t, port } = await opened();
    t.onFrame(() => {});
    port.deliver(slot(0));
    const late = slot(1);
    await t.dispose();
    expect(sharedSlotFenceQueue().pendingCount(), "dispose drops the session's unreleased slots").toBe(0);
    port.deliver(late);
    device.signalAll();
    sharedSlotFenceQueue().drain();
    expect(port.releases()).toEqual([]);
    expect(sharedSlotFenceQueue().pendingCount()).toBe(0);
    expect(port.closed).toBe(true);
  });

  it("releases a slot still in its fence after a terminal error, once", async () => {
    const device = installFakeSlotFenceDevice();
    const { t, port } = await opened();
    t.onFrame(() => {});
    port.deliver(slot(0, 9));
    port.deliver({ kind: "error", message: "session thread panicked", terminal: true });
    device.signalAll();
    sharedSlotFenceQueue().drain();
    sharedSlotFenceQueue().drain();
    expect(port.releases()).toEqual([[0, 9]]);
    await t.dispose();
  });

  it("reports every session error through onError, terminal or not: each one falls back to software", async () => {
    const { t, port } = await opened();
    const errors: string[] = [];
    t.onError((reason) => errors.push(reason));
    port.deliver({ kind: "error", message: "seek failed", terminal: false });
    port.deliver({ kind: "error", message: "session thread panicked", terminal: true });
    expect(errors).toEqual(["seek failed", "session thread panicked"]);
    await t.dispose();
    port.deliver({ kind: "error", message: "after dispose", terminal: true });
    expect(errors, "nothing is reported after dispose").toHaveLength(2);
  });

  it("reports the session's end once, and not after dispose", async () => {
    const { t, port } = await opened();
    const eof = vi.fn();
    t.onEof(eof);
    port.deliver({ kind: "end" });
    await t.dispose();
    port.deliver({ kind: "end" });
    expect(eof).toHaveBeenCalledOnce();
  });

  it("reports and closes the session when a completed slot's release cannot cross the port", async () => {
    const device = installFakeSlotFenceDevice();
    const { t, api, port } = await opened("release-failed");
    const errors: string[] = [];
    t.onFrame(() => {});
    t.onError((reason) => errors.push(reason));
    port.postMessage = vi.fn(() => {
      throw new Error("port closed");
    });
    port.deliver(slot(0));
    expect(() => device.signalAll()).not.toThrow();
    await vi.waitFor(() => expect(api.close).toHaveBeenCalledWith({ sessionId: "release-failed" }));
    // One report: the source falls back on it; a second would start two switches.
    expect(errors).toEqual(["GPU slot release could not be delivered"]);
    expect(sharedSlotFenceQueue().pendingCount()).toBe(0);
  });

  it("neither shows nor releases a slot whose read completion nothing could prove, and closes the session", async () => {
    // No device registered, and jsdom has no OffscreenCanvas for the proof.
    const { t, api, port } = await opened("unproven");
    const delivered = vi.fn();
    const error = vi.fn();
    t.onFrame(delivered);
    t.onError(error);
    port.deliver(slot(0));
    expect(delivered).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("GPU slot read completion could not be verified");
    expect(port.releases()).toEqual([]);
    expect(api.close).toHaveBeenCalledWith({ sessionId: "unproven" });
    await t.dispose();
  });

  it("does not resolve disposal until main has closed the session", async () => {
    const { t, api } = await opened();
    let finishClose!: () => void;
    api.close.mockImplementation(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    let disposed = false;
    const disposing = t.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finishClose();
    await disposing;
    expect(disposed).toBe(true);
    expect(api.close.mock.calls).toEqual([[{ sessionId: "s1" }]]);
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
    const t = new GpuTransport();
    const opening = t.open({ streamId: "s1", path: "C:/x.mp4", sourceColor: HD });
    const disposing = t.dispose();
    arrive();
    await opening;
    await disposing;
    expect(api.close.mock.calls).toEqual([[{ sessionId: "s1" }]]);
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();
  });

  it("opens its session under the caller's stream id and listens on the port it gets", async () => {
    const { t, port } = await opened("ffmpeg:hardware:L1:3");
    expect(session.open).toHaveBeenCalledWith("ffmpeg:hardware:L1:3", expect.any(Function));
    expect(port.onmessage).not.toBeNull();
    await t.dispose();
  });

  it("posts each new target up the port, not every paused tick, and re-arms after a ring flush", async () => {
    const { t, port } = await opened();
    for (let i = 0; i < 60; i++) t.requestFrameAt(0);
    t.requestFrameAt(40_000);
    t.resetRequestDedup();
    t.requestFrameAt(40_000);
    expect(port.requests()).toEqual([0, 40_000, 40_000]);
    await t.dispose();
    t.requestFrameAt(80_000);
    expect(port.requests()).toHaveLength(3);
  });

  it("uses the current pool size on each new session and retains explicit diagnostic overrides", async () => {
    const { api } = installApi();
    hydratePerformanceSettings({ preview_gpu_pool_slots: 6 });
    const first = new GpuTransport();
    await first.open({ streamId: "six", path: "C:/x.mp4", sourceColor: HD });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({ poolSize: 6 }));
    hydratePerformanceSettings({ preview_gpu_pool_slots: 2 });
    const next = new GpuTransport();
    await next.open({ streamId: "two", path: "C:/x.mp4", sourceColor: HD });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({ poolSize: 2 }));
    const explicit = new GpuTransport();
    await explicit.open({ streamId: "override", path: "C:/x.mp4", poolSize: 4, sourceColor: HD });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({ poolSize: 4 }));
    await Promise.all([first.dispose(), next.dispose(), explicit.dispose()]);
  });

  it("forwards renderer-probed coded dimensions to main admission", async () => {
    const { api } = installApi();
    const t = new GpuTransport();
    await t.open({ streamId: "budget-size", path: "C:/x.mp4", sourceColor: HD, codedWidth: 3840, codedHeight: 2160 });
    expect(api.open).toHaveBeenCalledWith({
      sessionId: "budget-size",
      path: "C:/x.mp4",
      poolSize: 3,
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "limited" },
      codedWidth: 3840,
      codedHeight: 2160,
    });
    await t.dispose();
  });

  it("hands main the colour it was given, not a default of its own", async () => {
    // An untagged SD source resolves to SMPTE 170M; the native shader must
    // be opened with its matrix, and no primaries step (`planeConversion`).
    const { api } = installApi();
    const sd = new GpuTransport();
    await sd.open({ streamId: "sd", path: "C:/sd.mp4", sourceColor: resolveSourceColor({ width: 720, height: 480 }) });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({
      colorSpace: { primaries: "bt709", transfer: "smpte170m", matrix: "smpte170m", range: "limited" },
    }));
    await sd.dispose();

    const full = new GpuTransport();
    await full.open({
      streamId: "full",
      path: "C:/full.mp4",
      sourceColor: resolveSourceColor({ width: 1920, height: 1080, color_matrix: "smpte170m", color_range: "pc" }),
    });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "smpte170m", range: "full" },
    }));
    await full.dispose();
  });

  it("hands main the conversion the ingest shaders would make: BT.2020 converted, HDR left alone", async () => {
    const { api } = installApi();
    const wide = new GpuTransport();
    await wide.open({
      streamId: "wide",
      path: "C:/wide.mp4",
      sourceColor: resolveSourceColor({
        width: 1920, height: 1080, color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer: "bt2020-10",
      }),
    });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({
      colorSpace: { primaries: "bt2020", transfer: "bt709", matrix: "bt2020-ncl", range: "limited" },
    }));
    await wide.dispose();

    const hdr = new GpuTransport();
    await hdr.open({
      streamId: "hdr",
      path: "C:/hdr.mp4",
      sourceColor: resolveSourceColor({
        width: 3840, height: 2160, color_matrix: "bt2020nc", color_primaries: "bt2020", color_transfer: "smpte2084",
      }),
    });
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({
      colorSpace: { primaries: "bt709", transfer: "pq", matrix: "bt709", range: "limited" },
    }));
    await hdr.dispose();
  });

  it("opens an RGB-coded source with the YCbCr colour every native lane's planes carry", async () => {
    // The native shader converts YCbCr; `rgb` is not a matrix it can be told.
    const { api } = installApi();
    const rgbColor = resolveSourceColor({ width: 1920, height: 1080, pix_fmt: "gbrp", color_matrix: "gbr" });
    const rgb = new GpuTransport();
    await rgb.open({ streamId: "rgb", path: "C:/rgb.mp4", sourceColor: rgbColor });
    const planes = nativePlaneColor(rgbColor);
    expect(planes.matrix).not.toBe("rgb");
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({
      colorSpace: {
        primaries: planes.primaries,
        transfer: planes.transfer,
        matrix: planes.matrix,
        range: planes.fullRange ? "full" : "limited",
      },
    }));
    await rgb.dispose();
  });

  it("records each shown slot's read and completion cost, with no proof fallback under the fence", async () => {
    const device = installFakeSlotFenceDevice();
    const { t, port } = await opened();
    t.onFrame(() => {});
    expect(t.handoffTimings()).toBeNull();
    port.deliver(slot(0));
    const s = t.handoffTimings()!;
    expect(s.n).toBe(1);
    expect(s.residentP50).toBeCloseTo(0.4);
    expect(s.proofFallbacks).toBe(0);
    device.signalAll();
    await t.dispose();
  });
});
