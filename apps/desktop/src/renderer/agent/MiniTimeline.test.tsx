// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../i18n";
import { MiniTimeline } from "./MiniTimeline";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["release", "cancel", "escape", "blur", "unmount"])(
  "stops mini-timeline seeking on %s so later edits cannot inherit its scrub",
  (ending) => {
    const onSeek = vi.fn();
    const { container, unmount } = render(<MiniTimeline
      durationUs={5_000_000} markers={[]} onSeek={onSeek} fpsNum={30} fpsDen={1}
    />);
    const strip = container.querySelector<HTMLElement>(".mini-timeline-strip-real")!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 36));
    fireEvent.pointerDown(strip, { button: 0, pointerId: 3, clientX: 100 });
    expect(onSeek).toHaveBeenLastCalledWith(1_000_000);
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 200 });
    expect(onSeek).toHaveBeenLastCalledWith(2_000_000);
    if (ending === "release") fireEvent.pointerUp(window, { pointerId: 3 });
    else if (ending === "cancel") fireEvent.pointerCancel(window, { pointerId: 3 });
    else if (ending === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (ending === "blur") fireEvent.blur(window);
    else unmount();
    onSeek.mockClear();
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 300 });
    expect(onSeek).not.toHaveBeenCalled();
  },
);
