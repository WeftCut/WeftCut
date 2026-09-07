// @vitest-environment jsdom
//
// The capture-phase Delete preemptor's contract. It bypasses the shortcut
// dispatcher to win the key from `deleteSelected`, so it has to reproduce that
// action's stand-down rules by hand — and every rule it forgets becomes "Delete
// does something different depending on which sub-selection happens to be
// armed".

import { afterEach, describe, expect, it } from "vitest";
import {
  subSelectionDeleteKey,
  subSelectionDeleteYields,
} from "./subSelectionDelete";
import { setActiveRegion } from "../focus/focusRegionStore";

afterEach(() => {
  setActiveRegion(null);
  document.body.innerHTML = "";
});

function timelineTarget(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("subSelectionDeleteYields", () => {
  it("claims Delete while the timeline region owns the keyboard", () => {
    setActiveRegion("timeline");
    expect(subSelectionDeleteYields(timelineTarget())).toBe(false);
  });

  it("stands down while a text field is focused", () => {
    setActiveRegion("timeline");
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(subSelectionDeleteYields(input)).toBe(true);
  });

  it("stands down while another region owns the keyboard", () => {
    setActiveRegion("preview");
    expect(subSelectionDeleteYields(timelineTarget())).toBe(true);
  });

  it("stands down when no region owns the keyboard", () => {
    expect(subSelectionDeleteYields(timelineTarget())).toBe(true);
  });
});

/// Which presses the chip claims. `Shift` is the ripple delete's chord, and a
/// ripple has no span to close over a transition — so the stronger key degrades
/// to the chip's plain delete rather than doing nothing, which is the same
/// precedence bare Delete already has over a keyframe selection.
function press(over: Partial<KeyboardEvent> & { key: string }) {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent;
}

describe("subSelectionDeleteKey", () => {
  it.each(["Delete", "Backspace"])("claims a bare %s", (key) => {
    expect(subSelectionDeleteKey(press({ key }))).toBe(true);
  });

  it.each(["Delete", "Backspace"])("claims Shift+%s and degrades the ripple", (key) => {
    expect(subSelectionDeleteKey(press({ key, shiftKey: true }))).toBe(true);
  });

  // Nothing in the catalogue binds these, and swallowing a chord the app has no
  // handler for would take the key from the platform for nothing.
  it.each([
    ["ctrlKey", { ctrlKey: true }],
    ["metaKey", { metaKey: true }],
    ["altKey", { altKey: true }],
  ] as const)("leaves %s+Delete alone", (_name, modifier) => {
    expect(subSelectionDeleteKey(press({ key: "Delete", ...modifier }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(subSelectionDeleteKey(press({ key: "x" }))).toBe(false);
  });
});
