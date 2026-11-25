import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioRole, AudioView } from "../../ipc";
import type { AudioGraph } from "./AudioGraph";

const conform = vi.hoisted(() => {
  interface PendingRead {
    resolve: () => void;
    reject: () => void;
  }
  return {
    pending: [] as PendingRead[],
    /// When set, `ConformSource.open` parks on it — lets a test land dispose()
    /// inside the open's in-flight window.
    openGate: null as Promise<void> | null,
  };
});

vi.mock("./conformSource", () => ({
  ConformSource: class {
    readonly header = { channels: 1 };

    static async open(): Promise<unknown> {
      if (conform.openGate) await conform.openGate;
      return new this();
    }

    readWindow(
      _startFrame: number,
      frameCount: number,
    ): Promise<Float32Array<ArrayBuffer>[]> {
      return new Promise((resolve, reject) => {
        conform.pending.push({
          resolve: () =>
            resolve([
              new Float32Array(
                new ArrayBuffer(frameCount * Float32Array.BYTES_PER_ELEMENT),
              ),
            ]),
          reject: () => reject(new Error("controlled stale read failure")),
        });
      });
    }
  },
}));

import { AudioMixer } from "./AudioMixer";
import { evalEnvelope, sampleGain } from "./envelope";

class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class FakeNode {
  constructor(readonly gain: FakeAudioParam | StrictAudioParam = new FakeAudioParam()) {}
  connected = false;
  /// Both directions are recorded so a re-pointed connection is observable
  /// from either end without reading the mixer's private fields.
  readonly inputs: FakeNode[] = [];
  readonly outputs: FakeNode[] = [];
  connect = vi.fn((target?: FakeNode) => {
    this.connected = true;
    if (target) {
      this.outputs.push(target);
      target.inputs.push(this);
    }
    return target ?? this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
    for (const target of this.outputs) {
      const at = target.inputs.indexOf(this);
      if (at >= 0) target.inputs.splice(at, 1);
    }
    this.outputs.length = 0;
  });
}

/// The automation rules of Chromium's AudioParam, as far as a schedule meets
/// them: a time before the context's current time is moved to it, and
/// cancelling drops every event at or after the time. `valueAt` reads the
/// resulting timeline. It has no `setValueCurveAtTime`, which the mixer must
/// not use (see `AudioMixer.applyEnvelopes`).
class StrictAudioParam {
  value = 1;
  private events: { kind: "set" | "ramp"; time: number; value: number }[] = [];
  constructor(private readonly ctx: { currentTime: number }) {}

  setValueAtTime(value: number, time: number): void {
    this.events.push({ kind: "set", time: Math.max(time, this.ctx.currentTime), value });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ kind: "ramp", time: Math.max(time, this.ctx.currentTime), value });
  }
  cancelScheduledValues(time: number): void {
    this.events = this.events.filter((e) => e.time < time);
  }

  valueAt(time: number): number {
    const ordered = this.events.map((e, seq) => ({ e, seq })).sort((a, b) => a.e.time - b.e.time || a.seq - b.seq).map((x) => x.e);
    let value = this.value;
    let from = -Infinity;
    for (const e of ordered) {
      if (e.time > time) {
        return e.kind === "ramp" && Number.isFinite(from) ? value + (e.value - value) * ((time - from) / (e.time - from)) : value;
      }
      value = e.value; from = e.time;
    }
    return value;
  }
}

class FakeBuffer {
  copyToChannel = vi.fn();
}

class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    this.stopped = true;
  });
}

class FakeAudioContext {
  currentTime = 10;
  /// Context time a source start lets pass: the audio thread renders a
  /// device callback between the mixer reading `currentTime` and its next
  /// call. Gain params obey Chromium's automation rules when it is set.
  startAdvanceS = 0;
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeNode[] = [];

  createGain = (): FakeNode => {
    const gain = new FakeNode(this.startAdvanceS > 0 ? new StrictAudioParam(this) : new FakeAudioParam());
    this.gains.push(gain);
    return gain;
  };
  createChannelMerger = (): FakeNode => new FakeNode();
  createChannelSplitter = (): FakeNode => new FakeNode();
  createBuffer = (): FakeBuffer => new FakeBuffer();
  createBufferSource = (): FakeBufferSource => {
    const source = new FakeBufferSource();
    const start = source.start;
    source.start = vi.fn(() => { start(); this.currentTime += this.startAdvanceS; });
    this.sources.push(source);
    return source;
  };
}

const view: AudioView = {
  media_id: "media",
  media_label: "media",
  src_in_us: 0,
  src_out_us: 1_000_000,
  gain_db: { mode: "Static", value: 0 },
  pan: { mode: "Static", value: 0 },
  fade_in_us: 0,
  fade_out_us: 0,
  mute: false,
  role: "dialogue",
};

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function createMixer(opts: { view?: AudioView; layerTEndUs?: number; startAdvanceS?: number } = {}): {
  ctx: FakeAudioContext;
  mixer: AudioMixer;
  /// The stand-in Role bus for `role`, created on first ask so a test can name
  /// a Role before the mixer connects to it.
  roleBus: (role: AudioRole) => FakeNode;
} {
  const ctx = new FakeAudioContext();
  ctx.startAdvanceS = opts.startAdvanceS ?? 0;
  const buses = new Map<AudioRole, FakeNode>();
  const roleBus = (role: AudioRole): FakeNode => {
    const existing = buses.get(role);
    if (existing) return existing;
    const bus = new FakeNode();
    buses.set(role, bus);
    return bus;
  };
  const graph = {
    ctx,
    input: new FakeNode(),
    roleBusInput: roleBus,
    resume: vi.fn(async () => {}),
  } as unknown as AudioGraph;
  const mixer = new AudioMixer(
    {
      layerId: "layer",
      conformUrl: "weftcut-media://audio.conform",
      view: opts.view ?? view,
      layerTStartUs: 0,
      layerTEndUs: opts.layerTEndUs ?? 1_000_000,
    },
    graph,
  );
  return { ctx, mixer, roleBus };
}

afterEach(() => {
  conform.pending.length = 0;
  conform.openGate = null;
  vi.restoreAllMocks();
});

describe("AudioMixer Role bus wiring", () => {
  it("folds the Role gain onto the layer and leaves the Role bus at unity", async () => {
    const { ctx, mixer, roleBus } = createMixer();
    // The pan graph splices in on open — it rewires INTO trim, never out of
    // it, so the Role connection has to survive.
    await flush();
    expect(roleBus("dialogue").inputs).toHaveLength(1);

    mixer.updateView(view, 0, 1_000_000, 0.5);

    // Applied exactly once, upstream of the fan-in: a bus gain tracking the
    // Role gain would apply it a second time.
    expect(ctx.gains.some((gain) => gain.gain.value === 0.5)).toBe(true);
    expect(roleBus("dialogue").gain.value).toBe(1);
    expect(roleBus("dialogue").inputs).toHaveLength(1);
  });

  it("re-points the layer when the view arrives with a different Role", () => {
    const { mixer, roleBus } = createMixer();
    expect(roleBus("dialogue").inputs).toHaveLength(1);
    expect(roleBus("music").inputs).toHaveLength(0);

    mixer.updateView({ ...view, role: "music" }, 0, 1_000_000, 1);

    expect(roleBus("dialogue").inputs).toHaveLength(0);
    expect(roleBus("music").inputs).toHaveLength(1);
  });
});

describe("AudioMixer dispose racing the conform open", () => {
  it("a dispose during the conform fetch must not resurrect the mixer", async () => {
    // A dispose landing inside `openSource`'s in-flight window must not
    // resurrect the mixer — see `AudioMixer.openSource`.
    let releaseOpen!: () => void;
    conform.openGate = new Promise<void>((r) => { releaseOpen = r; });
    const { mixer } = createMixer();
    mixer.dispose(); // open still in flight
    releaseOpen();
    await flush();
    // A resurrected source would schedule reads; a disposed mixer stays inert.
    mixer.tick(0, true, 1_000_000, { compUs: 0, ctxTime: 10 });
    expect(conform.pending).toHaveLength(0);
  });
});

describe("AudioMixer seek scheduling", () => {
  it.each(["resolves", "rejects"] as const)(
    "keeps the current chunk reserved when a stale read %s after seek",
    async (staleOutcome) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ctx, mixer } = createMixer();
      await flush();

      mixer.tick(0, true, 1_000_000, { compUs: 0, ctxTime: 10 });
      expect(conform.pending).toHaveLength(1);

      const anchorAfterSeek = { compUs: 100_000, ctxTime: 10 };
      mixer.tick(100_000, true, 1_000_000, anchorAfterSeek);
      expect(conform.pending).toHaveLength(2);

      conform.pending[0]![staleOutcome === "resolves" ? "resolve" : "reject"]();
      await flush();

      // A render tick lands while the replacement read is still pending.
      // A stale completion must not release that replacement's reservation.
      mixer.tick(100_000, true, 1_000_000, anchorAfterSeek);

      // Resolve every current-generation read; exactly one node may end up
      // audible.
      for (const read of conform.pending.slice(1)) read.resolve();
      await flush();

      const audible = ctx.sources.filter(
        (source) => source.started && !source.stopped && source.connected,
      );
      expect(audible).toHaveLength(1);
      expect(conform.pending).toHaveLength(2);
    },
  );
});

describe("AudioMixer envelope automation", () => {
  // A 2 s layer fading in across both of its 1 s chunks, played from 0.4 s:
  // the first chunk starts inside its span, on the context's current time.
  const fading: AudioView = { ...view, src_out_us: 2_000_000, fade_in_us: 2_000_000 };
  const anchor = { compUs: 400_000, ctxTime: 10.01 };
  const callbackS = 256 / 48_000;

  it.each([["in order", [0, 1]], ["the later chunk first", [1, 0]]] as const)(
    "follows the layer's envelope at every control point when the context moves on between reading its time and scheduling (reads land %s)",
    async (_label, order) => {
      const envelope = sampleGain(fading.gain_db, fading.fade_in_us, fading.fade_out_us, 2_000_000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ctx, mixer } = createMixer({ view: fading, layerTEndUs: 2_000_000, startAdvanceS: callbackS });
      await flush();
      mixer.tick(400_000, true, 2_000_000, anchor);
      expect(conform.pending).toHaveLength(2);
      for (const i of order) { conform.pending[i]!.resolve(); await flush(); }

      expect(warn).not.toHaveBeenCalled();
      const gain = ctx.gains[0]!.gain as StrictAudioParam;
      // From the first control point after the play's start, which a late
      // first event reaches only at the context's time.
      for (let tUs = 420_000; tUs < 2_000_000; tUs += envelope.stepUs) {
        const at = anchor.ctxTime + (tUs - anchor.compUs) / 1_000_000;
        expect(gain.valueAt(at), `gain at ${tUs} us`).toBeCloseTo(evalEnvelope(envelope, tUs), 6);
      }
    },
  );
});
