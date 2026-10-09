// Compositor integration with main-owned Motif preparation. Disk discovery and
// GC races are exercised at their owning seam in main/motif/{baking,bakeWorkspace}.test.ts.
import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import type { DecoderPool } from "./decoder/session";
import { Compositor } from "./Compositor";
import { getMotif } from "./motifs/catalog";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import { sharedBakedKeyIndex } from "./motifs/motifRasterCache";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useMotifBakeStatusStore, setLayerBakeStatuses } from "../timeline/motifBakeStatusStore";
import { summaryFixture } from "../testing/summaryFixture";
import type { MotifBakePlan, MotifBakeSnapshot } from '../../shared/motifs/baking';

const { warm, stopWarm } = vi.hoisted(() => ({ warm: vi.fn(), stopWarm: vi.fn() }));
vi.mock('./motifs/MotifPrewarmer', () => ({ MotifPrewarmer: class { setTargets = warm; dispose = stopWarm; } }));
vi.mock("./motifs/syncCatalog", () => ({ syncUserMotifsFromBackend: vi.fn(async () => {}) }));

function motifLayer(props: Record<string, unknown>): LayerSummary {
  return {
    id: "layer-motif",
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "Motif",
    color_hint: "#8a94a0",
    enabled: true,
    locked: false,
    effects: [],
    params: { kind: "Motif", motif_id: "countdown", src_in_us: 0, props },
  } as unknown as LayerSummary;
}

function summaryWith(props: Record<string, unknown>): ProjectSummary {
  const track: TrackSummary = {
    id: "track-1",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers: [motifLayer(props)],
  };
  return summaryFixture({
    project_id: "project-1",
    root: { fps_num: 30, fps_den: 1, duration_us: 2_000_000, tracks: [track] },
  });
}

/// The L2 cacheKeys the two snapshots produce (props differ → hashes differ),
/// computed through the same descriptor the Compositor uses.
const motif = getMotif("countdown")!;
const keyFor = (props: Record<string, unknown>): string =>
  motifFrameDescriptor({ props, src_in_us: 0 }, 0, 2_000_000, 30, 1, motif)!.cacheKey;
const K1 = keyFor({ seconds: 5 });

describe('Compositor delegates durable Motif preparation to main', () => {
  let compositor: Compositor;
  let projectId: string | null;
  let snapshot: MotifBakeSnapshot;
  let invoke: ReturnType<typeof vi.fn>;
  let on: ReturnType<typeof vi.fn>;
  let off: ReturnType<typeof vi.fn>;
  let fsRead: ReturnType<typeof vi.fn>;
  let fsRemove: ReturnType<typeof vi.fn>;

  const create = () => new Compositor({
    app: { stage: new Container() } as unknown as Application,
    width: 1920, height: 1080, mode: 'export',
    originalAssetUrl: () => null, sourceColor: () => undefined, mediaById: () => undefined,
    pool: { dispose: vi.fn() } as unknown as DecoderPool,
  });
  const plans = () => invoke.mock.calls.filter(([command]) => command === 'motif_bake_reconcile')
    .map(([, args]) => args.plan as MotifBakePlan);

  beforeEach(() => {
    vi.clearAllMocks();
    sharedBakedKeyIndex.clear();
    setLayerBakeStatuses({});
    projectId = 'project-1';
    snapshot = { generation: 1, statuses: {}, coverage: {} };
    off = vi.fn(); on = vi.fn(() => off); fsRead = vi.fn(); fsRemove = vi.fn();
    invoke = vi.fn(async command => {
      if (command === 'motif_bake_session') return { generation: 1, projectId };
      if (command === 'motif_bake_reconcile' || command === 'motif_bake_snapshot') return snapshot;
      throw new Error(`Unexpected renderer command: ${command}`);
    });
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', { api: { on, backend: { invoke }, fs: { readDir: fsRead, remove: fsRemove } } });
    useAppSettingsStore.setState(s => ({ settings: { ...s.settings, prebake_motifs: true } }));
    compositor = create();
  });
  afterEach(() => {
    compositor.dispose();
    vi.unstubAllGlobals();
    useAppSettingsStore.setState(s => ({ settings: { ...s.settings, prebake_motifs: false } }));
    sharedBakedKeyIndex.clear();
    setLayerBakeStatuses({});
  });

  it('declares used ranges and restores saved coverage without renderer filesystem work', async () => {
    snapshot.coverage[K1] = Array.from({ length: 150 }, (_, i) => i);
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(useMotifBakeStatusStore.getState().byLayer['layer-motif']?.phase).toBe('ready'));
    expect(plans()).toHaveLength(1);
    expect(plans()[0]?.contents[0]).toMatchObject({ cacheKey: K1, contentFrames: 150, ranges: [{ start: 0, end: 60 }] });
    expect(on).toHaveBeenCalledWith('motif:bake', expect.any(Function));
    expect(on).toHaveBeenCalledWith('motif:bake-ready', expect.any(Function));
    expect(fsRead).not.toHaveBeenCalled(); expect(fsRemove).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => command === 'motif_capture_frame')).toBe(false);
  });

  it('keeps partial restored coverage distinct from a completed manual bake when automatic work is off', async () => {
    useAppSettingsStore.setState(s => ({ settings: { ...s.settings, prebake_motifs: false } }));
    snapshot.coverage[K1] = [0];
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(sharedBakedKeyIndex.hasFrame(K1, 0)).toBe(true));
    expect(plans().at(-1)?.contents).toEqual([]);
    expect(useMotifBakeStatusStore.getState().byLayer['layer-motif']?.phase).not.toBe('ready');
    snapshot = { ...snapshot, coverage: { [K1]: Array.from({ length: 150 }, (_, i) => i) } };
    const callback = on.mock.calls[0]![1] as (value: MotifBakeSnapshot) => void;
    callback(snapshot);
    expect(useMotifBakeStatusStore.getState().byLayer['layer-motif']?.phase).toBe('ready');
  });

  it('does not submit another plan for an unchanged project snapshot', async () => {
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(plans()).toHaveLength(1));
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('motif_bake_snapshot', undefined));
    expect(plans()).toHaveLength(1);
  });

  it('ignores a superseded inventory reply and submits only the latest changed project', async () => {
    let finish!: (snapshot: MotifBakeSnapshot) => void;
    const real = invoke.getMockImplementation() as (command: string, args?: unknown) => Promise<unknown>;
    let first = true;
    invoke.mockImplementation((command, args) => {
      if (command === 'motif_bake_reconcile' && first) {
        first = false;
        return new Promise(resolve => { finish = resolve; });
      }
      return real(command, args);
    });
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(plans()).toHaveLength(1));
    compositor.setProject(summaryWith({ seconds: 7 }));
    compositor.setProject(summaryWith({ seconds: 9 }));
    const latestKey = keyFor({ seconds: 9 });
    snapshot.coverage[latestKey] = [0];
    finish({ generation: 1, coverage: { [K1]: [0] }, statuses: {} });
    await vi.waitFor(() => expect(sharedBakedKeyIndex.hasFrame(latestKey, 0)).toBe(true));
    expect(plans().map(plan => plan.contents[0]?.cacheKey)).toEqual([K1, latestKey]);
    expect(sharedBakedKeyIndex.has(K1)).toBe(false);
  });

  it('detaches on disposal without clearing background demand or accepting late discovery', async () => {
    let finish!: (snapshot: MotifBakeSnapshot) => void;
    invoke.mockImplementation(async command => {
      if (command === 'motif_bake_session') return { generation: 1, projectId };
      return new Promise(resolve => { finish = resolve; });
    });
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(plans()).toHaveLength(1));
    compositor.dispose();
    finish({ generation: 1, coverage: { [K1]: [0] }, statuses: {} });
    await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(2));
    expect(sharedBakedKeyIndex.has(K1)).toBe(false);
    expect(plans()).toHaveLength(1);
    expect(stopWarm).toHaveBeenCalledOnce();
  });

  it('marks unresolved catalog references unsafe for collection', async () => {
    const summary = summaryWith({ seconds: 5 });
    const layer = summary.compositions[summary.root_id]!.tracks[0]!.layers[0]!;
    if (layer.params.kind !== 'Motif') throw new Error('fixture');
    layer.params.motif_id = 'unresolved-package';
    compositor.setProject(summary);
    await vi.waitFor(() => expect(plans()).toHaveLength(1));
    expect(plans()[0]?.collect).toBe(false);
  });

  it('keeps the DOM-less export worker free of background preparation subscriptions', async () => {
    compositor.dispose();
    invoke.mockClear(); on.mockClear();
    vi.stubGlobal('document', undefined);
    compositor = create();
    compositor.setProject(summaryWith({ seconds: 5 }));
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
});
