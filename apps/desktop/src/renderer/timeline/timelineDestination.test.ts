import { describe, expect, it } from "vitest";
import { timelineDestination } from "./timelineDestination";
import { SPAWN_TRACK_ID } from "./placement";
import type { VisualTrack } from "./geometry";

const box = (left: number, top: number, right: number, bottom: number) => ({
  getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }),
}) as HTMLElement;

describe("visible timeline drop destinations", () => {
  const surfaces = {
    viewport: box(0, 100, 800, 300),
    strip: box(160, 66, 1200, 80),
    // The first lane scrolled behind the chrome. Expanded sub-lanes occupy
    // 150..190 and belong to their track, as in the editor's measured layout.
    lanes: new Map([
      ["hidden", box(160, 20, 1200, 76)],
      ["visible", box(160, 76, 1200, 150)],
      ["last", box(160, 190, 1200, 246)],
    ]),
    orderedTracks: ["hidden", "visible", "last"].map(id => ({ track: { id } })) as VisualTrack[],
  };

  it("rejects hidden lanes, headers and points outside the viewport", () => {
    for (const [x, y] of [[200, 30], [200, 90], [100, 130], [850, 130], [200, 301]]) {
      expect(timelineDestination(surfaces, x!, y!)).toBeNull();
    }
  });

  it("gives the fixed add-track strip its exact visible area", () => {
    expect(timelineDestination(surfaces, 200, 70)?.trackId).toBe(SPAWN_TRACK_ID);
    expect(timelineDestination(surfaces, 200, 80)).toBeNull();
    expect(timelineDestination(surfaces, 850, 70)).toBeNull();
  });

  it("keeps partially visible tracks and expanded sub-lanes droppable", () => {
    expect(timelineDestination(surfaces, 200, 100)?.trackId).toBe("visible");
    expect(timelineDestination(surfaces, 200, 175)?.trackId).toBe("visible");
    expect(timelineDestination(surfaces, 200, 190)?.trackId).toBe("last");
    expect(timelineDestination(surfaces, 200, 246)).toBeNull();
  });
});
