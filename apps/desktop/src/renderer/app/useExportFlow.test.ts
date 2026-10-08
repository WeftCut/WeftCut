// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
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
  emit: vi.fn(async () => {}),
}));

vi.mock("@/bridge/path", () => ({
  join: async (...parts: string[]) => parts.join("/"),
  tempDir: async () => "/tmp",
}));

vi.mock("@/bridge/window", () => ({
  ProgressBarStatus: { None: 0, Normal: 1, Error: 2 },
  SecondaryWindow: class {},
  getCurrentWindow: () => ({
    onCloseRequested: () => () => {},
    isFocused: async () => true,
    setProgressBar: async () => {},
    setTitle: async () => {},
  }),
}));

vi.mock("@/bridge/notification", () => ({
  isPermissionGranted: async () => false,
  requestPermission: async () => "denied",
  sendNotification: () => {},
}));

vi.mock("@/bridge/fs", () => ({
  remove: vi.fn(async () => {}),
  writeFile: async () => {},
}));

vi.mock("@/bridge/shell", () => ({ reveal: async () => {} }));

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

import { useExportFlow } from "./useExportFlow";

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

function mount(previewRef = createRef<PreviewSurfaceHandle>()) {
  return renderHook(() =>
    useExportFlow({
      previewRef,
      proxyStateRef: { current: new Map() },
      decodeProbeMemo: { current: new Map() },
    }),
  );
}

describe("useExportFlow", () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', { configurable: true, value: { resources: {
      planExport: vi.fn(async () => 0), onExportWaiting: () => () => {}, release: vi.fn(),
    } } });
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

  it("retains encoded files after mux failure and retries only mux, then cleans up", async () => {
    const project = summary([track("track-v", "Video", [COLOR_LAYER])]);
    const { useProjectStore } = await import("../state/projectStore");
    const { remove } = await import("@/bridge/fs");
    vi.mocked(remove).mockClear();
    act(() => useProjectStore.getState().apply(project));
    bridge.answers.set("project_summary", () => project);
    const encode = vi.fn(async () => ({ framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 }));
    const previewRef = createRef<PreviewSurfaceHandle>();
    previewRef.current = { suspendForExport: () => () => {}, runPixiExport: encode } as unknown as PreviewSurfaceHandle;
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
    previewRef.current = { suspendForExport: () => () => {}, runPixiExport: encode } as unknown as PreviewSurfaceHandle;
    const { result } = mount(previewRef);
    const settings = { ...DEFAULT_EXPORT_SETTINGS, encoderEngine: "native" as const, includeVideo: true,
      audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: true } };
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
});
