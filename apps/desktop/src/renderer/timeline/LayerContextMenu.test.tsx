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

/// The registry rows this file must keep on screen — the kind-gated tiers'
/// own, whose gates nothing else covers. Hoisted because the registry mock
/// factory below closes over it.
const KIND_GATED_LABELS = vi.hoisted<Record<string, string | undefined>>(() => ({
  autoCaptionSelected: "actions.auto_caption_selected",
  reviewShots: "actions.review_shots",
  describeSelected: "actions.describe_selected",
}));

vi.mock("../commands/registry", () => ({
  // No commands registered → CommandContextItem drops every registry row, which
  // is exactly what leaves the kind-gated tier alone on screen. The exceptions
  // are the kind-gated registry rows: those rows are themselves gated by kind,
  // so this file is where their gates are covered, and dropping them would make
  // every assertion about them vacuously pass.
  getCommand: (id: string) =>
    KIND_GATED_LABELS[id] === undefined
      ? undefined
      : { id, labelKey: KIND_GATED_LABELS[id], run: () => {} },
  commandRegistryVersion: () => 0,
  subscribeCommandRegistry: () => () => {},
}));
vi.mock("../state/linkOverrideStore", () => ({ useLinkOverride: () => false }));
vi.mock("../state/projectStore", () => ({ useGroupOrdinals: () => new Map() }));
vi.mock("../speech/autoCaptionEligibility", () => ({
  useAutoCaptionState: () => "auto_caption",
  useAudioClipState: () => "ok",
}));
vi.mock("../describe/describeEligibility", () => ({
  useDescribeState: () => "describe",
}));
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

  // The analysis tier follows the MATERIAL, not the visual kind: both kinds that
  // reference media with an audio stream get it, and nothing else does.
  it.each(["VideoClip", "Audio"])("%s gets the auto-caption row", (kind) => {
    renderMenu(kind);
    expect(screen.getByRole("menuitem", { name: /Auto-caption clip/ })).toBeTruthy();
  });

  it.each(["Text", "Color", "Motif", "ImageOverlay", "CompositionRef"])(
    "%s gets no auto-caption row — a row that can only refuse is worse than none",
    (kind) => {
      renderMenu(kind);
      expect(
        screen.queryByRole("menuitem", { name: /Auto-caption clip/ }),
      ).toBeNull();
    },
  );

  // The video tier is one notch narrower than the analysis tier above it: a
  // shot report is a claim about a picture stream, so an Audio layer — which
  // the analysis tier accepts — must not get this row.
  it("offers Review shots on a VideoClip, above Mark shot cuts", () => {
    renderMenu("VideoClip");
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "");
    const review = labels.findIndex((l) => /Review shots/.test(l));
    const mark = labels.findIndex((l) => /Mark shot cuts/.test(l));
    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(mark);
  });

  it.each(["Audio", "Text", "Color", "Motif", "ImageOverlay", "CompositionRef"])(
    "%s gets no Review shots row",
    (kind) => {
      renderMenu(kind);
      expect(screen.queryByRole("menuitem", { name: /Review shots/ })).toBeNull();
    },
  );

  // Describe follows Review shots in the same tier, and for the same reason it
  // is in that tier at all: its answer is prose to read ON those rows.
  it("offers Describe content on a VideoClip, after Review shots", () => {
    renderMenu("VideoClip");
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "");
    const review = labels.findIndex((l) => /Review shots/.test(l));
    const describe = labels.findIndex((l) => /Describe content/.test(l));
    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(describe);
  });

  it.each(["Audio", "Text", "Color", "Motif", "ImageOverlay", "CompositionRef"])(
    "%s gets no Describe content row",
    (kind) => {
      renderMenu(kind);
      expect(
        screen.queryByRole("menuitem", { name: /Describe content/ }),
      ).toBeNull();
    },
  );
});
