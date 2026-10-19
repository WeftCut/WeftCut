// One shared wall clock for surfaces that show "how long" (a job's wait, a
// stall). Every subscriber reads the same tick, so a list of rows costs one
// interval, not one per row, and the interval only runs while something is
// mounted that reads it.

import { useSyncExternalStore } from "react";

/// How often the clock ticks. A second is the finest unit any reader shows.
export const NOW_TICK_MS = 1000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, NOW_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// With no subscriber the clock is not running, so the first reader's render
// catches it up. Only by whole ticks: React reads the snapshot several times
// per render and needs the same value each time.
function snapshot(): number {
  if (timer === null && Date.now() - now >= NOW_TICK_MS) now = Date.now();
  return now;
}

/// Epoch milliseconds, re-rendering the caller once a second.
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
