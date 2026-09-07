import { beforeEach, describe, expect, it } from "vitest";

import {
  armRegionSelect,
  armedRegionSelect,
  disarmRegionSelect,
  useAudioRegionArmStore,
} from "./audioRegionArmStore";

const PAYLOAD = {
  layerId: "L1",
  effectId: "E1",
  inKey: "profile_in_us",
  outKey: "profile_out_us",
  minUs: 250_000,
};

describe("audioRegionArmStore", () => {
  beforeEach(() => useAudioRegionArmStore.setState({ armed: null }));

  it("starts disarmed", () => {
    expect(armedRegionSelect()).toBeNull();
  });

  // The gesture commits straight from this payload, so every field the drag
  // needs — both param keys and the minimum span — rides along with the ids.
  it("arms with the whole payload the gesture commits from", () => {
    armRegionSelect(PAYLOAD);
    expect(armedRegionSelect()).toEqual(PAYLOAD);
  });

  it("re-arming another card replaces the first", () => {
    armRegionSelect(PAYLOAD);
    armRegionSelect({ ...PAYLOAD, layerId: "L2", effectId: "E2" });
    expect(armedRegionSelect()).toMatchObject({ layerId: "L2", effectId: "E2" });
  });

  it("disarms", () => {
    armRegionSelect(PAYLOAD);
    disarmRegionSelect();
    expect(armedRegionSelect()).toBeNull();
  });

  // Escape and any pointerdown outside the target clip both disarm, so the
  // no-op path has to stay quiet or every stray click would wake subscribers.
  it("disarming while already disarmed notifies nobody", () => {
    let notifications = 0;
    const unsubscribe = useAudioRegionArmStore.subscribe(() => {
      notifications += 1;
    });
    disarmRegionSelect();
    expect(notifications).toBe(0);
    armRegionSelect(PAYLOAD);
    disarmRegionSelect();
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
