// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createModKeyReading, useModKeyReading } from "./modKeyReading";

// Both flags on every event, so each case holds on either platform's Mod.
const MOD = { ctrlKey: true, metaKey: true };
const NONE = { ctrlKey: false, metaKey: false };

describe("createModKeyReading", () => {
  it("re-reports Mod from key events while listening, once per change", () => {
    const reading = createModKeyReading();
    const onChange = vi.fn();
    const detach = reading.listen(onChange);
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    // Auto-repeat of a held key changes nothing.
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    expect(reading.held()).toBe(true);
    fireEvent.keyUp(window, { key: "Control", ...NONE });
    expect(reading.held()).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    detach();
  });

  it("takes a pointer event's reading without reporting it back", () => {
    const reading = createModKeyReading();
    const onChange = vi.fn();
    const detach = reading.listen(onChange);
    expect(reading.observe(MOD)).toBe(true);
    expect(reading.held()).toBe(true);
    // The key event agrees with what the pointer already said: no change.
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    expect(onChange).not.toHaveBeenCalled();
    detach();
  });

  it("reads Mod as released when the window loses focus", () => {
    const reading = createModKeyReading();
    const onChange = vi.fn();
    const detach = reading.listen(onChange);
    reading.observe(MOD);
    fireEvent.blur(window);
    expect(reading.held()).toBe(false);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
    detach();
  });

  it("hears nothing once detached", () => {
    const reading = createModKeyReading();
    const onChange = vi.fn();
    reading.listen(onChange)();
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    expect(onChange).not.toHaveBeenCalled();
    expect(reading.held()).toBe(false);
  });
});

describe("useModKeyReading", () => {
  it("listens only while active, and stops on unmount", () => {
    const onChange = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ active }) => useModKeyReading(active, onChange),
      { initialProps: { active: false } },
    );
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    expect(onChange).not.toHaveBeenCalled();

    rerender({ active: true });
    fireEvent.keyUp(window, { key: "Control", ...NONE });
    fireEvent.keyDown(window, { key: "Control", ...MOD });
    expect(onChange.mock.calls).toEqual([[true]]);

    unmount();
    fireEvent.keyUp(window, { key: "Control", ...NONE });
    expect(onChange.mock.calls).toEqual([[true]]);
  });
});
