import { afterEach, describe, expect, it, vi } from "vitest";
import { summaryFixture, compositionFixture, ROOT_ID } from "../../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../../ipc";
import type { AudioGraph } from "./AudioGraph";
import { PreviewAudioEngine } from "./PreviewAudioEngine";

const reads = vi.hoisted(() => ({ gate: null as Promise<void> | null,
  opens: [] as string[], windows: [] as number[], failOpen: false }));
vi.mock("./conformSource", () => ({
  ConformSource: class {
    header = { channels: 1 };
    static async open(url: string) {
      reads.opens.push(url);
      if (reads.failOpen) throw new Error("conform unavailable");
      return new this();
    }
    async readWindow(_start: number, frames: number) {
      reads.windows.push(_start);
      if (reads.gate) await reads.gate;
      return [new Float32Array(frames)];
    }
  },
}));

function node() {
  return {
    gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(), setValueCurveAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    onended: null, buffer: null,
  };
}
function setup(startUs = 0) {
  vi.useFakeTimers();
  const sources: ReturnType<typeof node>[] = [];
  const ctx = {
    currentTime: 10, state: "running", onstatechange: null,
    createGain: node, createChannelSplitter: node, createChannelMerger: node,
    createBuffer: () => ({ copyToChannel: vi.fn() }),
    createBufferSource: () => { const n = node(); sources.push(n); return n; },
  };
  const graph = { ctx, resume: vi.fn(async () => {}), dispose: vi.fn(),
    roleBusInput: node, setMasterMute: vi.fn() } as unknown as AudioGraph;
  const layer: LayerSummary = {
    id: "audio", label: null, kind: "Audio", enabled: true, locked: false,
    color_hint: "#fff", effects: [], t_start_us: startUs, t_end_us: startUs + 5_000_000,
    params: { kind: "Audio", media_id: "media", media_label: "tone.wav",
      src_in_us: 0, src_out_us: 5_000_000, gain_db: { mode: "Static", value: 0 },
      pan: { mode: "Static", value: 0 }, fade_in_us: 0, fade_out_us: 0,
      mute: false, role: "dialogue" },
  };
  const track: TrackSummary = { id: "track", label: "Audio", kind: "Audio",
    enabled: true, locked: false, muted: false, solo: false, role: "audio-a",
    transient: false, layers: [layer] };
  const summary = summaryFixture({ root: { duration_us: 10_000_000, tracks: [track] } });
  const source = { url: "weftcut-media://tone.conform" as string | null };
  const engine = new PreviewAudioEngine(graph, () => source.url);
  engine.setProject(summary, ROOT_ID);
  return { engine, ctx, sources, summary, graph, source, layer, track };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
afterEach(() => { reads.gate = null; reads.opens = []; reads.windows = []; reads.failOpen = false; vi.useRealTimers(); });

describe("session-owned preview audio transport", () => {
  it("starts and pauses real mixers without a visual ticker; pause stops synchronously", async () => {
    const { engine, sources } = setup();
    engine.play();
    expect(engine.snapshot().phase).toBe("preparing");
    await settle();
    expect(engine.snapshot().phase).toBe("playing");
    expect(sources.length).toBeGreaterThan(0);
    engine.pause();
    expect(sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
    expect(engine.snapshot().phase).toBe("paused");
    engine.dispose();
  });

  it("holds the clock until PCM is ready and never resurrects a cancelled play", async () => {
    let release!: () => void;
    reads.gate = new Promise<void>((r) => { release = r; });
    const { engine, ctx, sources } = setup();
    engine.play();
    await settle();
    ctx.currentTime += 1;
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.positionUs()).toBe(0);
    engine.pause();
    release();
    await settle();
    expect(sources).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("paused");
    engine.dispose();
  });

  it("pre-schedules an upcoming clip before its boundary", async () => {
    const { engine, ctx, sources } = setup(1_000_000);
    engine.play();
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]!.start.mock.calls[0]![0]).toBeGreaterThan(ctx.currentTime + 0.9);
    engine.dispose();
  });

  it("unrelated project updates neither restart pending reads nor extend the preparation deadline", async () => {
    let release!: () => void;
    reads.gate = new Promise<void>((r) => { release = r; });
    const { engine, summary } = setup();
    engine.play(); await settle();
    const windows = reads.windows.length;
    await vi.advanceTimersByTimeAsync(9_000);
    engine.setProject({ ...summary, name: "renamed" }, ROOT_ID); await settle();
    expect(reads.windows).toHaveLength(windows);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(engine.snapshot().phase).toBe("error");
    release(); await settle();
    engine.dispose();
  });

  it("seek and project replacement invalidate pending reads", async () => {
    let release!: () => void;
    reads.gate = new Promise<void>((r) => { release = r; });
    const { engine, sources, summary } = setup();
    engine.play();
    await settle();
    engine.seek(2_000_000);
    engine.setProject({ ...summary, project_id: "replacement" }, ROOT_ID);
    release();
    await settle();
    expect(sources).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("paused");
    expect(engine.positionUs()).toBe(0);
    engine.dispose();
  });

  it("reports resume failures instead of claiming playback", async () => {
    const { engine, graph, sources } = setup();
    vi.mocked(graph.resume).mockRejectedValueOnce(new Error("device unavailable"));
    engine.play();
    await settle();
    expect(engine.snapshot().phase).toBe("error");
    expect(engine.snapshot().error).toContain("device unavailable");
    expect(sources).toHaveLength(0);
    engine.dispose();
  });

  it("retries a failed conform open on the next Play", async () => {
    reads.failOpen = true;
    const { engine } = setup();
    engine.play(); await settle();
    expect(engine.snapshot().phase).toBe("error");
    reads.failOpen = false;
    engine.play(); await settle();
    expect(engine.snapshot().phase).toBe("playing");
    engine.dispose();
  });

  it("keeps preparing while a conform is missing, then starts when it arrives", async () => {
    const { engine, source, summary } = setup();
    source.url = null;
    // Force a new media identity: a transient null for the same source keeps
    // the last known artifact, as it did before the ownership move.
    engine.setProject(null, null);
    engine.setProject(summary, ROOT_ID);
    engine.play(); await settle();
    expect(engine.snapshot().phase).toBe("preparing");
    source.url = "weftcut-media://ready.conform";
    engine.refresh(); await settle();
    expect(engine.snapshot().phase).toBe("playing");
    engine.dispose();
  });

  it("times out preparation, and a late read cannot turn the error into playback", async () => {
    let release!: () => void;
    reads.gate = new Promise<void>((r) => { release = r; });
    const { engine, sources } = setup();
    engine.play(); await settle();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(engine.snapshot().phase).toBe("error");
    release(); await settle();
    expect(sources).toHaveLength(0);
    engine.dispose();
  });

  it("rapid play/pause/play and backward seek leave only the latest schedule audible", async () => {
    const { engine, sources } = setup();
    engine.play(); engine.pause(); engine.play(); await settle();
    const beforeSeek = [...sources];
    engine.seek(2_000_000); await settle();
    engine.seek(0); await settle();
    expect(engine.snapshot().phase).toBe("playing");
    expect(beforeSeek.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    const audible = sources.filter((s) => s.stop.mock.calls.length === 0);
    expect(audible.length).toBeGreaterThan(0);
    expect(audible.length).toBeLessThanOrEqual(4);
    engine.pause();
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    engine.dispose();
  });

  it("keeps unchanged artifacts, applies parameter edits and swaps a bake exactly once", async () => {
    const { engine, sources, source, summary, layer } = setup();
    engine.play(); await settle();
    engine.setProject({ ...summary, name: "renamed" }, ROOT_ID); await settle();
    expect(reads.opens).toHaveLength(1);
    if (layer.params.kind !== "Audio") throw new Error("fixture");
    layer.params = { ...layer.params, gain_db: { mode: "Static", value: -6 } };
    engine.setProject(summary, ROOT_ID); await settle();
    expect(reads.opens).toHaveLength(1);
    const beforeSwap = [...sources];
    source.url = "weftcut-media://baked.conform";
    engine.refresh(); await settle(); engine.refresh(); await settle();
    expect(reads.opens).toEqual(["weftcut-media://tone.conform", "weftcut-media://baked.conform"]);
    expect(beforeSwap.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    source.url = null;
    engine.refresh(); await settle();
    expect(reads.opens).toHaveLength(2);
    engine.dispose();
  });

  it("track/role gating and deleting layers stop scheduled sources on the edit", async () => {
    const { engine, sources, summary, track } = setup();
    engine.play(); await settle();
    track.enabled = false;
    engine.setProject(summary, ROOT_ID);
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    track.enabled = true;
    engine.setProject(summary, ROOT_ID); await settle();
    engine.setProject({ ...summary, audio_roles: [{ role: "dialogue", gain_db: 0, muted: true, solo: true }] }, ROOT_ID);
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    engine.setProject(summary, ROOT_ID); await settle();
    track.layers = [];
    engine.setProject(summary, ROOT_ID);
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    engine.dispose();
  });

  it("advances and stops at the material end without any visual frames", async () => {
    const { engine, ctx, sources } = setup();
    const moments: number[] = [];
    engine.onTimeUpdate((us) => moments.push(us));
    engine.play(); await settle();
    ctx.currentTime += 2;
    await vi.advanceTimersByTimeAsync(32);
    expect(engine.positionUs()).toBeGreaterThan(1_900_000);
    ctx.currentTime += 4;
    await vi.advanceTimersByTimeAsync(32);
    expect(engine.snapshot().phase).toBe("paused");
    expect(engine.positionUs()).toBe(4_966_667);
    expect(moments.every((us) => us <= 4_966_667)).toBe(true);
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    engine.dispose();
  });

  it("schedules two placements of a trimmed Group independently, before either is drawn", async () => {
    const { engine, sources, summary, layer, track, ctx } = setup();
    engine.setProject(null, null);
    reads.opens = []; reads.windows = [];
    const child = compositionFixture({ id: "child", tracks: [{ ...track, layers: [layer] }] });
    const stat = (value: number) => ({ mode: "Static" as const, value });
    const ref = (id: string, start: number): LayerSummary => ({
      ...layer, id, kind: "CompositionRef", t_start_us: start, t_end_us: start + 2_000_000,
      params: { kind: "CompositionRef", composition_id: child.id, composition_label: null,
        src_in_us: 1_000_000, src_out_us: 3_000_000, x: stat(0), y: stat(0),
        scale_x: stat(1), scale_y: stat(1), scale_linked: true, rotation_deg: stat(0),
        opacity: stat(1), anchor_x: stat(0.5), anchor_y: stat(0.5) },
    });
    const root = summary.compositions[ROOT_ID]!;
    const grouped = { ...summary, compositions: { [ROOT_ID]: { ...root,
      tracks: [{ ...track, layers: [ref("first", 0), ref("second", 2_000_000)] }] }, child } };
    engine.setProject(grouped, ROOT_ID);
    engine.play(); await settle();
    expect(reads.opens).toHaveLength(2);
    expect(reads.windows).toContain(48_000); // clipped source head = one second
    expect(reads.windows).not.toContain(0);
    const starts = sources.map((s) => s.start.mock.calls[0]![0] as number);
    expect(starts.some((t) => t > 11.9 && t < 12.1)).toBe(true);
    expect(sources).toHaveLength(3); // only the first three seconds are scheduled
    ctx.currentTime += 1;
    await vi.advanceTimersByTimeAsync(16);
    expect(sources).toHaveLength(4); // the second placement's tail is replenished
    engine.dispose();
  });

  it("borrows the monitor for an edit without moving or publishing the Moment", async () => {
    const { engine } = setup();
    const moments: number[] = [];
    engine.onTimeUpdate((us) => moments.push(us));
    engine.seek(500_000);
    engine.seek(2_000_000, "preview");
    expect(engine.positionUs()).toBe(2_000_000);
    expect(moments).toEqual([500_000]);
    engine.play(); await settle();
    expect(engine.positionUs()).toBe(500_000);
    engine.dispose();
  });

  it("surfaces device interruption and permits an explicit resume", async () => {
    const { engine, ctx, sources } = setup();
    engine.play(); await settle();
    ctx.state = "suspended";
    await vi.advanceTimersByTimeAsync(16);
    expect(engine.snapshot().phase).toBe("error");
    expect(sources.every((s) => s.stop.mock.calls.length > 0)).toBe(true);
    ctx.state = "running";
    engine.play(); await settle();
    expect(engine.snapshot().phase).toBe("playing");
    engine.dispose();
  });
});
