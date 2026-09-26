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

vi.mock("../commands/registry", async () => {
  // The ripple row's gate is the REAL predicate, unlike every other row here:
  // this file is where "greys with the reason" is covered, and a stubbed gate
  // would make both halves of that vacuous.
  const { canRippleDeleteSelection } = await import("./rippleEligibility");
  return {
    // No commands registered → CommandContextItem drops every registry row,
    // which is exactly what leaves the kind-gated tier alone on screen. The
    // exceptions are the kind-gated registry rows: those rows are themselves
    // gated by kind, so this file is where their gates are covered, and dropping
    // them would make every assertion about them vacuously pass.
    getCommand: (id: string) =>
      id === "rippleDeleteSelected"
        ? {
            id,
            labelKey: "actions.ripple_delete_selected",
            enabled: canRippleDeleteSelection,
            run: () => {},
          }
        : KIND_GATED_LABELS[id] === undefined
          ? undefined
          : { id, labelKey: KIND_GATED_LABELS[id], run: () => {} },
    commandRegistryVersion: () => 0,
    subscribeCommandRegistry: () => () => {},
  };
});
vi.mock("../state/linkOverrideStore", () => ({ useLinkOverride: () => false }));
// The real store, minus the one derived read this file has no fixture for: the
// ripple row's reason is composed against the live mirror
// (`errors/formatCommandError.ts` resolves the uuids off it), so a stub with
// only `useGroupOrdinals` on it would throw the moment a row greyed.
vi.mock("../state/projectStore", async (importActual) => ({
  ...(await importActual<typeof import("../state/projectStore")>()),
  useGroupOrdinals: () => new Map(),
}));
vi.mock("../speech/autoCaptionEligibility", () => ({
  useAutoCaptionState: () => "auto_caption",
}));
vi.mock("../commands/pauseCommands", () => ({
  usePauseSubjectState: () => "ok",
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
import type { CompositionSummary, LayerSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import { summaryFixture } from "../testing/summaryFixture";
import { LayerContextMenu } from "./LayerContextMenu";

const handlers = {
  onClose: vi.fn(),
  onRename: vi.fn(),
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
      linkMemberIds={["layer-1"]}
      escapeLink={false}
      transitionCut={null}
      {...handlers}
    />,
  );
}

afterEach(() => {
  cleanup();
  useProjectStore.getState().apply(null);
  clearLayerSelection();
});
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
  it.each(["VideoClip", "Audio"])("%s gets the transcribe row", (kind) => {
    renderMenu(kind);
    expect(screen.getByRole("menuitem", { name: /Transcribe selected clip/ })).toBeTruthy();
  });

  it.each(["Text", "Color", "Motif", "ImageOverlay", "CompositionRef"])(
    "%s gets no transcribe row — a row that can only refuse is worse than none",
    (kind) => {
      renderMenu(kind);
      expect(
        screen.queryByRole("menuitem", { name: /Transcribe selected clip/ }),
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
  it("offers Describe selected clip content on a VideoClip, after Review shots", () => {
    renderMenu("VideoClip");
    const labels = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "");
    const review = labels.findIndex((l) => /Review shots/.test(l));
    const describe = labels.findIndex((l) => /Describe selected clip content/.test(l));
    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(describe);
  });

  it.each(["Audio", "Text", "Color", "Motif", "ImageOverlay", "CompositionRef"])(
    "%s gets no Describe selected clip content row",
    (kind) => {
      renderMenu(kind);
      expect(
        screen.queryByRole("menuitem", { name: /Describe selected clip content/ }),
      ).toBeNull();
    },
  );
});

// The one registry row in this popup whose disabled reason the menu composes
// itself. Everything else greys with a fixed string; this one greys with the
// curated refusal line, entity names resolved off the mirror — the same
// sentence the status bar shows when the actor refuses for real — so the
// assertions below are on the TEXT, not merely on the attribute.
describe("LayerContextMenu — the Ripple delete row", () => {
  function clip(over: Partial<LayerSummary> & { id: string }): LayerSummary {
    return {
      label: null,
      t_start_us: 0,
      t_end_us: 2_000_000,
      kind: "VideoClip",
      color_hint: "",
      enabled: true,
      locked: false,
      params: { kind: "VideoClip", media_id: "m-1", media_label: "Aurora.mp4" },
      effects: [],
      ...over,
    } as LayerSummary;
  }

  function lane(
    id: string,
    layers: LayerSummary[],
  ): CompositionSummary["tracks"][number] {
    return {
      id,
      kind: "Video",
      label: null,
      enabled: true,
      locked: false,
      muted: false,
      solo: false,
      role: null,
      transient: false,
      layers,
    };
  }

  /// Two abutting clips: deleting the first vacates `[0, 2s)` and the second
  /// slides into it.
  function seed(extra: CompositionSummary["tracks"] = []): void {
    useProjectStore.getState().apply(
      summaryFixture({
        root: {
          duration_us: 4_000_000,
          tracks: [
            lane("t-video", [
              clip({ id: "layer-1", label: "Interview A" }),
              clip({
                id: "layer-2",
                label: "Interview B",
                t_start_us: 2_000_000,
                t_end_us: 4_000_000,
              }),
            ]),
            ...extra,
          ],
        },
      }),
    );
  }

  const row = () => screen.getByRole("menuitem", { name: "Ripple delete" });

  it("is live with a plain selection, and says nothing beyond its label", () => {
    seed();
    setLayerSelection("layer-1", ["layer-1"]);
    renderMenu("VideoClip");
    expect(row().getAttribute("aria-disabled")).not.toBe("true");
    // A live row explaining itself would only restate the label.
    expect(row().getAttribute("title")).toBeNull();
  });

  it("greys with the inside-hole sentence when a clip sits inside the span", () => {
    seed([
      lane("t-text", [
        clip({
          id: "layer-title",
          label: "Lower third",
          kind: "Text",
          params: { kind: "Text", content: "Chapter one" } as LayerSummary["params"],
          t_start_us: 1_000_000,
          t_end_us: 1_500_000,
        }),
      ]),
    ]);
    setLayerSelection("layer-1", ["layer-1"]);
    renderMenu("VideoClip");
    expect(row().getAttribute("aria-disabled")).toBe("true");
    // Names the blocking layer, which is the whole reason the sentence is
    // composed rather than looked up.
    expect(row().getAttribute("title")).toBe(
      "Ripple delete blocked: Lower third starts inside the span being closed — add it to the selection, or delete without ripple.",
    );
  });

  it("greys with the lane's own name when a locked lane holds a mover", () => {
    seed([
      {
        ...lane("t-music", [
          clip({ id: "layer-music", t_start_us: 2_000_000, t_end_us: 3_000_000 }),
        ]),
        locked: true,
      },
    ]);
    setLayerSelection("layer-1", ["layer-1"]);
    renderMenu("VideoClip");
    expect(row().getAttribute("aria-disabled")).toBe("true");
    expect(row().getAttribute("title")).toBe("Track 2 is locked.");
  });

  it("greys asking for a selection when there is none", () => {
    seed();
    renderMenu("VideoClip");
    expect(row().getAttribute("aria-disabled")).toBe("true");
    expect(row().getAttribute("title")).toBe(
      "Select the clips to remove and close the gap after, or click a gap to close it",
    );
  });
});
