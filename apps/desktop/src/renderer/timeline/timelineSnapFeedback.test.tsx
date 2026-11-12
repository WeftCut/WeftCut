// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TimelineSnapGuide } from "./TimelineSnapGuide";
import {
  setTimelineSnapGuide,
  clearTimelineSnapGuidesByOwner,
  useTimelineSnapFeedback,
} from "./timelineSnapFeedbackStore";

const update = (...args: Parameters<typeof setTimelineSnapGuide>) => {
  act(() => setTimelineSnapGuide(...args));
};

afterEach(() => {
  cleanup();
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
    expect(guide.className).toContain("pointer-events-none");
    expect(guide.children).toHaveLength(1); // no diamond or other marker
    expect(guide.firstElementChild?.className).toContain("border-[#B5D987]/90");
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

  it("clears all media-drag guides at gesture end without erasing other owners", () => {
    render(
      <>
        <TimelineSnapGuide compositionId="a" pxPerSec={100} />
        <TimelineSnapGuide compositionId="b" pxPerSec={100} />
        <TimelineSnapGuide compositionId="c" pxPerSec={100} />
      </>,
    );
    update("a", "media", 1_000_000);
    update("b", "blade", 2_000_000);
    update("c", "media", 3_000_000);
    act(() => clearTimelineSnapGuidesByOwner("media"));
    const guides = screen.getAllByTestId("timeline-snap-guide");
    expect(guides).toHaveLength(1);
    expect(guides[0]?.dataset.snapBoundaryUs).toBe("2000000");
    update("b", "blade", null);
  });
});
