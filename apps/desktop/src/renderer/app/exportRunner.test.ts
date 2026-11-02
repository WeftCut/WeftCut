// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef, useState, useMemo } from "react";
import type { ExportSettings } from "../render/exportSettings";
import type { ExportState } from "../panels/ExportPanel";
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "../i18n/locales/en-US";
import { DEFAULT_EXPORT_SETTINGS } from "../render/exportSettings";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../ipc";
import type { PreviewSurfaceHandle } from "../preview/PreviewSurface";

// The export's audio-effect gate, at both of the two sites that run it: the
// audio-only path and the full pipeline. Everything the hook reaches is driven
// through the ONE backend seam (`@/bridge/ipc`'s `invoke`, keyed by channel) and
// the event bridge, which is also how the listener-before-command ordering is
// observed. See ADR 0063.

const bridge = vi.hoisted(() => ({
  /// Channel -> answer. A channel with no entry resolves undefined.
  answers: new Map<string, (args: unknown) => unknown>(),
  /// Every backend call and every listener registration, in order.
  log: [] as string[],
  handlers: new Map<string, Array<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@/bridge/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    bridge.log.push(`invoke ${cmd}`);
    return bridge.answers.get(cmd)?.(args);
  }),
  convertFileSrc: (p: string) => `weftcut-media://${p}`,
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    bridge.log.push(`listen ${event}`);
    const list = bridge.handlers.get(event) ?? [];
    list.push(cb);
    bridge.handlers.set(event, list);
    return () => {
      bridge.handlers.set(
        event,
        (bridge.handlers.get(event) ?? []).filter((h) => h !== cb),
      );
    };
  }),
  emit: vi.fn(async () => { }),
}));

vi.mock("@/bridge/path", () => ({
  join: async (...parts: string[]) => parts.join("/"),
  tempDir: async () => "/tmp",
}));

vi.mock("@/bridge/window", () => ({
  ProgressBarStatus: { None: 0, Normal: 1, Error: 2 },
  SecondaryWindow: class { },
  getCurrentWindow: () => ({
    isFocused: async () => true,
    setProgressBar: async () => { },
    setTitle: async () => { },
  }),
}));

vi.mock("@/bridge/notification", () => ({
  isPermissionGranted: async () => false,
  requestPermission: async () => "denied",
  sendNotification: () => { },
}));

vi.mock("@/bridge/fs", () => ({
  remove: vi.fn(async () => { }),
  writeFile: async () => { },
}));

vi.mock("@/bridge/shell", () => ({ reveal: async () => { } }));

/// Resolves the real en-US copy for a dotted key and interpolates it, so the
/// assertions below read the shipped sentence rather than a stand-in.
function translate(key: string, vars?: Record<string, unknown>): string {
  const raw = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      enUS,
    );
  if (typeof raw !== "string") return key;
  return raw.replace(/{{(\w+)}}/g, (_m, name: string) =>
    String(vars?.[name] ?? ""),
  );
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: "en-US" } }),
}));

import { createExportRunner, queuedExportMessage } from "./exportRunner";
import { EXPORT_AUDIO_MIX_MIB } from "../../shared/export-resources";
import { capabilityOf, RendererCannotDrawError, type RendererCapability } from "../render/rendererCapability";

const GPU = capabilityOf("webgpu", true);
const CANVAS = capabilityOf("canvas", false);

const AUDIO_LAYER: LayerSummary = {
  id: "layer-vo",
  label: null,
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Audio",
  color_hint: "#3c7",
  enabled: true,
  locked: false,
  effects: [],
  params: {
    kind: "Audio",
    media_id: "media-1",
    media_label: "vo.wav",
    src_in_us: 0,
    src_out_us: 2_000_000,
    gain_db: { mode: "Static", value: 0 },
    pan: { mode: "Static", value: 0 },
    fade_in_us: 0,
    fade_out_us: 0,
    mute: false,
    role: "dialogue",
  },
};

const COLOR_LAYER: LayerSummary = {
  id: "layer-bg",
  label: null,
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Color",
  color_hint: "#345",
  enabled: true,
  locked: false,
  effects: [],
  params: {
    kind: "Color",
    color: { mode: "Static", value: { r: 10, g: 20, b: 30, a: 255 } },
    width: 1920,
    height: 1080,
  },
};

function track(id: string, kind: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind,
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: kind === "Audio" ? "audio-a" : "a-roll",
    transient: false,
    layers,
  };
}

const DENOISE_FAILED = {
  waiting: [],
  failed: [
    {
      layer_id: "layer-vo",
      effect_id: "effect-1",
      kind: "audio.denoise",
      error: "ffmpeg exited 1",
    },
  ],
};

function summary(tracks: TrackSummary[]) {
  return summaryFixture({
    root: { duration_us: 2_000_000, tracks },
  });
}

function mount(previewRef = createRef<PreviewSurfaceHandle>(), cap: RendererCapability = GPU) {
  let output = '';
  const controller = new AbortController();
  return renderHook(() => {
    const [exportState, setState] = useState<ExportState | null>(null);
    const runner = useMemo(() => createExportRunner({
previewRef, proxyStateRef: { current: new Map() }, decodeProbeMemo: { current: new Map() },
      t: translate as TFunction, onState: setState, cancel: () => controller.abort(), publish: async () => output,
      capability: async () => cap,
}), []);
    return {
exportState, runner, runExportWithSettings: async (settings: ExportSettings, path: string, range?: { startUs: number; endUs: number }) => {
        output = path;
        await runner.run({ job_id: 'test', state: 'preparing', filename: 'out.mp4', renderer_token: 'test', agent: false, settings, range: range ?? { startUs: 0, endUs: 2_000_000 }, output_path: path, staging_path: path, encoded_video_path: '/tmp/video.mp4', encoded_audio_path: '/tmp/audio.m4a' }, controller);
      }
};
  });
}

describe("exportRunner", () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true, value: {
        resources: {
          planExport: vi.fn(async () => 0), onExportWaiting: () => () => { }, release: vi.fn(),
        }
      }
    });
    bridge.answers.clear();
    bridge.log.length = 0;
    bridge.handlers.clear();
    bridge.answers.set("ensure_export_audio_conform", () => []);
    bridge.answers.set("audio_fx_snapshot", () => ({}));
  });

  it.each(['success', 'sink failure', 'worker failure', 'finish failure', 'mux failure'])("keeps preview suspended from sink admission through cleanup: %s", async outcome => {
    const project = summary([track("track-v", "Video", [COLOR_LAYER])]);
    const { useProjectStore } = await import("../state/projectStore");
    act(() => { useProjectStore.getState().apply(project); });
    bridge.answers.set("project_summary", () => project);
    let suspended = false;
    const restore = vi.fn(() => { suspended = false; });
    const previewRef = createRef<PreviewSurfaceHandle>();
    previewRef.current = {
      suspendForExport: () => { suspended = true; return restore; },
      runPixiExport: async () => {
        expect(suspended).toBe(true);
        if (outcome === 'worker failure') throw new Error('worker failed');
        return { framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 };
      },
    } as unknown as PreviewSurfaceHandle;
    bridge.answers.set("export_video_sink_start", () => {
      // Reproduce the CI ledger: 4 retained preview decoders reserve 764 of
      // 921 MiB. The encoder cannot acquire its 192 MiB until preview yields.
      if (!suspended) throw new Error('Resources are busy');
      if (outcome === 'sink failure') throw new Error('encoder failed');
    });
    bridge.answers.set("export_video_sink_finish", () => {
      expect(suspended).toBe(true);
      if (outcome === 'finish failure') throw new Error('finish failed');
    });
    bridge.answers.set("export_video_sink_cancel", () => { expect(suspended).toBe(true); });
    bridge.answers.set("mux_export", () => {
      expect(suspended).toBe(true);
      if (outcome === 'mux failure') throw new Error('mux failed');
    });
    const { result } = mount(previewRef);
    await act(async () => {
      await result.current.runExportWithSettings({
        ...DEFAULT_EXPORT_SETTINGS, encoderEngine: 'native', includeVideo: true,
        audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false },
      }, '/out/movie.mp4');
    });
    expect(bridge.log).toContain('invoke export_video_sink_start');
    expect(result.current.exportState?.kind).toBe(outcome === 'success' ? 'complete' : 'error');
    expect(restore).toHaveBeenCalledOnce();
    expect(suspended).toBe(false);
  });

  it("a mux behind a running derivative reads queued, names it, and returns to finalizing", async () => {
    const project = summary([track("track-v", "Video", [COLOR_LAYER])]);
    const { useProjectStore } = await import("../state/projectStore");
    act(() => useProjectStore.getState().apply(project));
    bridge.answers.set("project_summary", () => project);
    const previewRef = createRef<PreviewSurfaceHandle>();
    previewRef.current = { suspendForExport: () => () => { }, runPixiExport: async () => ({ framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 }) } as unknown as PreviewSurfaceHandle;
    const { result } = mount(previewRef);
    const wait = (payload: unknown) => act(async () => { for (const handler of bridge.handlers.get("export:mux_wait") ?? []) handler({ payload }); });
    const holders = [{ kind: "proxy", media_id: "m-1", mib: 900, threads: 2 }];
    let finishMux: (() => void) | undefined;
    bridge.answers.set("mux_export", () => new Promise<void>((resolve) => { finishMux = resolve; }));
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runExportWithSettings({
        ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native", includeVideo: true,
        audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false },
      }, "/out/movie.mp4");
    });
    await act(async () => { await vi.waitFor(() => expect(finishMux).toBeDefined()); });
    await wait({ waiting: true, holders });
    expect(result.current.exportState).toMatchObject({ kind: "preparing", queued: { reason: "busy", holders }, onCancel: expect.any(Function),
      message: "Waiting for proxy generation to finish; the file is written automatically" });
    await wait({ waiting: false });
    expect(result.current.exportState).toMatchObject({ kind: "finalizing", step: "mux" });
    await act(async () => { finishMux!(); await run; });
    expect(result.current.exportState?.kind).toBe("complete");
    expect(bridge.handlers.get("export:mux_wait") ?? []).toHaveLength(0);
  });

  it("retains encoded files after mux failure and retries only mux, then cleans up", async () => {
    const project = summary([track("track-v", "Video", [COLOR_LAYER])]);
    const { useProjectStore } = await import("../state/projectStore");
    const { remove } = await import("@/bridge/fs");
    vi.mocked(remove).mockClear();
    act(() => useProjectStore.getState().apply(project));
    bridge.answers.set("project_summary", () => project);
    const encode = vi.fn(async () => ({ framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 }));
    const previewRef = createRef<PreviewSurfaceHandle>();
    previewRef.current = { suspendForExport: () => () => { }, runPixiExport: encode } as unknown as PreviewSurfaceHandle;
    const mux = vi.fn().mockRejectedValueOnce(new Error("Resources are busy")).mockResolvedValue(undefined);
    bridge.answers.set("mux_export", mux);
    const { result } = mount(previewRef);
    await act(async () => result.current.runExportWithSettings({
      ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native", includeVideo: true,
      audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false },
    }, "/out/movie.mp4"));
    expect(result.current.exportState).toMatchObject({ kind: "error", onRetry: expect.any(Function) });
    expect(remove).not.toHaveBeenCalled();
    const failed = result.current.exportState;
    if (failed?.kind !== "error" || !("onRetry" in failed)) throw new Error("retry missing");
    await act(async () => { await (failed.onRetry as () => Promise<void>)(); });
    expect(result.current.exportState?.kind).toBe("complete");
    expect(encode).toHaveBeenCalledOnce();
    expect(bridge.log.filter(c => c === "invoke export_video_sink_start")).toHaveLength(1);
    expect(mux).toHaveBeenCalledTimes(2);
    expect(mux.mock.calls[0]).toEqual(mux.mock.calls[1]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("prepares audio once before video and preserves it through repeated mux failures and discard", async () => {
    const project = summary([track("track-v", "Video", [COLOR_LAYER]), track("track-a", "Audio", [AUDIO_LAYER])]);
    const { useProjectStore } = await import("../state/projectStore");
    const { remove } = await import("@/bridge/fs");
    vi.mocked(remove).mockClear();
    act(() => useProjectStore.getState().apply(project));
    bridge.answers.set("project_summary", () => project);
    bridge.answers.set("ensure_export_audio_fx", () => ({ waiting: [], failed: [] }));
    const audio = vi.fn(() => true);
    bridge.answers.set("export_project_audio_only", audio);
    const encode = vi.fn(async () => {
      expect(audio).toHaveBeenCalledOnce();
      return { framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 };
    });
    const mux = vi.fn().mockRejectedValue(new Error("disk full"));
    bridge.answers.set("mux_export", mux);
    const previewRef = createRef<PreviewSurfaceHandle>();
    previewRef.current = { suspendForExport: () => () => { }, runPixiExport: encode } as unknown as PreviewSurfaceHandle;
    const { result } = mount(previewRef);
    const settings = {
      ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native" as const, includeVideo: true,
      audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: true }
    };
    await act(async () => result.current.runExportWithSettings(settings, "/out/movie.mp4"));
    const failed = result.current.exportState;
    if (failed?.kind !== "error" || !failed.onRetry || !failed.onDiscard) throw new Error("retry missing");
    await act(async () => { await failed.onRetry!(); });
    await act(async () => { await result.current.runExportWithSettings(settings, "/out/other.mp4"); });
    expect(encode).toHaveBeenCalledOnce();
    expect(audio).toHaveBeenCalledOnce();
    expect(mux).toHaveBeenCalledTimes(2);
    expect(mux.mock.calls[0]![0]).toMatchObject({ audioRequired: true });
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { await failed.onDiscard!(); });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(result.current.exportState).toBeNull();
    await act(async () => { await failed.onRetry!(); });
    expect(mux).toHaveBeenCalledTimes(2);
  });

  it("gates the audio-only export and names the layer and the effect", async () => {
    bridge.answers.set("project_summary", () =>
      summary([track("track-a", "Audio", [AUDIO_LAYER])]),
    );
    bridge.answers.set("ensure_export_audio_fx", () => DENOISE_FAILED);
    const { result } = mount();

    await act(async () => {
      await result.current.runExportWithSettings(
        { ...DEFAULT_EXPORT_SETTINGS, includeVideo: false, includeAudio: true },
        "/out/mix.m4a",
      );
    });

    await waitFor(() => {
      expect(result.current.exportState).toEqual({
        kind: "error",
        detail: 'audio effect "Denoise" on "vo.wav": ffmpeg exited 1',
      });
    });
    // Failures never fall back to the raw conform (spec Decision 9): the mix
    // must not run at all.
    expect(bridge.log).not.toContain("invoke export_project_audio_only");
  });

  // A bake completing between the command and the registration would never be
  // seen, and the wait would hang.
  it("registers the status listener before asking for the gate", async () => {
    bridge.answers.set("project_summary", () =>
      summary([track("track-a", "Audio", [AUDIO_LAYER])]),
    );
    bridge.answers.set("ensure_export_audio_fx", () => DENOISE_FAILED);
    const { result } = mount();

    await act(async () => {
      await result.current.runExportWithSettings(
        { ...DEFAULT_EXPORT_SETTINGS, includeVideo: false, includeAudio: true },
        "/out/mix.m4a",
      );
    });

    const listenAt = bridge.log.lastIndexOf("listen audio_fx:status");
    const ensureAt = bridge.log.indexOf("invoke ensure_export_audio_fx");
    expect(listenAt).toBeGreaterThanOrEqual(0);
    expect(ensureAt).toBeGreaterThan(listenAt);
  });

  // The full pipeline runs the same gate after its own conform wait; the error
  // stops it before a single frame is encoded.
  it("gates the full export too", async () => {
    bridge.answers.set("project_summary", () =>
      summary([
        track("track-v", "Video", [COLOR_LAYER]),
        track("track-a", "Audio", [AUDIO_LAYER]),
      ]),
    );
    bridge.answers.set("ensure_export_audio_fx", () => DENOISE_FAILED);
    const { result } = mount();
    // The video path reads the store, not the command, for its own gate.
    const { useProjectStore } = await import("../state/projectStore");
    act(() => {
      useProjectStore
        .getState()
        .apply(
          summary([
            track("track-v", "Video", [COLOR_LAYER]),
            track("track-a", "Audio", [AUDIO_LAYER]),
          ]),
        );
    });

    await act(async () => {
      await result.current.runExportWithSettings(
        { ...DEFAULT_EXPORT_SETTINGS, includeVideo: true, includeAudio: true },
        "/out/movie.mp4",
      );
    });

    await waitFor(() => {
      expect(result.current.exportState).toEqual({
        kind: "error",
        detail: 'audio effect "Denoise" on "vo.wav": ffmpeg exited 1',
      });
    });
    expect(bridge.log).toContain("invoke ensure_export_audio_conform");
    expect(bridge.log).not.toContain("invoke export_video_sink_start");
  });

  // Issue 21: right after import a quick proxy holds the only CPU slot. A
  // fresh audio claim waited 15 s behind it and failed the export busy; the
  // mix must instead run under the export's admitted plan.
  describe("the audio mix borrows the export's admitted plan", () => {
    function recordPlans() {
      const plans: Array<{ id: string; options: number[] }> = [];
      const waiters = new Set<(event: { id: string } & Record<string, unknown>) => void>();
      let admit = () => { };
      const held = new Promise<void>((resolve) => { admit = resolve; });
      Object.assign(window.api.resources, {
        onExportWaiting: (cb: (event: { id: string } & Record<string, unknown>) => void) => { waiters.add(cb); return () => waiters.delete(cb); },
        planExport: vi.fn(async (request: { id: string; options: number[] }) => {
          plans.push(request);
          bridge.log.push(`plan ${request.options.join(",")}`);
          return 0;
        }),
      });
      /// The next plan request blocks, queued behind a quick proxy, until `admit`.
      const blockNext = () => {
        vi.mocked(window.api.resources.planExport).mockImplementationOnce(async (request: { id: string; options: number[] }) => {
          plans.push(request);
          bridge.log.push(`plan ${request.options.join(",")}`);
          for (const cb of waiters) cb({ id: request.id, kind: "blocked", reason: "busy", requestedMiB: request.options[0]!, availableMiB: 0, workMiB: 512, revision: 1,
            holders: [{ kind: "quick_proxy", media_id: "media-2", mib: 128, threads: 1 }] });
          await held;
          return 0;
        });
      };
      return { plans, blockNext, admit: () => admit() };
    }

    it("mixes a full export's audio under its working-set plan, after admission", async () => {
      const project = summary([track("track-v", "Video", [COLOR_LAYER]), track("track-a", "Audio", [AUDIO_LAYER])]);
      const { useProjectStore } = await import("../state/projectStore");
      act(() => useProjectStore.getState().apply(project));
      bridge.answers.set("project_summary", () => project);
      bridge.answers.set("ensure_export_audio_fx", () => ({ waiting: [], failed: [] }));
      const audio = vi.fn((_args: unknown) => true);
      bridge.answers.set("export_project_audio_only", audio);
      const { plans } = recordPlans();
      const previewRef = createRef<PreviewSurfaceHandle>();
      previewRef.current = { suspendForExport: () => () => { }, runPixiExport: async () => ({ framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 }) } as unknown as PreviewSurfaceHandle;
      const { result } = mount(previewRef);
      await act(async () => result.current.runExportWithSettings({
        ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native", includeVideo: true,
        audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: true },
      }, "/out/movie.mp4"));
      expect(result.current.exportState?.kind).toBe("complete");
      expect(audio).toHaveBeenCalledOnce();
      const workingSet = plans.at(-1)!;
      expect(audio.mock.calls[0]![0]).toMatchObject({ finalizationToken: workingSet.id });
      expect(bridge.log.indexOf(`plan ${workingSet.options.join(",")}`)).toBeLessThan(bridge.log.indexOf("invoke export_project_audio_only"));
      expect(Math.min(...workingSet.options)).toBeGreaterThanOrEqual(EXPORT_AUDIO_MIX_MIB);
    });

    it("queues an audio-only export for its plan, then mixes under it", async () => {
      bridge.answers.set("project_summary", () => summary([track("track-a", "Audio", [AUDIO_LAYER])]));
      bridge.answers.set("ensure_export_audio_fx", () => ({ waiting: [], failed: [] }));
      const audio = vi.fn((_args: unknown) => true);
      bridge.answers.set("export_project_audio_only", audio);
      const { plans, blockNext, admit } = recordPlans();
      blockNext();
      const { result } = mount();
      let run!: Promise<void>;
      act(() => { run = result.current.runExportWithSettings({ ...DEFAULT_EXPORT_SETTINGS, includeVideo: false, includeAudio: true }, "/out/mix.m4a"); });
      await waitFor(() => expect(result.current.exportState).toMatchObject({
        kind: "preparing", queued: { reason: "busy", holders: [{ kind: "quick_proxy" }] },
        message: "Waiting for proxy generation to finish; the export starts automatically",
      }));
      expect(audio).not.toHaveBeenCalled();
      await act(async () => { admit(); await run; });
      expect(plans).toEqual([expect.objectContaining({ options: [EXPORT_AUDIO_MIX_MIB] })]);
      expect(audio.mock.calls[0]![0]).toMatchObject({ finalizationToken: plans[0]!.id });
      expect(window.api.resources.release).toHaveBeenCalledWith(plans[0]!.id);
      expect(result.current.exportState?.kind).toBe("complete");
    });
  });

  it("lets an export with nothing to bake through the gate", async () => {
    bridge.answers.set("project_summary", () =>
      summary([track("track-a", "Audio", [AUDIO_LAYER])]),
    );
    bridge.answers.set("ensure_export_audio_fx", () => ({
      waiting: [],
      failed: [],
    }));
    bridge.answers.set("export_project_audio_only", () => true);
    const { result } = mount();

    await act(async () => {
      await result.current.runExportWithSettings(
        { ...DEFAULT_EXPORT_SETTINGS, includeVideo: false, includeAudio: true },
        "/out/mix.m4a",
      );
    });

    await waitFor(() => {
      expect(result.current.exportState?.kind).toBe("complete");
    });
  });

  // `ROOT_ID` is what the gate windows against, so a fixture that lost the root
  // would silently gate an empty range instead.
  it("windows the gate over the whole root composition", async () => {
    const calls: unknown[] = [];
    bridge.answers.set("project_summary", () =>
      summary([track("track-a", "Audio", [AUDIO_LAYER])]),
    );
    bridge.answers.set("ensure_export_audio_fx", (args) => {
      calls.push(args);
      return DENOISE_FAILED;
    });
    const { result } = mount();

    await act(async () => {
      await result.current.runExportWithSettings(
        { ...DEFAULT_EXPORT_SETTINGS, includeVideo: false, includeAudio: true },
        "/out/mix.m4a",
      );
    });

    expect(calls).toEqual([{ startUs: 0, endUs: 2_000_000 }]);
    expect(summary([]).compositions[ROOT_ID]).toBeDefined();
  });

  // Spec D1 on a host without WebGPU or WebGL2: the canvas fallback draws no
  // effects, so a frame that holds one is refused with the typed reason, and a
  // plain frame renders as before.
  describe("on the canvas renderer", () => {
    const DARK: LayerSummary = { ...COLOR_LAYER, id: "layer-dark", t_start_us: 1_000_000, effects: [{ id: "fx-1", kind: "brightness", enabled: true, params: {} }] };
    const CROPPED: LayerSummary = { ...COLOR_LAYER, id: "layer-crop", kind: "VideoClip", t_start_us: 1_000_000, params: { kind: "VideoClip", crop: { x: 0.1, y: 0, w: 0.9, h: 1 } } as never };
    type RunOpts = { startUs: number; encoderConfig: VideoEncoderConfig; nativeSinkPixFmt?: string; stills?: { width: number; effects?: boolean }; onStill?: (s: { width: number; height: number; jpeg: ArrayBuffer }) => void };
    function stillsPreview(rendered: number[], runs: RunOpts[] = []) {
      const previewRef = createRef<PreviewSurfaceHandle>();
      previewRef.current = {
        suspendForExport: () => () => { },
        runPixiExport: async (opts: RunOpts) => {
          rendered.push(opts.startUs);
          runs.push(opts);
          opts.onStill?.({ width: 640, height: 360, jpeg: new ArrayBuffer(4) });
          return { framesEncoded: 1, totalFrames: 1, fpsNum: 30, fpsDen: 1 };
        },
      } as unknown as PreviewSurfaceHandle;
      return previewRef;
    }
    async function load(project: ReturnType<typeof summary>) {
      const { useProjectStore } = await import("../state/projectStore");
      act(() => { useProjectStore.getState().apply(project); });
      bridge.answers.set("project_summary", () => project);
    }

    it("render_frames refuses a frame with an effect layer, before rendering any", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK])]));
      const rendered: number[] = [];
      const { result } = mount(stillsPreview(rendered), CANVAS);
      const err = await result.current.runner.runStills({ times_us: [500_000, 1_500_000], width: 640, settings: DEFAULT_EXPORT_SETTINGS }, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RendererCannotDrawError);
      // Effects are all it lacks, so the refusal offers to look without them.
      expect((err as RendererCannotDrawError).fault).toEqual({
        error: "RendererCannotDraw", renderer: "canvas", missing: ["effects"], layer_ids: ["layer-dark"], needs: "WebGPU or WebGL2", t_us: [1_500_000],
        options: [{ action: "render_without_effects", tool: "render_frames", without: ["effects"] }],
      });
      expect((err as Error).message).toContain("layer-dark");
      expect((err as Error).message).toContain('without: ["effects"]');
      expect(rendered).toEqual([]);
    });

    it("render_frames without effects draws with effects off and marks the frames that held one", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK])]));
      const rendered: number[] = [];
      const runs: RunOpts[] = [];
      const { result } = mount(stillsPreview(rendered, runs), CANVAS);
      const frames = await result.current.runner.runStills({ times_us: [500_000, 1_500_000], width: 640, settings: DEFAULT_EXPORT_SETTINGS, without: ["effects"] }, new AbortController().signal);
      expect(rendered).toEqual([500_000, 1_500_000]);
      expect(runs.map((r) => r.stills)).toEqual([{ width: 640, effects: false }, { width: 640, effects: false }]);
      expect(frames.map((f) => [f.t_us, f.omitted])).toEqual([[500_000, undefined], [1_500_000, ["effects"]]]);
    });

    it("render_frames without effects still refuses a crop, and offers no without", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK]), track("track-c", "Video", [CROPPED])]));
      for (const without of [["effects" as const], undefined]) {
        const rendered: number[] = [];
        const { result } = mount(stillsPreview(rendered), CANVAS);
        const err = await result.current.runner.runStills({ times_us: [1_500_000], width: 640, settings: DEFAULT_EXPORT_SETTINGS, ...(without ? { without } : {}) }, new AbortController().signal).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RendererCannotDrawError);
        const fault = (err as RendererCannotDrawError).fault;
        expect(fault).toMatchObject({ error: "RendererCannotDraw", missing: without ? ["crop"] : ["effects", "crop"] });
        expect(fault).not.toHaveProperty("options");
        expect((err as Error).message).not.toContain("without:");
        expect(rendered).toEqual([]);
      }
    });

    it("render_frames without effects on a GPU host still skips them, labelled", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK])]));
      const runs: RunOpts[] = [];
      const { result } = mount(stillsPreview([], runs), GPU);
      const frames = await result.current.runner.runStills({ times_us: [1_500_000], width: 640, settings: DEFAULT_EXPORT_SETTINGS, without: ["effects"] }, new AbortController().signal);
      expect(runs[0]!.stills).toEqual({ width: 640, effects: false });
      expect(frames[0]!.omitted).toEqual(["effects"]);
    });

    it("render_frames renders a plain frame", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK])]));
      const rendered: number[] = [];
      const runs: RunOpts[] = [];
      const { result } = mount(stillsPreview(rendered, runs), CANVAS);
      const frames = await result.current.runner.runStills({ times_us: [500_000], width: 640, settings: DEFAULT_EXPORT_SETTINGS }, new AbortController().signal);
      expect(frames.map((f) => f.t_us)).toEqual([500_000]);
      expect(frames[0]).not.toHaveProperty("omitted");
      expect(rendered).toEqual([500_000]);
      expect(runs[0]!.stills).toEqual({ width: 640 });
    });

    it("an export whose range holds an effect fails before encoding, typed", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER, DARK])]));
      const { result } = mount(stillsPreview([]), CANVAS);
      await act(async () => {
        await result.current.runExportWithSettings({ ...DEFAULT_EXPORT_SETTINGS, includeVideo: true, audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false } }, "/out/movie.mp4");
      });
      expect(result.current.exportState).toMatchObject({ kind: "error", code: "renderer_cannot_draw", fault: { error: "RendererCannotDraw", layer_ids: ["layer-dark"] } });
      expect(bridge.log).not.toContain("invoke export_video_sink_start");
    });

    it("an auto export without WebGL encodes with WebCodecs, not the native sink", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER])]));
      const runs: RunOpts[] = [];
      const { result } = mount(stillsPreview([], runs), CANVAS);
      await act(async () => {
        await result.current.runExportWithSettings({ ...DEFAULT_EXPORT_SETTINGS, codec: "h264", includeVideo: true, audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false } }, "/out/movie.mp4");
      });
      expect(bridge.log).not.toContain("invoke export_video_sink_start");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.nativeSinkPixFmt).toBeUndefined();
      expect(runs[0]!.encoderConfig.codec).toMatch(/^avc1\./);
      await waitFor(() => expect(result.current.exportState?.kind).toBe("complete"));
    });

    it("a native pin without WebGL fails naming encoder_engine", async () => {
      await load(summary([track("track-v", "Video", [COLOR_LAYER])]));
      const { result } = mount(stillsPreview([]), CANVAS);
      await act(async () => {
        await result.current.runExportWithSettings({ ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native", includeVideo: true, audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false } }, "/out/movie.mp4");
      });
      expect(result.current.exportState).toMatchObject({ kind: "error", code: "encoder_unavailable", fault: { error: "EncoderUnavailable", option: "encoder_engine" } });
      expect((result.current.exportState as { detail: string }).detail).toContain("encoder_engine");
    });
  });
});

describe("queued export message", () => {
  const block = { kind: "blocked", reason: "busy", requestedMiB: 800, availableMiB: 100, workMiB: 1024, revision: 1 } as const;
  const t = translate as unknown as TFunction;
  it("names the largest holder it knows, waiting without a deadline", () => {
    expect(queuedExportMessage(t, { ...block, holders: [{ kind: "proxy", media_id: "m-1", mib: 900, threads: 1 }] }))
      .toBe("Waiting for proxy generation to finish; the export starts automatically");
    expect(queuedExportMessage(t, { ...block, holders: [{ kind: "editor", mib: 900, threads: 1 }, { kind: "waveform", mib: 64, threads: 1 }] }))
      .toBe("Waiting for waveform generation to finish; the export starts automatically");
  });
  it("falls back to other processing, and memory reasons say memory", () => {
    expect(queuedExportMessage(t, block)).toBe(enUS.export.wait_resources);
    expect(queuedExportMessage(t, { ...block, reason: "host-pressure", holders: [{ kind: "proxy", mib: 900, threads: 1 }] })).toBe(enUS.export.wait_memory);
  });
});
