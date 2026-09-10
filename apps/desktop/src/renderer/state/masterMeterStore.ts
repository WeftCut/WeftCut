// The single renderer publication seam for the preview mixer's real analyser
// readings — the master output and the per-Role metering taps
// (`render/audio/AudioGraph.ts`) — plus the silence-floor contract every
// consumer thresholds against. It owns no sampling: `render/PixiPreview.tsx`
// runs the timers and publishes here.

import { create } from "zustand";

import { AUDIO_ROLES, type AudioRole } from "../ipc";

export interface MasterMeterSnapshot {
  /** Combined master output in dBFS. Silence is represented as -120. */
  rmsDb: number;
  peakDb: number;
  /** Monotonic sample time. Null until the preview audio graph publishes. */
  sampledAtMs: number | null;
}

/** One Role's contribution to the mix, in dBFS on the same silence floor as
 *  the master. */
export interface RoleMeterSnapshot {
  rmsDb: number;
  peakDb: number;
}

/** The master reading and the per-Role slice. The preview UI tap publishes both
 *  together at one fast rate and one sample time, so the master's line and the
 *  Role columns shown beside it move as one clock. Each keeps its own
 *  `*SampledAtMs` so a consumer can still tell a stale slice from a fresh one.
 *  The agent-facing master REPORT (`reportAudioMeter`, the MCP resource) is a
 *  separate ~2 Hz push and does not pass through this store. */
interface MeterState extends MasterMeterSnapshot {
  /** The loudest master peak since the hold was last reset, in dBFS on the same
   *  floor. A meter's NUMBER is a hold, not a sample: the bar and the tick move
   *  with the signal, and the number stands at the pass's maximum until someone
   *  resets it, so an editor can play through and then read what the mix
   *  reached. It is held across a stopped transport on purpose (the silent
   *  sample leaves it alone), because "the loudest moment of the pass" is
   *  exactly what a reader looks at once the pass is over; only a reset or a
   *  disposed preview (`clearMasterMeter`) lets it go. Infinite hold rather
   *  than a timed decay, as a console's peak display does — a decay needs a
   *  clock that keeps ticking after the last sample, and the store has none. */
  peakHoldDb: number;
  roleLevels: Record<AudioRole, RoleMeterSnapshot>;
  roleSampledAtMs: number | null;
}

/** The dBFS a non-finite (true-silence) analyser reading normalizes to. The one
 *  home for this contract — consumers threshold against it rather than hard-code
 *  their own silence floor. */
export const SILENCE_DB = -120;

function silentRoleLevels(): Record<AudioRole, RoleMeterSnapshot> {
  const levels = {} as Record<AudioRole, RoleMeterSnapshot>;
  for (const role of AUDIO_ROLES) {
    levels[role] = { rmsDb: SILENCE_DB, peakDb: SILENCE_DB };
  }
  return levels;
}

export const useMasterMeterStore = create<MeterState>(() => ({
  rmsDb: SILENCE_DB,
  peakDb: SILENCE_DB,
  peakHoldDb: SILENCE_DB,
  sampledAtMs: null,
  roleLevels: silentRoleLevels(),
  roleSampledAtMs: null,
}));

function jsonSafeDb(value: number): number {
  return Number.isFinite(value) ? value : SILENCE_DB;
}

/** Publish one master analyser reading. The peak hold ratchets up here and
 *  nowhere else: a sample can raise it, never lower it. */
export function publishMasterMeter(
  sample: Pick<MasterMeterSnapshot, "rmsDb" | "peakDb">,
  sampledAtMs = performance.now(),
): void {
  const peakDb = jsonSafeDb(sample.peakDb);
  useMasterMeterStore.setState((prev) => ({
    rmsDb: jsonSafeDb(sample.rmsDb),
    peakDb,
    peakHoldDb: Math.max(prev.peakHoldDb, peakDb),
    sampledAtMs,
  }));
}

/** Let the master peak hold go. The next published sample becomes the new
 *  hold, so a reset mid-play reads the current peak rather than silence for
 *  longer than one sample. */
export function resetMasterPeakHold(): void {
  useMasterMeterStore.setState({ peakHoldDb: SILENCE_DB });
}

/** Publish one per-Role reading. The slice is replaced wholesale so every Role
 *  a subscriber reads comes from the same instant. */
export function publishRoleMeters(
  samples: Readonly<Record<AudioRole, { rmsDb: number; peakDb: number }>>,
  sampledAtMs = performance.now(),
): void {
  const roleLevels = {} as Record<AudioRole, RoleMeterSnapshot>;
  for (const role of AUDIO_ROLES) {
    const sample = samples[role];
    roleLevels[role] = {
      rmsDb: jsonSafeDb(sample.rmsDb),
      peakDb: jsonSafeDb(sample.peakDb),
    };
  }
  useMasterMeterStore.setState({ roleLevels, roleSampledAtMs: sampledAtMs });
}

/** Publish one all-silent master reading. The push calls this when the
 *  transport stops: its timer samples only while playing, so without this the
 *  master would hold its last playing reading beside four Role meters that have
 *  fallen to the floor — level claimed over a mix that has gone silent. The
 *  peak HOLD is not a reading of the mix now and is deliberately left standing
 *  (see `peakHoldDb`). */
export function publishMasterMeterSilent(): void {
  useMasterMeterStore.setState({
    rmsDb: SILENCE_DB,
    peakDb: SILENCE_DB,
    sampledAtMs: performance.now(),
  });
}

/** Publish one all-silent per-Role reading. The tap calls this when it stops
 *  (no demand, or a paused transport), for the same reason as the master's. */
export function publishRoleMetersSilent(): void {
  useMasterMeterStore.setState({
    roleLevels: silentRoleLevels(),
    roleSampledAtMs: performance.now(),
  });
}

/** Clear a disposed preview's stale reading without coupling consumers to it. */
export function clearMasterMeter(): void {
  useMasterMeterStore.setState({
    rmsDb: SILENCE_DB,
    peakDb: SILENCE_DB,
    peakHoldDb: SILENCE_DB,
    sampledAtMs: null,
    roleLevels: silentRoleLevels(),
    roleSampledAtMs: null,
  });
}

export const useMasterRmsDb = (): number =>
  useMasterMeterStore((state) => state.rmsDb);

export const useMasterPeakDb = (): number =>
  useMasterMeterStore((state) => state.peakDb);

export const useMasterPeakHoldDb = (): number =>
  useMasterMeterStore((state) => state.peakHoldDb);

// Scalar on purpose: a selector that builds `{ rmsDb, peakDb }` returns a fresh
// reference on every call, `useSyncExternalStore` compares snapshots with
// `Object.is`, and the subtree then re-renders forever. A per-Role peak reading
// is published and kept, but nothing reads it yet — peak answers headroom and
// the Role meters answer balance — so it has no selector of its own until a
// consumer wants one.
export const useRoleRmsDb = (role: AudioRole): number =>
  useMasterMeterStore((state) => state.roleLevels[role].rmsDb);

/** Ref-counted demand for the fast per-Role tap: it samples only while
 *  something is looking at it, so a closed Panel spends no frame budget.
 *  Counted rather than a boolean because StrictMode mounts a holder twice and
 *  two Panel instances can hold a lease at once. */
let roleMeterDemand = 0;
const roleMeterDemandListeners = new Set<(wanted: boolean) => void>();

function notifyRoleMeterDemand(wanted: boolean): void {
  for (const listener of roleMeterDemandListeners) listener(wanted);
}

/** Take a lease on the per-Role tap; call the returned release to drop it. */
export function acquireRoleMeterDemand(): () => void {
  roleMeterDemand += 1;
  if (roleMeterDemand === 1) notifyRoleMeterDemand(true);
  let released = false;
  return () => {
    // Idempotent: an effect cleanup can run more than once for one acquire.
    if (released) return;
    released = true;
    roleMeterDemand -= 1;
    if (roleMeterDemand === 0) notifyRoleMeterDemand(false);
  };
}

/** Notified on every 0↔1 transition of the lease count, not on every lease. */
export function subscribeRoleMeterDemand(
  fn: (wanted: boolean) => void,
): () => void {
  roleMeterDemandListeners.add(fn);
  return () => {
    roleMeterDemandListeners.delete(fn);
  };
}

export function roleMeterDemandWanted(): boolean {
  return roleMeterDemand > 0;
}
