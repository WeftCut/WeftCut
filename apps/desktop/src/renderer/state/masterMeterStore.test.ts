import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIO_ROLES, type AudioRole } from "../ipc";
import {
  acquireRoleMeterDemand,
  clearMasterMeter,
  publishMasterMeter,
  publishMasterMeterSilent,
  publishRoleMeters,
  publishRoleMetersSilent,
  resetMasterPeakHold,
  roleMeterDemandWanted,
  subscribeRoleMeterDemand,
  useMasterMeterStore,
} from "./masterMeterStore";

/// Every Role at one level, for a publication that only cares about some.
function everyRoleAt(
  rmsDb: number,
  peakDb: number,
  overrides: Partial<Record<AudioRole, { rmsDb: number; peakDb: number }>> = {},
): Record<AudioRole, { rmsDb: number; peakDb: number }> {
  const samples = {} as Record<AudioRole, { rmsDb: number; peakDb: number }>;
  for (const role of AUDIO_ROLES) {
    samples[role] = overrides[role] ?? { rmsDb, peakDb };
  }
  return samples;
}

describe("masterMeterStore", () => {
  beforeEach(() => clearMasterMeter());

  it("publishes one real master RMS/peak sample to renderer subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = useMasterMeterStore.subscribe(listener);

    publishMasterMeter({ rmsDb: -18.25, peakDb: -2.5 }, 42);

    expect(useMasterMeterStore.getState()).toMatchObject({
      rmsDb: -18.25,
      peakDb: -2.5,
      sampledAtMs: 42,
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("normalizes analyser silence and clears a disposed owner", () => {
    publishMasterMeter({ rmsDb: -Infinity, peakDb: Number.NaN }, 9);
    expect(useMasterMeterStore.getState()).toMatchObject({
      rmsDb: -120,
      peakDb: -120,
      sampledAtMs: 9,
    });

    clearMasterMeter();
    expect(useMasterMeterStore.getState()).toMatchObject({
      rmsDb: -120,
      peakDb: -120,
      sampledAtMs: null,
    });
  });

  it("reads silence again once the transport stops, leaving the Role slice alone", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 }, 11);
    publishRoleMeters(everyRoleAt(-9, -3), 12);

    publishMasterMeterSilent();

    const state = useMasterMeterStore.getState();
    expect(state).toMatchObject({ rmsDb: -120, peakDb: -120 });
    // A sample, not a clear: the reading is fresh silence, so it carries a time.
    expect(state.sampledAtMs).not.toBeNull();
    // The two publications stay independent in this direction too.
    expect(state.roleLevels.music).toEqual({ rmsDb: -9, peakDb: -3 });
    expect(state.roleSampledAtMs).toBe(12);
  });
});

describe("masterMeterStore peak hold", () => {
  beforeEach(() => clearMasterMeter());

  it("ratchets up with the samples and never down", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 }, 1);
    publishMasterMeter({ rmsDb: -30, peakDb: -12 }, 2);
    // The live peak fell; the hold did not.
    expect(useMasterMeterStore.getState()).toMatchObject({ peakDb: -12, peakHoldDb: -6 });

    publishMasterMeter({ rmsDb: -12, peakDb: -3 }, 3);
    expect(useMasterMeterStore.getState().peakHoldDb).toBe(-3);
  });

  it("stands through the transport's silent sample, and lets go on reset or a cleared preview", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 }, 1);

    publishMasterMeterSilent();
    // The reading is silence; the loudest moment of the pass is still on record.
    expect(useMasterMeterStore.getState()).toMatchObject({ peakDb: -120, peakHoldDb: -6 });

    resetMasterPeakHold();
    expect(useMasterMeterStore.getState().peakHoldDb).toBe(-120);
    // The next sample is the new hold, not the floor.
    publishMasterMeter({ rmsDb: -20, peakDb: -9 }, 2);
    expect(useMasterMeterStore.getState().peakHoldDb).toBe(-9);

    clearMasterMeter();
    expect(useMasterMeterStore.getState().peakHoldDb).toBe(-120);
  });

  it("reads analyser silence as the floor, so it cannot raise the hold", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 }, 1);
    publishMasterMeter({ rmsDb: -Infinity, peakDb: Number.NaN }, 2);
    expect(useMasterMeterStore.getState().peakHoldDb).toBe(-6);
  });
});

describe("masterMeterStore per-Role slice", () => {
  beforeEach(() => clearMasterMeter());

  it("publishes and reads back one sample per Role", () => {
    publishRoleMeters(
      everyRoleAt(-30, -20, { music: { rmsDb: -12.5, peakDb: -3.25 } }),
      7,
    );

    const state = useMasterMeterStore.getState();
    expect(state.roleLevels.music).toEqual({ rmsDb: -12.5, peakDb: -3.25 });
    expect(state.roleLevels.dialogue).toEqual({ rmsDb: -30, peakDb: -20 });
    expect(state.roleSampledAtMs).toBe(7);
    // The two publications are independent: a Role sample leaves the master
    // reading (and its own sample time) alone.
    expect(state.rmsDb).toBe(-120);
    expect(state.sampledAtMs).toBeNull();
  });

  it("normalizes a non-finite Role reading to the silence floor", () => {
    publishRoleMeters(
      everyRoleAt(-6, -1, { sfx: { rmsDb: -Infinity, peakDb: Number.NaN } }),
      3,
    );
    expect(useMasterMeterStore.getState().roleLevels.sfx).toEqual({
      rmsDb: -120,
      peakDb: -120,
    });
  });

  it("reads silence again once the tap stops", () => {
    publishRoleMeters(everyRoleAt(-6, -1), 1);
    publishRoleMetersSilent();

    for (const role of AUDIO_ROLES) {
      expect(useMasterMeterStore.getState().roleLevels[role]).toEqual({
        rmsDb: -120,
        peakDb: -120,
      });
    }
  });

  it("clearing a disposed preview clears the per-Role slice too", () => {
    publishRoleMeters(everyRoleAt(-6, -1), 5);

    clearMasterMeter();

    const state = useMasterMeterStore.getState();
    for (const role of AUDIO_ROLES) {
      expect(state.roleLevels[role]).toEqual({ rmsDb: -120, peakDb: -120 });
    }
    expect(state.roleSampledAtMs).toBeNull();
  });
});

describe("masterMeterStore per-Role demand lease", () => {
  it("stays wanted until every lease is released", () => {
    const wanted = vi.fn();
    const unsubscribe = subscribeRoleMeterDemand(wanted);

    const first = acquireRoleMeterDemand();
    const second = acquireRoleMeterDemand();
    // One transition, not one notification per lease.
    expect(wanted.mock.calls).toEqual([[true]]);

    first();
    // A second holder is still looking.
    expect(roleMeterDemandWanted()).toBe(true);
    // And a repeated release must not drop someone else's lease.
    first();
    expect(roleMeterDemandWanted()).toBe(true);

    second();
    expect(roleMeterDemandWanted()).toBe(false);
    expect(wanted.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
  });
});
