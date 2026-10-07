// Control-flow half of the export EOS tail-deadlock fix, tested with a fake
// decoder + scripted packet sink (no WebCodecs in node).
//
// The worker consumes concurrently with bounded dispatch. Tests cover credits
// across planning blocks, reorder/EOS output, failure and cancellation. A range
// must never await the EOS drain: it would prevent later ranges from advancing
// retention while trailing pictures are still being consumed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceHandleInit } from "./session";
import { ExportDecoderPool, ExportSourceHandle } from "./ExportDecoderPool";
import { openMediaInput } from "./mediaInput";

vi.mock("./mediaInput", () => ({ openMediaInput: vi.fn() }));

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

function makeSink(packets: FakePacket[]) {
  return {
    async getKeyPacket(tSec: number): Promise<FakePacket | null> {
      let found: FakePacket | null = null;
      for (const p of packets) {
        if (p.type === "key" && p.timestamp <= tSec) found = p;
      }
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
}

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  readonly output: (frame: VideoFrame) => void;
  readonly errorCb: (e: unknown) => void;
  decoded: unknown[] = [];
  flushCalls = 0;
  closed = false;
  decodeQueueSize = 0;
  private flushResolvers: Array<() => void> = [];

  constructor(init: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) {
    this.output = init.output;
    this.errorCb = init.error;
    FakeVideoDecoder.instances.push(this);
  }
  configure(_cfg: VideoDecoderConfig): void {}
  decode(chunk: unknown): void {
    this.decoded.push(chunk);
  }
  flush(): Promise<void> {
    this.flushCalls += 1;
    // Stays PENDING until the test resolves it — models a drain stalled on
    // VideoFrame-pool exhaustion (no consumer freeing slots yet).
    return new Promise((resolve) => this.flushResolvers.push(resolve));
  }
  resolveFlush(): void {
    for (const r of this.flushResolvers.splice(0)) r();
  }
  close(): void {
    this.closed = true;
  }
}

/// Decoder OUTPUT frame stub (what `ring.push` receives) — distinct from the
/// store tests' fakeFrame only in that the diag path reads colorSpace/format.
function decodedFrame(ptsUs: number, durationUs: number): VideoFrame {
  return { timestamp: ptsUs, duration: durationUs, close: () => {} } as unknown as VideoFrame;
}

/// Race a promise against a short timer. All fakes settle in microtasks, so
/// "blocked" reliably means "would park forever", not "was slow".
function settledWithin(p: Promise<unknown>, ms = 150): Promise<"settled" | "blocked"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

let sink: ReturnType<typeof makeSink>;

function makeHandle(extra?: Partial<SourceHandleInit>): ExportSourceHandle {
  const init: SourceHandleInit = {
    layerId: "layer-1",
    mediaId: "media-1",
    proxyAssetUrl: "weftcut-media://localhost/test.mp4",
    ...extra,
  };
  return new ExportSourceHandle(init);
}

// Control-flow tests below inspect packet coverage/re-seeks, not frame identity.
// Give their producer a consuming sink so dispatch can exceed its fixed window.
async function dispatchWithConsumer(h: ExportSourceHandle, aUs: number, bUs: number): Promise<void> {
  const decode = vi.spyOn(FakeVideoDecoder.prototype, 'decode').mockImplementation(function (this: FakeVideoDecoder, chunk) {
    this.decoded.push(chunk);
    const pts = (chunk as EncodedVideoChunk).timestamp;
    this.output(decodedFrame(pts, 20_000));
    h.evictBefore(pts);
  });
  try { await h.decodeRange(aUs, bUs); }
  finally { decode.mockRestore(); }
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
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

describe("ExportSourceHandle EOS tail", () => {
  it.each([
    { tenBit: false, reorder: 0 }, { tenBit: true, reorder: 0 },
    { tenBit: false, reorder: 16 }, { tenBit: true, reorder: 16 },
  ])('streams across blocks within its allowance (tenBit=$tenBit, reorder=$reorder)', async ({ tenBit, reorder }) => {
    const resources = await import('../resourceClient');
    const planes = await import('./tenBitFrame');
    const copy = vi.spyOn(planes, 'copyToTenBit').mockImplementation(async frame => ({
      kind: 'p10', width: 1920, height: 1080, data: new Uint8Array(8),
      yOffset: 0, uOffset: 0, vOffset: 0, colorSpace: null,
      timestamp: frame.timestamp, duration: frame.duration, close() {},
    }));
    let reserved = 0;
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockImplementation(async memory => {
      if (reserved + memory > (tenBit ? 720 : 400)) throw new Error('resource-capacity-exceeded');
      reserved += memory;
      return () => { reserved -= memory; };
    });
    sink = makeSink(Array.from({ length: 180 }, (_, i) => pkt(i / 30, i === 0 ? 'key' : 'delta')));
    const h = makeHandle({ tenBitLane: tenBit });
    try {
      await h.ensureReady();
      const dec = FakeVideoDecoder.instances[0]!;
      let submitted = 0, consumed = 0, peak = 0;
      const tail: EncodedVideoChunk[] = [];
      const emit = () => dec.output(Object.assign(decodedFrame(tail.shift()!.timestamp, 33_333), { format: tenBit ? 'I420P10' : 'I420' }));
      vi.spyOn(dec, 'decode').mockImplementation(chunk => {
        submitted++; peak = Math.max(peak, submitted - consumed);
        tail.push(chunk as EncodedVideoChunk);
        if (tail.length > reorder) queueMicrotask(emit);
      });
      vi.spyOn(dec, 'flush').mockImplementation(async () => { while (tail.length) emit(); });
      // The producer's GOP extends past the 60-frame planning block. Consumers
      // must run before that dispatch finishes, including across block edges.
      const producers: Promise<void>[] = [];
      for (let i = 0; i < 180; i++) {
        if (i % 60 === 0) {
          producers.push(h.decodeRange(Math.trunc(i / 30 * 1e6), Math.trunc((i + 60) / 30 * 1e6) - 1).catch(error => { h.ring.fail(String(error)); }));
          // A temporarily slower encoder must throttle the producer, not grow
          // another 32-frame reservation or fail the export.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const pts = Math.trunc(i / 30 * 1e6);
        await h.ring.waitForPts(pts);
        expect(h.ring.frameAt(pts)?.timestamp).toBe(pts);
        consumed++;
        h.evictBefore(Math.trunc((i + 1) / 30 * 1e6));
      }
      await Promise.all(producers);
      expect(h.dispatchedTotal).toBe(180);
      expect(peak).toBeLessThanOrEqual(24);
      expect(admission).toHaveBeenCalledOnce();
    } finally { h.dispose(); await new Promise(resolve => setTimeout(resolve, 0)); admission.mockRestore(); copy.mockRestore(); }
    expect(reserved).toBe(0);
  });

  it('wakes both the producer and consumer on a fatal decoder failure', async () => {
    sink = makeSink(Array.from({ length: 90 }, (_, i) => pkt(i / 30, i === 0 ? 'key' : 'delta')));
    const h = makeHandle();
    try {
      await h.ensureReady();
      const dec = FakeVideoDecoder.instances[0]!;
      const producer = h.decodeRange(0, 2_000_000);
      const production = expect(producer).rejects.toThrow('codec failed');
      await vi.waitFor(() => expect(dec.decoded).toHaveLength(24), { interval: 1 });
      dec.output(decodedFrame(0, 33_333)); // an established decoder: failure is terminal
      const consumption = expect(h.ring.waitForPts(1_000_000)).rejects.toThrow('codec failed');
      dec.errorCb(new Error('codec failed'));
      await Promise.all([production, consumption]);
    } finally { h.dispose(); }
  });

  it('rejects a tail consumer when EOS draining fails', async () => {
    sink = makeSink([pkt(0, 'key')]);
    const h = makeHandle();
    try {
      await h.ensureReady();
      vi.spyOn(FakeVideoDecoder.instances[0]!, 'flush').mockRejectedValue(new Error('EOS drain failed'));
      const consumer = expect(h.ring.waitForPts(10_000)).rejects.toThrow('EOS drain failed');
      await h.decodeRange(0, 20_000);
      await consumer;
    } finally { h.dispose(); }
  });

  it('retains a 10-bit lease through an in-flight copy after cancellation', async () => {
    const resources = await import('../resourceClient');
    const planes = await import('./tenBitFrame');
    const release = vi.fn(), close = vi.fn();
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockResolvedValue(release);
    let finish!: (value: Awaited<ReturnType<typeof planes.copyToTenBit>>) => void;
    const copy = vi.spyOn(planes, 'copyToTenBit').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    sink = makeSink([pkt(0, 'key')]);
    const h = makeHandle({ tenBitLane: true });
    try {
      await h.decodeRange(0, 1);
      FakeVideoDecoder.instances[0]!.output(Object.assign(decodedFrame(0, 33_333), { format: 'I420P10', close }));
      await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce(), { interval: 1 });
      const waiting = expect(h.ring.waitForPts(0)).rejects.toThrow('disposed');
      h.dispose();
      expect(release).not.toHaveBeenCalled();
      finish({ kind: 'p10', width: 1, height: 1, data: new Uint8Array(6), yOffset: 0, uOffset: 2, vOffset: 4,
        timestamp: 0, duration: 33_333, colorSpace: null, close() {} });
      await waiting;
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce(), { interval: 1 });
      expect(close).toHaveBeenCalledOnce();
      expect(h.ring.residentFrames).toBe(0);
    } finally { h.dispose(); admission.mockRestore(); copy.mockRestore(); }
  });

  it('returns inactive chunk decoders before admitting subsequent clips and preserves export diagnostics', async () => {
    const resources = await import('../resourceClient');
    let reserved = 0;
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockImplementation(async memory => {
      if (reserved + memory > 700) throw new Error('resource-capacity-exceeded');
      reserved += memory;
      return () => { reserved -= memory; };
    });
    sink = makeSink([pkt(0, 'key')]);
    const pool = new ExportDecoderPool();
    try {
      for (let i = 0; i < 4; i++) {
        const key = `phase-${i % 2}`;
        pool.retainOnly(new Set([key]));
        const handle = pool.acquire({ layerId: `clip-${i}`, mediaId: 'media-1', handleKey: key, proxyAssetUrl: 'weftcut-media://localhost/test.mp4' });
        await expect(handle.decodeRange(0, 1)).resolves.toBeUndefined();
        expect(pool.handles.size).toBe(1);
      }
      expect(pool.diagnostics().totalDispatched).toBe(4);
      expect(pool.diagnostics().sources).toHaveLength(2);
    } finally { pool.dispose(); admission.mockRestore(); }
    expect(reserved).toBe(0);
  });

  it.each([
    { timing: 'immediate', tenBit: false },
    { timing: 'delayed', tenBit: false },
    { timing: 'delayed', tenBit: true },
  ])('exports a trimmed long GOP with $timing output (tenBit=$tenBit)', async ({ timing, tenBit }) => {
    const resources = await import('../resourceClient');
    const planes = await import('./tenBitFrame');
    const copy = vi.spyOn(planes, 'copyToTenBit').mockImplementation(async frame => ({
      kind: 'p10', width: 1920, height: 1080, data: new Uint8Array(8),
      yOffset: 0, uOffset: 0, vOffset: 0, colorSpace: null,
      timestamp: frame.timestamp, duration: frame.duration, close() {},
    }));
    let reserved = 0;
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockImplementation(async memory => {
      if (reserved + memory > (tenBit ? 1400 : 700)) throw new Error('resource-capacity-exceeded: Resource capacity is busy or the memory target is too small');
      reserved += memory;
      return () => { reserved -= memory; };
    });
    // A trimmed 1080p clip starts well inside a GOP. Decoder output arrives
    // during dispatch, before the worker enters its consumption phase.
    sink = makeSink(Array.from({ length: 101 }, (_, i) => pkt(i / 30, i === 0 ? 'key' : 'delta')));
    const handle = makeHandle({ tenBitLane: tenBit });
    try {
      await handle.ensureReady();
      const decoder = FakeVideoDecoder.instances[0]!;
      vi.spyOn(decoder, 'decode').mockImplementation(chunk => {
        const output = () => decoder.output(Object.assign(
          decodedFrame((chunk as EncodedVideoChunk).timestamp, 33_333),
          { format: tenBit ? 'I420P10' : 'I420' },
        ));
        if (timing === 'delayed') setTimeout(output, 0);
        else output();
      });
      await expect(handle.decodeRange(3_000_000, 3_033_333)).resolves.toBeUndefined();
      await handle.ring.waitForPts(3_000_000);
      expect(handle.ring.frameAt(3_000_000)?.timestamp).toBe(3_000_000);
      expect(handle.ring.residentFrames).toBeLessThanOrEqual(12);
    } finally { handle.dispose(); admission.mockRestore(); copy.mockRestore(); }
    // Ten-bit teardown keeps credits until the last copy closes its frame.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reserved).toBe(0);
  });

  it('unblocks a bounded preroll dispatch when its decoder is disposed', async () => {
    const resources = await import('../resourceClient');
    const release = vi.fn();
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockResolvedValue(release);
    sink = makeSink(Array.from({ length: 101 }, (_, i) => pkt(i / 30, i === 0 ? 'key' : 'delta')));
    const handle = makeHandle();
    try {
      const range = handle.decodeRange(3_000_000, 3_033_333);
      await vi.waitFor(() => expect(FakeVideoDecoder.instances[0]?.decoded).toHaveLength(24), { interval: 1 });
      handle.dispose();
      await expect(range).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
    } finally { handle.dispose(); admission.mockRestore(); }
  });

  it('fails preroll when a decoder error arrives before its capacity wait', async () => {
    sink = makeSink(Array.from({ length: 101 }, (_, i) => pkt(i / 30, i === 0 ? 'key' : 'delta')));
    const handle = makeHandle();
    try {
      await handle.ensureReady();
      const decoder = FakeVideoDecoder.instances[0]!;
      vi.spyOn(decoder, 'decode').mockImplementation(chunk => {
        if ((chunk as EncodedVideoChunk).timestamp === 0) decoder.output(decodedFrame(0, 33_333));
      });
      const next = sink.getNextPacket.bind(sink);
      vi.spyOn(sink, 'getNextPacket').mockImplementation(async packet => {
        if (packet === (await sink.getFirstPacket())) decoder.errorCb(new Error('codec failed'));
        return next(packet);
      });
      const range = handle.decodeRange(3_000_000, 3_033_333);
      await expect(settledWithin(range)).resolves.toBe('settled');
      await expect(range).rejects.toThrow('codec failed');
    } finally { handle.dispose(); }
  });

  it('parks in-range production at capacity and cancels queued ranges without reopening the decoder', async () => {
    const resources = await import('../resourceClient');
    const release = vi.fn();
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockResolvedValueOnce(release)
      .mockRejectedValue(new Error('Memory target too small'));
    sink = makeSink(Array.from({ length: 40 }, (_, i) => pkt(i * .02, i === 0 ? 'key' : 'delta')));
    const handle = makeHandle();
    try {
      const producer = handle.decodeRange(0, 800_000);
      const queued = handle.decodeRange(800_000, 1_000_000);
      await vi.waitFor(() => expect(FakeVideoDecoder.instances[0]?.decoded).toHaveLength(24), { interval: 1 });
      expect(FakeVideoDecoder.instances[0]!.decoded).toHaveLength(24);
      handle.dispose(); handle.dispose(); expect(release).toHaveBeenCalledOnce();
      await Promise.all([producer, queued]);
      expect(admission).toHaveBeenCalledOnce();
      expect(FakeVideoDecoder.instances).toHaveLength(1);
    } finally { handle.dispose(); admission.mockRestore(); }
  });

  it('keeps a single reservation while consuming a long GOP and releases it on disposal', async () => {
    const resources = await import('../resourceClient');
    const releases: ReturnType<typeof vi.fn>[] = [];
    const admission = vi.spyOn(resources, 'acquireRenderResources').mockImplementation(async () => {
      const release = vi.fn(); releases.push(release); return release;
    });
    sink = makeSink(Array.from({ length: 70 }, (_, i) => pkt(i * .02, i === 0 ? 'key' : 'delta')));
    const handle = makeHandle();
    try {
      await dispatchWithConsumer(handle, 0, 1_400_000);
      expect(releases).toHaveLength(1);
      expect(releases[0]).not.toHaveBeenCalled();
      handle.dispose(); expect(releases[0]).toHaveBeenCalledOnce();
    } finally { handle.dispose(); admission.mockRestore(); }
  });

  it("stores decoded frames in normalized source time for non-zero media starts", async () => {
    const startUs = 299_674;
    sink = makeSink([pkt(startUs / 1e6, "key"), pkt((startUs + 20_000) / 1e6, "delta")]);
    const h = makeHandle({ sourceStartPtsUs: startUs });

    await h.decodeRange(0, 20_000);
    const dec = FakeVideoDecoder.instances[0]!;
    dec.output(decodedFrame(startUs, 20_000));

    expect(h.ring.firstPtsUs()).toBe(0);
    expect(h.ring.frameAt(0)).not.toBeNull();
  });

  it("normalizes export output with the chunk timestamp when seconds round one microsecond higher", async () => {
    // 2/30 s rounds to 66,667 µs but Mediabunny sends 66,666 in the chunk.
    // The first output frame inherits that chunk timestamp and must still be
    // source PTS 0, not -1 µs.
    sink = makeSink([pkt(2 / 30, "key")]);
    const h = makeHandle();

    await h.decodeRange(0, 20_000);
    const dec = FakeVideoDecoder.instances[0]!;
    dec.output(decodedFrame(66_666, 33_333));

    expect(h.ring.firstPtsUs()).toBe(0);
    expect(h.ring.frameAt(0)).not.toBeNull();
  });

  it("ignores import metadata start PTS when the decode target begins at zero", async () => {
    const metadataStartUs = 299_674;
    const seekUs = 212_133_333;
    const packets = [pkt(0, "key"), pkt(seekUs / 1e6, "key")];
    sink = makeSink(packets);
    const h = makeHandle({ sourceStartPtsUs: metadataStartUs });

    await h.ensureReady();
    await h.decodeRange(seekUs, seekUs + 33_333);
    const dec = FakeVideoDecoder.instances[0]!;
    dec.output(decodedFrame(seekUs, 33_333));

    expect(h.ring.firstPtsUs()).toBe(seekUs);
    expect(h.ring.frameAt(seekUs)).not.toBeNull();
  });

  it("does not block a forward tail range on a stalled EOS flush (export-freeze regression)", async () => {
    // Single trailing GOP: key@0 + deltas to 0.98s, nothing after — chunk A's
    // dispatch runs straight into EOS and floats the flush.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta"));
    sink = makeSink(packets);
    const h = makeHandle();

    await dispatchWithConsumer(h, 0, 500_000);
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(1);
    expect(dec.decoded.length).toBe(50);

    // The flush is STALLED (never resolved here). Chunk B's range lies fully
    // inside the already-dispatched tail: it must return promptly so the worker
    // can reach `waitForPts` (the only thing that frees pool slots). Awaiting
    // the stalled flush here IS the deadlock.
    await expect(settledWithin(h.decodeRange(500_000, 1_000_000))).resolves.toBe("settled");
    expect(dec.decoded.length).toBe(50); // no packets were re-dispatched
  });

  it("issues exactly one EOS flush when the stream ends on a stop-after-key boundary", async () => {
    // The stream's LAST packet is a key just past chunk A's range end. The
    // pre-fix code dispatched it via the stop-after-key rule, exited without
    // seeing EOS, and chunk B's continue then found nothing with dispatched
    // === 0 — no flush was EVER issued, parking the final GOP forever (the
    // lone-IDR shape). Whether EOS is discovered during A (leading-B peek) or
    // B (zero-dispatch probe), exactly one flush must be in flight after both.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 24; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.48s
    packets.push(pkt(0.5, "key"));
    sink = makeSink(packets);
    const h = makeHandle();

    await dispatchWithConsumer(h, 0, 480_000);
    await h.decodeRange(500_000, 980_000);
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(1);
  });

  it("rebuilds the decoder for a backward clip-reuse range instead of awaiting a stalled flush", async () => {
    // Two GOPs (key@0, key@1.0), EOS after 1.48s.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.98s
    packets.push(pkt(1.0, "key"));
    for (let i = 1; i <= 24; i++) packets.push(pkt(1.0 + i * 0.02, "delta")); // ..1.48s
    sink = makeSink(packets);
    const h = makeHandle();

    await dispatchWithConsumer(h, 0, 990_000); // ends on the key@1.0 stop-after-key break
    await dispatchWithConsumer(h, 1_000_000, 1_500_000); // runs to EOS → flush floated
    const first = FakeVideoDecoder.instances[0]!;
    expect(first.flushCalls).toBe(1);

    // A later clip reuses this media from t=0 while the flush is still in
    // flight. A re-seek needs a fresh keyframe start anyway — rebuild and go;
    // awaiting the (possibly pool-stalled) flush deadlocks the export.
    await expect(settledWithin(dispatchWithConsumer(h, 0, 200_000))).resolves.toBe("settled");
    expect(FakeVideoDecoder.instances.length).toBe(2);
    const second = FakeVideoDecoder.instances[1]!;
    expect(second.decoded.length).toBeGreaterThan(0); // re-seeked into the fresh decoder
    expect(first.closed).toBe(true);
  });

  // The stop-after-key rule overshoots the dispatch frontier to the NEXT GOP's
  // key pts. The continue-vs-seek decision must use COVERAGE semantics, not the
  // per-packet frontier: a forward range starting below the overshot key is NOT
  // a backward jump. Re-seeking from the range's GOP key re-feeds the whole
  // stream prefix BEHIND the consumer — the decoder then re-emits stale early
  // frames interleaved with the live tail and `frameAt` serves them into the
  // output (observed: source frame 12 composited at output 150 on a 5s-GOP
  // source; outputs 145..151 corrupted around the GOP boundary).
  it("treats a forward range under the overshot key frontier as covered/continuing, never a re-seek", async () => {
    // Two GOPs: key@0 (+49 deltas to 0.98s), key@1.0 (+25 deltas to 1.5s).
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta"));
    packets.push(pkt(1.0, "key"));
    for (let i = 1; i <= 25; i++) packets.push(pkt(1.0 + i * 0.02, "delta"));
    sink = makeSink(packets);
    const h = makeHandle();

    // Chunk 1 [0..0.4s): stop-after-key dispatches through key@1.0, then the
    // reorder margin adds 16 lead-in packets — coverage is still only
    // "everything ≤ 1.0s" even though dispatch ran ahead to 1.32s.
    await dispatchWithConsumer(h, 0, 400_000);
    const dec = FakeVideoDecoder.instances[0]!;
    const fedAfterChunk1 = dec.decoded.length;
    expect(fedAfterChunk1).toBe(51 + 16); // key@0 + 49 deltas + key@1.0 + 16 margin

    // Chunk 2 [0.4s..0.8s): fully covered by chunk 1's dispatch. Nothing to
    // feed — and CRUCIALLY no re-seek back to key@0 (the corruption source).
    await h.decodeRange(400_000, 800_000);
    expect(dec.decoded.length).toBe(fedAfterChunk1);

    // Chunk 3 [0.8s..1.2s): extends past the parked key — continues from the
    // cursor (packets after key@1.0), still without re-feeding the prefix.
    await dispatchWithConsumer(h, 800_000, 1_200_000);
    expect(dec.decoded.length).toBeGreaterThan(fedAfterChunk1);
    expect(dec.decoded.length).toBeLessThanOrEqual(packets.length);
  });

  it("finalizes the ring when the EOS flush completes so grid-overhang waits clamp", async () => {
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 10; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.2s
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 500_000); // runs to EOS → flush floated
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(1);

    // The drain emits the true-last frame, then the flush completes. A consumer
    // target past the last frame (composition grid longer than the video track)
    // must then clamp instead of parking forever.
    dec.output(decodedFrame(200_000, 20_000));
    const wait = h.ring.waitForPts(300_000);
    dec.resolveFlush();
    await expect(settledWithin(wait)).resolves.toBe("settled");
    expect(h.ring.frameAt(300_000)).not.toBeNull();
  });
});

// Reorder margin: a SW decoder holds the trailing frames of a fed window in
// its reorder/pipelining tail internally (never emits them without more input
// or a flush). The margin feeds up to REORDER_MARGIN extra packets past the
// stop key so those trailing frames drain without an explicit mid-export
// flush. It applies to EVERY lane, not just tenBitLane — Chromium's macOS
// prefer-software H.264 decoder withholds the last 2 frames of a fed window
// (4 with B-frames), which wedged each short-GOP chunk's final `waitForPts`
// (the macOS Lite-export freeze).
describe("ExportSourceHandle reorder margin", () => {
  it("dispatches a reorder margin past the stop key on the default lane", async () => {
    // Two GOPs. key@0 + 9 deltas, key@0.333 + 13 more deltas (24 total).
    // Range ends at 300_000 µs (before the second key), so the stop-after-key
    // dispatch exits at the stop key (key@0.333) — then the margin keeps going.
    const packets: FakePacket[] = [pkt(0, "key")];
    for (let i = 1; i <= 9; i++) packets.push(pkt(i * 0.02, "delta")); // 0.02..0.18s
    packets.push(pkt(0.333, "key")); // stop key for a 300_000 µs bUs
    for (let i = 1; i <= 13; i++) packets.push(pkt(0.333 + i * 0.02, "delta")); // 13 more
    sink = makeSink(packets);

    const h = makeHandle();
    await dispatchWithConsumer(h, 0, 300_000);
    const dec = FakeVideoDecoder.instances[0]!;

    // key@0 + 9 deltas + key@0.333 = 11 through the stop key, then the margin
    // adds min(16, remaining=13) = 13 more — all 24 packets in the stream.
    expect(dec.decoded.length).toBe(11 + 13);
  });

  it("dispatches the same margin on the tenBitLane", async () => {
    const packets: FakePacket[] = [pkt(0, "key")];
    for (let i = 1; i <= 9; i++) packets.push(pkt(i * 0.02, "delta"));
    packets.push(pkt(0.333, "key"));
    for (let i = 1; i <= 13; i++) packets.push(pkt(0.333 + i * 0.02, "delta"));
    sink = makeSink(packets);

    const h = makeHandle({ tenBitLane: true });
    await dispatchWithConsumer(h, 0, 300_000);
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.decoded.length).toBe(11 + 13);
  });

  // The 16-packet cap is enforced even when more than 16 packets remain
  // after the stop key. Ensures the margin never grows unbounded on long-GOP
  // sources (e.g. a stream with a 250-packet GOP and the stop key near the start).
  it("caps the reorder margin at exactly 16 packets when more than 16 remain after the stop key", async () => {
    // key@0 + 9 deltas = 10 packets, then key@0.333 (stop key for 300_000µs bUs),
    // then 20 more deltas — 20 remain after the stop key (above the cap of 16).
    const packets: FakePacket[] = [pkt(0, "key")];
    for (let i = 1; i <= 9; i++) packets.push(pkt(i * 0.02, "delta")); // 0.02..0.18s
    packets.push(pkt(0.333, "key")); // stop key
    for (let i = 1; i <= 20; i++) packets.push(pkt(0.333 + i * 0.02, "delta")); // 20 more
    sink = makeSink(packets);

    const h = makeHandle();
    await dispatchWithConsumer(h, 0, 300_000);
    const dec = FakeVideoDecoder.instances[0]!;
    // 11 through the stop key + exactly 16 margin (not 17 or more).
    expect(dec.decoded.length).toBe(11 + 16);
  });
});

// A decoder rebuild fired by the error callback (the CI shape: a GPU-less
// runner fails the prefer-hardware configure before any output frame, so
// handleDecodeError downgrades to software) lands BETWEEN decodeRange's
// dispatch awaits. The fresh decoder starts keyframe-hungry; continuing the
// old dispatch fed it a delta — the synchronous "A key frame is required
// after configure() or flush()" throw that killed every export on CI.
describe("ExportSourceHandle mid-dispatch rebuild", () => {
  it("restarts the range from a key seek instead of feeding the fresh decoder a delta", async () => {
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 20; i++) packets.push(pkt(i * 0.02, "delta"));
    const base = makeSink(packets);
    let nextCalls = 0;
    sink = {
      ...base,
      async getNextPacket(p: FakePacket) {
        nextCalls++;
        // The HW failure surfaces mid-dispatch, as a task between awaits —
        // exactly how Chromium queues the WebCodecs error callback.
        if (nextCalls === 3) {
          FakeVideoDecoder.instances[0]!.errorCb(new Error("Unsupported configuration"));
        }
        return base.getNextPacket(p);
      },
    };
    const h = makeHandle();

    await h.decodeRange(0, 400_000);

    expect(FakeVideoDecoder.instances.length).toBe(2);
    expect(FakeVideoDecoder.instances[0]!.closed).toBe(true);
    const rebuilt = FakeVideoDecoder.instances[1]!;
    expect((rebuilt.decoded[0] as { type: string }).type).toBe("key");
    // The restart re-fed the whole range, so the chunk's waiters can resolve
    // (a bailed dispatch parks the worker's waitForPts forever).
    expect(rebuilt.decoded.length).toBe(packets.length);
  });

  // Short single-GOP sources (the 1s color fixtures) dispatch every packet and
  // return before Chromium's queued configure error lands — no restart loop is
  // alive to re-drive the range, which was the macOS CI wedge: rebuilt decoder,
  // empty ring, waitForPts parked forever.
  it("re-drives the range when the error lands after decodeRange returned", async () => {
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 20; i++) packets.push(pkt(i * 0.02, "delta"));
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 400_000);
    expect(FakeVideoDecoder.instances.length).toBe(1);

    FakeVideoDecoder.instances[0]!.errorCb(new Error("Unsupported configuration"));
    // The re-drive is a detached async chain — settle it.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(FakeVideoDecoder.instances.length).toBe(2);
    expect(FakeVideoDecoder.instances[0]!.closed).toBe(true);
    const rebuilt = FakeVideoDecoder.instances[1]!;
    expect((rebuilt.decoded[0] as { type: string }).type).toBe("key");
    expect(rebuilt.decoded.length).toBe(packets.length);
  });
});

// preferSoftware: 10-bit decode has no HW path; pre-configure SW to skip the
// HW-error→fallback round-trip. Also verify the default stays prefer-hardware.
describe("ExportSourceHandle preferSoftware", () => {
  it.each([true, false])("uses the supported decode lane when hardware support is %s", async (hardwareSupported) => {
    sink = makeSink([pkt(0, "key")]);
    const probe = vi.fn(async (config: VideoDecoderConfig) => ({
      supported: config.hardwareAcceleration === "prefer-software" || hardwareSupported,
      config,
    }));
    class ProbedDecoder extends FakeVideoDecoder {
      static isConfigSupported = probe;
    }
    vi.stubGlobal("VideoDecoder", ProbedDecoder);
    const configure = vi.spyOn(FakeVideoDecoder.prototype, "configure");
    const handle = makeHandle();
    try {
      await handle.ensureReady();
      expect(configure).toHaveBeenCalledWith(expect.objectContaining({
        hardwareAcceleration: hardwareSupported ? "prefer-hardware" : "prefer-software",
      }));
      expect(FakeVideoDecoder.instances).toHaveLength(1);
    } finally {
      configure.mockRestore();
      handle.dispose();
    }
  });

  it("captures the hardwareAcceleration config via spy before ensureReady", async () => {
    const packets = [pkt(0, "key")];
    sink = makeSink(packets);

    // Capture configure calls by overriding FakeVideoDecoder's configure before
    // the handle calls ensureReady.
    const configuredWith: VideoDecoderConfig[] = [];
    // Patch the class-level configure to capture calls.
    const OrigProto = FakeVideoDecoder.prototype as { configure: (cfg: VideoDecoderConfig) => void };
    const origConfigure = OrigProto.configure;
    OrigProto.configure = function (cfg: VideoDecoderConfig) {
      configuredWith.push(cfg);
      origConfigure.call(this, cfg);
    };

    try {
      // preferSoftware: true → hardwareAcceleration must be "prefer-software"
      FakeVideoDecoder.instances = [];
      const hSW = makeHandle({ preferSoftware: true });
      await hSW.ensureReady();
      expect(configuredWith.length).toBeGreaterThanOrEqual(1);
      expect(configuredWith[0]!.hardwareAcceleration).toBe("prefer-software");

      configuredWith.length = 0;
      FakeVideoDecoder.instances = [];

      // default (no preferSoftware) → hardwareAcceleration must be "prefer-hardware"
      const hDefault = makeHandle();
      await hDefault.ensureReady();
      expect(configuredWith.length).toBeGreaterThanOrEqual(1);
      expect(configuredWith[0]!.hardwareAcceleration).toBe("prefer-hardware");
    } finally {
      OrigProto.configure = origConfigure;
    }
  });
});
