// @vitest-environment jsdom
//
// The mode switcher is the only entry to changing representation, so what
// matters is that it never leaves the user without a route: it branches on
// what the data allows and shows the consequence, instead of disabling itself
// while a second control elsewhere is the real way through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

const { setPosition, updateLayerParamTrack } = vi.hoisted(() => ({
  setPosition: vi.fn(async () => {}),
  updateLayerParamTrack: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  setPosition,
  updateLayerParamTrack,
}));
// Isolate from the keyframe field stack: this file is about the mode choice
// and the node controls, not about how a value row renders.
vi.mock("./InspectorAnimField", () => ({
  InspectorAnimField: ({ desc }: { desc: { paramKey: string } }) => (
    <div data-testid={`field-${desc.paramKey}`} />
  ),
}));

import { PositionFields } from "./PositionFields";
import type { AnimTrack, LayerSummary } from "../ipc";
import { usePathEditingStore } from "../state/pathEditingStore";
import type { PathNode, PositionAnimation } from "../../shared/position";
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from "../../shared/keyframe";
import { evaluatePosition } from "../render/position";

const staticTrack = (value: number): AnimTrack<number> => ({ mode: "Static", value });

const keyedTrack = (a: number, b: number): AnimTrack<number> => ({
  mode: "Keyframed",
  extrapolate: HOLD_EXTRAPOLATION,
  value: [a, b].map((value, i) => ({
    id: `k${i}`, t_us: i * 1_000_000, value,
    in: { ...IN_IDENTITY, mode: "Free" }, out: { ...OUT_IDENTITY, mode: "Free" },
    continuity: "Broken", segment: { kind: "Linear" },
  })),
});

const node = (id: string, x: number): PathNode => ({
  id, tangent_mode: "Corner", point: { x, y: 100 },
  in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: "Line",
});

const pathOf = (...nodes: PathNode[]): PositionAnimation => ({
  mode: "Path",
  path: { nodes },
  progress: { mode: "Static", value: 0 },
});

const onMutated = vi.fn(async () => {});

function renderFields(position: PositionAnimation, tInLayerUs = 0, playheadInSpan = true) {
  render(
    <PositionFields
      layer={{
        id: "L1",
        kind: "Text",
        t_start_us: 0,
        t_end_us: 2_000_000,
        params: { kind: "Text", x: staticTrack(0), y: staticTrack(0), position },
      } as unknown as LayerSummary}
      tInLayerUs={tInLayerUs}
      playheadInSpan={playheadInSpan}
      onMutated={onMutated}
    />,
  );
}

const segment = (name: RegExp) => screen.getByRole("button", { name });
const conversion = () => screen.queryByTestId("position-conversion");

/// Put the canvas' selection in place BEFORE rendering — the store is the
/// canvas' channel into this panel, and a post-render write is a React update
/// outside `act`.
const selectNode = (id: string) => {
  usePathEditingStore.getState().setLayer("L1");
  usePathEditingStore.getState().setNode(id);
};

beforeEach(() => usePathEditingStore.getState().setLayer(null));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the position mode switcher", () => {
  it("preserves a static position without inventing a route or animation", async () => {
    renderFields({ mode: "XY", x: staticTrack(640), y: staticTrack(360) });
    await userEvent.click(segment(/^Path$/));

    expect(setPosition).toHaveBeenCalledTimes(1);
    const [layerId, next] = setPosition.mock.calls[0]! as unknown as [string, PositionAnimation];
    expect(layerId).toBe("L1");
    expect(next.mode).toBe("Path");
    // Switching representation preserves the position and leaves motion unauthored.
    if (next.mode !== "Path") throw new Error("not a path");
    expect(next.path.nodes).toHaveLength(1);
    expect(next.path.nodes[0]!.point).toEqual({ x: 640, y: 360 });
    expect(next.progress).toEqual({ mode: "Static", value: 0 });
    expect(usePathEditingStore.getState().layerId).toBe("L1");
    // Nothing to fit, so nothing to fill in.
    expect(conversion()).toBeNull();
  });

  it("opens the fitted conversion instead when X or Y is animated", async () => {
    renderFields({ mode: "XY", x: keyedTrack(0, 600), y: staticTrack(360) });
    await userEvent.click(segment(/^Path$/));

    // Fitting is measured and applied by the well, never by the switcher.
    expect(setPosition).not.toHaveBeenCalled();
    expect(conversion()).toBeTruthy();
    expect(screen.getByText("Convert XY to path…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply conversion" })).toHaveProperty("disabled", true);
  });

  it.each([staticTrack(0), keyedTrack(0, 1)])("returns a single-node path to static XY without baking (%j)", async progress => {
    selectNode("a");
    renderFields({ mode: "Path", path: { nodes: [node("a", 640)] }, progress });
    await userEvent.click(segment(/^XY$/));

    expect(setPosition).toHaveBeenCalledTimes(1);
    expect(setPosition).toHaveBeenCalledWith("L1", {
      mode: "XY", x: staticTrack(640), y: staticTrack(100),
    }, false);
    expect(conversion()).toBeNull();
    expect(usePathEditingStore.getState().layerId).toBeNull();
  });

  it("offers baking when leaving a multi-node path", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    await userEvent.click(segment(/^XY$/));

    expect(setPosition).not.toHaveBeenCalled();
    expect(screen.getByText("Convert to XY…")).toBeTruthy();
  });

  it("hides the node controls while a conversion is in flight", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.getByRole("button", { name: "Edit path" })).toBeTruthy();
    await userEvent.click(segment(/^XY$/));
    // Two open wells would be two focal points, and a conversion that has not
    // been applied has no nodes to edit yet.
    expect(screen.queryByRole("button", { name: "Edit path" })).toBeNull();
  });

  // `MotionPathOverlay` returns null for an unedited XY position, so this
  // toggle is the only way to see an XY trajectory — and it is meaningless in
  // path mode, where the trajectory is always drawn.
  it("carries the trajectory toggle in XY mode only", async () => {
    renderFields({ mode: "XY", x: keyedTrack(0, 600), y: staticTrack(360) });
    const eye = screen.getByRole("button", { name: "Show trajectory" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(eye);
    expect(screen.getByRole("button", { name: "Show trajectory" }).getAttribute("aria-pressed")).toBe("true");
    expect(setPosition, "asking to see the motion is not an edit").not.toHaveBeenCalled();

    cleanup();
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.queryByRole("button", { name: "Show trajectory" })).toBeNull();
  });

  it("does nothing when the active mode is chosen again", async () => {
    renderFields({ mode: "XY", x: staticTrack(640), y: staticTrack(360) });
    await userEvent.click(segment(/^XY$/));
    expect(setPosition).not.toHaveBeenCalled();
    expect(conversion()).toBeNull();
  });
});

describe("the path node well", () => {
  it("lets the user extend a single-node path without adding animation", async () => {
    selectNode("a");
    const position = pathOf(node("a", 640));
    renderFields(position);
    expect(screen.getByRole("button", { name: "Remove point" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Insert after point" })).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    const [, next, geometryOnly] = setPosition.mock.calls[0]! as unknown as [string, PositionAnimation, boolean];
    if (next.mode !== "Path" || position.mode !== "Path") throw new Error("not a path");
    expect(next.path.nodes).toHaveLength(2);
    expect(next.path.nodes[0]).toEqual(position.path.nodes[0]);
    expect(next.progress).toEqual(position.progress);
    expect(geometryOnly).toBe(true);
  });

  it("offers no node actions until the path is being edited", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    // The well says what it holds and how much of it, so the count is legible
    // without counting handles on the canvas.
    expect(screen.getByText("2 points")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add point" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit path" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add point" })).toBeTruthy();
  });

  it("asks for a selection rather than showing dead per-node actions", async () => {
    renderFields(pathOf(node("a", 0), node("b", 200)));
    await userEvent.click(screen.getByRole("button", { name: "Edit path" }));

    expect(screen.getByText("Select a point on the path to edit it")).toBeTruthy();
    // Appending needs no selection, so it stands. The per-node actions are
    // absent rather than greyed: four dead controls read as a broken panel,
    // where the line above already says what to do.
    expect(screen.getByRole("button", { name: "Add point" })).toHaveProperty("disabled", false);
    for (const action of ["Insert after point", "Line / curve", "Remove point"]) {
      expect(screen.queryByRole("button", { name: action }), action).toBeNull();
    }
    expect(screen.queryByRole("combobox", { name: "Spatial node" })).toBeNull();
  });

  it("names the selected node and offers its tangent modes", async () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 200), node("c", 400)));

    // Which node, not just that one is selected: the canvas is where it was
    // picked, and the caption is what confirms the panel followed.
    expect(screen.getByText("Point 2 / 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("combobox", { name: "Spatial node" }));
    await userEvent.click(await screen.findByRole("option", { name: "Smooth" }));

    expect(setPosition).toHaveBeenCalledTimes(1);
    const [, next] = setPosition.mock.calls[0]! as unknown as [string, PositionAnimation];
    if (next.mode !== "Path") throw new Error("not a path");
    expect(next.path.nodes[1]!.tangent_mode).toBe("Smooth");
  });

  it("refuses a span action on the last node, which has no span after it", () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 200)));
    expect(screen.getByRole("button", { name: "Insert after point" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Line / curve" })).toHaveProperty("disabled", true);
    // Removing it is still fine — it is a node, just not a span start.
    expect(screen.getByRole("button", { name: "Remove point" })).toHaveProperty("disabled", false);
  });
});

describe("arrival at a path node", () => {
  const arrival = () => screen.getByRole("button", { name: "Reach point at current time" });

  it("selects the 32% node from the panel and keys its exact position at the playhead", async () => {
    const position = pathOf(node("a", 0), node("b", 320), node("c", 1000));
    renderFields(position, 750_000);
    await userEvent.click(screen.getByRole("combobox", { name: "Path point" }));
    await userEvent.click(await screen.findByRole("option", { name: "Point 2 · 32%" }));
    expect(usePathEditingStore.getState().nodeId).toBe("b");
    expect(setPosition).not.toHaveBeenCalled();
    await userEvent.click(arrival());
    expect(updateLayerParamTrack).toHaveBeenCalledTimes(1);
    const [layerId, param, progress] = updateLayerParamTrack.mock.calls[0]! as [string, string, AnimTrack<number>];
    expect([layerId, param]).toEqual(["L1", "path_progress"]);
    expect(progress.mode).toBe("Keyframed");
    if (progress.mode !== "Keyframed") throw new Error("not keyed");
    expect(progress.value.map(k => [k.t_us, k.value])).toEqual([[0, 0], [750_000, 0.32]]);
    expect(evaluatePosition({ ...position, progress } as PositionAnimation, 750_000)).toEqual({ x: 320, y: 100 });
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it("updates an existing arrival without duplicating its key or changing other keys", async () => {
    selectNode("b");
    const progress = keyedTrack(0, 1);
    renderFields({ mode: "Path", path: { nodes: [node("a", 0), node("b", 320), node("c", 1000)] }, progress }, 1_000_000);
    await userEvent.click(arrival());
    const next = updateLayerParamTrack.mock.calls[0]![2] as AnimTrack<number>;
    if (next.mode !== "Keyframed" || progress.mode !== "Keyframed") throw new Error("not keyed");
    expect(next.value).toEqual([progress.value[0], { ...progress.value[1], value: 0.32 }]);
    expect(next.extrapolate).toEqual(progress.extrapolate);
  });

  it("uses curve length and full precision even though the selector rounds the percentage", async () => {
    selectNode("b");
    const a = { ...node("a", 0), segment: "Cubic" as const, out_handle: { x: 0, y: 600 } };
    const b = { ...node("b", 320), in_handle: { x: 0, y: 600 } };
    const position = pathOf(a, b, node("c", 1000));
    renderFields(position, 800_000);
    await userEvent.click(arrival());
    const progress = updateLayerParamTrack.mock.calls[0]![2] as AnimTrack<number>;
    if (progress.mode !== "Keyframed") throw new Error("not keyed");
    expect(progress.value[1]!.value).not.toBeCloseTo(0.32, 2);
    const point = evaluatePosition({ ...position, progress } as PositionAnimation, 800_000);
    expect(point.x).toBeCloseTo(b.point.x, 8);
    expect(point.y).toBeCloseTo(b.point.y, 8);
  });

  it("does not create an extra start key when authoring at the clip start", async () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 1000)));
    await userEvent.click(arrival());
    const progress = updateLayerParamTrack.mock.calls[0]![2] as AnimTrack<number>;
    expect(progress.value).toEqual([expect.objectContaining({ t_us: 0, value: 1 })]);
  });

  it("disables arrival outside the clip and explains how to enable it", async () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 1000)), -100_000, false);
    expect(arrival()).toHaveProperty("disabled", true);
    expect(screen.getByText("Move the playhead inside this clip to set an arrival keyframe.")).toBeTruthy();
    await userEvent.click(arrival());
    expect(updateLayerParamTrack).not.toHaveBeenCalled();
  });

  it("reports failed writes and allows retrying", async () => {
    selectNode("b");
    renderFields(pathOf(node("a", 0), node("b", 1000)), 500_000);
    updateLayerParamTrack.mockRejectedValueOnce(new Error("Write failed"));
    await userEvent.click(arrival());
    expect(screen.getByRole("alert").textContent).toContain("Write failed");
    expect(onMutated).not.toHaveBeenCalled();
    await userEvent.click(arrival());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onMutated).toHaveBeenCalledTimes(1);
  });
});
