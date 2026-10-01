// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePointerGesture } from "./usePointerGesture";

afterEach(cleanup);

it.each(["release", "cancel", "escape", "blur", "unmount", "replacement"])(
  "ends an owned pointer exactly once on %s and leaves no active listeners",
  (ending) => {
    const { result, unmount } = renderHook(usePointerGesture);
    const gesture = { move: vi.fn(), release: vi.fn(), cancel: vi.fn() };
    result.current(7, gesture);
    // A different touch cannot move, release or cancel this one.
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 8 });
    fireEvent.pointerCancel(window, { pointerId: 8 });
    expect(gesture.move).not.toHaveBeenCalled();
    expect(gesture.release).not.toHaveBeenCalled();
    expect(gesture.cancel).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 50 });
    expect(gesture.move).toHaveBeenCalledOnce();

    if (ending === "release") fireEvent.pointerUp(window, { pointerId: 7 });
    else if (ending === "cancel") fireEvent.pointerCancel(window, { pointerId: 7 });
    else if (ending === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (ending === "blur") fireEvent.blur(window);
    else if (ending === "unmount") unmount();
    else result.current(9, { move: vi.fn(), release: vi.fn(), cancel: vi.fn() });

    fireEvent.pointerMove(window, { pointerId: 7 });
    fireEvent.pointerUp(window, { pointerId: 7 });
    fireEvent.pointerCancel(window, { pointerId: 7 });
    expect(gesture.move).toHaveBeenCalledOnce();
    expect(gesture.release).toHaveBeenCalledTimes(ending === "release" ? 1 : 0);
    expect(gesture.cancel).toHaveBeenCalledTimes(ending === "release" ? 0 : 1);
  },
);
