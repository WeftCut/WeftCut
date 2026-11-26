// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import i18n from "../i18n";
import { PLAYBACK_FPS_LOW_RATIO } from "../render/playbackFpsMeter";
import { resetPlaybackFps, setPlaybackFps } from "../state/playbackFpsStore";
import { PlaybackFpsReadout } from "./PlaybackFpsReadout";

const TARGET = 30_000 / 1_001;

const readout = (container: HTMLElement) => container.querySelector<HTMLElement>(".playback-fps-readout");

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  resetPlaybackFps();
});

describe("playback fps readout", () => {
  it("is absent while nothing plays", () => {
    const { container } = render(<PlaybackFpsReadout targetFps={TARGET} />);
    act(() => setPlaybackFps(null));
    expect(container.firstChild).toBeNull();
  });

  // The reading changes every window while frames drop, so it is read on
  // demand from its own text, never announced and never replaced by a label.
  it("is read as its own number, outside any live region", () => {
    const { container } = render(<PlaybackFpsReadout targetFps={TARGET} />);
    act(() => setPlaybackFps(TARGET));
    const el = readout(container)!;
    expect(el.textContent).toBe("29.97 fps");
    expect(container.querySelector('[role="status"], [aria-live]')).toBeNull();
    expect(container.querySelector("[aria-label]")).toBeNull();
    expect(el.querySelector(".sr-only")).toBeNull();
    expect(el.classList.contains("is-low")).toBe(false);
  });

  it("reads to the rate's own precision, so a healthy playback never reads above its rate", () => {
    const fractional = render(<PlaybackFpsReadout targetFps={24_000 / 1_001} />);
    act(() => setPlaybackFps(24_000 / 1_001));
    expect(readout(fractional.container)!.textContent).toBe("23.98 fps");
    cleanup();

    const whole = render(<PlaybackFpsReadout targetFps={30} />);
    act(() => setPlaybackFps(30));
    expect(readout(whole.container)!.textContent).toBe("30.0 fps");
  });

  it("says in words that a low reading is low, and only while it is", () => {
    const { container } = render(<PlaybackFpsReadout targetFps={TARGET} />);
    act(() => setPlaybackFps(20));
    const el = readout(container)!;
    expect(el.classList.contains("is-low")).toBe(true);
    const suffix = el.querySelector(".sr-only")!.textContent!;
    expect(suffix).toContain("29.97");
    expect(suffix).toContain(`${Math.round(PLAYBACK_FPS_LOW_RATIO * 100)}%`);
    expect(el.textContent).toBe(`20.00 fps${suffix}`);
    expect(container.querySelector('[role="status"], [aria-live], [aria-label]')).toBeNull();

    act(() => setPlaybackFps(TARGET));
    expect(readout(container)!.querySelector(".sr-only")).toBeNull();
    expect(readout(container)!.classList.contains("is-low")).toBe(false);
  });
});
