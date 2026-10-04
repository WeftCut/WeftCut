import { useLayoutEffect, useState } from "react";
import { SILENCE_DB, useMasterMeterStore } from "../state/masterMeterStore";

export const METER_FLOOR_DB = -60;

// Display ballistics only: analyser readings and the pass's maximum stay exact.
const FRAME_MS = 50;
const RMS_HOLD_MS = 300;
const PEAK_HOLD_MS = 1000;
const RMS_RELEASE_DB_PER_SECOND = 24;
const PEAK_RELEASE_DB_PER_SECOND = 18;
const LEVEL_RELEASE_DB_PER_SECOND = 36;
const SILENT_RELEASE_DB_PER_SECOND = 240;

interface Envelope {
  value: number;
  target: number;
  releaseAt: number;
  updatedAt: number;
}

function envelope(value: number, now: number, holdMs: number): Envelope {
  return { value, target: value, releaseAt: now + holdMs, updatedAt: now };
}

function receive(state: Envelope, target: number, now: number, holdMs: number): void {
  state.target = target;
  if (target <= SILENCE_DB) state.releaseAt = now;
  if (target >= state.value) {
    state.value = target;
    state.releaseAt = now + holdMs;
    state.updatedAt = now;
  }
}

function release(state: Envelope, now: number, rate: number): void {
  const elapsed = Math.max(0, now - Math.max(state.updatedAt, state.releaseAt));
  state.updatedAt = now;
  state.value = Math.max(state.target, state.value - (elapsed * rate) / 1000);
  // Once a silent target reaches the meter's visual floor, show true silence.
  if (state.target <= SILENCE_DB && state.value <= METER_FLOOR_DB) state.value = SILENCE_DB;
}

/** The signal peak pushes a bar with fast release and a marker held for one
 * second. Silence cancels the hold and releases quickly. RMS stays a separate
 * average reading. The clock survives a stopped sampling timer and is cancelled
 * on unmount. No clock runs once both readings have reached their targets. */
export function useMasterMeterDisplay(): { rmsDb: number; levelDb: number; peakDb: number } {
  const [display, setDisplay] = useState(() => {
    const { rmsDb, peakDb } = useMasterMeterStore.getState();
    return { rmsDb, levelDb: peakDb, peakDb };
  });

  useLayoutEffect(() => {
    const initial = useMasterMeterStore.getState();
    const now = performance.now();
    let rms = envelope(initial.rmsDb, now, RMS_HOLD_MS);
    let level = envelope(initial.peakDb, now, 0);
    let peak = envelope(initial.peakDb, now, PEAK_HOLD_MS);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => setDisplay((prev) =>
      prev.rmsDb === rms.value && prev.levelDb === level.value && prev.peakDb === peak.value
        ? prev : { rmsDb: rms.value, levelDb: level.value, peakDb: peak.value });
    const advance = (time: number) => {
      release(rms, time, rms.target <= SILENCE_DB ? SILENT_RELEASE_DB_PER_SECOND : RMS_RELEASE_DB_PER_SECOND);
      release(level, time, level.target <= SILENCE_DB ? SILENT_RELEASE_DB_PER_SECOND : LEVEL_RELEASE_DB_PER_SECOND);
      release(peak, time, peak.target <= SILENCE_DB ? SILENT_RELEASE_DB_PER_SECOND : PEAK_RELEASE_DB_PER_SECOND);
      peak.value = Math.max(peak.value, level.value);
    };
    const schedule = () => {
      if (timer !== null || (rms.value === rms.target && level.value === level.target && peak.value === peak.target)) return;
      timer = setTimeout(() => {
        timer = null;
        const time = performance.now();
        advance(time);
        publish();
        schedule();
      }, FRAME_MS);
    };
    publish();
    const unsubscribe = useMasterMeterStore.subscribe((next, prev) => {
      if (next.peakHoldDb === SILENCE_DB && prev.peakHoldDb !== SILENCE_DB && next.sampledAtMs !== null) {
        peak.value = level.value;
        peak.releaseAt = performance.now() + PEAK_HOLD_MS;
        publish();
      }
      if (next.sampledAtMs === prev.sampledAtMs && next.rmsDb === prev.rmsDb && next.peakDb === prev.peakDb) return;
      const time = performance.now();
      if (next.sampledAtMs === null) {
        // A disposed/replaced preview has no signal whose tail should linger.
        rms = envelope(next.rmsDb, time, RMS_HOLD_MS);
        level = envelope(next.peakDb, time, 0);
        peak = envelope(next.peakDb, time, PEAK_HOLD_MS);
        if (timer !== null) clearTimeout(timer);
        timer = null;
      } else {
        advance(time);
        receive(rms, next.rmsDb, time, RMS_HOLD_MS);
        receive(level, next.peakDb, time, 0);
        receive(peak, next.peakDb, time, PEAK_HOLD_MS);
      }
      publish();
      schedule();
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  return display;
}
