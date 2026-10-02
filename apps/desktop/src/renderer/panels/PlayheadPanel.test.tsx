// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { LayerSummary, LinkSummary, TrackSummary } from "../ipc";

// `deltaWindowUs` is mutable so the ±Δ dial's tests can assert what a
// non-preset value does without reaching for the real store.
const settings = vi.hoisted(() => ({
  displayMode: "AbRoll",
  deltaWindowUs: 5_000_000,
  setAppSettings: vi.fn(),
}));

vi.mock("../settings/appSettingsStore", () => ({
  useDeltaWindowUs: () => settings.deltaWindowUs,
  useDisplayMode: () => settings.displayMode,
  setAppSettings: settings.setAppSettings,
}));

// Mutable so the drag-restack tests can tick the playhead mid-gesture (the
// panel re-reads it per render; a rerender stands in for the store's throttle).
const playhead = vi.hoisted(() => ({ timeUs: 1_000_000 }));

vi.mock("../state/playheadStore", () => ({
  usePlayheadTimeUsThrottled: () => playhead.timeUs,
}));

vi.mock("./MediaThumbnail", () => ({
  MediaThumbnail: () => <span>thumbnail</span>,
}));

// The link action commits straight through IPC (the `project:changed` bridge
// refreshes the summary), so the panel test observes the IPC calls themselves.
const ipcMocks = vi.hoisted(() => ({
  linksDissolve: vi.fn(async () => {}),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    linksDissolve: ipcMocks.linksDissolve,
  };
});

import { PlayheadPanel, type PlayheadPanelProps } from "./PlayheadPanel";

// jsdom has no PointerEvent constructor; MouseEvent carries the same client
// coordinates the pointer sequence needs (EffectsSection.test.tsx prior art).
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

beforeEach(() => {
  settings.displayMode = "AbRoll";
  settings.deltaWindowUs = 5_000_000;
  settings.setAppSettings.mockClear();
  ipcMocks.linksDissolve.mockClear();
  playhead.timeUs = 1_000_000;
});

afterEach(() => cleanup());

function makeLayer(
  id: string,
  label: string | null,
  kind: string,
  startUs: number,
  endUs: number,
): LayerSummary {
  return {
    id,
    kind,
    label,
    t_start_us: startUs,
    t_end_us: endUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind } as LayerSummary["params"],
    effects: [],
  };
}

function makeTrack(
  id: string,
  label: string,
  kind: string,
  layers: LayerSummary[],
): TrackSummary {
  return {
    id,
    kind,
    label,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers,
  };
}

function nearbyTrack(): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "B-roll",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [makeLayer("layer-1", "Clip one", "Color", 500_000, 1_500_000)],
  };
}

// Playhead is mocked at 1s. Track array order is bottom-of-z-stack first:
// Wash sits at the bottom, Song (audio) above it, Logo on top; Later is a
// text layer strictly in the future, so it lands in the Nearby section.
function stackedTracks(): TrackSummary[] {
  return [
    makeTrack("t-wash", "Wash lane", "Video", [
      makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
    ]),
    makeTrack("t-song", "Song lane", "Audio", [
      makeLayer("l-song", "Song", "Audio", 0, 2_000_000),
    ]),
    makeTrack("t-logo", "Logo lane", "Video", [
      makeLayer("l-logo", "Logo", "ImageOverlay", 500_000, 1_500_000),
    ]),
    makeTrack("t-later", "Later lane", "Video", [
      makeLayer("l-later", "Later", "Text", 2_000_000, 3_000_000),
    ]),
  ];
}

function renderPanel(
  tracks: TrackSummary[],
  handlers: {
    onPick?: (layerId: string, trackId: string) => void;
    onGoTo?: (layerId: string, trackId: string, startUs: number) => void;
    onRename?: (layerId: string, nextLabel: string) => void;
    onRestack?: PlayheadPanelProps["onRestack"];
  } = {},
  links: LinkSummary[] = [],
) {
  const onPick = handlers.onPick ?? vi.fn();
  const { container, rerender } = render(
    <PlayheadPanel
      tracks={tracks}
      links={links}
      selectedLayerId={null}
      fpsNum={30}
      fpsDen={1}
      onPick={onPick}
      onGoTo={handlers.onGoTo}
      onRename={handlers.onRename}
      onRestack={handlers.onRestack}
    />,
  );
  const rerenderPanel = () =>
    rerender(
      <PlayheadPanel
        tracks={tracks}
        links={links}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={onPick}
        onGoTo={handlers.onGoTo}
        onRename={handlers.onRename}
        onRestack={handlers.onRestack}
      />,
    );
  return { onPick, container, rerenderPanel };
}

describe("PlayheadPanel reserved visual track references", () => {
  function reservedStack(): TrackSummary[] {
    return [
      { ...makeTrack("a", "A Roll", "Video", []), role: "a-roll", transient: false },
      { ...makeTrack("b", "B Roll", "Video", [makeLayer("b-clip", "Cutaway", "Color", 0, 2_000_000)]), role: "b-roll", transient: false },
      makeTrack("overlay", "Overlay", "Video", [makeLayer("overlay-clip", "Logo", "ImageOverlay", 0, 2_000_000)]),
      { ...makeTrack("audio", "Dialogue", "Audio", []), role: "audio-a", transient: false },
    ];
  }

  it("shows occupied and empty references as read-only boundaries in real stack order, without grips or audio references", () => {
    const { onPick } = renderPanel(reservedStack(), { onRestack: vi.fn() });
    const stack = screen.getByRole("region", { name: "Now playing" });
    expect(Array.from(stack.querySelectorAll("li")).map(el => el.textContent)).toEqual([
      expect.stringContaining("Logo"), expect.stringContaining("B Roll"), expect.stringContaining("A Roll"),
    ]);
    expect(screen.getByText("No visual content")).toBeTruthy();
    expect(screen.queryByText("Dialogue")).toBeNull();
    expect(screen.queryByLabelText("Drag to restack Cutaway")).toBeNull();
    for (const reference of screen.getAllByTestId("playhead-track-reference")) {
      expect(within(reference).queryByRole("button")).toBeNull();
      expect(reference.querySelector(".playhead-item-row")).toBeNull();
    }
    fireEvent.click(screen.getByTitle("Cutaway"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps empty references when the entire observation window is empty", () => {
    const tracks = reservedStack().filter(t => t.role === "a-roll" || t.role === "b-roll").map(t => ({ ...t, layers: [] }));
    renderPanel(tracks);
    expect(screen.getByRole("region", { name: "Now playing" }).querySelectorAll("li")).toHaveLength(2);
    expect(screen.getAllByText("No visual content")).toHaveLength(2);
  });

  it("preserves references under a category filter and distinguishes filtered contents from gaps", async () => {
    renderPanel(reservedStack());
    await userEvent.click(screen.getByRole("checkbox", { name: "Text" }));
    expect(screen.getByText("B Roll")).toBeTruthy();
    expect(screen.getByText("A Roll")).toBeTruthy();
    expect(screen.getByText("Content filtered")).toBeTruthy();
    expect(screen.queryByTitle("Cutaway")).toBeNull();
  });

  it("measures reference rows as drop targets and emits one command below an empty A Roll", () => {
    const onRestack = vi.fn();
    renderPanel(reservedStack(), { onRestack });
    const stack = screen.getByRole("region", { name: "Now playing" });
    Array.from(stack.querySelectorAll("li")).forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 40, height: 40, left: 0, right: 120, width: 120, x: 0, y: i * 40, toJSON: () => ({}) }) as DOMRect;
    });
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), { button: 0, clientX: 8, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 115 });
    expect(onRestack).not.toHaveBeenCalled();
    expect(stack.querySelector(".playhead-row--drop-after")?.textContent).toContain("A Roll");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 115 });
    expect(onRestack).toHaveBeenCalledExactlyOnceWith("overlay-clip", { kind: "track", id: "a" }, "below");
  });

  it("provides a keyboard menu action to place the clip below empty A Roll", async () => {
    const onRestack = vi.fn();
    renderPanel(reservedStack(), { onRestack });
    fireEvent.keyDown(screen.getByTitle("Logo"), { key: "F10", shiftKey: true });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Place below A Roll" }));
    expect(onRestack).toHaveBeenCalledExactlyOnceWith("overlay-clip", { kind: "track", id: "a" }, "below");
  });

  it("freezes reference contents through playhead ticks during a drag and restores live contents on cancel", () => {
    const { rerenderPanel } = renderPanel(reservedStack(), { onRestack: vi.fn() });
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), { button: 0, clientX: 8, clientY: 10 });
    playhead.timeUs = 3_000_000;
    rerenderPanel();
    expect(screen.getByTitle("Cutaway")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTitle("Cutaway")).toBeNull();
    expect(screen.getAllByText("No visual content")).toHaveLength(2);
  });
});

/// Row titles inside `root`, in DOM order — the row button carries the
/// layer's display name as its title.
function rowTitles(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll(".playhead-item")).map((el) =>
    el.getAttribute("title"),
  );
}

describe("PlayheadPanel", () => {
  it.each([255, 128, 0])("shows a Color clip's actual RGB and alpha (%s) instead of a video icon", (alpha) => {
    const track = nearbyTrack();
    track.layers[0]!.params = {
      kind: "Color", width: 640, height: 360,
      color: { mode: "Static", value: { r: 12, g: 34, b: 56, a: alpha } },
    };
    renderPanel([track]);
    const thumb = screen.getByTitle("Clip one").querySelector(".playhead-thumb")!;
    expect(thumb.querySelector("svg")).toBeNull();
    expect(thumb.classList.contains("playhead-thumb--color")).toBe(true);
    const fill = thumb.querySelector<HTMLElement>(".playhead-color-fill")!;
    if (alpha === 255) expect(fill.style.backgroundColor).toBe("rgb(12, 34, 56)");
    else expect(fill.style.backgroundColor).toBe(`rgba(12, 34, 56, ${Math.round(alpha / 255 * 1000) / 1000})`);
  });

  it("updates a keyframed Color thumbnail using clip-local time and the nearest edge for Nearby clips", () => {
    const track = nearbyTrack();
    track.layers[0]!.params = {
      kind: "Color", width: 640, height: 360,
      color: {
        mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
        value: [
          { id: "red", t_us: 0, value: { r: 255, g: 0, b: 0, a: 255 },
            in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
            continuity: "Broken", segment: { kind: "Hold" } },
          { id: "green", t_us: 1_000_000, value: { r: 0, g: 255, b: 0, a: 255 },
            in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
            continuity: "Broken", segment: { kind: "Hold" } },
        ],
      },
    };
    const { rerenderPanel } = renderPanel([track]);
    const fillColor = () => screen.getByTitle("Clip one").querySelector<HTMLElement>(".playhead-color-fill")!.style.backgroundColor;
    expect(fillColor()).toBe("rgb(255, 0, 0)");
    playhead.timeUs = 2_000_000;
    rerenderPanel();
    expect(fillColor()).toBe("rgb(0, 255, 0)");
    playhead.timeUs = 0;
    rerenderPanel();
    expect(fillColor()).toBe("rgb(255, 0, 0)");
  });

  it("explains All Tracks instead of collapsing to a blank Panel", () => {
    settings.displayMode = "AllTracks";
    const { container } = render(
      <PlayheadPanel
        tracks={[nearbyTrack()]}
        links={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("All Tracks")).toBeTruthy();
    // The explainer hands back the way out, and names the key from the
    // effective bindings rather than a literal — no provider here, so this is
    // the default chord (`Shift+T`; the bare `T` arms the Text tool).
    expect(container.querySelector(".playhead-empty-kbd")?.textContent).toBe("Shift+T");
  });

  // The other idle state has no single key that fixes it, so it offers none.
  it("offers no key hint on the empty-window explainer", () => {
    const { container } = render(
      <PlayheadPanel
        tracks={[]}
        links={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(container.querySelector(".playhead-empty-kbd")).toBeNull();
  });

  it("explains an empty playhead window instead of a blank Panel", () => {
    render(
      <PlayheadPanel
        tracks={[]}
        links={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );

    expect(screen.getByText("Nothing near the playhead")).toBeTruthy();
  });

  // The dock tab is the Panel's title; a Panel that prints its own name spends
  // its first line saying nothing. Asserted structurally rather than by copy,
  // so no wording of a heading can slip past it.
  it("prints no title bar of its own in any state", () => {
    const { container, rerender } = render(
      <PlayheadPanel
        tracks={[nearbyTrack()]}
        links={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );
    expect(container.querySelector("header")).toBeNull();

    settings.displayMode = "AllTracks";
    rerender(
      <PlayheadPanel
        tracks={[nearbyTrack()]}
        links={[]}
        selectedLayerId={null}
        fpsNum={30}
        fpsDen={1}
        onPick={() => {}}
      />,
    );
    expect(container.querySelector("header")).toBeNull();
  });

  describe("the ±Δ window dial", () => {
    it("shows the current window as a compact duration", () => {
      renderPanel([nearbyTrack()]);

      expect(
        screen.getByLabelText("Playhead window").textContent,
      ).toContain("±5s");
    });

    it("writes the picked preset to app settings", async () => {
      renderPanel([nearbyTrack()]);

      await userEvent.click(screen.getByLabelText("Playhead window"));
      await userEvent.click(await screen.findByRole("option", { name: "±30s" }));

      expect(settings.setAppSettings).toHaveBeenCalledWith({
        delta_window_us: 30_000_000,
      });
    });

    // Whole minutes read in minutes — the presets run to 5 min, and
    // "±300s" is the same number said badly.
    it("reads whole minutes in minutes", () => {
      settings.deltaWindowUs = 120_000_000;
      renderPanel([nearbyTrack()]);

      expect(
        screen.getByLabelText("Playhead window").textContent,
      ).toContain("±2min");
    });

    // A value written straight into app_settings.json (or by MCP) is still the
    // live setting; a select whose value is absent from its options renders a
    // blank trigger, which would read as "unset".
    it("keeps an out-of-band window visible by joining it to the presets", () => {
      settings.deltaWindowUs = 7_000_000;
      renderPanel([nearbyTrack()]);

      expect(
        screen.getByLabelText("Playhead window").textContent,
      ).toContain("±7s");
    });

    // An empty window is exactly when the user wants to widen it, so the dial
    // outlives the rows — only the chips, which have nothing to filter, grey out.
    it("stays reachable on an empty window while the chips grey out", () => {
      render(
        <PlayheadPanel
          tracks={[]}
          links={[]}
          selectedLayerId={null}
          fpsNum={30}
          fpsDen={1}
          onPick={() => {}}
        />,
      );

      expect(screen.getByLabelText("Playhead window")).toBeTruthy();
      expect(
        screen.getByRole("checkbox", { name: "Video" }).hasAttribute("disabled"),
      ).toBe(true);
    });
  });

  it("renders the window's items and reveals the picked layer without seeking", () => {
    const { onPick } = renderPanel([nearbyTrack()]);

    const stack = screen.getByRole("region", { name: "Now playing" });
    expect(within(stack).getByText("1")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Clip one"));
    expect(onPick).toHaveBeenCalledWith("layer-1", "track-1");
  });

  // Shared naming with the timeline block and the inspector: a row must name
  // the Layer it stands for, never fall back to its track's name.
  it("names an unnamed layer by its kind, not by its track", () => {
    const track = nearbyTrack();
    (track.layers[0] as { label: string | null }).label = null;
    renderPanel([track]);

    expect(screen.getByTitle("Color")).toBeTruthy();
    expect(screen.queryByTitle("B-roll")).toBeNull();
  });

  it("Go To seeks to the layer's start", () => {
    const onGoTo = vi.fn();
    renderPanel([nearbyTrack()], { onGoTo });

    const button = screen.getByLabelText("Jump to clip start");
    expect(button.getAttribute("title")).toBe("Jump to clip start");
    fireEvent.click(button);
    expect(onGoTo).toHaveBeenCalledWith("layer-1", "track-1", 500_000);
  });

  it("double-click renames through the label command on Enter", () => {
    const onRename = vi.fn();
    renderPanel([nearbyTrack()], { onRename });

    fireEvent.doubleClick(screen.getByTitle("Clip one"));
    const input = screen.getByLabelText("Rename Clip one");
    fireEvent.change(input, { target: { value: "Renamed clip" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("layer-1", "Renamed clip");
  });

  it("Escape cancels an inline rename without committing", () => {
    const onRename = vi.fn();
    renderPanel([nearbyTrack()], { onRename });

    fireEvent.doubleClick(screen.getByTitle("Clip one"));
    const input = screen.getByLabelText("Rename Clip one");
    fireEvent.change(input, { target: { value: "Renamed clip" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("PlayheadPanel two sections", () => {
  it("splits rows at the playhead into an At-playhead stack and a Nearby list", () => {
    const { container } = renderPanel(stackedTracks());

    // The playhead boundary is the ONLY thing that opens a section — category
    // never does. Each header is trailed by the count of the rows beneath it.
    const headers = Array.from(
      container.querySelectorAll(".playhead-section-header"),
    ).map((el) => el.textContent);
    expect(headers).toEqual(["Now playing3", "Nearby1"]);

    // Visuals order top-of-stack first (Logo's track is above Wash's);
    // the spanning audio row sinks to the tail despite its track position.
    const stack = screen.getByRole("region", { name: "Now playing" });
    expect(rowTitles(stack)).toEqual(["Logo", "Wash", "Song"]);

    const near = screen.getByRole("region", { name: "Nearby" });
    expect(rowTitles(near)).toEqual(["Later"]);
  });

  it("shows a short hint when nothing spans the playhead", () => {
    renderPanel([
      makeTrack("t-later", "Later lane", "Video", [
        makeLayer("l-later", "Later", "Text", 2_000_000, 3_000_000),
      ]),
    ]);

    const stack = screen.getByRole("region", { name: "Now playing" });
    expect(
      within(stack).getByText("Nothing is playing right now"),
    ).toBeTruthy();
    expect(rowTitles(screen.getByRole("region", { name: "Nearby" }))).toEqual([
      "Later",
    ]);
  });

  it("filters both sections through the chips", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("checkbox", { name: "Audio" }));

    expect(
      rowTitles(screen.getByRole("region", { name: "Now playing" })),
    ).toEqual(["Song"]);
    expect(screen.queryByTitle("Logo")).toBeNull();
    expect(screen.queryByTitle("Later")).toBeNull();
    // An emptied Nearby section disappears rather than sitting as a bare header.
    expect(screen.queryByRole("region", { name: "Nearby" })).toBeNull();
  });

  it("a filter can empty the stack: the hint shows while Nearby keeps its rows", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("checkbox", { name: "Text" }));

    expect(
      screen.getByText("Nothing is playing right now"),
    ).toBeTruthy();
    expect(rowTitles(screen.getByRole("region", { name: "Nearby" }))).toEqual([
      "Later",
    ]);
  });

  it("keeps the filtered-empty message when nothing of the kind is in the window", () => {
    const { container } = renderPanel([nearbyTrack()]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Text" }));

    expect(
      screen.getByText("Nothing of the checked kinds near the playhead"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".playhead-section-header")).toHaveLength(0);
  });

  // Checking a second chip must WIDEN the result, never replace the first.
  it("unions the checked chips instead of switching between them", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("checkbox", { name: "Audio" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Text" }));

    expect(
      screen.getByRole("checkbox", { name: "Audio" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      rowTitles(screen.getByRole("region", { name: "Now playing" })),
    ).toEqual(["Song"]);
    expect(rowTitles(screen.getByRole("region", { name: "Nearby" }))).toEqual([
      "Later",
    ]);
    // Video stayed unchecked throughout, so its rows never came back.
    expect(screen.queryByTitle("Logo")).toBeNull();
  });

  // Unchecking the last category returns the unfiltered view, so no state is
  // stranded — the chips need no separate escape hatch.
  it("returns to the unfiltered view when the last chip is unchecked", () => {
    renderPanel(stackedTracks());

    fireEvent.click(screen.getByRole("checkbox", { name: "Audio" }));
    expect(screen.queryByTitle("Logo")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Audio" }));

    expect(
      screen.getByRole("checkbox", { name: "Audio" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      rowTitles(screen.getByRole("region", { name: "Now playing" })),
    ).toEqual(["Logo", "Wash", "Song"]);
  });

  // No chip starts checked — the Panel opens showing everything, which is what
  // makes "check nothing" the honest default rather than a state to escape.
  it("checks no chip on mount", () => {
    renderPanel(stackedTracks());

    for (const name of ["Video", "Audio", "Text"]) {
      expect(
        screen.getByRole("checkbox", { name }).getAttribute("aria-checked"),
      ).toBe("false");
    }
  });

  // Nothing on a row names its two times, so what this pins is what makes
  // them tellable apart: the playhead relation is a phrase carrying unit
  // letters, the length is MM:SS, and the field names live in the accessible
  // names — the one place they cost no width.
  it("prints a row's two times in two vocabularies and names both for a reader", () => {
    renderPanel(stackedTracks());

    const logo = screen.getByTitle("Logo");
    expect(within(logo).getByText("Logo lane")).toBeTruthy();
    // Logo runs 0.5s → 1.5s and the playhead sits at 1s: half a second left,
    // 15 frames at 30 fps. No LIVE badge — the section header said it already.
    expect(within(logo).getByText("15f left")).toBeTruthy();
    expect(within(logo).queryByText("LIVE")).toBeNull();
    // One second long, in the media pool's length vocabulary.
    expect(within(logo).getByText("00:01")).toBeTruthy();
    expect(within(logo).getByLabelText("15f left to play")).toBeTruthy();
    expect(within(logo).getByLabelText("Duration 00:01")).toBeTruthy();

    const later = screen.getByTitle("Later");
    // Later starts one second ahead of the playhead.
    expect(within(later).getByText("in 1s 0f")).toBeTruthy();
    expect(
      within(later).getByLabelText("Starts 1s 0f after the playhead"),
    ).toBeTruthy();
  });
});

describe("PlayheadPanel drag restack", () => {
  /// The At-playhead section's <li> rows in DOM order (visual stack first,
  /// audio tail after) — the elements the gesture hit-tests against.
  function stackRows(): HTMLElement[] {
    const stack = screen.getByRole("region", { name: "Now playing" });
    return Array.from(stack.querySelectorAll("li"));
  }

  // jsdom rects are all zero; give each row a real vertical slot so the
  // gesture math has something to hit (EffectsSection.test.tsx prior art).
  function mockRowRects(rows: HTMLElement[], tops: number[], height = 40) {
    rows.forEach((row, i) => {
      const top = tops[i];
      if (top === undefined) return;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 120,
          width: 120,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  /// stackedTracks rendered with a restack handler and the two visual rows
  /// (Logo on top, Wash below, Song as the grip-less audio tail) given rects.
  function renderStack(tracks = stackedTracks()) {
    const onRestack = vi.fn();
    const rendered = renderPanel(tracks, { onRestack });
    mockRowRects(stackRows(), [0, 40]);
    return { onRestack, ...rendered };
  }

  it("grips only the At-playhead visual rows; audio and Nearby rows carry none", () => {
    renderStack();

    expect(screen.getByLabelText("Drag to restack Logo")).toBeTruthy();
    expect(screen.getByLabelText("Drag to restack Wash")).toBeTruthy();
    // Audio mixes by role, never stacks; Nearby rows are not at the playhead.
    expect(screen.queryByLabelText("Drag to restack Song")).toBeNull();
    expect(screen.queryByLabelText("Drag to restack Later")).toBeNull();
  });

  it("renders no grips when the host wires no restack handler", () => {
    renderPanel(stackedTracks());
    expect(screen.queryByLabelText(/Drag to restack/)).toBeNull();
  });

  it("emits exactly one restack at drop, none mid-gesture, and never starts an HTML5 drag", () => {
    const { onRestack } = renderStack();
    const dragstart = vi.fn();
    document.addEventListener("dragstart", dragstart);
    try {
      const grip = screen.getByLabelText("Drag to restack Logo");
      expect(grip.getAttribute("draggable")).toBeNull();
      fireEvent.pointerDown(grip, { button: 0, clientX: 8, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

      // Live insertion indicator mid-gesture, but no command before release.
      const rows = stackRows();
      expect(rows[0]!.className).toContain("playhead-row--dragging");
      expect(rows[1]!.className).toContain("playhead-row--drop-after");
      expect(onRestack).not.toHaveBeenCalled();

      fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
      expect(onRestack).toHaveBeenCalledTimes(1);
      expect(onRestack).toHaveBeenCalledWith("l-logo", { kind: "layer", id: "l-wash" }, "below");
      expect(dragstart).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("dragstart", dragstart);
    }
  });

  it("opens the slot: rows past the gap part, the section flags parting, and the drag follows via --playhead-drag-y", () => {
    renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Wash"), {
      button: 0,
      clientX: 8,
      clientY: 50,
    });
    const section = screen.getByRole("region", { name: "Now playing" });
    // The follow offset resets at grab, before any move.
    expect(section.style.getPropertyValue("--playhead-drag-y")).toBe("0px");

    fireEvent.pointerMove(window, { clientX: 8, clientY: 5 });
    const rows = stackRows();
    expect(section.className).toContain("playhead-stack--parting");
    // Gap 0: Logo parts to open the slot; the dragged Wash never parts —
    // its transform is the pointer follow.
    expect(rows[0]!.className).toContain("playhead-row--parted");
    expect(rows[1]!.className).toContain("playhead-row--dragging");
    expect(rows[1]!.className).not.toContain("playhead-row--parted");
    expect(section.style.getPropertyValue("--playhead-drag-y")).toBe("-45px");
  });

  it("a no-op gap opens no slot: no parting flag, no parted rows", () => {
    const { container } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    // y=30 is the gap right below the dragged row — a no-op drop.
    fireEvent.pointerMove(window, { clientX: 8, clientY: 30 });
    const section = screen.getByRole("region", { name: "Now playing" });
    expect(section.className).toContain("playhead-stack--reordering");
    expect(section.className).not.toContain("playhead-stack--parting");
    expect(container.querySelector(".playhead-row--parted")).toBeNull();
  });

  it("dragging the bottom visual row above the top targets 'above' the top row", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Wash"), {
      button: 0,
      clientX: 8,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 5 });
    expect(stackRows()[0]!.className).toContain("playhead-row--drop-before");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 5 });
    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-wash", { kind: "layer", id: "l-logo" }, "above");
  });

  it("dropping at a no-op gap shows no indicator and emits nothing", () => {
    const { onRestack, container } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    // y=30 is past Logo's midline: the gap right below the dragged row.
    fireEvent.pointerMove(window, { clientX: 8, clientY: 30 });
    expect(container.querySelector(".playhead-row--drop-before")).toBeNull();
    expect(container.querySelector(".playhead-row--drop-after")).toBeNull();
    fireEvent.pointerUp(window, { clientX: 8, clientY: 30 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("Escape aborts the gesture; a later pointerup commits nothing", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    expect(stackRows()[1]!.className).toContain("playhead-row--drop-after");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(stackRows()[1]!.className).not.toContain("playhead-row--drop-after");
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("pointercancel disarms the gesture; a later pointerup commits nothing", () => {
    const { onRestack } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

    fireEvent.pointerCancel(window);
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).not.toHaveBeenCalled();
  });

  it("freezes the row snapshot while the playhead ticks; drop resolves against the snapshot", () => {
    const { onRestack, rerenderPanel } = renderStack();
    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });

    // The playhead store ticks to 2.6s mid-gesture: live data would move
    // Logo and Wash out of At-playhead and pull Later in. Frozen rows don't.
    playhead.timeUs = 2_600_000;
    rerenderPanel();
    expect(
      rowTitles(screen.getByRole("region", { name: "Now playing" })),
    ).toEqual(["Logo", "Wash", "Song"]);

    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });
    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", { kind: "layer", id: "l-wash" }, "below");

    // The gesture is over: the list snaps back to live data.
    expect(
      rowTitles(screen.getByRole("region", { name: "Now playing" })),
    ).toEqual(["Later"]);
  });

  it("under a category filter, a drop anchors on the visible row — never the hidden neighbour", () => {
    // Bottom→top: Wash (video), Caption (text, hidden by the Video chip),
    // Logo (video). The visible stack is [Logo, Wash].
    const tracks = [
      makeTrack("t-wash", "Wash lane", "Video", [
        makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
      ]),
      makeTrack("t-cap", "Caption lane", "Video", [
        makeLayer("l-cap", "Caption", "Text", 0, 2_000_000),
      ]),
      makeTrack("t-logo", "Logo lane", "Video", [
        makeLayer("l-logo", "Logo", "ImageOverlay", 500_000, 1_500_000),
      ]),
    ];
    const onRestack = vi.fn();
    renderPanel(tracks, { onRestack });
    fireEvent.click(screen.getByRole("checkbox", { name: "Video" }));
    mockRowRects(stackRows(), [0, 40]);

    fireEvent.pointerDown(screen.getByLabelText("Drag to restack Logo"), {
      button: 0,
      clientX: 8,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 8, clientY: 70 });
    fireEvent.pointerUp(window, { clientX: 8, clientY: 70 });

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", { kind: "layer", id: "l-wash" }, "below");
  });
});

describe("PlayheadPanel row context menu", () => {
  // Bottom→top of the z-stack: Wash (video), Song (audio, sinks to the
  // tail), Caption (text — visual, interleaves), Logo on top; Later is
  // strictly in the future so it lands in the Nearby section. The visible
  // At-playhead visual stack top-first is [Logo, Caption, Wash].
  function threeStackTracks(): TrackSummary[] {
    return [
      makeTrack("t-wash", "Wash lane", "Video", [
        makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
      ]),
      makeTrack("t-song", "Song lane", "Audio", [
        makeLayer("l-song", "Song", "Audio", 0, 2_000_000),
      ]),
      makeTrack("t-cap", "Caption lane", "Video", [
        makeLayer("l-cap", "Caption", "Text", 0, 2_000_000),
      ]),
      makeTrack("t-logo", "Logo lane", "Video", [
        makeLayer("l-logo", "Logo", "ImageOverlay", 500_000, 1_500_000),
      ]),
      makeTrack("t-later", "Later lane", "Video", [
        makeLayer("l-later", "Later", "Text", 2_000_000, 3_000_000),
      ]),
    ];
  }

  const ORDER_ITEMS = [
    "Bring forward",
    "Send backward",
    "Bring to front",
    "Send to back",
  ];

  /// Right-click the row named `title` (the row button carries the layer's
  /// display name as its title) and return the opened menu popup.
  function openRowMenu(title: string): HTMLElement {
    fireEvent.contextMenu(screen.getByTitle(title), {
      clientX: 40,
      clientY: 40,
    });
    return screen.getByRole("menu");
  }

  function menuItem(name: string): HTMLElement {
    return screen.getByRole("menuitem", { name });
  }

  /// Enablement matrix assertion: `expected` maps item label → enabled.
  function expectEnablement(expected: Record<string, boolean>) {
    for (const [name, enabled] of Object.entries(expected)) {
      const disabled = menuItem(name).getAttribute("aria-disabled") === "true";
      expect({ name, enabled: !disabled }).toEqual({ name, enabled });
    }
  }

  it("right-click on an At-playhead visual row offers exactly the four ordering items", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });

    const menu = openRowMenu("Caption");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(ORDER_ITEMS);
  });

  it("top row: bring forward / bring to front disabled, the rest enabled", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    openRowMenu("Logo");
    expectEnablement({
      "Bring forward": false,
      "Bring to front": false,
      "Send backward": true,
      "Send to back": true,
    });
  });

  it("bottom row: send backward / send to back disabled, the rest enabled", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    openRowMenu("Wash");
    expectEnablement({
      "Bring forward": true,
      "Bring to front": true,
      "Send backward": false,
      "Send to back": false,
    });
  });

  it("middle row: all four enabled", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    openRowMenu("Caption");
    expectEnablement({
      "Bring forward": true,
      "Bring to front": true,
      "Send backward": true,
      "Send to back": true,
    });
  });

  it("single-row stack: all four disabled — the menu never offers a no-op", () => {
    renderPanel(
      [
        makeTrack("t-wash", "Wash lane", "Video", [
          makeLayer("l-wash", "Wash", "Color", 0, 2_000_000),
        ]),
      ],
      { onRestack: vi.fn() },
    );
    openRowMenu("Wash");
    expectEnablement({
      "Bring forward": false,
      "Bring to front": false,
      "Send backward": false,
      "Send to back": false,
    });
  });

  it("bring forward restacks above the visible upper neighbour and closes the menu", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Caption");
    await user.click(menuItem("Bring forward"));

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-cap", { kind: "layer", id: "l-logo" }, "above");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("send backward restacks below the visible lower neighbour", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Caption");
    await user.click(menuItem("Send backward"));

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-cap", { kind: "layer", id: "l-wash" }, "below");
  });

  it("bring to front anchors above the top of the visible stack, not the adjacent row", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    // From the bottom row, forward's anchor would be Caption; front must
    // jump the whole stack and anchor above Logo.
    openRowMenu("Wash");
    await user.click(menuItem("Bring to front"));

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-wash", { kind: "layer", id: "l-logo" }, "above");
  });

  it("send to back anchors below the bottom of the visible stack, not the adjacent row", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Logo");
    await user.click(menuItem("Send to back"));

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", { kind: "layer", id: "l-wash" }, "below");
  });

  it("clicking a disabled item emits nothing", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Logo");
    await user.click(menuItem("Bring forward"));

    expect(onRestack).not.toHaveBeenCalled();
  });

  it("audio rows offer no context menu", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    fireEvent.contextMenu(screen.getByTitle("Song"), {
      clientX: 40,
      clientY: 40,
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Nearby rows offer no context menu", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    fireEvent.contextMenu(screen.getByTitle("Later"), {
      clientX: 40,
      clientY: 40,
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers no menu when the host wires no restack handler", () => {
    renderPanel(threeStackTracks());
    fireEvent.contextMenu(screen.getByTitle("Logo"), {
      clientX: 40,
      clientY: 40,
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("under a category filter the actions anchor on visible rows — never the hidden neighbour", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    // The Video chip hides Caption (text): the visible stack is [Logo, Wash].
    fireEvent.click(screen.getByRole("checkbox", { name: "Video" }));
    openRowMenu("Logo");
    await user.click(menuItem("Send backward"));

    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-logo", { kind: "layer", id: "l-wash" }, "below");
  });

  it("Shift+F10 opens the row menu from the keyboard; arrow + Enter fires the action", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    const row = screen.getByTitle("Caption");
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");

    // Base UI moves focus into the popup asynchronously; arrow navigation
    // only listens once it has.
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onRestack).toHaveBeenCalledTimes(1);
    expect(onRestack).toHaveBeenCalledWith("l-cap", { kind: "layer", id: "l-logo" }, "above");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape closes the menu without emitting", async () => {
    const user = userEvent.setup();
    const onRestack = vi.fn();
    renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Caption");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onRestack).not.toHaveBeenCalled();
  });

  /// Pin a row's viewport position; jsdom reports every rect as zeros, so a
  /// scroll can only be made observable by moving one of these by hand.
  function stubRowTop(row: HTMLElement, top: number) {
    row.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + 40,
        height: 40,
        left: 0,
        right: 120,
        width: 120,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  it("survives the scroll event its own opening fires", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    const row = screen.getByTitle("Caption").closest("li")!;
    stubRowTop(row, 40);

    openRowMenu("Caption");
    // Base UI takes focus into the popup and Chromium answers with a `scroll`
    // on the row's scroll container a few ms later, offset UNCHANGED. Closing
    // on that event dismissed the menu before the user could read it — red on
    // every Windows CI run, flaky on macOS, green on Linux, purely on which
    // handler won.
    fireEvent.scroll(row.parentElement!);

    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("closes when a scroll actually moves the row out from under it", () => {
    renderPanel(threeStackTracks(), { onRestack: vi.fn() });
    const row = screen.getByTitle("Caption").closest("li")!;
    stubRowTop(row, 40);

    openRowMenu("Caption");
    // The list really scrolls: the popup is pinned to viewport coordinates the
    // row has now left, so it would float over a different row's content.
    stubRowTop(row, -60);
    fireEvent.scroll(row.parentElement!);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opening the menu leaves click-to-select and the grip drag untouched", () => {
    const onRestack = vi.fn();
    const { onPick } = renderPanel(threeStackTracks(), { onRestack });

    openRowMenu("Caption");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByTitle("Caption"));
    expect(onPick).toHaveBeenCalledWith("l-cap", "t-cap");
    expect(screen.getByLabelText("Drag to restack Caption")).toBeTruthy();
  });
});

describe("PlayheadPanel linked clip rows", () => {
  const LINK = { id: "link-1", layer_ids: ["l-v", "l-a"] };
  function linkedTracks(): TrackSummary[] {
    return [
      makeTrack("t-wash", "Wash lane", "Video", [makeLayer("l-wash", "Wash", "Color", 0, 2_000_000)]),
      makeTrack("t-v", "Cam lane", "Video", [makeLayer("l-v", "Cam", "VideoClip", 500_000, 1_500_000)]),
      makeTrack("t-a", "Cam audio lane", "Audio", [makeLayer("l-a", "Cam audio", "Audio", 500_000, 1_500_000)]),
    ];
  }
  function openMenuOn(title: string): HTMLElement {
    fireEvent.contextMenu(screen.getByTitle(title), { clientX: 40, clientY: 40 });
    return screen.getByRole("menu");
  }

  it("shows each linked clip with a chain icon and no count, disclosure or link tooltip", () => {
    renderPanel(linkedTracks(), { onRestack: vi.fn() }, [LINK]);
    const stack = screen.getByRole("region", { name: "Now playing" });
    expect(rowTitles(stack)).toEqual(["Cam", "Wash", "Cam audio"]);
    expect(screen.getAllByRole("img", { name: "Linked" })).toHaveLength(2);
    expect(screen.queryByTestId("playhead-row-link-count")).toBeNull();
    expect(screen.queryByTestId("playhead-row-expand")).toBeNull();
    for (const title of ["Cam", "Cam audio"]) {
      const row = screen.getByTitle(title).closest("li")!;
      expect(row.getAttribute("data-link-id")).toBe("link-1");
      const icon = within(row).getByRole("img", { name: "Linked" });
      expect(icon.getAttribute("title")).toBeNull();
      expect(icon.textContent).toBe("");
      expect(row.querySelector<HTMLElement>(".playhead-item-row")!.style.boxShadow).toContain("inset 2px 0 0");
    }
    expect(screen.getByTitle("Wash").closest("li")!.querySelector(".playhead-link-indicator")).toBeNull();
    expect(screen.queryByLabelText("Drag to restack Cam audio")).toBeNull();
  });

  it("selects and seeks each linked clip independently", () => {
    const onGoTo = vi.fn();
    const { onPick } = renderPanel(linkedTracks(), { onGoTo }, [LINK]);
    for (const [title, id, trackId] of [["Cam", "l-v", "t-v"], ["Cam audio", "l-a", "t-a"]]) {
      const button = screen.getByTitle(title!);
      fireEvent.click(button);
      expect(onPick).toHaveBeenLastCalledWith(id, trackId);
      fireEvent.click(within(button.closest("li")!).getByLabelText("Jump to clip start"));
      expect(onGoTo).toHaveBeenLastCalledWith(id, trackId, 500_000);
    }
  });

  it("shows two linked visual clips in actual z-order, with one thumbnail and grip each", () => {
    const tracks = linkedTracks();
    tracks[2] = makeTrack("t-a", "Second lane", "Video", [{
      ...makeLayer("l-a", "Second", "VideoClip", 500_000, 1_500_000),
      params: { kind: "VideoClip", media_id: "media-second" } as LayerSummary["params"],
    }]);
    tracks[1]!.layers[0]!.params = { kind: "VideoClip", media_id: "media-cam" } as LayerSummary["params"];
    renderPanel(tracks, { onRestack: vi.fn() }, [LINK]);
    expect(rowTitles(screen.getByRole("region", { name: "Now playing" }))).toEqual(["Second", "Cam", "Wash"]);
    for (const title of ["Cam", "Second"]) {
      const row = screen.getByTitle(title).closest("li")!;
      expect(within(row).getAllByText("thumbnail")).toHaveLength(1);
      expect(within(row).getByLabelText("Drag to restack " + title)).toBeTruthy();
    }
  });

  it("filters linked members independently", async () => {
    renderPanel(linkedTracks(), {}, [LINK]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Audio" }));
    expect(screen.getByTitle("Cam audio")).toBeTruthy();
    expect(screen.queryByTitle("Cam")).toBeNull();
    expect(screen.queryByTitle("Wash")).toBeNull();
  });

  it("a linked visual row's ordering action addresses only that clip", async () => {
    const onRestack = vi.fn();
    renderPanel(linkedTracks(), { onRestack }, [LINK]);
    const menu = openMenuOn("Cam");
    expect(within(menu).getByRole("menuitem", { name: "Unlink" })).toBeTruthy();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Send to back" }));
    expect(onRestack).toHaveBeenCalledExactlyOnceWith("l-v", { kind: "layer", id: "l-wash" }, "below");
  });

  it("linked audio and Nearby clips offer a link-only menu", () => {
    renderPanel(linkedTracks(), { onRestack: vi.fn() }, [LINK]);
    openMenuOn("Cam audio");
    const audioMenu = screen.getByRole("menu", { name: "Link Cam audio" });
    expect(within(audioMenu).getAllByRole("menuitem").map(el => el.textContent)).toEqual(["Unlink"]);
    fireEvent.keyDown(window, { key: "Escape" });
    playhead.timeUs = 0;
    cleanup();
    renderPanel(linkedTracks(), { onRestack: vi.fn() }, [LINK]);
    expect(within(openMenuOn("Cam")).getAllByRole("menuitem").map(el => el.textContent)).toEqual(["Unlink"]);
  });

  it("Unlink dissolves the selected clip's link through IPC", async () => {
    renderPanel(linkedTracks(), {}, [LINK]);
    await userEvent.click(within(openMenuOn("Cam audio")).getByRole("menuitem", { name: "Unlink" }));
    expect(ipcMocks.linksDissolve).toHaveBeenCalledExactlyOnceWith("link-1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renames a linked clip independently", () => {
    const onRename = vi.fn();
    renderPanel(linkedTracks(), { onRename }, [LINK]);
    fireEvent.doubleClick(screen.getByTitle("Cam"));
    const input = screen.getByLabelText("Rename Cam");
    fireEvent.change(input, { target: { value: "Cam 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledExactlyOnceWith("l-v", "Cam 2");
    expect(screen.getByTitle("Cam audio")).toBeTruthy();
  });

  it("marks a clip even when its linked partner is on a reserved lane", () => {
    const tracks = linkedTracks();
    tracks[2] = { ...tracks[2]!, role: "dialogue" as TrackSummary["role"] };
    renderPanel(tracks, {}, [LINK]);
    expect(screen.getByTitle("Cam")).toBeTruthy();
    expect(screen.queryByTitle("Cam audio")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Linked" })).toHaveLength(1);
  });
});
