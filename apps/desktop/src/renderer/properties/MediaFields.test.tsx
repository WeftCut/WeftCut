// @vitest-environment jsdom
//
// A media item is inspectable without a clip. Picking a card in the pool puts
// the FILE in the Attribute panel — what it is, and every clip that shows it,
// which until now could only be learned by pretending to delete it. Drives the
// real `AttributePanel` and the real `../i18n`, so a missing translation
// surfaces as a raw `property_panel.*` key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";

vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../state/navigation", () => ({ jumpToLayer: vi.fn(() => true) }));

import type { LayerSummary, MediaSummary, TrackSummary } from "../ipc";
import { AttributePanel } from "./PropertyPanel";
import { clearPropSectionMemory } from "./PropSection";
import { jumpToLayer } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  currentSelection,
  setMediaSelection,
} from "../state/selectionStore";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearPropSectionMemory();
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

const MEDIA: MediaSummary = {
  id: "m-1",
  label: "interview.mov",
  path: "/media/interview.mov",
  kind: "Video",
  duration_us: 12_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 3_145_728,
  available: true,
  decode_route: { route: "direct-export", quick_proxy: "/proxies/m-1.mp4" },
  codec: "hevc",
  pix_fmt: "yuv420p10le",
  color_matrix: "bt709",
  color_range: "tv",
};

function audioLayer(id: string, label: string | null, tStartUs: number): LayerSummary {
  return {
    id,
    label,
    t_start_us: tStartUs,
    t_end_us: tStartUs + 1_000_000,
    kind: "Audio",
    color_hint: "audio",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Audio",
      media_id: MEDIA.id,
      media_label: MEDIA.label,
      src_in_us: 0,
      src_out_us: 1_000_000,
      gain_db: { mode: "Static", value: 0 },
      pan: { mode: "Static", value: 0 },
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "dialogue",
    },
  };
}

function trackWith(
  id: string,
  label: string | null,
  layers: LayerSummary[],
): TrackSummary {
  return {
    id,
    kind: "Audio",
    label,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

/// One clip on the root, one inside a Group — the case a per-composition list
/// would under-report.
function seed(media: MediaSummary[] = [MEDIA]) {
  useProjectStore.getState().apply(
    summaryFixture({
      media,
      root: {
        tracks: [
          trackWith("track-1", "Dialogue", [
            audioLayer("layer-1", "Interview clip", 2_000_000),
          ]),
        ],
      },
      groups: [
        compositionFixture({
          id: "comp-a",
          duration_us: 6_000_000,
          tracks: [trackWith("track-2", null, [audioLayer("layer-2", null, 5_000_000)])],
        }),
      ],
    }),
  );
}

function renderPanel() {
  return render(
    <AttributePanel
      tracks={[]}
      selectedLayerId={null}
      onMutated={vi.fn().mockResolvedValue(undefined)}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={0}
    />,
  );
}

describe("the media branch of the Attribute panel", () => {
  it("describes the file from the summary the store already holds", async () => {
    seed();
    setMediaSelection("m-1");
    renderPanel();

    expect(await screen.findByText("interview.mov")).toBeTruthy();
    expect(screen.getByText("1920×1080")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
    expect(screen.getByText("00:12")).toBeTruthy();
    expect(screen.getByText("/media/interview.mov")).toBeTruthy();
    expect(screen.getByText("hevc")).toBeTruthy();
    expect(screen.getByText("yuv420p10le")).toBeTruthy();
    expect(screen.getByText("bt709 · tv")).toBeTruthy();
    // Route plus the proxy's readiness — the two halves of "where does preview
    // decode from".
    expect(
      screen.getByText("Original, proxy for preview · proxy ready"),
    ).toBeTruthy();
  });

  it("reports a route whose proxy has not landed as pending", async () => {
    seed([{ ...MEDIA, decode_route: { route: "direct-export", quick_proxy: null } }]);
    setMediaSelection("m-1");
    renderPanel();

    expect(
      await screen.findByText("Original, proxy for preview · proxy pending"),
    ).toBeTruthy();
  });

  it("lists every clip that shows it, across compositions", async () => {
    seed();
    setMediaSelection("m-1");
    renderPanel();

    expect(await screen.findByText("Interview clip")).toBeTruthy();
    expect(screen.getByText("Dialogue · 00:00:02:00")).toBeTruthy();
    // The Group's clip is unlabelled, so it reads as its kind — and the row
    // names the Group, because "Track 1" alone would not say which timeline.
    expect(screen.getByText("Group 1 · Track 1 · 00:00:05:00")).toBeTruthy();
  });

  it("navigates to the clip a reference row names", async () => {
    seed();
    setMediaSelection("m-1");
    renderPanel();

    await userEvent.click(await screen.findByText("Group 1 · Track 1 · 00:00:05:00"));

    expect(jumpToLayer).toHaveBeenCalledWith("layer-2");
  });

  it("says nothing is wrong about an unplaced item", async () => {
    useProjectStore.getState().apply(summaryFixture({ media: [MEDIA] }));
    setMediaSelection("m-1");
    renderPanel();

    expect(await screen.findByText("Not used on any timeline.")).toBeTruthy();
  });

  it("falls back to the empty placeholder when the media leaves the pool", () => {
    seed();
    setMediaSelection("m-1");
    renderPanel();

    act(() => useProjectStore.getState().apply(summaryFixture()));

    expect(currentSelection()).toEqual({ kind: "none" });
    expect(screen.getByText("Select a layer to edit its properties.")).toBeTruthy();
  });
});
