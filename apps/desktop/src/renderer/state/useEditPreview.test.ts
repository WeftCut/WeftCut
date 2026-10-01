// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registerTransport, releaseTransport, type TransportHandle } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useEditPreview } from "./useEditPreview";

const transport = (): TransportHandle => ({
  pause: vi.fn(), play: vi.fn(), seek: vi.fn(), isPlaying: () => false,
});
afterEach(cleanup);

it("captures the parked moment once, restores once, and can start another preview", () => {
  const handle = transport();
  registerTransport(handle);
  setPlayheadTimeUs(500_000);
  const { result, unmount } = renderHook(useEditPreview);
  try {
    act(() => { result.current.show(1_000_000); result.current.show(2_000_000); });
    expect(handle.pause).toHaveBeenCalledOnce();
    expect(handle.seek).toHaveBeenLastCalledWith(2_000_000, "preview");
    expect(playheadTimeUs()).toBe(500_000);
    act(() => { result.current.end(); result.current.end(); });
    expect(handle.seek).toHaveBeenCalledTimes(3);
    expect(handle.seek).toHaveBeenLastCalledWith(500_000);
    act(() => { setPlayheadTimeUs(700_000); result.current.show(3_000_000); });
    unmount();
    expect(handle.seek).toHaveBeenLastCalledWith(700_000);
  } finally { unmount(); releaseTransport(handle); }
});

it("cannot let old preview cleanup seek a replacement transport", () => {
  const old = transport();
  const next = transport();
  registerTransport(old);
  const { result, unmount } = renderHook(useEditPreview);
  act(() => result.current.show(1_000_000));
  registerTransport(next);
  setPlayheadTimeUs(800_000);
  unmount();
  expect(next.seek).not.toHaveBeenCalled();
  expect(playheadTimeUs()).toBe(800_000);
  releaseTransport(next);
});
