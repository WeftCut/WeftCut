// @vitest-environment jsdom
//
// A composition is inspectable without a clip. Selecting a row in the media
// pool's Groups section puts the COMPOSITION in the Attribute panel — which is
// the only way to read or name an orphan, since an orphan has no Group clip to
// select. Drives the real `AttributePanel` and the real `../i18n`, so a missing
// translation surfaces as a raw `property_panel.*` key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, groupsRename: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, ariaLabel }: { checked: boolean; ariaLabel?: string }) => (
    <button role="switch" aria-checked={checked} aria-label={ariaLabel} />
  ),
}));

import { groupsRename, type TrackSummary } from "../ipc";
import { AttributePanel } from "./PropertyPanel";
import { clearPropSectionMemory } from "./PropSection";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setCompositionSelection,
} from "../state/selectionStore";
import { compositionFixture, groupLayerFixture, summaryFixture } from "../testing/summaryFixture";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearPropSectionMemory();
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

function trackWith(layers: TrackSummary["layers"]): TrackSummary {
  return {
    id: "track-1",
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

/// `comp-a` placed once, `comp-b` an orphan at a different canvas size.
function seed() {
  useProjectStore.getState().apply(
    summaryFixture({
      root: {
        tracks: [trackWith([groupLayerFixture({ id: "ref-1", compositionId: "comp-a" })])],
      },
      groups: [
        compositionFixture({ id: "comp-a", duration_us: 2_000_000 }),
        compositionFixture({
          id: "comp-b",
          width: 640,
          height: 360,
          duration_us: 5_000_000,
        }),
      ],
    }),
  );
}

function renderPanel() {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  return {
    onMutated,
    ...render(
      <AttributePanel
        tracks={[]}
        selectedLayerId={null}
        onMutated={onMutated}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={0}
      />,
    ),
  };
}

describe("the composition branch of the Attribute panel", () => {
  it("shows the orphan's name, size, duration and reference count", async () => {
    seed();
    setCompositionSelection("comp-b");
    renderPanel();
    // Group 2: the ordinals count unlabelled compositions in creation order.
    expect(await screen.findByText("Group 2")).toBeTruthy();
    expect(screen.getByText("640 × 360")).toBeTruthy();
    expect(screen.getByText("00:00:05:00")).toBeTruthy();
    expect(screen.getByText("0 refs")).toBeTruthy();
  });

  it("counts the references of a placed composition", async () => {
    seed();
    setCompositionSelection("comp-a");
    renderPanel();
    expect(await screen.findByText("1 ref")).toBeTruthy();
    expect(screen.getByText("1920 × 1080")).toBeTruthy();
  });

  it("names the composition through groups_rename, not a layer label", async () => {
    seed();
    setCompositionSelection("comp-b");
    const { onMutated } = renderPanel();
    const field = await screen.findByLabelText("Name");
    expect((field as HTMLInputElement).value).toBe("");
    await userEvent.type(field, "Outro");
    await userEvent.tab();
    await waitFor(() => expect(groupsRename).toHaveBeenCalledWith("comp-b", "Outro"));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("falls back to the empty placeholder when nothing is selected", () => {
    seed();
    renderPanel();
    expect(screen.getByText("Select a layer to edit its properties.")).toBeTruthy();
  });
});
