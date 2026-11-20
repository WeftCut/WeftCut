// The renderer's copy of main's font face index (main/fonts/catalog.ts, ADR
// 0176): fetched once, then replaced by every `fonts:index` event. Main
// thread only: the export Worker gets its index in the start request.

import { useSyncExternalStore } from "react";

import type { FontIndex } from "../../../shared/fonts/types";

/// What every reader sees before the first fetch lands: no faces, and
/// `systemScanned` false so nothing is reported missing yet. Revision -1 sits
/// below any index main sends.
const NOT_FETCHED: FontIndex = { revision: -1, systemScanned: false, faces: [] };

let current: FontIndex = NOT_FETCHED;
let first: Promise<FontIndex> | null = null;
/// The `fonts:index` subscription lives as long as the window.
let subscribed = false;
const listeners = new Set<() => void>();

function accept(next: FontIndex): void {
  // A fetch answered after a newer event must not roll the index back.
  if (current !== NOT_FETCHED && next.revision <= current.revision) return;
  current = next;
  for (const listener of listeners) listener();
}

function start(): Promise<FontIndex> {
  first ??= Promise.resolve()
    .then(() => {
      if (!subscribed) {
        window.api.font.onIndex(accept);
        subscribed = true;
      }
      return window.api.font.index();
    })
    .then(
      (index) => {
        accept(index);
        return current;
      },
      (error: unknown) => {
        // The next reader retries.
        first = null;
        throw error;
      },
    );
  return first;
}

/// The last known index; an empty one with `systemScanned` false before the
/// first fetch has landed.
export function getFontIndex(): FontIndex {
  void start().catch(() => {});
  return current;
}

/// The first fetch; rejects when it fails (the next call retries).
export function whenFontIndex(): Promise<FontIndex> {
  return start();
}

/// The first index that includes the system fonts. Export waits for it: before
/// the scan lands a system-only family would draw a bundled font, unannounced.
/// Answers the index current when it resolves, never the first fetch's: an
/// export started long after launch must see the project opened since.
export async function whenSystemScanned(): Promise<FontIndex> {
  await start();
  if (current.systemScanned) return current;
  return new Promise<FontIndex>((resolve) => {
    const stop = subscribeFontIndex(() => {
      if (!current.systemScanned) return;
      stop();
      resolve(current);
    });
    // An event may have landed between the check above and subscribing.
    if (current.systemScanned) {
      stop();
      resolve(current);
    }
  });
}

/// Calls `listener` whenever the index is replaced.
export function subscribeFontIndex(listener: () => void): () => void {
  void start().catch(() => {});
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFontIndex(): FontIndex {
  return useSyncExternalStore(subscribeFontIndex, getFontIndex);
}
