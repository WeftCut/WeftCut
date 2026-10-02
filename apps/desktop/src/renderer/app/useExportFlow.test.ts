// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enUS from "../i18n/locales/en-US";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "../render/exportSettings";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary, MediaSummary } from "../ipc";
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
  removed: [] as string[],
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
  remove: async (path: string) => { bridge.removed.push(path); },
  writeFile: async () => { await bridge.answers.get("fs_write_file")?.({}); },
}));
vi.mock("../render/exportCodecProbe", () => ({ smokeEncode: async () => true }));

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
import { runExportPipeline } from "./runExportPipeline";

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

function mount() {
  return renderHook(() =>
    useExportFlow({
      previewRef: createRef(),
      proxyStateRef: { current: new Map() },
      decodeProbeMemo: { current: new Map() },
    }),
  );
}

describe("useExportFlow audio-effect gate", () => {
  beforeEach(() => {
    bridge.answers.clear();
    bridge.log.length = 0;
    bridge.handlers.clear();
    bridge.answers.set("ensure_export_audio_conform", () => []);
    bridge.answers.set("audio_fx_snapshot", () => ({}));
    // Model main admission and publication through the same backend/event seam.
    // Deliberately deliver run before the start reply: real IPC can do that.
    let nextJob = 0;
    const jobs = new Map<string, Record<string, unknown>>();
    bridge.answers.set("export_job_start", (raw) => {
      const args = raw as Record<string, unknown>;
      const job_id = `test-export-${++nextJob}`;
      const job = { job_id, state: "preparing", ...args };
      jobs.set(job_id, job);
      for (const handler of bridge.handlers.get("export:run") ?? []) handler({ payload: job });
      return job;
    });
    bridge.answers.set("export_job_update", (raw) => {
      const args = raw as Record<string, unknown>;
      const job_id = args.job_id as string;
      const job = { ...jobs.get(job_id), ...args };
      jobs.set(job_id, job);
      return job;
    });

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

describe("shared export pipeline cancellation and cleanup", () => {
  beforeEach(() => {
    bridge.answers.clear();
    bridge.log.length = 0;
    bridge.removed.length = 0;
    bridge.handlers.clear();
    bridge.answers.set("project_summary", () => summary([track("track-v", "Video", [COLOR_LAYER])]));
  });

  function render(runPixiExport: PreviewSurfaceHandle["runPixiExport"], signal = new AbortController().signal, overrides: Partial<ExportSettings> = {}) {
    return runExportPipeline(
      { ...DEFAULT_EXPORT_SETTINGS, ...overrides, includeAudio: false, audio: { ...DEFAULT_EXPORT_SETTINGS.audio, include: false } },
      "/output/.staging.mp4",
      { startUs: 0, endUs: 2_000_000 },
      {
        previewRef: { current: {
          play() {}, pause() {}, seekTo() {}, paused: () => true, refreshSources() {}, runPixiExport,
        } },
        proxyStateRef: { current: new Map() },
        decodeProbeMemo: { current: new Map() },
        signal,
        t: translate,
        onState: vi.fn(),
      },
    );
  }

  const rendered = { framesEncoded: 60, totalFrames: 60, fpsNum: 30, fpsDen: 1 };

  it("cancels an already-aborted request before any backend stage", async () => {
    const abort = new AbortController();
    abort.abort();
    const worker = vi.fn(async () => rendered);
    expect(await render(worker, abort.signal)).toEqual({ state: "cancelled" });
    expect(bridge.log).not.toContain("invoke project_summary");
    expect(worker).not.toHaveBeenCalled();
  });

  it("reaps the native sink and scratch files when the worker rejects", async () => {
    const outcome = await render(async () => { throw new Error("Worker failed."); });
    expect(outcome).toEqual({ state: "failed", error: "Worker failed." });
    expect(bridge.log).toContain("invoke export_video_sink_cancel");
    expect(bridge.removed).toEqual(expect.arrayContaining([
      expect.stringMatching(/weftcut-pixi-.*\.mp4$/),
      expect.stringMatching(/weftcut-pixi-.*\.m4a$/),
    ]));
    expect(bridge.log).not.toContain("invoke mux_export");
  });

  it("never opens a fallback modal for an agent when native encoding fails", async () => {
    const confirm = vi.spyOn(window, "confirm");
    bridge.answers.set("export_video_sink_start", () => { throw new Error("Encoder unavailable."); });
    const outcome = await render(async () => rendered);
    expect(outcome).toEqual({ state: "failed", error: "Failed to start the native encoder: Encoder unavailable." });
    expect(confirm).not.toHaveBeenCalled();
    expect(bridge.removed.length).toBe(2);
    confirm.mockRestore();
  });

  it("checks cancellation after encoder start before launching a worker", async () => {
    const abort = new AbortController();
    bridge.answers.set("export_video_sink_start", () => { abort.abort(); });
    const worker = vi.fn(async () => rendered);
    expect(await render(worker, abort.signal)).toEqual({ state: "cancelled" });
    expect(worker).not.toHaveBeenCalled();
    expect(bridge.log).toContain("invoke export_video_sink_cancel");
    expect(bridge.removed.length).toBe(2);
  });

  it("checks cancellation after sink finalization before starting audio or mux", async () => {
    const abort = new AbortController();
    bridge.answers.set("export_video_sink_finish", () => { abort.abort(); });
    expect(await render(async () => rendered, abort.signal)).toEqual({ state: "cancelled" });
    expect(bridge.log).not.toContain("invoke export_project_audio_only");
    expect(bridge.log).not.toContain("invoke mux_export");
    expect(bridge.removed.length).toBe(2);
  });

  it("cleans scratch files on successful video-only completion", async () => {
    const outcome = await render(async () => rendered);
    expect(outcome).toEqual({ state: "completed", outputPath: "/output/.staging.mp4", durationUs: 2_000_000 });
    expect(bridge.log).toContain("invoke mux_export");
    expect(bridge.log).not.toContain("invoke export_project_audio_only");
    expect(bridge.removed.length).toBe(2);
  });

  it("passes frozen admitted geometry and fresh readiness paths to the worker", async () => {
    const admitted = summary([track("track-v", "Video", [COLOR_LAYER])]);
    const freshMedia = [{ id: "source-1", label: "source.mp4", kind: "Video", path: "/source.mp4", decode_route: { route: "bypass" } } as MediaSummary];
    const afterReadiness = summaryFixture({ root: { duration_us: 99_000_000, tracks: [] }, media: freshMedia });
    let summaries = 0;
    bridge.answers.set("project_summary", () => ++summaries === 1 ? admitted : afterReadiness);
    const worker = vi.fn(async (_options: Parameters<PreviewSurfaceHandle["runPixiExport"]>[0]) => rendered);
    expect((await render(worker)).state).toBe("completed");
    const exported = worker.mock.calls[0]![0].summary!;
    expect(exported.compositions).toBe(admitted.compositions);
    expect(exported.media).toBe(freshMedia);
    expect(exported.compositions[ROOT_ID]!.duration_us).toBe(2_000_000);
  });

  it.each(["failed", "cancelled"] as const)("drains an in-flight append before removing scratch files when the worker is %s", async (terminal) => {
    const abort = new AbortController();
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let appended = false;
    bridge.answers.set("fs_write_file", async () => {
      bridge.log.push("append started");
      await writing;
      appended = true;
    });
    const pipeline = render(async (options) => {
      // The real worker can reject on abort before the asynchronous IPC append
      // it already dispatched settles. Reproduce that ordering exactly.
      void options.writeChunk(new ArrayBuffer(4)).catch(() => {});
      if (terminal === "cancelled") abort.abort();
      throw new Error("Worker failed during append.");
    }, abort.signal, { encoderEngine: "webcodecs" });
    let finished = false;
    void pipeline.then(() => { finished = true; });
    await waitFor(() => expect(bridge.log).toContain("append started"));
    expect(finished).toBe(false);
    expect(bridge.removed).toEqual([]);
    releaseWrite();
    expect(await pipeline).toEqual(terminal === "cancelled"
      ? { state: "cancelled" }
      : { state: "failed", error: "Worker failed during append." });
    expect(appended).toBe(true);
    expect(bridge.removed.length).toBe(2);
  });
});
