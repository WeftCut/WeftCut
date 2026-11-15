import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnimTrack, CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { formatTimecode } from "../frames";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import { focusComposition, openComposition } from "./compositionAnchorStore";
import { setTransportPlaying } from "./playbackStore";
import { playheadReport } from "./playheadReport";
import { setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import { clearRange, setRangeIn, setRangeOut } from "./rangeStore";
import { clearLayerSelection, setLayerSelection } from "./selectionStore";

// The editor's answer to an agent's playhead read: every time on the clock of
// the timeline holding the keyboard, so it lines up with that composition's
// own layer spans; the range, stored in root time, comes down the same way.

const S = 1_000_000;
const G1 = "comp-g1";
const ORPHAN = "comp-orphan";

const stat = <T,>(value: T): AnimTrack<T> => ({ mode: "Static", value });

function colorLayer(id: string, tEndUs: number): LayerSummary {
  return {
    id, label: null, t_start_us: 0, t_end_us: tEndUs, kind: "Color", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Color", color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 16, height: 9 },
  };
}

function refLayer(id: string, compositionId: string, tStartUs: number): LayerSummary {
  return {
    id, label: null, t_start_us: tStartUs, t_end_us: tStartUs + 4 * S, kind: "CompositionRef", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: {
      kind: "CompositionRef", composition_id: compositionId, composition_label: null, src_in_us: 0, src_out_us: 4 * S,
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), scale_linked: true, rotation_deg: stat(0),
      opacity: stat(1), anchor_x: stat(0.5), anchor_y: stat(0.5),
    },
  };
}

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return { id, kind: "Video", label: null, enabled: true, locked: false, muted: false, solo: false, role: null, transient: true, layers };
}

/// A 20 s root holding one 5 s Group placed at 2 s and at 12 s, plus a
/// composition nothing places.
function project() {
  const g1: CompositionSummary = compositionFixture({ id: G1, duration_us: 5 * S, tracks: [track("t-g1", [colorLayer("inner-g1", 5 * S)])] });
  const orphan: CompositionSummary = compositionFixture({ id: ORPHAN, duration_us: 3 * S, tracks: [track("t-orphan", [colorLayer("inner-orphan", 3 * S)])] });
  return summaryFixture({
    project_id: "p-report",
    root: { duration_us: 20 * S, tracks: [track("t-root", [colorLayer("root-color", 20 * S), refLayer("early", G1, 2 * S), refLayer("late", G1, 12 * S)])] },
    groups: [g1, orphan],
  });
}

beforeEach(() => {
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
  clearRange();
  clearLayerSelection();
  setTransportPlaying(false);
  useProjectStore.getState().apply(project());
});

afterEach(() => {
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
  clearRange();
  clearLayerSelection();
  setTransportPlaying(false);
});

describe("playheadReport", () => {
  it("reports nothing before the editor holds a project", () => {
    useProjectStore.getState().apply(null);
    expect(playheadReport()).toBeNull();
  });

  it("reads the root on the film's own clock, with the editor's timecode", () => {
    focusComposition(ROOT_ID);
    setPlayheadTimeUs(3 * S);
    setRangeIn(2 * S);
    setRangeOut(5 * S);
    setLayerSelection("late", ["late", "early"]);
    setTransportPlaying(true);
    const report = playheadReport()!;
    expect(report).toMatchObject({
      root_id: ROOT_ID, composition_id: ROOT_ID, t_us: 3 * S, playing: true,
      range: { t_start_us: 2 * S, t_end_us: 5 * S },
    });
    expect(report.timecode).toBe(formatTimecode(3 * S, 30, 1));
    expect([...report.selection].sort()).toEqual(["early", "late"]);
  });

  it("reads a Group on its own clock, through the placement it was entered by", () => {
    openComposition(G1, "late");
    setPlayheadTimeUs(13 * S);
    setRangeIn(12 * S);
    setRangeOut(14 * S);
    expect(playheadReport()).toMatchObject({ composition_id: G1, t_us: 1 * S, range: { t_start_us: 0, t_end_us: 2 * S } });
    // The same moment through the other placement is another reading.
    openComposition(G1, "early");
    setPlayheadTimeUs(3 * S);
    expect(playheadReport()).toMatchObject({ composition_id: G1, t_us: 1 * S, range: { t_start_us: 10 * S, t_end_us: 12 * S } });
  });

  it("runs a lone in point to the end of the film", () => {
    openComposition(G1, "late");
    setRangeIn(12 * S);
    expect(playheadReport()!.range).toEqual({ t_start_us: 0, t_end_us: 8 * S });
  });

  it("gives a composition nothing places no reading of the range", () => {
    openComposition(ORPHAN, null);
    setRangeIn(2 * S);
    expect(playheadReport()).toMatchObject({ composition_id: ORPHAN, range: null });
  });
});
