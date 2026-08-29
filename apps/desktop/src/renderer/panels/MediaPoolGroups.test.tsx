// @vitest-environment jsdom
//
// Groups as cards in the pool's ONE list: the order they take among media, the
// glyph that stands where a thumbnail would, the card an orphan keeps, the
// Delete its menu only offers when nothing references it, and the selection
// that puts a composition in the inspector with no clip involved.
//
// Drives the real Panel against a seeded project store and the real `../i18n`,
// so a missing translation surfaces as a raw `media_pool.*` key.
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
    getMediaThumbnail: vi.fn().mockRejectedValue("not_ready"),
  };
});

import {
  compositionsDelete,
  groupsRename,
  type MediaSummary,
  type ProjectSummary,
  type TrackSummary,
} from "../ipc";
import { MediaPool } from "./MediaPool";
import { useProjectStore } from "../state/projectStore";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  clearLayerSelection,
  currentSelection,
  setCompositionSelection,
  setLayerSelection,
} from "../state/selectionStore";
import { MEDIA_DRAG_TYPE, useMediaDragStore } from "../timeline/mediaDrag";
import {
  compositionFixture,
  groupLayerFixture,
  summaryFixture,
} from "../testing/summaryFixture";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearLayerSelection();
  useMediaDragStore.getState().end();
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

function mediaFixture(id: string, label: string): MediaSummary {
  return {
    id,
    label,
    path: `/media/${id}.mp4`,
    kind: "Video",
    duration_us: 1_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1024,
    available: true,
    decode_route: { route: "bypass" },
    codec: null,
    pix_fmt: null,
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

function renderPool(media: MediaSummary[] = []) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  return {
    onMutated,
    ...render(
      <MediaPool
        media={media}
        tracks={[]}
        importing={new Set()}
        proxyState={new Map()}
        previewDecodable={new Set()}
        fpsNum={30}
        fpsDen={1}
        onCancelImport={vi.fn().mockResolvedValue(undefined)}
        onMutated={onMutated}
        onImportMedia={vi.fn().mockResolvedValue(undefined)}
      />,
    ),
  };
}

/// The clickable `app-menu-item` a Base UI menu row's label sits inside — the
/// label is a span, and `disabled` lands on the item.
const menuItem = (label: HTMLElement): HTMLElement => {
  const item = label.closest(".app-menu-item");
  if (!(item instanceof HTMLElement)) throw new Error("menu label is not inside an item");
  return item;
};

const card = (compositionId: string): HTMLElement => {
  const el = document.querySelector(`[data-composition-id="${compositionId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no pool card for ${compositionId}`);
  return el;
};

/// Every card in the list, in list order, by the id attribute its kind carries.
const cardIds = (): string[] =>
  Array.from(document.querySelectorAll(".media-list > li")).map(
    (li) =>
      li.getAttribute("data-media-id") ?? li.getAttribute("data-composition-id") ?? "?",
  );

async function search(text: string) {
  await userEvent.type(screen.getByRole("searchbox"), text);
}

describe("one pool list", () => {
  it("holds both kinds in one name-sorted list", () => {
    seed();
    renderPool([mediaFixture("m-z", "zebra.mp4"), mediaFixture("m-a", "alpha.mp4")]);
    expect(document.querySelectorAll(".media-list")).toHaveLength(1);
    expect(cardIds()).toEqual(["m-a", "comp-a", "comp-b", "m-z"]);
  });

  it("filters both kinds from the one search box", async () => {
    seed();
    renderPool([mediaFixture("m-a", "alpha.mp4")]);
    await search("group 2");
    expect(cardIds()).toEqual(["comp-b"]);
  });

  it("distinguishes an unmatched query from an empty pool, Groups counting as content", async () => {
    seed();
    // No media at all: the pool is still not empty, and the placeholder must not
    // claim it is.
    renderPool();
    await search("nothing");
    expect(screen.getByText("No matches for “nothing”.")).toBeTruthy();
    expect(screen.queryByText("No media imported yet.")).toBeNull();
  });

  it("keeps the empty state when the project holds neither kind", () => {
    useProjectStore.getState().apply(summaryFixture());
    renderPool();
    expect(screen.getByText("No media imported yet.")).toBeTruthy();
    expect(document.querySelector(".media-list")).toBeNull();
  });
});

describe("a Group card", () => {
  it("wears the media card skin and shows a glyph where a thumbnail would be", () => {
    seed();
    renderPool([mediaFixture("m-a", "alpha.mp4")]);
    expect(card("comp-a").classList.contains("media-item")).toBe(true);
    expect(card("comp-a").querySelector(".media-group-glyph")).not.toBeNull();
    // Never a thumbnail: a composition has no fixed frame to show.
    expect(card("comp-a").querySelector(".media-thumbnail")).toBeNull();
    expect(card("comp-a").querySelector(".media-kind")?.textContent).toBe("Group");
    // …and the media card beside it is unchanged.
    expect(
      document.querySelector('[data-media-id="m-a"] .media-thumbnail'),
    ).not.toBeNull();
  });

  it("tags the orphan and dims it, leaving the referenced card plain", () => {
    seed();
    renderPool();
    expect(card("comp-a").getAttribute("data-ref-count")).toBe("1");
    expect(card("comp-b").getAttribute("data-ref-count")).toBe("0");
    expect(card("comp-a").classList.contains("is-isolated")).toBe(false);
    expect(card("comp-b").classList.contains("is-isolated")).toBe(true);
    expect(card("comp-a").querySelector('[data-testid="group-pool-isolated"]')).toBeNull();
    expect(card("comp-b").querySelector('[data-testid="group-pool-isolated"]')).not.toBeNull();
    // The count reads as a sentence, not a bare number.
    expect(card("comp-a").textContent).toContain("1 ref");
    expect(card("comp-b").textContent).toContain("0 refs");
  });

  it("refuses the drag on an empty composition, in the treatment media's not-ready cards wear", () => {
    useProjectStore.getState().apply(
      summaryFixture({ groups: [compositionFixture({ id: "comp-empty" })] }),
    );
    renderPool();
    expect(card("comp-empty").draggable).toBe(false);
    expect(card("comp-empty").classList.contains("is-not-placeable")).toBe(true);
    // One treatment, its own reason.
    expect(card("comp-empty").getAttribute("title")).toBe(
      "This Group is empty. Open it and add a layer first.",
    );
  });

  it("carries the composition, not a media id, into a timeline drop", () => {
    seed();
    renderPool();
    const setData = vi.fn();
    const target = card("comp-a");
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      dataTransfer: { value: { setData, setDragImage: vi.fn(), effectAllowed: "none" } },
      clientX: { value: 20 },
      clientY: { value: 30 },
    });
    target.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith(MEDIA_DRAG_TYPE, expect.any(String));
    expect(JSON.parse(setData.mock.calls[0]![1] as string)).toMatchObject({
      source: "composition",
      compositionId: "comp-a",
      label: "Group 1",
      durationUs: 2_000_000,
    });
  });
});

describe("Group card interactions", () => {
  it("selects the composition on click, evicting any layer selection", async () => {
    seed();
    setLayerSelection("ref-1", ["ref-1"]);
    renderPool();
    await userEvent.click(card("comp-b"));
    expect(currentSelection()).toEqual({ kind: "group", id: "comp-b" });
  });

  it("opens the composition on Enter, as double-click does", async () => {
    seed();
    renderPool();
    card("comp-b").focus();
    await userEvent.keyboard("{Enter}");
    expect(useCompositionAnchorStore.getState().focusedId).toBe("comp-b");
  });

  it("drops the selection when the composition leaves the project", () => {
    seed();
    setCompositionSelection("comp-b");
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
    expect(currentSelection()).toEqual({ kind: "none" });
  });

  it("offers Delete only on the orphan, and commits compositions_delete", async () => {
    seed();
    const { onMutated } = renderPool();

    await userEvent.pointer({ target: card("comp-a"), keys: "[MouseRight]" });
    expect(menuItem(await screen.findByText("Delete Group")).getAttribute("data-disabled")).toBe("");
    await userEvent.keyboard("{Escape}");

    await userEvent.pointer({ target: card("comp-b"), keys: "[MouseRight]" });
    const enabled = await screen.findByText("Delete Group");
    expect(menuItem(enabled).getAttribute("data-disabled")).toBeNull();
    await userEvent.click(enabled);
    await waitFor(() => expect(compositionsDelete).toHaveBeenCalledWith("comp-b"));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("renames the COMPOSITION, seeding the field from the stored label only", async () => {
    seed();
    renderPool();
    await userEvent.pointer({ target: card("comp-a"), keys: "[MouseRight]" });
    await userEvent.click(await screen.findByText("Rename group…"));
    const field = await screen.findByRole("textbox");
    // Seeded from the STORED label, which is absent here — the derived name is
    // only the placeholder, so an untouched field would change nothing.
    expect((field as HTMLInputElement).value).toBe("");
    expect(field.getAttribute("placeholder")).toBe("Group 1");
    await userEvent.type(field, "Intro{Enter}");
    await waitFor(() => expect(groupsRename).toHaveBeenCalledWith("comp-a", "Intro"));
  });
});
