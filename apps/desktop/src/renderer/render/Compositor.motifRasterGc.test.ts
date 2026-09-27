// The baked-index hydrate/GC pass is fire-and-forget from `setProject`, and
// PixiPreview calls setProject on EVERY project snapshot — so runs must be
// serialized on a project epoch: a run superseded mid-flight bails at its
// await boundaries (never GCs against a stale snapshot), and exactly one
// coalesced follow-up redoes the work for the latest snapshot. The GC live
// set additionally unions the baker's queued/in-flight target keys, so a hash
// dir a concurrent bake is writing into is never collected.
//
// `document` is stubbed (not a full DOM) so the DOM-gated prewarmer/baker
// exist; `window` is stubbed so the L2 bridge (`frameCache.ts` rasterRootDir)
// resolves — both are otherwise absent under vitest. mode "export" keeps the
// preview-only AudioGraph out of the constructor; the hydrate/GC path is
// mode-independent.

import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const readDirMock = vi.fn();
const removeMock = vi.fn(async (_path: string) => {});
const existsMock = vi.fn();

vi.mock("./motifs/syncCatalog", () => ({ syncUserMotifsFromBackend: vi.fn(async () => {}) }));

import type { DirEntry } from "../../shared/ipc";
import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import type { DecoderPool } from "./decoder/session";
import { Compositor } from "./Compositor";
import { getMotif } from "./motifs/catalog";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import { hashCacheKey } from "./motifs/frameCache";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { summaryFixture } from "../testing/summaryFixture";

const RASTER_ROOT = "/ws/Cache/raster";

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
const K2 = keyFor({ seconds: 7 });

const dirEntry = (name: string): DirEntry => ({
  name,
  isDirectory: true,
  isFile: false,
  isSymlink: false,
});

describe("Compositor baked-index hydrate/GC epoch serialization", () => {
  let compositor: Compositor;
  let idle: Array<() => void>;
  /// When true, the FIRST readDir of the test never resolves until released —
  /// that is run #1 parked mid-hydrate, the overlap window under test.
  let deferFirstReadDir: boolean;
  let releaseFirstReadDir: ((entries: DirEntry[]) => void) | null;
  let readDirCalls: number;
  let entries: DirEntry[];

  beforeEach(() => {
    vi.stubGlobal("document", {});
    // The real bridge modules (bridge/fs, bridge/path, bridge/ipc) all call
    // `window.api.*` — stub that one object instead of mocking the modules
    // (dynamic import() of a mocked alias module proved racy under vitest).
    vi.stubGlobal("window", {
      api: {
        backend: { invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) },
        path: { join: (parts: string[]) => Promise.resolve(parts.join("/")) },
        fs: {
          readDir: (p: string) => readDirMock(p),
          exists: (p: string) => existsMock(p),
          remove: (p: string) => removeMock(p),
          readFile: vi.fn(),
          mkdir: vi.fn(async () => {}),
          writeFile: vi.fn(async () => {}),
          writeTextFile: vi.fn(async () => {}),
        },
      },
    });
    idle = [];
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idle.push(cb);
      return idle.length;
    });
    vi.stubGlobal("cancelIdleCallback", () => {});
    deferFirstReadDir = false;
    releaseFirstReadDir = null;
    readDirCalls = 0;
    entries = [];
    invokeMock.mockReset().mockImplementation((cmd: string) => {
      if (cmd === "workspace_dir") return Promise.resolve("/ws");
      // The capture never resolves: the baker's frame stays in flight, which is
      // exactly the concurrent-write window the GC live set must protect.
      if (cmd === "motif_capture_frame") return new Promise(() => {});
      return Promise.resolve(null);
    });
    removeMock.mockClear();
    existsMock.mockReset().mockImplementation(async (p: string) => p === RASTER_ROOT);
    readDirMock.mockReset().mockImplementation(() => {
      readDirCalls += 1;
      if (readDirCalls === 1 && deferFirstReadDir) {
        return new Promise((r) => {
          releaseFirstReadDir = r;
        });
      }
      return Promise.resolve(entries);
    });
    // Pre-bake on, so setProject hands the motif layer to the baker.
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, prebake_motifs: true },
    }));
    compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "export",
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
    });
  });

  afterEach(() => {
    compositor.dispose();
    vi.unstubAllGlobals();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, prebake_motifs: false },
    }));
  });

  it("a settled run GCs orphans and keeps live keys", async () => {
    entries = [dirEntry(hashCacheKey(K1)), dirEntry("deadbeef")];
    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    expect(removeMock).toHaveBeenCalledWith(`${RASTER_ROOT}/deadbeef`);
  });

  it("a superseded run never GCs; the follow-up protects the baker's in-flight key", async () => {
    deferFirstReadDir = true;
    // On "disk": K1's dir (being written by the in-flight bake), K2's dir, and
    // an orphan. K1 is NOT in snapshot B's active keys — only the baker's
    // in-flight target set keeps it alive.
    entries = [dirEntry(hashCacheKey(K1)), dirEntry(hashCacheKey(K2)), dirEntry("deadbeef")];

    compositor.setProject(summaryWith({ seconds: 5 }));
    // Run #1 is parked inside listBakedHashes.
    await vi.waitFor(() => expect(readDirCalls).toBe(1));

    // Start the L2 bake: the baker pulls (K1, frame 0), its render never
    // resolves, so K1 stays an in-flight target for the rest of the test.
    for (const cb of idle.splice(0)) cb();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", expect.anything()),
    );

    // A newer snapshot (props changed → K2) supersedes run #1 and arms one
    // follow-up.
    compositor.setProject(summaryWith({ seconds: 7 }));
    releaseFirstReadDir!(entries);

    await vi.waitFor(() => expect(removeMock).toHaveBeenCalled());
    // Exactly the orphan, exactly once: run #1 bailed on the stale epoch
    // without GC'ing, and run #2's live set kept both K1 (in-flight bake) and
    // K2 (active layer).
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(`${RASTER_ROOT}/deadbeef`);
  });

  it("multiple setProjects during a run arm exactly one coalesced follow-up", async () => {
    deferFirstReadDir = true;
    entries = [dirEntry("deadbeef")];

    compositor.setProject(summaryWith({ seconds: 5 }));
    await vi.waitFor(() => expect(readDirCalls).toBe(1));
    compositor.setProject(summaryWith({ seconds: 7 }));
    compositor.setProject(summaryWith({ seconds: 9 }));
    releaseFirstReadDir!(entries);

    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    // Settle, then count: run #1's parked readDir + ONE follow-up's
    // (listBakedHashes + gcUnreferenced). Without coalescing, each setProject
    // would have added its own run (two more readDir pairs).
    await new Promise((r) => setTimeout(r, 10));
    expect(readDirCalls).toBe(3);
  });
});
