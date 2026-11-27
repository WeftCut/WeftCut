// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import i18n from "../i18n";
import { resetUnderrunState, setUnderrunState } from "../state/underrunStore";
import { DroppedFramesIndicator } from "./DroppedFramesIndicator";

function report(droppedFrames: number, lateFrames: number): void {
  act(() => setUnderrunState({ active: true, droppedFrames, lateFrames }));
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  resetUnderrunState();
});
afterEach(cleanup);

describe("the dropped/late indicator's tooltip", () => {
  it("keeps the same text while the counts grow, so it can show during playback", () => {
    render(<DroppedFramesIndicator />);
    report(3, 1);
    const indicator = screen.getByRole("status");
    const tooltip = indicator.title;
    report(17, 4);
    expect(indicator.textContent).toBe("17/4");
    expect(indicator.title).toBe(tooltip);
  });

  it.each([
    [5, 0, "transport.dropped_frames_cause"],
    [0, 2, "transport.late_frames_cause"],
    [5, 2, "transport.dropped_late_frames_cause"],
  ] as const)("with %i dropped and %i late, names the causes behind the numbers shown", (dropped, late, key) => {
    render(<DroppedFramesIndicator />);
    report(dropped, late);
    expect(screen.getByRole("status").title).toBe(i18n.t(key));
  });

  it("keeps the counts in the accessible name", () => {
    render(<DroppedFramesIndicator />);
    report(0, 2);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      i18n.t("transport.late_frames", { count: 2 }),
    );
  });
});
