// @vitest-environment jsdom
//
// The media pool's Groups section: the row an orphan keeps, the Delete its menu
// only offers when nothing references it, and the selection that puts a
// composition in the inspector with no clip involved.
//
// Drives the real component against a seeded project store and the real
// `../i18n`, so a missing translation surfaces as a raw `media_pool.*` key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    compositionsDelete: vi.fn().mockResolvedValue(undefined),
    groupsRename: vi.fn().mockResolvedValue(undefined),
  };
});

import { compositionsDelete, groupsRename, type ProjectSummary, type TrackSummary } from "../ipc";
import { GroupPoolSection } from "./GroupPoolSection";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, useSelectionStore } from "../state/selectionStore";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

function trackWith(id: string, layers: TrackSummary["layers"]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers,
  };
}

/// `comp-a` placed once in the root, `comp-b` placed nowhere.
function seed(): ProjectSummary {
  const summary = summaryFixture({
    root: {
      tracks: [
        trackWith("track-1", [
          groupLayerFixture({ id: "ref-1", compositionId: "comp-a" }),
        ]),
      ],
    },
    groups: [
      compositionFixture({ id: "comp-a", duration_us: 2_000_000 }),
      compositionFixture({ id: "comp-b", duration_us: 5_000_000 }),
    ],
  });
  useProjectStore.getState().apply(summary);
  return summary;
}

function renderSection(query = "") {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  return { onMutated, ...render(<GroupPoolSection query={query} onMutated={onMutated} />) };
}

/// The clickable `app-menu-item` a Base UI menu row's label sits inside — the
/// label is a span, and `disabled` lands on the item.
const menuItem = (label: HTMLElement): HTMLElement => {
  const item = label.closest(".app-menu-item");
  if (!(item instanceof HTMLElement)) throw new Error("menu label is not inside an item");
  return item;
};

const row = (compositionId: string): HTMLElement => {
  const el = document.querySelector(`[data-composition-id="${compositionId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no pool row for ${compositionId}`);
  return el;
};

describe("group pool section", () => {
  it("renders nothing when the project holds no Group", () => {
    useProjectStore.getState().apply(summaryFixture());
    const { container } = renderSection();
    expect(container.innerHTML).toBe("");
  });

  it("tags the orphan and dims it, leaving the referenced row plain", () => {
    seed();
    renderSection();
    expect(row("comp-a").getAttribute("data-ref-count")).toBe("1");
    expect(row("comp-b").getAttribute("data-ref-count")).toBe("0");
    expect(row("comp-a").className).not.toContain("opacity-55");
    expect(row("comp-b").className).toContain("opacity-55");
    expect(row("comp-a").querySelector('[data-testid="group-pool-unused"]')).toBeNull();
    expect(row("comp-b").querySelector('[data-testid="group-pool-unused"]')).not.toBeNull();
    // The count reads as a sentence, not a bare number.
    expect(row("comp-a").textContent).toContain("1 ref");
    expect(row("comp-b").textContent).toContain("0 refs");
  });

  it("selects the composition on click, evicting any layer selection", async () => {
    seed();
    useSelectionStore.setState({
      primaryLayerId: "ref-1",
      selectedLayerIds: new Set(["ref-1"]),
    });
    renderSection();
    await userEvent.click(row("comp-b"));
    expect(useSelectionStore.getState().selectedCompositionId).toBe("comp-b");
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
  });

  it("drops the selection when the composition leaves the project", () => {
    seed();
    useSelectionStore.setState({ selectedCompositionId: "comp-b" });
    useProjectStore.getState().apply(
      summaryFixture({
        root: {
          tracks: [
            trackWith("track-1", [
              groupLayerFixture({ id: "ref-1", compositionId: "comp-a" }),
            ]),
          ],
        },
        groups: [compositionFixture({ id: "comp-a", duration_us: 2_000_000 })],
      }),
    );
    expect(useSelectionStore.getState().selectedCompositionId).toBeNull();
  });

  it("offers Delete only on the orphan, and commits compositions_delete", async () => {
    seed();
    const { onMutated } = renderSection();

    await userEvent.pointer({ target: row("comp-a"), keys: "[MouseRight]" });
    expect(menuItem(await screen.findByText("Delete Group")).getAttribute("data-disabled")).toBe("");
    await userEvent.keyboard("{Escape}");

    await userEvent.pointer({ target: row("comp-b"), keys: "[MouseRight]" });
    const enabled = await screen.findByText("Delete Group");
    expect(menuItem(enabled).getAttribute("data-disabled")).toBeNull();
    await userEvent.click(enabled);
    await waitFor(() => expect(compositionsDelete).toHaveBeenCalledWith("comp-b"));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("renames the COMPOSITION, seeding the field from the stored label only", async () => {
    seed();
    renderSection();
    await userEvent.pointer({ target: row("comp-a"), keys: "[MouseRight]" });
    await userEvent.click(await screen.findByText("Rename group…"));
    const field = await screen.findByRole("textbox");
    // Seeded from the STORED label, which is absent here — the derived name is
    // only the placeholder, so an untouched field would change nothing.
    expect((field as HTMLInputElement).value).toBe("");
    expect(field.getAttribute("placeholder")).toBe("Group 1");
    await userEvent.type(field, "Intro{Enter}");
    await waitFor(() => expect(groupsRename).toHaveBeenCalledWith("comp-a", "Intro"));
  });

  it("filters on the pool's own search text", () => {
    seed();
    renderSection("group 2");
    expect(document.querySelector('[data-composition-id="comp-a"]')).toBeNull();
    expect(row("comp-b")).toBeTruthy();
  });
});
