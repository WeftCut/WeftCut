// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bumpPreviewLayoutEpoch, observeClientRect } from "./layoutRectCache";

// The cache exists so a per-frame loop never forces a reflow, so the property
// under test is a CALL COUNT on `getBoundingClientRect` — not a rect value.

let ancestor: HTMLDivElement;
let el: HTMLDivElement;
let unrelated: HTMLDivElement;
let reads: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ancestor = document.createElement("div");
  el = document.createElement("div");
  unrelated = document.createElement("div");
  ancestor.appendChild(el);
  document.body.append(ancestor, unrelated);
  reads = vi.fn(() => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect);
  el.getBoundingClientRect = reads as unknown as () => DOMRect;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("observeClientRect", () => {
  it("reads the box once for any number of frames", () => {
    const cache = observeClientRect(el);
    cache.rect();
    cache.rect();
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("re-reads after the window resizes", () => {
    const cache = observeClientRect(el);
    cache.rect();
    window.dispatchEvent(new Event("resize"));
    cache.rect();
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("re-reads after the layout epoch is bumped", () => {
    const cache = observeClientRect(el);
    cache.rect();
    bumpPreviewLayoutEpoch();
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("ignores a scroll it cannot have moved, and follows one on an ancestor", () => {
    const cache = observeClientRect(el);
    cache.rect();
    unrelated.dispatchEvent(new Event("scroll"));
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(1);
    ancestor.dispatchEvent(new Event("scroll"));
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("re-reads once a gesture starts, so no handler measures last frame's box", () => {
    const cache = observeClientRect(el);
    cache.rect();
    document.dispatchEvent(new Event("pointerdown"));
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("hears nothing once disposed", () => {
    const cache = observeClientRect(el);
    cache.rect();
    cache.dispose();
    cache.dispose();
    window.dispatchEvent(new Event("resize"));
    ancestor.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("pointerdown"));
    bumpPreviewLayoutEpoch();
    cache.rect();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
