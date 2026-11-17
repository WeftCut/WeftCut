import { Ticker } from "pixi.js";

/// How often `Ticker.system` runs. Its listeners are every renderer's
/// scheduler (GC on 30 s cycles) and the event system's hover re-check, which
/// nothing here uses, so a second is ample.
export const SYSTEM_TICK_MS = 1000;

let paced = false;

/// Drives Pixi's `Ticker.system` from a timer instead of its own
/// requestAnimationFrame loop, which would run for the whole life of any
/// renderer in this realm.
///
/// LANDMINE (Chromium, Windows): while the editor page keeps a rAF loop,
/// every synchronous GPU call from its export Worker (PBO readback, Motif
/// texture import) waits for the next display frame, which locks native export
/// to the display rate. Do not let any Pixi ticker run a rAF loop while nothing
/// animates; see docs/notes/export-pipeline-2026-11.md.
export function paceSystemTicker(): void {
  if (paced) return;
  paced = true;
  const ticker = Ticker.system;
  ticker.autoStart = false;
  ticker.stop();
  setInterval(() => ticker.update(), SYSTEM_TICK_MS);
}
