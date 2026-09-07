// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  updateLayerParamTracks: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../../ipc")>();
  return {
    ...actual,
    updateLayerParamTracks: ipcMocks.updateLayerParamTracks,
    logEmit: ipcMocks.logEmit,
  };
});

import { useProjectStore } from "../../state/projectStore";
import {
  armRegionSelect,
  armedRegionSelect,
  useAudioRegionArmStore,
} from "../audioRegionArmStore";
import {
  useAudioRegionDrag,
  type RegionDragContext,
  type RegionHandleContext,
} from "./useAudioRegionDrag";

const PAYLOAD = {
  layerId: "L1",
  effectId: "E1",
  inKey: "profile_in_us",
  outKey: "profile_out_us",
  minUs: 250_000,
};

/// A clip at 1 s → 5 s playing its media from 3 s, drawn at 100 px/s from 200 px
/// in: a click at 300 px is 2 s of composition and 4 s of source, so no
/// expectation below can pass on the wrong axis.
const CTX: RegionDragContext = {
  layerId: "L1",
  tStartUs: 1_000_000,
  tEndUs: 5_000_000,
  srcInUs: 3_000_000,
  pxPerSec: 100,
  blockLeftPx: 200,
};

/// The same clip with a region already on it, 2 s → 3 s of composition.
const HANDLE_CTX: RegionHandleContext = {
  ...CTX,
  effectId: "E1",
  inKey: "profile_in_us",
  outKey: "profile_out_us",
  minUs: 250_000,
  inUs: 2_000_000,
  outUs: 3_000_000,
};

const press = (clientX: number) => ({
  button: 0,
  clientX,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

/// jsdom has no PointerEvent; a MouseEvent under the pointer type carries the
/// `clientX` the listeners read, which is all the gesture asks of an event.
const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { clientX });

afterEach(cleanup);
beforeEach(() => {
  useAudioRegionArmStore.setState({ armed: null });
  useProjectStore.setState({ summary: null });
  ipcMocks.updateLayerParamTracks.mockReset();
});

describe("useAudioRegionDrag region gesture", () => {
  it("commits both bounds as one batch of source µs, then disarms", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    armRegionSelect(PAYLOAD);
    const down = press(300);
    let took = false;
    act(() => {
      took = result.current.startRegionDrag(down, CTX);
    });
    expect(took).toBe(true);
    expect(down.stopPropagation).toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(pointer("pointermove", 400));
    });
    expect(result.current.preview).toEqual({ t0Us: 2_000_000, t1Us: 3_000_000 });

    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 400));
    });
    expect(ipcMocks.updateLayerParamTracks).toHaveBeenCalledTimes(1);
    expect(ipcMocks.updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[profile_in_us]", { mode: "Static", value: 4_000_000 }],
      ["effects[E1].params[profile_out_us]", { mode: "Static", value: 5_000_000 }],
    ]);
    expect(armedRegionSelect()).toBeNull();
  });

  // The band has to keep painting the region for the round trip: the command
  // returning means the actor has it, not that the mirror does.
  it("holds the promised region until the summary arrives", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    armRegionSelect(PAYLOAD);
    act(() => {
      result.current.startRegionDrag(press(300), CTX);
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 400));
    });
    expect(result.current.preview).toEqual({ t0Us: 2_000_000, t1Us: 3_000_000 });

    act(() => {
      useProjectStore.setState({ summary: null });
    });
    expect(result.current.preview).toBeNull();
  });

  // The arm is the whole permission: without it the press belongs to the
  // block's own select/move path, which is why the refusal claims nothing.
  it("refuses a press with no arm, or an arm naming another clip", () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    const unarmed = press(300);
    expect(result.current.startRegionDrag(unarmed, CTX)).toBe(false);
    expect(unarmed.stopPropagation).not.toHaveBeenCalled();

    armRegionSelect({ ...PAYLOAD, layerId: "L2" });
    expect(result.current.startRegionDrag(press(300), CTX)).toBe(false);
    expect(result.current.preview).toBeNull();
  });

  // The card's button is disabled on a clip this short, but a clip trimmed
  // short after arming still gets the press.
  it("writes nothing on a clip shorter than the minimum span, and still disarms", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    armRegionSelect(PAYLOAD);
    act(() => {
      result.current.startRegionDrag(press(300), { ...CTX, tEndUs: 1_200_000 });
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 320));
    });
    expect(ipcMocks.updateLayerParamTracks).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    expect(armedRegionSelect()).toBeNull();
  });
});

describe("useAudioRegionDrag handle gesture", () => {
  it("commits the moved bound alone", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    const down = press(400);
    act(() => {
      result.current.startHandleDrag(down, HANDLE_CTX, "out");
    });
    // Load-bearing: the handle sits inside the clip block, whose own
    // pointerdown would select the clip and arm a move under the edge drag.
    expect(down.stopPropagation).toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(pointer("pointermove", 450));
    });
    expect(result.current.preview).toEqual({ t0Us: 2_000_000, t1Us: 3_500_000 });

    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 450));
    });
    expect(ipcMocks.updateLayerParamTracks).toHaveBeenCalledTimes(1);
    expect(ipcMocks.updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[profile_out_us]", { mode: "Static", value: 5_500_000 }],
    ]);
    // A handle needs no arm, and takes none: the one-shot belongs to the clip
    // body's gesture.
    expect(armedRegionSelect()).toBeNull();
  });

  it("keeps the in bound a whole minimum span short of the out bound", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    act(() => {
      result.current.startHandleDrag(press(300), HANDLE_CTX, "in");
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 380));
    });
    expect(ipcMocks.updateLayerParamTracks).toHaveBeenCalledWith("L1", [
      ["effects[E1].params[profile_in_us]", { mode: "Static", value: 4_750_000 }],
    ]);
  });

  it("treats a handle that came back to where it started as no edit", async () => {
    const { result } = renderHook(() => useAudioRegionDrag());
    act(() => {
      result.current.startHandleDrag(press(400), HANDLE_CTX, "out");
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 400));
    });
    expect(ipcMocks.updateLayerParamTracks).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });
});
