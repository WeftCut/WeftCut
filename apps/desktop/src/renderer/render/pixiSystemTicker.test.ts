import { Ticker } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_TICK_MS, paceSystemTicker } from "./pixiSystemTicker";

describe("paceSystemTicker", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("runs Pixi's system listeners on a timer and never asks for an animation frame", () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.useFakeTimers();
    paceSystemTicker();
    const listener = vi.fn();
    // A renderer's scheduler joins after pacing, as it does in the app.
    Ticker.system.add(listener);

    expect(Ticker.system.started).toBe(false);
    vi.advanceTimersByTime(SYSTEM_TICK_MS * 3);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(raf).not.toHaveBeenCalled();
    Ticker.system.remove(listener);
  });
});
