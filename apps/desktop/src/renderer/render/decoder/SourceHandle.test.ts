// Preview `SourceHandle` recovery from a decoder error that `handleDecodeError`
// classifies as `log-only`, with a fake WebCodecs decoder + scripted packet sink
// (no WebCodecs in node).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMediaInput } from "./mediaInput";
import { logEmit } from "../../ipc";

vi.mock("./mediaInput", () => ({ openMediaInput: vi.fn() }));
vi.mock("./transports/GpuTransport", () => ({ GpuTransport: class {} }));
vi.mock("../../ipc", () => ({ logEmit: vi.fn(async () => {}) }));

import { SourceHandle, SourceMedia } from "./SourceDecoderPool";
import { resolveSourceColor, type SourceColor } from "./ffprobeColorSpace";

interface FakePacket {
  timestamp: number; // seconds — mediabunny's EncodedPacket unit
  microsecondTimestamp: number;
  type: "key" | "delta";
  toEncodedVideoChunk: () => EncodedVideoChunk;
}

function pkt(tSec: number, type: "key" | "delta"): FakePacket {
  const timestampUs = Math.trunc(tSec * 1e6);
  return {
    timestamp: tSec,
    microsecondTimestamp: timestampUs,
    type,
    toEncodedVideoChunk: () => ({ timestamp: timestampUs, type }) as EncodedVideoChunk,
  };
}

/// Two seconds at 30 fps, a key packet every second.
const packets = Array.from({ length: 60 }, (_, i) => pkt(i / 30, i % 30 === 0 ? "key" : "delta"));

const sink = {
  async getKeyPacket(tSec: number): Promise<FakePacket | null> {
    let found: FakePacket | null = null;
    for (const p of packets) if (p.type === "key" && p.timestamp <= tSec) found = p;
    return found;
  },
  async getFirstPacket(): Promise<FakePacket | null> {
    return packets[0] ?? null;
  },
  async getNextPacket(p: FakePacket): Promise<FakePacket | null> {
    const i = packets.indexOf(p);
    return i >= 0 && i + 1 < packets.length ? packets[i + 1]! : null;
  },
};

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  /// `decode` emits a frame only for chunks at or before this timestamp (µs).
  /// Models a decoder that produces nothing, or nothing past some point,
  /// before it errors.
  static outputsUpToUs = Number.POSITIVE_INFINITY;
  state: CodecState = "unconfigured";
  decoded: EncodedVideoChunk[] = [];
  decodeQueueSize = 0;
  private readonly init: { output: (frame: VideoFrame) => void; error: (e: unknown) => void };

  constructor(init: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) {
    this.init = init;
    FakeVideoDecoder.instances.push(this);
  }
  configure(_cfg: VideoDecoderConfig): void {
    this.state = "configured";
  }
  decode(chunk: EncodedVideoChunk): void {
    if (this.state !== "configured") throw new Error("InvalidStateError: decode on a closed codec");
    this.decoded.push(chunk);
    if (chunk.timestamp <= FakeVideoDecoder.outputsUpToUs) {
      this.init.output({ timestamp: chunk.timestamp, duration: 33_333, close: () => {} } as unknown as VideoFrame);
    }
  }
  reset(): void {}
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.state = "closed";
  }
  /// The platform closes the codec before it delivers the error callback.
  fail(message: string): void {
    this.state = "closed";
    this.init.error(new Error(message));
  }
}

/// Every fake settles in microtasks; one macrotask drains them all.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeHandle(sourceColor: SourceColor = resolveSourceColor({ height: 1080 })): SourceHandle {
  return new SourceHandle("layer-1", new SourceMedia("media-1", "weftcut-media://localhost/test.mp4", sourceColor));
}

function warnings(): string[] {
  return vi.mocked(logEmit).mock.calls.map(([entry]) => entry.message);
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  FakeVideoDecoder.outputsUpToUs = Number.POSITIVE_INFINITY;
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 2, height: 2, close: () => {} }));
  vi.mocked(openMediaInput).mockImplementation(async () =>
    ({
      videoTrack: {
        getDecoderConfig: async () =>
          ({ codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 }) as VideoDecoderConfig,
      },
      packetSink: sink,
      dispose: () => {},
    }) as unknown as Awaited<ReturnType<typeof openMediaInput>>,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SourceHandle after an unclassified decoder error", () => {
  it("rebuilds its decoder on the next request and restarts it from a key packet", async () => {
    const h = makeHandle();
    try {
      await h.requestFrameAt(0);
      await settle();
      expect(h.decodedFrameCount(), "the handle produced frames before the error").toBeGreaterThan(0);

      FakeVideoDecoder.instances[0]!.fail("Decoding error.");
      await h.requestFrameAt(500_000);
      await settle();

      expect(FakeVideoDecoder.instances, "a fresh decoder replaced the closed one").toHaveLength(2);
      expect(FakeVideoDecoder.instances[1]!.decoded[0]?.type).toBe("key");
    } finally {
      h.dispose();
    }
  });

  it("stops after a rebuilt decoder fails before producing any output", async () => {
    const h = makeHandle();
    try {
      await h.requestFrameAt(0);
      await settle();
      FakeVideoDecoder.instances[0]!.fail("Decoding error.");

      FakeVideoDecoder.outputsUpToUs = -1;
      await h.requestFrameAt(500_000);
      await settle();
      expect(FakeVideoDecoder.instances).toHaveLength(2);
      const rebuilt = FakeVideoDecoder.instances[1]!;
      rebuilt.fail("Decoding error.");
      // A dying decoder can deliver more than one error.
      rebuilt.fail("Decoding error.");

      for (let i = 0; i < 5; i++) {
        await h.requestFrameAt(500_000 + i * 33_333);
        await settle();
      }

      expect(FakeVideoDecoder.instances, "no decoder replaces the one that failed").toHaveLength(2);
      expect(warnings().filter((m) => m.includes("video decoder stopped"))).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it("stops after a rebuilt decoder fails again without outputting past the earlier failure", async () => {
    // A packet mid-GOP fails deterministically: every rebuild restarts at the
    // GOP's key, outputs the frames before it, and fails at the same packet.
    FakeVideoDecoder.outputsUpToUs = 500_000;
    const h = makeHandle();
    try {
      await h.requestFrameAt(500_000);
      await settle();
      FakeVideoDecoder.instances[0]!.fail("Decoding error.");
      await h.requestFrameAt(500_000);
      await settle();
      expect(FakeVideoDecoder.instances).toHaveLength(2);
      expect(FakeVideoDecoder.instances[1]!.decoded.length, "the rebuilt decoder decoded again").toBeGreaterThan(0);
      FakeVideoDecoder.instances[1]!.fail("Decoding error.");

      for (let i = 0; i < 5; i++) {
        await h.requestFrameAt(500_000);
        await settle();
      }

      expect(FakeVideoDecoder.instances, "no decoder replaces the one that got no further").toHaveLength(2);
      expect(warnings().filter((m) => m.includes("video decoder rebuilt"))).toHaveLength(1);
      expect(warnings().filter((m) => m.includes("video decoder stopped"))).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it("rebuilds again once a rebuilt decoder outputs past the earlier failure", async () => {
    FakeVideoDecoder.outputsUpToUs = 500_000;
    const h = makeHandle();
    try {
      await h.requestFrameAt(500_000);
      await settle();
      FakeVideoDecoder.instances[0]!.fail("Decoding error.");

      FakeVideoDecoder.outputsUpToUs = 1_000_000;
      await h.requestFrameAt(500_000);
      await settle();
      expect(FakeVideoDecoder.instances).toHaveLength(2);
      FakeVideoDecoder.instances[1]!.fail("Decoding error.");
      await h.requestFrameAt(1_000_000);
      await settle();

      expect(FakeVideoDecoder.instances, "progress past the failure re-arms the rebuild").toHaveLength(3);
      expect(warnings().filter((m) => m.includes("video decoder stopped"))).toEqual([]);
    } finally {
      h.dispose();
    }
  });
});

// A hardware decoder converts a stream that declares no matrix as BT.709,
// whatever the config says, so only a software decoder can show the colour the
// rule supplies for an untagged SD source.
describe("SourceHandle decoder lane", () => {
  it.each([
    ["an untagged SD source", resolveSourceColor({ height: 480 }), "prefer-software"],
    ["an untagged HD source", resolveSourceColor({ height: 1080 }), "prefer-hardware"],
    ["a 601-tagged SD source", resolveSourceColor({ height: 480, color_matrix: "smpte170m" }), "prefer-hardware"],
  ] as const)("builds the decoder of %s as its colour needs", async (_name, sourceColor, lane) => {
    const configure = vi.spyOn(FakeVideoDecoder.prototype, "configure");
    const h = makeHandle(sourceColor);
    try {
      await h.requestFrameAt(0);
      await settle();
      expect(configure).toHaveBeenCalledWith(expect.objectContaining({ hardwareAcceleration: lane }));
    } finally {
      configure.mockRestore();
      h.dispose();
    }
  });
});
