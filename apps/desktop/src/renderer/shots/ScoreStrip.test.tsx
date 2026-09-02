// @vitest-environment jsdom
//
// The strip's geometry and its line's keyboard contract, with no store and no
// IPC — the component is controlled, so every gesture here is one reported
// value and nothing else.
//
// The keyboard path is the one a test can drive: jsdom has no pointer geometry
// (`getBoundingClientRect` is all zeroes), so a pointer drag would measure
// nothing. That is why the handle carries `role="slider"` and full arrow / page
// / Home / End handling rather than being a bare draggable div.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import "../i18n"; // side effect: init global i18next (en-US fallback)
import i18n from "../i18n";
import type { CutScore } from "../ipc";
import { ScoreStrip } from "./ScoreStrip";

/// Four candidates across a six-second window, scores spread so a line can sit
/// between them.
const CANDIDATES: readonly CutScore[] = [
  { t_us: 1_000_000, score: 0.9 },
  { t_us: 1_200_000, score: 0.8 },
  { t_us: 3_000_000, score: 0.3 },
  { t_us: 4_500_000, score: 0.6 },
];

const FLOOR = 0.05;

function renderStrip(
  over: Partial<React.ComponentProps<typeof ScoreStrip>> = {},
): {
  onThresholdChange: ReturnType<typeof vi.fn>;
  onThresholdCommit: ReturnType<typeof vi.fn>;
  ticks: () => NodeListOf<Element>;
} {
  const onThresholdChange = vi.fn();
  const onThresholdCommit = vi.fn();
  const { container } = render(
    <ScoreStrip
      candidates={CANDIDATES}
      srcInUs={0}
      srcOutUs={6_000_000}
      threshold={0.4}
      floor={FLOOR}
      fpsNum={30}
      fpsDen={1}
      onThresholdChange={onThresholdChange}
      onThresholdCommit={onThresholdCommit}
      {...over}
    />,
  );
  return {
    onThresholdChange,
    onThresholdCommit,
    ticks: () => container.querySelectorAll(".shots-tick"),
  };
}

const handle = (): HTMLElement => screen.getByRole("slider");

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
});

describe("ScoreStrip — one tick per candidate", () => {
  it("places a tick per candidate, x by source time and y by score", () => {
    const { ticks } = renderStrip();
    const drawn = [...ticks()].map((el) => ({
      srcUs: el.getAttribute("data-src-us"),
      x: el.getAttribute("x1"),
      y: el.getAttribute("y2"),
    }));
    // The plot box is 1000 × 100 user units, y measured DOWN from the top — so
    // the tallest tick (score 0.9) has the smallest y.
    expect(drawn).toEqual([
      { srcUs: "1000000", x: "166.667", y: "10" },
      { srcUs: "1200000", x: "200", y: "20" },
      { srcUs: "3000000", x: "500", y: "70" },
      { srcUs: "4500000", x: "750", y: "40" },
    ]);
  });

  it("draws only the candidates strictly inside the clip's window", () => {
    // The window edges are hard boundaries in `build_shots`, so a candidate ON
    // one can never become a cut — drawing it would show a tick the line has no
    // power over.
    const { ticks } = renderStrip({ srcInUs: 1_200_000, srcOutUs: 4_500_000 });
    const drawn = [...ticks()].map((el) => ({
      srcUs: el.getAttribute("data-src-us"),
      x: el.getAttribute("x1"),
    }));
    expect(drawn).toEqual([{ srcUs: "3000000", x: "545.455" }]);
  });

  it("splits the ticks at the line, strictly, the way the reduce does", () => {
    // `score > sensitivity`, matching ffmpeg's `gt`: a candidate scoring
    // exactly the threshold is EXCLUDED.
    const { ticks } = renderStrip({ threshold: 0.8 });
    expect([...ticks()].map((el) => el.getAttribute("data-accepted"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
  });

  it("says so instead of drawing a line over an empty plot", () => {
    renderStrip({ candidates: [] });
    expect(screen.getByTestId("shots-no-candidates").textContent).toContain(
      "No candidate cuts in this clip's range",
    );
    // No line, because there is nothing for one to sort.
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("ScoreStrip — the line's handle", () => {
  it("declares the floor as its minimum and 1 as its maximum", () => {
    renderStrip();
    expect(handle().getAttribute("aria-valuemin")).toBe(String(FLOOR));
    expect(handle().getAttribute("aria-valuemax")).toBe("1");
    expect(handle().getAttribute("aria-valuenow")).toBe("0.4");
    // Named by what the axis measures. "Sensitivity" reads backwards and
    // reaches no label.
    expect(handle().getAttribute("aria-label")).toBe("Shot cut threshold");
    expect(screen.getByText("Frame change")).toBeTruthy();
  });

  it("nudges by 0.01, pages by 0.1, and lands on the floor and 1", () => {
    const { onThresholdChange } = renderStrip();
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]) {
      fireEvent.keyDown(handle(), { key });
    }
    // Quantized on the way out: a dozen presses must not accumulate float dust
    // into the value that gets persisted and read back as `aria-valuenow`.
    expect(onThresholdChange.mock.calls.map(([v]) => v)).toEqual([
      0.41, 0.39, 0.5, 0.3, FLOOR, 1,
    ]);
  });

  it("ignores a key it does not own, so the Panel keeps its own shortcuts", () => {
    const { onThresholdChange, onThresholdCommit } = renderStrip();
    fireEvent.keyDown(handle(), { key: "a" });
    fireEvent.keyUp(handle(), { key: "a" });
    expect(onThresholdChange).not.toHaveBeenCalled();
    expect(onThresholdCommit).not.toHaveBeenCalled();
  });

  it("keeps its keys away from the app's bare-key seek shortcuts", () => {
    // ArrowUp / ArrowDown / Home / End are `seekPrevEdit` / `seekNextEdit` /
    // `seekStart` / `seekEnd`: unscoped bubble-phase bindings, so the window
    // dispatcher has no reason of its own to stand down for a focused slider.
    // Aiming the line must not also walk the playhead.
    const seen: string[] = [];
    const spy = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener("keydown", spy);
    renderStrip();
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "Home", "End"]) {
      fireEvent.keyDown(handle(), { key });
    }
    window.removeEventListener("keydown", spy);
    expect(seen).toEqual([]);
  });

  it("commits on release and not on press — a held key is still one gesture", () => {
    const { onThresholdCommit } = renderStrip();
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(onThresholdCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(handle(), { key: "ArrowUp" });
    expect(onThresholdCommit).toHaveBeenCalledTimes(1);
  });
});
