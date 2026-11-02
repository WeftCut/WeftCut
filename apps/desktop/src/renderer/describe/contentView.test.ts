import { describe, it, expect } from 'vitest';
import type { RunSummary } from '../ipc';
import { contentForWindow } from './contentView';
const summary = (summaries: readonly RunSummary[], start: number, end: number) =>
  contentForWindow({ summaries, segments: [] }, start, end).summary;

describe('contentForWindow', () => {
  it('returns the summary and intersecting segments from one record without inventing a lead', () => {
    const first = { src_start_us: 0, src_end_us: 2_000_000, text: 'hallway', tags: [] };
    const second = { src_start_us: 2_000_000, src_end_us: 4_000_000, text: 'door', tags: [] };
    const content = { segments: [second, first], summaries: [{ window: [0, 4_000_000] as [number, number], text: 'A hallway and a door.' }] };
    expect(contentForWindow(content, 0, 2_000_000)).toEqual({ summary: 'A hallway and a door.', segments: [first] });
    expect(contentForWindow({ ...content, summaries: [] }, 0, 2_000_000)).toEqual({ summary: null, segments: [first] });
    expect(content.segments).toEqual([second, first]);
    expect(contentForWindow(undefined, 0, 2_000_000)).toEqual({ summary: null, segments: [] });
  });

  it("leads with the exact window's summary, else a covering one, never a narrower one", () => {
    const summaries = [
      { window: [2_000_000, 4_000_000] as [number, number], text: "narrower" },
      { window: [0, 10_000_000] as [number, number], text: "wider" },
      { window: [0, 6_000_000] as [number, number], text: "exact" },
    ];
    expect(summary(summaries, 0, 6_000_000)).toBe("exact");
    expect(summary(summaries, 1_000_000, 8_000_000)).toBe("wider");
    expect(summary(summaries.slice(0, 1), 0, 6_000_000)).toBeNull();
    expect(summary([], 0, 6_000_000)).toBeNull();
  });

  it("matches the run over a clip whose source end is not on a frame", () => {
    // The tool resolves its window from the frame-snapped timeline span: a
    // 150.0165 s source on a 30 fps timeline is described over [0, 150 s].
    const summaries = [{ window: [0, 150_000_000] as [number, number], text: "whole clip" }];
    expect(summary(summaries, 0, 150_016_533)).toBe("whole clip");
    // A run a second short of the clip still does not speak for it.
    expect(summary(summaries, 0, 151_000_000)).toBeNull();
  });

});
