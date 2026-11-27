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

  it("names each cause that occurred", () => {
    render(<DroppedFramesIndicator />);
    report(5, 0);
    const indicator = screen.getByRole("status");
    expect(indicator.title).toBe(i18n.t("transport.dropped_frames_cause"));
    report(5, 2);
    expect(indicator.title).toBe(
      `${i18n.t("transport.dropped_frames_cause")} · ${i18n.t("transport.late_frames_cause")}`,
    );
  });

  it("keeps the counts in the accessible name", () => {
    render(<DroppedFramesIndicator />);
    report(0, 2);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      i18n.t("transport.late_frames", { count: 2 }),
    );
  });
});
