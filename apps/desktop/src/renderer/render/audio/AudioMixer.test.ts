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

class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  setValueCurveAtTime = vi.fn();
}

class FakeNode {
  gain = new FakeAudioParam();
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
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeNode[] = [];

  createGain = (): FakeNode => {
    const gain = new FakeNode();
    this.gains.push(gain);
    return gain;
  };
  createChannelMerger = (): FakeNode => new FakeNode();
  createChannelSplitter = (): FakeNode => new FakeNode();
  createBuffer = (): FakeBuffer => new FakeBuffer();
  createBufferSource = (): FakeBufferSource => {
    const source = new FakeBufferSource();
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
  await Promise.resolve();
  await Promise.resolve();
}

function createMixer(): {
  ctx: FakeAudioContext;
  mixer: AudioMixer;
  /// The stand-in Role bus for `role`, created on first ask so a test can name
  /// a Role before the mixer connects to it.
  roleBus: (role: AudioRole) => FakeNode;
} {
  const ctx = new FakeAudioContext();
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
      view,
      layerTStartUs: 0,
      layerTEndUs: 1_000_000,
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
