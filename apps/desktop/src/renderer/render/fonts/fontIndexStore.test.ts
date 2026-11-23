// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { FontIndex } from "../../../shared/fonts/types";

const at = (revision: number, complete = true): FontIndex => ({ revision, complete, faces: [] });

/// A fresh store over a fake bridge; `emit` plays a `fonts:index` event.
async function freshStore(index: () => Promise<FontIndex>) {
  vi.resetModules();
  let emit: (i: FontIndex) => void = () => {};
  const onIndex = vi.fn((cb: (i: FontIndex) => void) => {
    emit = cb;
    return () => {};
  });
  Object.defineProperty(window, "api", { configurable: true, value: { font: { index, onIndex } } });
  const store = await import("./fontIndexStore");
  return { store, emit: (i: FontIndex) => emit(i), onIndex };
}

describe("font index store", () => {
  it("answers an empty, unscanned index before the first fetch lands", async () => {
    const { store } = await freshStore(() => new Promise(() => {}));
    expect(store.getFontIndex()).toMatchObject({ complete: false, faces: [] });
  });

  it("takes the fetched index, then each newer event", async () => {
    const { store, emit } = await freshStore(async () => at(1, false));
    expect(await store.whenFontIndex()).toEqual(at(1, false));
    emit(at(2));
    expect(store.getFontIndex()).toEqual(at(2));
  });

  it("never rolls back to a fetch answered after a newer event", async () => {
    let answer!: (i: FontIndex) => void;
    const { store, emit } = await freshStore(() => new Promise(r => { answer = r; }));
    const first = store.whenFontIndex();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    emit(at(5));
    answer(at(4));
    await first;
    expect(store.getFontIndex().revision).toBe(5);
  });

  it("tells subscribers when the index is replaced", async () => {
    const { store, emit } = await freshStore(async () => at(1));
    await store.whenFontIndex();
    const listener = vi.fn();
    store.subscribeFontIndex(listener);
    emit(at(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("holds an export until the index is complete", async () => {
    const { store, emit } = await freshStore(async () => at(1, false));
    let settled: FontIndex | null = null;
    const waiting = store.whenFontIndexComplete().then((i) => { settled = i; });
    await store.whenFontIndex();
    emit(at(2, false));
    await Promise.resolve();
    expect(settled).toBeNull();
    emit(at(3, true));
    await waiting;
    expect(settled).toEqual(at(3, true));
  });

  it("answers the index current now, not the first fetch's, once it is complete", async () => {
    const { store, emit } = await freshStore(async () => at(1, false));
    await store.whenFontIndex();
    emit(at(2, true));
    emit(at(3, true));
    expect(await store.whenFontIndexComplete()).toEqual(at(3, true));
  });

  it("retries the fetch after a failure", async () => {
    const index = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(at(1));
    const { store, onIndex } = await freshStore(index);
    await expect(store.whenFontIndex()).rejects.toThrow("offline");
    expect(await store.whenFontIndex()).toEqual(at(1));
    expect(onIndex).toHaveBeenCalledTimes(1);
  });
});
