import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both halves of the description path, so this file can assert the one that
// matters: the index reads the cache and never spends a model.
const mocks = vi.hoisted(() => ({
  getMediaDescription: vi.fn(),
  describeClip: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  getMediaDescription: mocks.getMediaDescription,
  describeClip: mocks.describeClip,
}));

import { registerCommandProvider } from "../commands/registry";
import { resetDescriptionsStore } from "../describe/descriptionsStore";
import i18n from "../i18n";
import type { DescriptionCache, MediaSummary, ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { useSearchIndexStore, wireSearchIndex } from "./searchIndexStore";
import { summaryFixture } from "../testing/summaryFixture";

/// A source of the given kind. `mus.mp3` is here so the description sweep can
/// be shown to skip it: `describe_clip` reads a picture stream and refuses
/// every other kind, so probing one would be a round trip that cannot answer.
function media(over: { id: string; label: string; kind: string }): MediaSummary {
  return {
    id: over.id, label: over.label, path: `C:/x/${over.label}`, kind: over.kind,
    duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
    available: true, decode_route: { kind: "Original" } as never,
    codec: "h264", pix_fmt: "yuv420p",
  };
}

// Same fixture shape as buildEntries.test.ts — copied in (one media m1, one
// track t1 with clip l1). Varies media label per test via a parameter.
function fixtureSummary(label = "beach.mp4"): ProjectSummary {
  return summaryFixture({
    project_id: "p1",
    name: "fixture",
    media: [
      media({ id: "m1", label, kind: "Video" }),
      media({ id: "m-audio", label: "mus.mp3", kind: "Audio" }),
    ],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 10_000_000,
      tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: label,
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
        ],
      },
    ],
      markers: [],
      links: [],
    },
  });
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getMediaDescription.mockReset().mockResolvedValue(null);
  mocks.describeClip.mockReset();
  resetDescriptionsStore();
  useProjectStore.getState().apply(null);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  resetDescriptionsStore();
  vi.useRealTimers();
});

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(301); // debounce window
  await vi.advanceTimersByTimeAsync(1);   // async rebuild slice
}

describe("searchIndexStore", () => {
  it("builds an initial index on wire and rebuilds after a debounced summary change", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;

    useProjectStore.getState().apply(fixtureSummary("beach.mp4"));
    // Not yet — debounce pending.
    expect(useSearchIndexStore.getState().entries.some((e) => e.label === "beach.mp4")).toBe(false);
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBeGreaterThan(v0);
    expect(s.entries.some((e) => e.key === "media:m1")).toBe(true);
  });

  it("coalesces a burst of changes into one rebuild", async () => {
    teardown = wireSearchIndex();
    const v0 = useSearchIndexStore.getState().version;
    useProjectStore.getState().apply(fixtureSummary("a.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("b.mp4"));
    await vi.advanceTimersByTimeAsync(100);
    useProjectStore.getState().apply(fixtureSummary("c.mp4"));
    await flushDebounce();
    const s = useSearchIndexStore.getState();
    expect(s.version).toBe(v0 + 1);
    expect(s.entries.some((e) => e.label === "c.mp4")).toBe(true);
    expect(s.entries.some((e) => e.label === "a.mp4")).toBe(false);
  });

  it("re-snapshots command labels when a provider registers", async () => {
    teardown = wireSearchIndex();
    const un = registerCommandProvider(() => [
      { id: "save", labelKey: "actions.save", run: () => {} },
    ]);
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(true);
    un();
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.key === "command:save"),
    ).toBe(false);
  });

  it("re-snapshots command labels on languageChanged", async () => {
    // Pin the starting locale explicitly — the LanguageDetector may resolve
    // either supported language from the host environment, and the signal
    // under test is the en→zh transition, not the detector.
    await i18n.changeLanguage("en-US");
    const un = registerCommandProvider(() => [
      { id: "save", labelKey: "actions.save", run: () => {} },
    ]);
    teardown = wireSearchIndex();
    await flushDebounce();
    const en = useSearchIndexStore
      .getState()
      .entries.find((e) => e.key === "command:save");
    expect(en?.label).toBe("Save");

    await i18n.changeLanguage("zh-CN");
    await flushDebounce();
    const zh = useSearchIndexStore
      .getState()
      .entries.find((e) => e.key === "command:save");
    expect(zh?.label).toBe("保存");
    // en-US label stays a haystack so English queries still hit on zh-CN UI.
    expect(zh?.haystacks).toContain("Save");

    un();
    // Restore — i18n locale (and its localStorage cache, where present) is
    // process-global; don't leak zh-CN into other suites.
    await i18n.changeLanguage("en-US");
  });

  // The load-bearing rule of the description entries: they are indexed from
  // what is already on disk. Nothing on this path may spend a model.
  it("indexes the cached descriptions of the pool's video sources", async () => {
    const cache: DescriptionCache = {
      covered_ranges: [[0, 2_000_000]],
      segments: [
        { t_start_us: 0, t_end_us: 1_000_000, text: "a hallway", tags: ["interior"] },
      ],
    };
    mocks.getMediaDescription.mockResolvedValue(cache);
    teardown = wireSearchIndex();
    useProjectStore.getState().apply(fixtureSummary());

    await flushDebounce();
    // The read lands after the summary's own rebuild, and marks the index
    // dirty in its own right — hence a second debounce window.
    await flushDebounce();
    const entries = useSearchIndexStore.getState().entries;
    expect(entries.some((e) => e.key === "description:l1:0")).toBe(true);
    expect(mocks.describeClip).not.toHaveBeenCalled();
  });

  it("sweeps video sources only", async () => {
    teardown = wireSearchIndex();
    useProjectStore.getState().apply(fixtureSummary());
    await flushDebounce();
    expect(mocks.getMediaDescription).toHaveBeenCalledWith("m1");
    expect(mocks.getMediaDescription).toHaveBeenCalledTimes(1);
  });

  // Nothing described is the ordinary state: the sweep still runs, and the
  // corpus simply carries no rows of that type.
  it("indexes no description entry for a project with none", async () => {
    teardown = wireSearchIndex();
    useProjectStore.getState().apply(fixtureSummary());
    await flushDebounce();
    await flushDebounce();
    expect(
      useSearchIndexStore.getState().entries.some((e) => e.type === "description"),
    ).toBe(false);
  });
});
