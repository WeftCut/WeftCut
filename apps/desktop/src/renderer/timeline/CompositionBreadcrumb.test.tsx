// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "../i18n";

import { CompositionBreadcrumb } from "./CompositionBreadcrumb";
import {
  leaveToCrumb,
  openComposition,
  useCompositionScopeStore,
} from "../state/compositionScopeStore";
import { useProjectStore } from "../state/projectStore";
import {
  compositionFixture,
  groupLayerFixture,
  ROOT_ID,
  summaryFixture,
} from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../ipc";

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

/// The root places `outer`, which places `inner` — the two-deep shape the
/// breadcrumb exists for. `outer` is named, `inner` is not, so one crumb reads a
/// stored label and the other a derived number.
function seedNestedProject(): void {
  useProjectStore.getState().apply(
    summaryFixture({
      name: "Wedding cut",
      root: {
        tracks: [track("t-root", [groupLayerFixture({ id: "L-outer", compositionId: "c-outer" })])],
      },
      groups: [
        compositionFixture({
          id: "c-outer",
          label: "Titles",
          tracks: [
            track("t-outer", [groupLayerFixture({ id: "L-inner", compositionId: "c-inner" })]),
          ],
        }),
        compositionFixture({ id: "c-inner", label: null }),
      ],
    }),
  );
}

const crumbs = (): string[] =>
  screen.queryAllByTestId("timeline-crumb").map((el) => el.textContent ?? "");

afterEach(() => {
  cleanup();
  useProjectStore.getState().apply(null);
});

describe("CompositionBreadcrumb", () => {
  // Depth 0 renders NOTHING, which is what lets the row sit in normal flow: a
  // project with no Groups has exactly the layout it had before Groups existed.
  it("renders nothing at the root", () => {
    seedNestedProject();
    render(<CompositionBreadcrumb />);
    expect(useCompositionScopeStore.getState().openId).toBe(ROOT_ID);
    expect(screen.queryByTestId("timeline-breadcrumb")).toBeNull();
  });

  it("reads project › Group for one level, naming each crumb as the timeline does", () => {
    seedNestedProject();
    openComposition("c-outer", "L-outer");
    render(<CompositionBreadcrumb />);
    expect(crumbs()).toEqual(["Wedding cut", "Titles"]);
  });

  // A composition with no stored label takes the derived `Group N` — the same
  // name its clip carries on the parent's timeline.
  it("derives the number for an unnamed Group, and appends a crumb per level", () => {
    seedNestedProject();
    openComposition("c-outer", "L-outer");
    openComposition("c-inner", "L-inner");
    render(<CompositionBreadcrumb />);
    // `c-outer` is labelled, so it takes no ordinal; `c-inner` is the first
    // unlabelled composition and takes 1.
    expect(crumbs()).toEqual(["Wedding cut", "Titles", "Group 1"]);
  });

  // The open composition is the last crumb, marked current so the row says which
  // end of the path you are standing at.
  it("marks the open composition's crumb as current", () => {
    seedNestedProject();
    openComposition("c-outer", "L-outer");
    render(<CompositionBreadcrumb />);
    const buttons = screen.getAllByTestId("timeline-crumb");
    expect(buttons[0]?.getAttribute("aria-current")).toBeNull();
    expect(buttons[1]?.getAttribute("aria-current")).toBe("page");
  });

  it("leaves to the crumb that was clicked", () => {
    seedNestedProject();
    openComposition("c-outer", "L-outer");
    openComposition("c-inner", "L-inner");
    render(<CompositionBreadcrumb />);
    screen.getAllByTestId("timeline-crumb")[1]!.click();
    expect(useCompositionScopeStore.getState().openId).toBe("c-outer");
  });

  it("leaves to the root from the project crumb", () => {
    seedNestedProject();
    openComposition("c-outer", "L-outer");
    openComposition("c-inner", "L-inner");
    render(<CompositionBreadcrumb />);
    screen.getAllByTestId("timeline-crumb")[0]!.click();
    expect(useCompositionScopeStore.getState().openId).toBe(ROOT_ID);
  });

  // A project saved with no name would otherwise render a zero-width first
  // crumb — the one crumb that is always there and always clickable.
  it("falls back to a name for an unnamed project", () => {
    useProjectStore.getState().apply(
      summaryFixture({
        name: "   ",
        root: {
          tracks: [
            track("t-root", [groupLayerFixture({ id: "L-outer", compositionId: "c-outer" })]),
          ],
        },
        groups: [compositionFixture({ id: "c-outer", label: "Titles" })],
      }),
    );
    openComposition("c-outer", "L-outer");
    render(<CompositionBreadcrumb />);
    expect(crumbs()[0]).toBe("Open composition");
  });

  afterEach(() => {
    leaveToCrumb(-1);
  });
});
