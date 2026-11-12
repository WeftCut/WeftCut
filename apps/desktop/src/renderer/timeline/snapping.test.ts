import { describe, expect, it } from "vitest";
import { timeUsAtFrame } from "../frames";
import type { LinkSummary, LayerSummary, TrackSummary } from "../ipc";
import {
  resolveTimelineDragSnap,
  resolveTimelineTimeSnap,
} from "./snapping";

function layer(id: string, startUs: number, endUs: number): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "Color",
    color_hint: "#4488cc",
    enabled: true,
    locked: false,
    params: {
      kind: "Color",
      color: {
        mode: "Static",
        value: { r: 0, g: 0, b: 0, a: 1 },
      },
      width: 1920,
      height: 1080,
    },
    effects: [],
  };
}

function track(layers: LayerSummary[]): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

function baseOpts(overrides: {
  visibleTracks?: TrackSummary[];
  links?: LinkSummary[];
  linkByLayerId?: Map<string, string>;
  currentTimeUs?: number;
  enabled?: boolean;
} = {}) {
  return {
    visibleTracks: overrides.visibleTracks ?? [track([])],
    links: overrides.links ?? [],
    linkByLayerId: overrides.linkByLayerId ?? new Map<string, string>(),
    currentTimeUs: overrides.currentTimeUs ?? 3_000_000,
    fpsNum: 30,
    fpsDen: 1,
    pxPerSec: 100,
    enabled: overrides.enabled ?? true,
    strengthPx: 20,
  };
}

describe("timeline snapping", () => {
  it("does not snap a selection to the original edge of another moving member", () => {
    const delta = resolveTimelineDragSnap({
      ...baseOpts({ visibleTracks: [track([layer("other", 2_000_000, 3_000_000)])], currentTimeUs: 10_000_000 }),
      state: { kind: "move", layerId: "anchor", originalTStart: 0, originalTEnd: 1_000_000,
        escapeLink: true, subjects: [{ layerId: "anchor" }, { layerId: "other" }] },
      frameDeltaUs: 950_000,
    }).deltaUs;
    expect(delta).toBe(950_000);
  });
  it("keeps move snapping by aligning a moved edge to the playhead", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts(),
      state: {
        kind: "move",
        layerId: "layer-1",
        originalTStart: 1_000_000,
        originalTEnd: 2_000_000,
        escapeLink: false,
      },
      frameDeltaUs: 950_000,
    }).deltaUs;

    expect(deltaUs).toBe(1_000_000);
  });

  it("snaps an out-trim edge to the playhead", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts(),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeLink: false,
      },
      frameDeltaUs: 950_000,
    }).deltaUs;

    expect(deltaUs).toBe(1_000_000);
  });

  it("allows an out-trim snap that leaves exactly one frame", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts({ currentTimeUs: 33_333 }),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeLink: false,
      },
      frameDeltaUs: -1_950_000,
    }).deltaUs;

    expect(deltaUs).toBe(-1_966_667);
  });

  it("snaps an in-trim edge to the playhead", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts({ currentTimeUs: 1_000_000 }),
      state: {
        kind: "trim-start",
        layerId: "layer-1",
        originalTStart: 2_000_000,
        originalTEnd: 5_000_000,
        escapeLink: false,
      },
      frameDeltaUs: -950_000,
    }).deltaUs;

    expect(deltaUs).toBe(-1_000_000);
  });

  it("allows an in-trim snap that leaves exactly one frame", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts({ currentTimeUs: 1_966_667 }),
      state: {
        kind: "trim-start",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeLink: false,
      },
      frameDeltaUs: 1_950_000,
    }).deltaUs;

    expect(deltaUs).toBe(1_966_667);
  });

  it("does not snap drag operations when disabled", () => {
    const deltaUs = resolveTimelineDragSnap({
      ...baseOpts({ enabled: false }),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeLink: false,
      },
      frameDeltaUs: 950_000,
    }).deltaUs;

    expect(deltaUs).toBe(950_000);
  });

  it("snaps a blade cut point to the playhead", () => {
    const snappedUs = resolveTimelineTimeSnap({
      ...baseOpts(),
      timeUs: 2_950_000,
      layerId: "layer-1",
      isValidSnap: (boundaryUs) =>
        boundaryUs > 1_000_000 && boundaryUs < 4_000_000,
    }).timeUs;

    expect(snappedUs).toBe(3_000_000);
  });

  it("snaps a blade cut point to visible layer boundaries", () => {
    const snappedUs = resolveTimelineTimeSnap({
      ...baseOpts({
        visibleTracks: [
          track([
            layer("layer-1", 1_000_000, 4_000_000),
            layer("layer-2", 3_000_000, 5_000_000),
          ]),
        ],
        currentTimeUs: 10_000_000,
      }),
      timeUs: 2_950_000,
      layerId: "layer-1",
      isValidSnap: (boundaryUs) =>
        boundaryUs > 1_000_000 && boundaryUs < 4_000_000,
    }).timeUs;

    expect(snappedUs).toBe(3_000_000);
  });
});

describe("magnetic feedback contract (#156)", () => {
  const state = {
    kind: "move" as const, layerId: "moving", originalTStart: 1_000_000,
    originalTEnd: 2_000_000, escapeLink: false,
  };

  it("returns the exact winning boundary alongside the quantised move delta", () => {
    expect(resolveTimelineDragSnap({
      ...baseOpts(), state, frameDeltaUs: 950_000,
    })).toMatchObject({ deltaUs: 1_000_000, boundaryUs: 3_000_000 });
  });

  it("has no magnetic target under Mod, even though the frame delta is preserved", () => {
    expect(resolveTimelineDragSnap({
      ...baseOpts({ enabled: false }), state, frameDeltaUs: 966_667,
    })).toMatchObject({ deltaUs: 966_667, boundaryUs: null });
  });

  it("reports trim targets and suppresses feedback when outside snap strength", () => {
    const trim = { ...state, kind: "trim-end" as const };
    expect(resolveTimelineDragSnap({
      ...baseOpts(), state: trim, frameDeltaUs: 966_667,
    })).toMatchObject({ deltaUs: 1_000_000, boundaryUs: 3_000_000 });
    expect(resolveTimelineDragSnap({
      ...baseOpts({ currentTimeUs: 10_000_000 }), state: trim, frameDeltaUs: 966_667,
    })).toMatchObject({ deltaUs: 966_667, boundaryUs: null });
  });

  it.each([1, 1001])("keeps a fixed move at the same time on the %i-denominator grid", (fpsDen) => {
    const fpsNum = fpsDen === 1 ? 30 : 30_000;
    const boundaryUs = timeUsAtFrame(61, fpsNum, fpsDen);
    const opts = {
      ...baseOpts({
        visibleTracks: [track([layer("target", boundaryUs, boundaryUs + 1_000_000)])],
        currentTimeUs: 10_000_000,
      }),
      fpsNum, fpsDen, frameDeltaUs: 0, preserveTime: true,
    };
    for (const driftUs of [-1, 0, 1]) {
      expect(resolveTimelineDragSnap({
        ...opts, state: { ...state, originalTStart: 0, originalTEnd: boundaryUs + driftUs },
      })).toMatchObject({ deltaUs: 0, boundaryUs });
    }
    expect(resolveTimelineDragSnap({
      ...opts,
      state: { ...state, originalTStart: 0, originalTEnd: timeUsAtFrame(60, fpsNum, fpsDen) },
    })).toMatchObject({ deltaUs: 0, boundaryUs: null });
  });

  it("keeps a track-only guide off when a one-microsecond difference crosses the frame rounding boundary", () => {
    const result = resolveTimelineDragSnap({
      ...baseOpts({
        visibleTracks: [track([layer("target", 16_667, 1_000_000)])],
        currentTimeUs: 10_000_000,
      }),
      state: { ...state, originalTStart: 0, originalTEnd: 16_666 },
      frameDeltaUs: 0,
      preserveTime: true,
    });
    expect(result).toMatchObject({ deltaUs: 0, boundaryUs: null });
  });

  it.each([
    { zoom: 100, strength: 4, snaps: true },
    { zoom: 200, strength: 4, snaps: false },
    { zoom: 200, strength: 7, snaps: true },
  ])("applies snap strength in screen pixels (%j)", ({ zoom, strength, snaps }) => {
    const result = resolveTimelineDragSnap({
      ...baseOpts(), state, frameDeltaUs: 966_667, pxPerSec: zoom, strengthPx: strength,
    });
    expect(result).toMatchObject({
      deltaUs: snaps ? 1_000_000 : 966_667,
      boundaryUs: snaps ? 3_000_000 : null,
    });
  });

  it("uses the nearest target the projected edge can actually land on", () => {
    const result = resolveTimelineDragSnap({
      ...baseOpts({
        visibleTracks: [track([layer("target", 1_866_667, 1_933_333)])],
        currentTimeUs: 10_000_000,
      }),
      state, frameDeltaUs: -133_333,
      projectMove: (deltaUs) => {
        // Another selected member reaches zero before the nearest snap.
        const shift = Math.max(-100_000, deltaUs);
        return {
          anchor: { tStartUs: state.originalTStart + shift, tEndUs: state.originalTEnd + shift },
          validity: "valid" as const,
        };
      },
    });
    expect(result).toEqual({
      deltaUs: -66_667, boundaryUs: 1_933_333,
      placement: { anchor: { tStartUs: 933_333, tEndUs: 1_933_333 }, validity: "valid" },
    });
  });

  it("a blade/cut reports the target independently of its resulting time", () => {
    expect(resolveTimelineTimeSnap({
      ...baseOpts(), timeUs: 2_966_667,
    })).toEqual({ timeUs: 3_000_000, boundaryUs: 3_000_000 });
    expect(resolveTimelineTimeSnap({
      ...baseOpts({ enabled: false }), timeUs: 2_966_667,
    })).toEqual({ timeUs: 2_966_667, boundaryUs: null });
  });
});
