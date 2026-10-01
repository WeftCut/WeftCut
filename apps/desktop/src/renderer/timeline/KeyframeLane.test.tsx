// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "../i18n";
import type { TrackSummary } from "../ipc";
import { HOLD_EXTRAPOLATION, inIdentity, outIdentity } from "../../shared/keyframe";
import { clearKeyframeFocus, setKeyframeFocus } from "../keyframe/focusStore";
import { KeyframeLane, KeyframeLaneHeaders } from "./KeyframeLane";

afterEach(() => { cleanup(); clearKeyframeFocus(); });

it("renders matching effect headers and curve rows without mounting the effect inspector", () => {
  const paramKey = "effects[blur-a].params[strength]";
  const track = { id: "track-a", layers: [{
    id: "layer-a", kind: "Text", label: "Title A", t_start_us: 0, t_end_us: 2_000_000,
    params: { kind: "Text" }, effects: [{ id: "blur-a", kind: "blur", enabled: true, params: {
      strength: { mode: "Keyframed", extrapolate: HOLD_EXTRAPOLATION, value: [{
        id: "effect-key", t_us: 0, value: 23, in: inIdentity(), out: outIdentity(),
        continuity: "Broken", segment: { kind: "Linear" },
      }] },
    } }],
  }] } as unknown as TrackSummary;
  setKeyframeFocus("layer-a", paramKey);
  const register = vi.fn(), commit = vi.fn();
  const { container, rerender } = render(<>
    <KeyframeLaneHeaders track={track} compositionId={null} fpsNum={30} fpsDen={1}
      visible onCommitParamTrack={commit} />
    <KeyframeLane track={track} pxPerSec={100} registerSubLaneEl={register} onCommitParamTrack={commit} />
  </>);
  expect(screen.getByText("Blur #1 · Strength").title).toBe("Title A · Blur #1 · Strength");
  expect(screen.getAllByTestId("kf-sublane")).toHaveLength(1);
  expect(container.querySelector('[data-kf-id="effect-key"]')).not.toBeNull();
  expect(register).toHaveBeenCalledWith("track-a", paramKey, true, expect.any(HTMLElement));
  const removed = { ...track, layers: track.layers.map((l) => ({ ...l, effects: [] })) };
  rerender(<KeyframeLane track={removed} pxPerSec={100} registerSubLaneEl={register} onCommitParamTrack={commit} />);
  expect(screen.queryByTestId("kf-sublane")).toBeNull();
});
