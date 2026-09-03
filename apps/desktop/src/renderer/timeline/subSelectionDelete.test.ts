// @vitest-environment jsdom
//
// The capture-phase Delete preemptor's contract. It bypasses the shortcut
// dispatcher to win the key from `deleteSelected`, so it has to reproduce that
// action's stand-down rules by hand — and every rule it forgets becomes "Delete
// does something different depending on which sub-selection happens to be
// armed".

import { afterEach, describe, expect, it } from "vitest";
import { subSelectionDeleteYields } from "./subSelectionDelete";
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
