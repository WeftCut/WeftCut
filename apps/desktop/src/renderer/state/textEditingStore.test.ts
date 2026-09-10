import { beforeEach, describe, expect, it } from "vitest";

import {
  beginTextEdit,
  consumesPointerDown,
  endTextEdit,
  markEditorClosedByPointer,
  textEditingLayerId,
  useTextEditingStore,
} from "./textEditingStore";

describe("textEditingStore", () => {
  beforeEach(() => {
    useTextEditingStore.setState({ layerId: null, closingPointerStamp: null });
  });

  it("opens on a layer and closes only for that layer", () => {
    beginTextEdit("a");
    expect(textEditingLayerId()).toBe("a");
    // A stale close from another layer's unmount must not close this one.
    endTextEdit("b");
    expect(textEditingLayerId()).toBe("a");
    endTextEdit("a");
    expect(textEditingLayerId()).toBeNull();
  });

  it("does not notify subscribers when re-opening the open layer", () => {
    beginTextEdit("a");
    let notifications = 0;
    const unsubscribe = useTextEditingStore.subscribe(() => {
      notifications += 1;
    });
    beginTextEdit("a");
    expect(notifications).toBe(0);
    beginTextEdit("b");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  // The Text tool sees the same pointerdown the editor closed on, after the
  // editor did. The stamp is how it knows that press is spent — and it is spent
  // exactly once, so a later press with a fresh stamp is judged on its own.
  it("marks the closing press as consumed, once", () => {
    markEditorClosedByPointer({ timeStamp: 1234.5 });
    expect(consumesPointerDown({ timeStamp: 999 })).toBe(false);
    expect(consumesPointerDown({ timeStamp: 1234.5 })).toBe(true);
    expect(consumesPointerDown({ timeStamp: 1234.5 })).toBe(false);
  });

  it("consumes nothing when no editor has closed", () => {
    expect(consumesPointerDown({ timeStamp: 1 })).toBe(false);
  });
});
