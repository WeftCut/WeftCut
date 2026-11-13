// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TimelineSnapGuide } from "./TimelineSnapGuide";
import { useMediaDragStore } from "./mediaDrag";
import { SPAWN_TRACK_ID } from "./placement";
import {
  setTimelineSnapGuide,
  useTimelineSnapFeedback,
} from "./timelineSnapFeedbackStore";

const update = (...args: Parameters<typeof setTimelineSnapGuide>) => {
  act(() => setTimelineSnapGuide(...args));
};

afterEach(() => {
  cleanup();
  useMediaDragStore.getState().end();
  useTimelineSnapFeedback.setState({ byComposition: {} });
});

describe("timeline snap feedback", () => {
  it("draws one transient, non-interactive line at the solver's exact composition time", () => {
    const { rerender } = render(<TimelineSnapGuide compositionId={null} pxPerSec={100} />);
    expect(screen.queryByTestId("timeline-snap-guide")).toBeNull();
    update(null, "layer", 3_000_000);
    const guide = screen.getByTestId("timeline-snap-guide");
    expect(guide.getAttribute("data-snap-boundary-us")).toBe("3000000");
    expect(guide.style.left).toBe("300px");
    expect(guide.getAttribute("aria-hidden")).toBe("true");
    expect(guide.children).toHaveLength(0); // a bare rule: no diamond or other marker
    rerender(<TimelineSnapGuide compositionId={null} pxPerSec={250} />);
    expect(screen.getByTestId("timeline-snap-guide").style.left).toBe("750px");
    update(null, "layer", null);
    expect(screen.queryByTestId("timeline-snap-guide")).toBeNull();
  });

  it("isolates compositions and refuses to erase a newer owner's guide", () => {
    render(
      <>
        <TimelineSnapGuide compositionId="a" pxPerSec={100} />
        <TimelineSnapGuide compositionId="b" pxPerSec={100} />
      </>,
    );
    update("a", "layer", 2_000_000);
    update("b", "foreign", 4_000_000);
    expect(screen.getAllByTestId("timeline-snap-guide")).toHaveLength(2);
    update("a", "marker", 3_000_000);
    update("a", "layer", null);
    const guides = screen.getAllByTestId("timeline-snap-guide");
    expect(guides.map((el) => el.dataset.snapBoundaryUs).sort()).toEqual(["3000000", "4000000"]);
    update("a", "marker", null);
    expect(screen.getAllByTestId("timeline-snap-guide")).toHaveLength(1);
    update("b", "foreign", null);
    expect(screen.queryByTestId("timeline-snap-guide")).toBeNull();
  });

  it("follows the current media drop claim across compositions and clears at gesture end", () => {
    render(
      <>
        <TimelineSnapGuide compositionId="a" pxPerSec={100} />
        <TimelineSnapGuide compositionId="b" pxPerSec={100} />
        <TimelineSnapGuide compositionId="c" pxPerSec={100} />
      </>,
    );
    const drag = useMediaDragStore.getState();
    const claim = (compositionId: string, snapBoundaryUs: number) => act(() => {
      drag.claimDropTarget({
        compositionId, trackId: SPAWN_TRACK_ID, absorptionTarget: null, snapBoundaryUs,
      });
    });
    const boundaries = () => screen.getAllByTestId("timeline-snap-guide")
      .map((guide) => guide.dataset.snapBoundaryUs).sort();

    act(() => drag.begin({
      source: "media", mediaId: "media", kind: "Video", label: "Source", durationUs: 1_000_000,
    }));
    update("b", "marker", 2_000_000);
    claim("a", 1_000_000);
    expect(boundaries()).toEqual(["1000000", "2000000"]);
    claim("c", 3_000_000);
    act(() => drag.releaseDropTarget("a", SPAWN_TRACK_ID));
    expect(boundaries()).toEqual(["2000000", "3000000"]);

    act(() => drag.end());
    expect(boundaries()).toEqual(["2000000"]);
  });
});
