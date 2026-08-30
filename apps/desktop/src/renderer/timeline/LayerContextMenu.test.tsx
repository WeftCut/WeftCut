// @vitest-environment jsdom
//
// Covers the clip menu's KIND-GATED tier — the rows that take an explicit
// layerId rather than acting on the selection, and appear only for the kind
// they belong to. The registry-driven tier above them has its own safety net in
// menu/contextMenuCommands.test.ts; this file is the one for the rows that net
// cannot see, because they never go through the command catalogue.
//
// The eligibility hooks and the command registry are stubbed to their "nothing
// special" answers: this file is about which rows the KIND produces, and a live
// registry would only make the assertions depend on the selection state too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../commands/registry", () => ({
  // No commands registered → CommandContextItem drops every registry row, which
  // is exactly what leaves the kind-gated tier alone on screen.
  getCommand: () => undefined,
  commandRegistryVersion: () => 0,
  subscribeCommandRegistry: () => () => {},
}));
vi.mock("../state/linkOverrideStore", () => ({ useLinkOverride: () => false }));
vi.mock("../state/projectStore", () => ({ useGroupOrdinals: () => new Map() }));
vi.mock("./groupEligibility", () => ({
  useAddToGroupState: () => "needs_selection",
  addToGroupTarget: () => null,
}));
vi.mock("./linkEligibility", () => ({ linkFanoutActive: () => false }));
vi.mock("./moveToCompositionEligibility", () => ({
  useMoveToCompositionState: () => "needs_selection",
  moveDestinations: () => [],
}));

import i18n from "../i18n";
import { LayerContextMenu } from "./LayerContextMenu";

const handlers = {
  onClose: vi.fn(),
  onRename: vi.fn(),
  onRenameLink: vi.fn(),
  onRenameGroup: vi.fn(),
  onToggleEnabled: vi.fn(),
  onSeparateAudio: vi.fn(),
  onPrebakeNow: vi.fn(),
  onMarkShotCuts: vi.fn(),
  onAddTransition: vi.fn(),
};

function renderMenu(layerKind: string) {
  return render(
    <LayerContextMenu
      x={10}
      y={10}
      layerId="layer-1"
      layerKind={layerKind}
      layerEnabled
      linkId={null}
      linkMemberIds={["layer-1"]}
      escapeLink={false}
      transitionCut={null}
      {...handlers}
    />,
  );
}

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  for (const fn of Object.values(handlers)) fn.mockReset();
});

describe("LayerContextMenu — kind-gated rows", () => {
  it("offers Mark shot cuts on a VideoClip and hands it the clicked layer", async () => {
    const user = userEvent.setup();
    renderMenu("VideoClip");
    const row = screen.getByRole("menuitem", { name: /Mark shot cuts/ });
    await user.click(row);
    // The clicked clip's id, NOT the selection: a shot report belongs to one
    // source, so this row is layer-scoped like Separate audio / Pre-bake now.
    expect(handlers.onMarkShotCuts).toHaveBeenCalledWith("layer-1");
  });

  it.each([
    ["Audio", "Separate audio to new track"],
    ["Motif", "Pre-bake now"],
  ])("%s gets its own row and NOT Mark shot cuts", (kind, ownRow) => {
    renderMenu(kind);
    expect(screen.getByRole("menuitem", { name: ownRow })).toBeTruthy();
    // Shots are a video concept — the hybrid rejects a non-VideoClip layer, so
    // the row must not be reachable to produce that error in the first place.
    expect(screen.queryByRole("menuitem", { name: /Mark shot cuts/ })).toBeNull();
  });

  it("a Text clip gets none of the three kind-gated rows", () => {
    renderMenu("Text");
    expect(screen.queryByRole("menuitem", { name: /Mark shot cuts/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Pre-bake now" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Separate audio to new track" }),
    ).toBeNull();
  });
});
