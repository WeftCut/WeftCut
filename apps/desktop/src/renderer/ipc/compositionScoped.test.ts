import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/bridge/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn() }));

import {
  addColorLayerIn,
  addGroupLayerIn,
  addMarkerAtIn,
  addMotifIn,
  addTextLayerIn,
  addTrackIn,
} from "./compositionScoped";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";

const GROUP = "comp-group";

/// Every wrapper is exercised with a composition that is NOT the focused one:
/// the drop that motivates this feature lands in a background timeline while
/// the keyboard stays where it was, so an argument silently losing to a store
/// read is the failure worth catching.
beforeEach(() => {
  invoke.mockReset().mockResolvedValue("new-id");
  useCompositionAnchorStore.setState({ focusedId: "comp-elsewhere" });
});

describe("composition-scoped creation channels", () => {
  it("sends the composition it was handed, not the focused one", async () => {
    await addTrackIn(GROUP);
    expect(invoke).toHaveBeenCalledWith("add_track", { compositionId: GROUP });

    await addMarkerAtIn(GROUP, 500_000);
    expect(invoke).toHaveBeenLastCalledWith("add_marker", {
      tUs: 500_000,
      label: "",
      compositionId: GROUP,
    });

    await addColorLayerIn({ compositionId: GROUP, tStartUs: 0 });
    expect(invoke).toHaveBeenLastCalledWith(
      "add_color_layer",
      expect.objectContaining({ compositionId: GROUP }),
    );

    await addTextLayerIn({ compositionId: GROUP, tStartUs: 0 });
    expect(invoke).toHaveBeenLastCalledWith(
      "add_text_layer",
      expect.objectContaining({ compositionId: GROUP }),
    );

    await addMotifIn({ compositionId: GROUP, motifId: "m1", tStartUs: 0 });
    expect(invoke).toHaveBeenLastCalledWith(
      "add_motif",
      expect.objectContaining({ compositionId: GROUP }),
    );
  });

  it("names the composition beside the track, so the actor's cross-check agrees", async () => {
    // A track id already fixes the destination; naming a DIFFERENT composition
    // is `InvalidArgument`, which is exactly what a store read would produce
    // for a drop into a Panel that does not hold the keyboard.
    await addGroupLayerIn({
      compositionId: GROUP,
      sourceCompositionId: "comp-inner",
      trackId: "track-in-group",
      tStartUs: 0,
    });
    expect(invoke).toHaveBeenCalledWith("add_group_layer", {
      sourceCompositionId: "comp-inner",
      trackId: "track-in-group",
      tStartUs: 0,
      compositionId: GROUP,
    });
  });

  it("passes null through as the root, which is what the unbound row is", async () => {
    await addTrackIn(null);
    expect(invoke).toHaveBeenCalledWith("add_track", { compositionId: null });
  });
});
