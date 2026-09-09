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

/** The master reading and the per-Role slice. Published independently: the
 *  master runs at the agent resource's slow rate, the Roles at the UI tap's
 *  fast one, so each carries its own sample time. */
interface MeterState extends MasterMeterSnapshot {
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
  sampledAtMs: null,
  roleLevels: silentRoleLevels(),
  roleSampledAtMs: null,
}));

function jsonSafeDb(value: number): number {
  return Number.isFinite(value) ? value : SILENCE_DB;
}

/** Publish one master analyser reading. */
export function publishMasterMeter(
  sample: Pick<MasterMeterSnapshot, "rmsDb" | "peakDb">,
  sampledAtMs = performance.now(),
): void {
  useMasterMeterStore.setState({
    rmsDb: jsonSafeDb(sample.rmsDb),
    peakDb: jsonSafeDb(sample.peakDb),
    sampledAtMs,
  });
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

/** Publish one all-silent per-Role reading. The tap calls this when it stops
 *  (no demand, or a paused transport): holding the last reading would claim
 *  level over a mix that has gone silent. */
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
    sampledAtMs: null,
    roleLevels: silentRoleLevels(),
    roleSampledAtMs: null,
  });
}

export const useMasterRmsDb = (): number =>
  useMasterMeterStore((state) => state.rmsDb);

export const useMasterPeakDb = (): number =>
  useMasterMeterStore((state) => state.peakDb);

// Scalar on purpose: a selector that builds `{ rmsDb, peakDb }` returns a fresh
// reference on every call, `useSyncExternalStore` compares snapshots with
// `Object.is`, and the subtree then re-renders forever. Two scalar hooks per
// Role cost nothing.
export const useRoleRmsDb = (role: AudioRole): number =>
  useMasterMeterStore((state) => state.roleLevels[role].rmsDb);

export const useRolePeakDb = (role: AudioRole): number =>
  useMasterMeterStore((state) => state.roleLevels[role].peakDb);

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
