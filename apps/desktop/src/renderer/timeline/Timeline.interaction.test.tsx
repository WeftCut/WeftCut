// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type {
  AnimTrack,
  LinkSummary,
  LayerSummary,
  MediaSummary,
  TrackSummary,
} from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  MEDIA_DRAG_TYPE,
  compositionDragPayload,
  mediaDragPayload,
  useMediaDragStore,
} from "./mediaDrag";
import { SPAWN_TRACK_ID } from "./placement";
import { useLayerDragStore } from "./layerDragStore";
import {
  clearLayerSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  setLayerSelection,
  setTransitionSelection,
  transitionIdOf,
} from "../state/selectionStore";
import {
  openComposition,
  useCompositionAnchorStore,
} from "../state/compositionAnchorStore";
import { registerTimelineSurface } from "./timelineSurfaces";
import {
  clearKeyframeSelection,
  getSelectedKeyframes,
  selectKeyframe,
} from "../keyframe/selectionStore";
import {
  clearKeyframeFocus,
  setKeyframeFocus,
  useKeyframeFocusStore,
} from "../keyframe/focusStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../state/timelineScrollStore";
import { setActiveRegion } from "../focus/focusRegionStore";
import { setTool } from "../state/toolStore";
import { listCommands, registerCommandProvider } from "../commands/registry";
import { registerTransport, releaseTransport } from "../state/playbackStore";
import { registerRevealTrack } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { DEFAULT_TRACK_HEIGHT, HEADER_COL_PX } from "./geometry";

const ipcMocks = vi.hoisted(() => ({
  addMediaLayer: vi.fn().mockResolvedValue(undefined),
  addTrack: vi.fn().mockResolvedValue("spawned-track"),
  addGroupLayer: vi.fn().mockResolvedValue("placed-group-layer"),
  moveLayer: vi.fn().mockResolvedValue(undefined),
  moveLayersToNewTrack: vi.fn().mockResolvedValue("raised-track"),
  // Answers with one clone per id it was handed, so the pending-ghost swap
  // has a real id per subject.
  pasteLayers: vi.fn((layerIds: string[]) =>
    Promise.resolve({
      clones: layerIds.map((source) => ({ source, clone: `${source}::clone` })),
    }),
  ),
  trimLayer: vi.fn().mockResolvedValue(undefined),
  getWaveformPeaks: vi.fn().mockRejectedValue("not_ready"),
  linksCreate: vi.fn().mockResolvedValue("link-created"),
  updateLayerParamTrack: vi.fn().mockResolvedValue(undefined),
  updateParamTracksMulti: vi.fn().mockResolvedValue(undefined),
  logEmit: vi.fn().mockResolvedValue(undefined),
  viewStateGet: vi.fn().mockResolvedValue({
    composition_tabs: [],
    active_composition_id: null,
    track_heights: {},
    expanded_tracks: [],
  }),
  viewStateSet: vi.fn().mockResolvedValue(undefined),
}));

// Inert where the DOM environment provides PointerEvent (current jsdom does);
// kept as a fallback alias to MouseEvent so fireEvent.pointerDown still carries
// a usable .button / .clientX where it doesn't (same shim the
// KeyframeCurveGraph test uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

// useTimelineView loads/saves view.json over the backend IPC on mount. There is no
// backend runtime under jsdom, so stub just those two calls; keep every other
// ipc export real (types, helpers).
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    addMediaLayer: ipcMocks.addMediaLayer,
    addTrack: ipcMocks.addTrack,
    moveLayer: ipcMocks.moveLayer,
    moveLayersToNewTrack: ipcMocks.moveLayersToNewTrack,
    pasteLayers: ipcMocks.pasteLayers,
    trimLayer: ipcMocks.trimLayer,
    getWaveformPeaks: ipcMocks.getWaveformPeaks,
    linksCreate: ipcMocks.linksCreate,
    updateLayerParamTrack: ipcMocks.updateLayerParamTrack,
    updateParamTracksMulti: ipcMocks.updateParamTracksMulti,
    logEmit: ipcMocks.logEmit,
    viewStateGet: ipcMocks.viewStateGet,
    viewStateSet: ipcMocks.viewStateSet,
  };
});
// The drop's lane spawn and its Group-placement sibling both go through the
// composition-scoped wrappers.
vi.mock("../ipc/compositionScoped", () => ({
  addTrackIn: ipcMocks.addTrack,
  addGroupLayerIn: ipcMocks.addGroupLayer,
}));

// The clip drag is module state (`layerDragStore.ts`), so a test that leaves a
// gesture in flight would hand it to the next one.
afterEach(() => {
  useLayerDragStore.getState().end();
});

const staticNum = (value: number) => ({ mode: "Static" as const, value });

const layer: LayerSummary = {
  id: "layer-1",
  label: "Clip A",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Color",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: { kind: "Color", color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 },
  effects: [],
};

const track: TrackSummary = {
  id: "track-1",
  kind: "Video",
  label: "S1",
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: "a-roll",
  transient: false,
  layers: [layer],
};

const tinyVideoLayer: LayerSummary = {
  id: "video-1",
  label: "Tiny Video",
  t_start_us: 0,
  t_end_us: 100_000,
  kind: "VideoClip",
  color_hint: "#5588aa",
  enabled: true,
  locked: false,
  params: {
    kind: "VideoClip",
    media_id: "media-1",
    media_label: "media.mov",
    src_in_us: 0,
    src_out_us: 100_000,
    x: staticNum(0),
    y: staticNum(0),
    scale_x: staticNum(1),
    scale_y: staticNum(1),
    scale_linked: true,
    rotation_deg: staticNum(0),
    anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
    opacity: staticNum(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
  },
  effects: [],
};

const tinyVideoTrack: TrackSummary = {
  ...track,
  layers: [tinyVideoLayer],
};

const linkedLayer: LayerSummary = {
  ...layer,
  id: "layer-2",
  label: "Clip B",
  t_start_us: 2_000_000,
  t_end_us: 4_000_000,
  color_hint: "#cc8844",
};

const linkedTrack: TrackSummary = {
  ...track,
  layers: [layer, linkedLayer],
};

const link: LinkSummary = {
  id: "link-1",
  label: null,
  layer_ids: [layer.id, linkedLayer.id],
};

const sourceMedia: MediaSummary = {
  id: "media-source",
  label: "Source clip",
  path: "C:/media/source.mp4",
  kind: "Video",
  duration_us: 3_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 1024,
  available: true,
  decode_route: { route: "bypass" },
  codec: "h264",
  pix_fmt: "yuv420p",
};

function renderTimeline(overrides: {
  /// The Panel's own composition. Null — the unbound row — unless a case is
  /// about which composition a gesture reaches.
  compositionId?: string | null;
  selectedLayerId?: string | null;
  onSeek?: () => void;
  bladeMode?: boolean;
  tracks?: TrackSummary[];
  links?: LinkSummary[];
  media?: MediaSummary[];
  onMutated?: () => Promise<void>;
  fpsNum?: number;
  fpsDen?: number;
  durationUs?: number;
}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const selectedLayerId = overrides.selectedLayerId ?? null;
  setLayerSelection(selectedLayerId, selectedLayerId ? [selectedLayerId] : []);
  return render(
    <Timeline
      compositionId={overrides.compositionId ?? null}
      tracks={overrides.tracks ?? [track]}
      links={overrides.links ?? []}
      durationUs={overrides.durationUs ?? 5_000_000}
      keybindings={{}}
      fpsNum={overrides.fpsNum ?? 30}
      fpsDen={overrides.fpsDen ?? 1}
      bladeMode={overrides.bladeMode ?? false}
      media={overrides.media ?? []}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSeek={onSeek}
      onMutated={overrides.onMutated ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("Timeline seek/selection coupling", () => {
  beforeEach(() => {
    clearLayerSelection();
    // No region by default: a leaked one would arm every timeline-scoped
    // binding for tests that never meant to exercise the keyboard.
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    ipcMocks.addMediaLayer.mockClear();
    ipcMocks.addTrack.mockClear();
    ipcMocks.moveLayer.mockClear();
    ipcMocks.moveLayersToNewTrack.mockClear();
    ipcMocks.pasteLayers.mockClear();
    ipcMocks.trimLayer.mockClear();
    ipcMocks.getWaveformPeaks.mockClear();
    ipcMocks.linksCreate.mockClear();
    ipcMocks.logEmit.mockClear();
    // All Tracks so the role-stamped track always renders regardless of the
    // default AB-roll filter.
    useAppSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        display_mode: "AllTracks",
        tail_snap_enabled: true,
        tail_snap_strength_px: 12,
      },
    }));
  });
  afterEach(() => {
    useMediaDragStore.getState().end();
    cleanup();
    vi.useRealTimers();
  });

  it("clicking the ruler seeks AND keeps the selected clip selected", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(ruler);
    expect(onSeek).toHaveBeenCalled();
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([layer.id]);
  });

  it("clicking empty lane background deselects and does NOT seek", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const lane = container.querySelector('[data-testid="track-lane"]')!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(lane);
    expect(onSeek).not.toHaveBeenCalled();
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  it("clicking a clip selects it without seeking", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerDown(block, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(block);
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([layer.id]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not let snapping move a selected clip during a stationary click", () => {
    setPlayheadTimeUs(100_000);
    const { getByText } = renderTimeline({ selectedLayerId: layer.id });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(ipcMocks.trimLayer).not.toHaveBeenCalled();
  });

  it("keeps a short drag on an unselected clip as selection only", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });

    expect(block.style.left).toBe("0px");

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("arms an unselected clip drag after a short delay without losing its small delta", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });
    expect(block.style.left).toBe("0px");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(block.style.left).toBe(`${(33_333 / 1_000_000) * 80}px`);

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      layer.id,
      track.id,
      33_333,
      false,
    );
  });

  it("starts a selected clip drag without the temporal delay", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: layer.id });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });

    expect(block.style.left).toBe(`${(33_333 / 1_000_000) * 80}px`);

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      layer.id,
      track.id,
      33_333,
      false,
    );
  });

  // -------- Cross-track hit-testing --------
  //
  // Visual order is the reverse of the data array, so [bottom, mid, top]
  // renders top → bottom as rowTop, rowMid, rowBottom.

  const rowTop: TrackSummary = { ...track, id: "row-top", label: "Top", layers: [] };
  const rowMid: TrackSummary = { ...track, id: "row-mid", label: "Mid", layers: [] };
  const draggedLayer: LayerSummary = { ...layer, id: "dragged", label: "Dragged" };
  const rowBottom: TrackSummary = {
    ...track,
    id: "row-bottom",
    label: "Bottom",
    layers: [draggedLayer],
  };
  const threeRows = [rowBottom, rowMid, rowTop];

  function stubRect(el: Element, top: number, bottom: number) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      top,
      bottom,
      height: bottom - top,
      y: top,
      left: 0,
      right: 1040,
      width: 1040,
      x: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  // Give the lanes a vertical layout jsdom cannot produce on its own. The gap
  // between rowMid and rowBottom is what an expanded track's keyframe
  // sub-lanes occupy — the geometry an arithmetic row-offset table cannot see.
  //
  // The drop strip is measured by the SAME hit-test, so it gets the band it
  // actually renders in: immediately above the topmost lane. Without it the
  // strip's unlaid-out (0, 0) rect would tie with rowTop's and steal its band —
  // which is a fixture artifact, not app behaviour, and would send a lane-to-lane
  // drag to the spawn target.
  function stubLaneLayout(container: HTMLElement) {
    stubRect(
      container.querySelector('[data-testid="timeline-drop-strip"]')!,
      -14,
      0,
    );
    const bands: [number, number][] = [
      [0, 56], // rowTop
      [56, 112], // rowMid — its sub-lanes then fill 112 → 184
      [184, 240], // rowBottom
    ];
    container
      .querySelectorAll('[data-testid="track-lane"]')
      .forEach((el, i) => {
        const band = bands[i];
        if (!band) return;
        stubRect(el, band[0], band[1]);
      });
  }

  it("keeps a drag on the lane the DOM reports it is over", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // Both ends stay inside rowBottom's measured band [184, 240).
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 214 });
    fireEvent.pointerUp(window, { clientX: 83, clientY: 214 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowBottom.id,
      33_333,
      false,
    );
  });

  it("lands a cross-track drag on the measured destination lane", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    // 80 is inside rowMid's own lane [56, 112).
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 80 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowMid.id,
      0,
      false,
    );
    // A lane with room takes the clip itself; spawning stays the exception.
    expect(ipcMocks.moveLayersToNewTrack).not.toHaveBeenCalled();
  });

  it("hands an expanded track's sub-lane band to the track that owns it", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    // 150 is in the 112 → 184 sub-lane strip, which belongs to rowMid.
    fireEvent.pointerMove(window, { clientX: 80, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 150 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowMid.id,
      0,
      false,
    );
  });

  it("never changes track without vertical travel, even if the measurement disagrees", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // y=30 measures as rowTop while the clip lives on rowBottom. A horizontal
    // drag must still be a pure time move on its own track.
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowBottom.id,
      33_333,
      false,
    );
  });

  it("keeps a motionless click on a clip a selection, never a track change", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // A disagreeing hit-test alone is not edit intent.
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("starts an explicit trim handle drag without the temporal delay", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 160,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 163, clientY: 30 });

    expect(block.title).toContain("00:00:02:01");

    fireEvent.pointerUp(window, { clientX: 163, clientY: 30 });
    expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
      layer.id,
      "out",
      2_033_333,
      false,
    );
  });

  it("drives the monitor to the LAST KEPT frame during a tail trim and restores on release", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const seek = vi.fn();
    const pause = vi.fn();
    const transport = { play() {}, pause, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(500_000);
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 163, clientY: 30 });

    // New end 2_033_333 (exclusive) → the monitor shows the last kept
    // frame's start, 2_000_000 (frame 60 @ 30fps) — not the boundary frame.
    expect(pause).toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(2_000_000);

    fireEvent.pointerMove(window, { clientX: 168, clientY: 30 });
    // New end 2_100_000 → last kept frame 62 starts at 2_066_667.
    expect(seek).toHaveBeenCalledWith(2_066_667);

    fireEvent.pointerUp(window, { clientX: 168, clientY: 30 });
    // Gesture over: the playhead line and the monitor return to the
    // pre-trim park position.
    expect(playheadTimeUs()).toBe(500_000);
    expect(seek).toHaveBeenLastCalledWith(500_000);
    releaseTransport(transport);
  });

  it("drives the monitor to the FIRST KEPT frame during a head trim", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const seek = vi.fn();
    const transport = { play() {}, pause() {}, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(500_000);
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 3, clientY: 30 });

    // New start 33_333: the in side shows the boundary frame itself.
    expect(seek).toHaveBeenCalledWith(33_333);

    fireEvent.pointerUp(window, { clientX: 3, clientY: 30 });
    expect(playheadTimeUs()).toBe(500_000);
    releaseTransport(transport);
  });

  it("clicking the content preview overlay still selects without seeking", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek });
    const preview = container.querySelector('[data-testid="timeline-visual-preview"]')!;
    fireEvent.pointerDown(preview, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(preview);
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([layer.id]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("writes plain, Alt escape, and Shift toggle link selection globally", () => {
    const { getByText } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
    });
    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(first, { button: 0, clientX: 40 });
    fireEvent.pointerUp(window, { clientX: 40 });
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([layer.id, linkedLayer.id]);

    fireEvent.pointerDown(second, { button: 0, clientX: 200, altKey: true });
    fireEvent.pointerUp(window, { clientX: 200, altKey: true });
    expect(primaryLayerIdOf(currentSelection())).toBe(linkedLayer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([linkedLayer.id]);

    fireEvent.pointerDown(first, { button: 0, clientX: 40, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 40, shiftKey: true });
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(new Set(layerIdsOf(currentSelection()))).toEqual(
      new Set([layer.id, linkedLayer.id]),
    );

    // The same Shift+click again TAKES THE LINK BACK OUT — the additive
    // modifier toggles, so there is a way back from an over-wide selection
    // without starting over.
    fireEvent.pointerDown(first, { button: 0, clientX: 40, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 40, shiftKey: true });
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  // A selected clip has a ZERO drag-arm delay, so without the deselect check in
  // `onLayerPointerDown` the smallest wobble would move the clip the Shift+click
  // just dropped from the selection.
  it("does not drag a clip the Shift+click removed from the selection", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: layer.id });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 30, shiftKey: true });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(block.style.left).toBe("0px");

    fireEvent.pointerUp(window, { clientX: 200, clientY: 30, shiftKey: true });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  describe("select all / deselect all", () => {
    // Both are timeline-scoped (ADR 0041) and this harness renders Timeline
    // bare, outside the dock Panel that would BE the region — so the region is
    // declared directly, as the link test below does.
    beforeEach(() => {
      setActiveRegion("timeline");
    });

    const pressSelectAll = () =>
      fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true });

    it("selects every clip on the rendered tracks", () => {
      renderTimeline({ tracks: [linkedTrack] });

      pressSelectAll();

      expect(new Set(layerIdsOf(currentSelection()))).toEqual(
        new Set([layer.id, linkedLayer.id]),
      );
      expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    });

    // The A/B Roll filter hides role-less tracks from the view entirely. A
    // Select All that reached them would arm the next Delete for clips that are
    // not on screen.
    it("leaves clips the A/B Roll filter hides out of the selection", () => {
      useAppSettingsStore.setState((s) => ({
        settings: { ...s.settings, display_mode: "AbRoll" },
      }));
      const hidden: TrackSummary = {
        ...track,
        id: "track-hidden",
        role: null,
        layers: [{ ...linkedLayer, id: "layer-hidden", label: "Hidden" }],
      };
      renderTimeline({ tracks: [track, hidden] });

      pressSelectAll();

      expect(Array.from(layerIdsOf(currentSelection()))).toEqual([
        layer.id,
      ]);
    });

    // A locked clip cannot be clicked (`LayerBlock`'s pointerdown returns
    // early), so Select All must not put one in the selection either — the next
    // Delete would refuse `TrackLocked` for a clip the user never chose.
    it("skips a locked track's clips", () => {
      const locked: TrackSummary = {
        ...track,
        id: "track-locked",
        locked: true,
        layers: [{ ...linkedLayer, id: "layer-locked", label: "Locked" }],
      };
      renderTimeline({ tracks: [track, locked] });

      pressSelectAll();

      expect(Array.from(layerIdsOf(currentSelection()))).toEqual([
        layer.id,
      ]);
    });

    // Select All follows the primary the user was inspecting, so the Attribute
    // panel does not jump to another clip.
    it("keeps a primary that survives the new selection", () => {
      renderTimeline({
        tracks: [linkedTrack],
        selectedLayerId: linkedLayer.id,
      });

      pressSelectAll();

      expect(primaryLayerIdOf(currentSelection())).toBe(linkedLayer.id);
      expect(layerIdsOf(currentSelection()).size).toBe(2);
    });

    it("drops the whole selection on Ctrl+Shift+A", () => {
      renderTimeline({ tracks: [linkedTrack] });
      pressSelectAll();
      expect(layerIdsOf(currentSelection()).size).toBe(2);

      fireEvent.keyDown(window, {
        key: "A",
        code: "KeyA",
        ctrlKey: true,
        shiftKey: true,
      });

      expect(layerIdsOf(currentSelection()).size).toBe(0);
      expect(primaryLayerIdOf(currentSelection())).toBeNull();
    });
  });

  // The clip menu's registry rows act on the SELECTION, so a right-click that
  // left the selection alone could delete or copy a clip other than the one
  // under the cursor. `onLayerPointerDown` deliberately ignores button 2 (a
  // right-press must not arm a drag), which is why the menu handler does the
  // selecting.
  describe("right-click selection", () => {
    it("selects the clicked clip, link-aware, like a left click", () => {
      const { getByText } = renderTimeline({
        tracks: [linkedTrack],
        links: [link],
      });
      const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

      fireEvent.contextMenu(first, { clientX: 40, clientY: 30 });
      expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
      expect(
        Array.from(layerIdsOf(currentSelection())),
      ).toEqual([layer.id, linkedLayer.id]);
    });

    it("honours Alt to escape the link, the same as a left click", () => {
      const { getByText } = renderTimeline({
        tracks: [linkedTrack],
        links: [link],
      });
      const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

      fireEvent.contextMenu(second, { clientX: 200, clientY: 30, altKey: true });
      expect(
        Array.from(layerIdsOf(currentSelection())),
      ).toEqual([linkedLayer.id]);
    });

    // The clip menu's first section comes from the command registry, so the
    // rows carry the keys that do the same thing — the point of routing them
    // through `CommandContextItem` rather than hand-writing five labels.
    it("offers the registry rows with their accelerators", async () => {
      const unregister = registerCommandProvider(() => [
        { id: "copySelected", actionId: "copySelected", labelKey: "actions.copy_selected", run: () => {} },
        { id: "deleteSelected", actionId: "deleteSelected", labelKey: "actions.delete_selected", run: () => {} },
        { id: "splitAtPlayhead", actionId: "splitAtPlayhead", labelKey: "actions.split_at_playhead", run: () => {} },
      ]);
      try {
        const { getByText } = renderTimeline({ tracks: [linkedTrack] });
        const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
        fireEvent.contextMenu(first, { clientX: 40, clientY: 30 });

        const row = await screen.findByText("Split at playhead");
        expect(
          row.parentElement?.querySelector(".app-menu-item-accelerator")
            ?.textContent,
        ).toBe("Ctrl+B");
        // A row whose provider never mounted is omitted, never rendered dead:
        // `pasteAtPlayhead` and `moveToNewTrack` are absent here on purpose.
        expect(screen.queryByText("Paste layer at playhead")).toBeNull();
      } finally {
        unregister();
      }
    });

    // "Select four clips, right-click one, Delete" has to mean what it reads.
    // Collapsing to the clicked clip would silently shrink the target.
    it("keeps a multi-selection when the click lands inside it", () => {
      const { getByText } = renderTimeline({
        tracks: [linkedTrack],
        links: [link],
      });
      const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

      // Alt-select just Clip B, then Shift-extend back over Clip A's link so
      // the selection holds both and its primary is NOT the clip about to be
      // right-clicked.
      fireEvent.pointerDown(second, { button: 0, clientX: 200, altKey: true });
      fireEvent.pointerUp(window, { clientX: 200, altKey: true });
      const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
      fireEvent.pointerDown(first, { button: 0, clientX: 40, shiftKey: true });
      fireEvent.pointerUp(window, { clientX: 40, shiftKey: true });
      const before = currentSelection();

      fireEvent.contextMenu(second, { clientX: 200, clientY: 30 });
      expect(currentSelection()).toEqual(before);
    });
  });

  it("links the complete global selection through the existing shortcut", async () => {
    // `toggleLinkSelected` is timeline-scoped (ADR 0041) and this harness renders
    // Timeline bare, outside the dock Panel that would BE the region — so the
    // region is declared directly. Under test here is the link fan-out, not
    // the scope gate (`useShortcuts.test.tsx` owns that).
    setActiveRegion("timeline");
    const { getByText } = renderTimeline({
      tracks: [linkedTrack],
      links: [],
    });
    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(first, { button: 0, clientX: 40 });
    fireEvent.pointerUp(window, { clientX: 40 });
    fireEvent.pointerDown(second, { button: 0, clientX: 200, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 200, shiftKey: true });
    fireEvent.keyDown(window, { key: "l", code: "KeyL", ctrlKey: true });

    await waitFor(() => {
      expect(ipcMocks.linksCreate).toHaveBeenCalledWith(
        [layer.id, linkedLayer.id],
        null,
        false,
      );
    });
  });

  it("keeps the layer root overflow visible while the visual preview clips its own content", () => {
    const { container } = renderTimeline({});
    const block = container.querySelector(".timeline-layer") as HTMLElement;
    const preview = container.querySelector(
      '[data-testid="timeline-visual-preview"]',
    ) as HTMLElement;

    expect(block.className).not.toContain("overflow-hidden");
    expect(preview.className).toContain("overflow-hidden");
  });

  it("hides labels and avoids preview requests for clips narrower than 16px", () => {
    const { container, queryByText } = renderTimeline({ tracks: [tinyVideoTrack] });
    expect(queryByText("Tiny Video")).toBeNull();
    expect(container.querySelector('[data-testid="timeline-visual-preview"]')).toBeNull();
  });

  it("shows a blade cut preview at the hovered cut point", () => {
    const { container } = renderTimeline({ bladeMode: true });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerMove(block, { clientX: 80, buttons: 0 });

    const marker = container.querySelector(
      '[data-testid="timeline-blade-preview"]',
    ) as HTMLElement | null;
    expect(marker).not.toBeNull();
    expect(marker?.style.left).toBe("80px");

    fireEvent.pointerLeave(block);
    expect(container.querySelector('[data-testid="timeline-blade-preview"]')).toBeNull();
  });

  it("dragging on the ruler scrubs the playhead repeatedly", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window, { clientX: 300 });
    // pointerdown seeks once; the drag-scrub pointermove seeks again.
    expect(onSeek.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([layer.id]);
  });

  it("pins the ruler and playhead head during vertical timeline scrolling", () => {
    const { container } = renderTimeline({});
    const ruler = container.querySelector('[data-testid="timeline-ruler"]') as HTMLElement;
    const rulerCorner = container.querySelector(
      '[data-testid="timeline-ruler-corner"]',
    ) as HTMLElement;
    const playheadHead = container.querySelector(
      '[data-testid="timeline-playhead-head"]',
    ) as HTMLElement;
    const playheadHeadShape = container.querySelector(
      '[data-testid="timeline-playhead-head-shape"]',
    ) as HTMLElement;

    expect(ruler.className).toContain("sticky");
    expect(ruler.className).toContain("top-0");
    expect(rulerCorner.className).toContain("sticky");
    expect(rulerCorner.className).toContain("top-0");
    expect(playheadHead.className).toContain("sticky");
    expect(playheadHead.classList.contains("top-0")).toBe(true);
    expect(playheadHeadShape.classList.contains("top-0.5")).toBe(true);
  });

  it("masks the playhead line above the sticky head", () => {
    const { container } = renderTimeline({});
    const playhead = container.querySelector(
      '[data-testid="timeline-playhead"]',
    ) as HTMLElement;
    const playheadHead = container.querySelector(
      '[data-testid="timeline-playhead-head"]',
    ) as HTMLElement;
    const lineCap = container.querySelector(
      '[data-testid="timeline-playhead-line-cap"]',
    ) as HTMLElement | null;
    const headShape = container.querySelector(
      '[data-testid="timeline-playhead-head-shape"]',
    ) as HTMLElement | null;

    expect(playhead.classList.contains("top-0")).toBe(true);
    expect(playheadHead.classList.contains("top-0")).toBe(true);
    expect(lineCap?.classList.contains("h-0.5")).toBe(true);
    expect(headShape?.classList.contains("top-0.5")).toBe(true);
  });

  it("starts with a longer ruler and matching trailing edit workspace", () => {
    const { container } = renderTimeline({});
    const ruler = container.querySelector(
      '[data-testid="timeline-ruler"]',
    ) as HTMLElement;
    const canvas = container.querySelector(
      '[data-testid="timeline-canvas"]',
    ) as HTMLElement;

    expect(ruler.style.width).toBe("1040px");
    expect(canvas.style.width).toBe(ruler.style.width);
  });

  it.each([
    {
      fpsNum: 30,
      fpsDen: 1,
      oneFrameUs: 33_333,
    },
    {
      fpsNum: 60,
      fpsDen: 1,
      oneFrameUs: 16_667,
    },
  ])(
    "trims a layer down to one frame by dragging its right edge at $fpsNum/$fpsDen fps",
    async ({ fpsNum, fpsDen, oneFrameUs }) => {
      const onMutated = vi.fn().mockResolvedValue(undefined);
      const { getByText } = renderTimeline({
        selectedLayerId: layer.id,
        onMutated,
        fpsNum,
        fpsDen,
      });
      const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 160,
        top: 0,
        bottom: 48,
        width: 160,
        height: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const oneFrameEdgeX = (oneFrameUs / 1_000_000) * 80;
      fireEvent.pointerDown(block, { button: 0, clientX: 160, clientY: 24 });
      fireEvent.pointerMove(window, { clientX: oneFrameEdgeX, clientY: 24 });

      expect(block.title).toContain("00:00:00:00 → 00:00:00:01");

      fireEvent.pointerUp(window, { clientX: oneFrameEdgeX, clientY: 24 });
      await waitFor(() => {
        expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
          layer.id,
          "out",
          oneFrameUs,
          false,
        );
      });
      expect(onMutated).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      fpsNum: 30,
      fpsDen: 1,
      lastFrameStartUs: 1_966_667,
      lastFrameLabel: "00:00:01:29",
    },
    {
      fpsNum: 60,
      fpsDen: 1,
      lastFrameStartUs: 1_983_333,
      lastFrameLabel: "00:00:01:59",
    },
  ])(
    "trims a layer down to one frame by dragging its left edge at $fpsNum/$fpsDen fps",
    async ({ fpsNum, fpsDen, lastFrameStartUs, lastFrameLabel }) => {
      const onMutated = vi.fn().mockResolvedValue(undefined);
      const { getByText } = renderTimeline({
        selectedLayerId: layer.id,
        onMutated,
        fpsNum,
        fpsDen,
      });
      const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 160,
        top: 0,
        bottom: 48,
        width: 160,
        height: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const lastFrameEdgeX = (lastFrameStartUs / 1_000_000) * 80;
      fireEvent.pointerDown(block, { button: 0, clientX: 0, clientY: 24 });
      fireEvent.pointerMove(window, { clientX: lastFrameEdgeX, clientY: 24 });

      expect(block.title).toContain(`${lastFrameLabel} → 00:00:02:00`);

      fireEvent.pointerUp(window, { clientX: lastFrameEdgeX, clientY: 24 });
      await waitFor(() => {
        expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
          layer.id,
          "in",
          lastFrameStartUs,
          false,
        );
      });
      expect(onMutated).toHaveBeenCalledOnce();
    },
  );

  it("extends an existing one-frame clip by one frame instead of forcing 100 ms", async () => {
    const oneFrameLayer: LayerSummary = {
      ...layer,
      id: "one-frame-layer",
      label: "One frame",
      t_end_us: 33_333,
    };
    const oneFrameTrack: TrackSummary = { ...track, layers: [oneFrameLayer] };
    const { container } = renderTimeline({
      tracks: [oneFrameTrack],
      selectedLayerId: oneFrameLayer.id,
    });
    const block = container.querySelector(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 4,
      top: 0,
      bottom: 48,
      width: 4,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const oneFrameWidthPx = (33_333 / 1_000_000) * 80;
    fireEvent.pointerDown(block, { button: 0, clientX: 4, clientY: 24 });
    fireEvent.pointerMove(window, {
      clientX: 4 + oneFrameWidthPx,
      clientY: 24,
    });
    expect(block.title).toContain("00:00:00:00 → 00:00:00:02");

    fireEvent.pointerUp(window, {
      clientX: 4 + oneFrameWidthPx,
      clientY: 24,
    });
    await waitFor(() => {
      expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
        oneFrameLayer.id,
        "out",
        66_667,
        false,
      );
    });
  });

  it("previews every linked layer during and immediately after a move drag", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { getByText } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
      selectedLayerId: layer.id,
      onMutated,
    });

    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    expect(first.style.left).toBe("0px");
    expect(second.style.left).toBe("160px");

    fireEvent.pointerDown(first, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(first.style.left).toBe("80px");
    expect(second.style.left).toBe("240px");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    await waitFor(() => {
      expect(ipcMocks.moveLayer).toHaveBeenCalledWith(layer.id, track.id, 1_000_000, false);
      expect(first.style.left).toBe("80px");
      expect(second.style.left).toBe("240px");
    });
  });

  // Premiere's Alt+drag on a linked clip copies both halves: one ghost per
  // member during the drag, both sources left in place, and ONE `paste_layers`
  // with the dragged seed first — the op reads the drop position as the seed's.
  it("Alt+drag duplicates the whole link in one paste, sources untouched", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { getByText, container } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
      onMutated,
    });
    // The whole link selected, as a plain click leaves it: a selected clip arms
    // the drag at once, and a selection covering every member narrows nothing.
    act(() => setLayerSelection(layer.id, [layer.id, linkedLayer.id]));

    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const sibling = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 30, altKey: true });

    const previews = Array.from(
      container.querySelectorAll<HTMLElement>('[data-duplicate-preview="true"]'),
    );
    expect(source.style.left).toBe("0px");
    expect(sibling.style.left).toBe("160px");
    expect(previews.map((ghost) => ghost.style.left).sort()).toEqual([
      "400px",
      "560px",
    ]);

    fireEvent.pointerUp(window, { clientX: 400, clientY: 30, altKey: true });

    await waitFor(() => {
      expect(ipcMocks.pasteLayers).toHaveBeenCalledWith(
        [layer.id, linkedLayer.id],
        5_000_000,
        track.id,
      );
    });
    expect(ipcMocks.pasteLayers).toHaveBeenCalledTimes(1);
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  // The escape is the selection: Alt on the body already means duplicate, so a
  // selection narrowed to one member BEFORE the drag (an Alt+click first) is
  // what makes the copy a single, unlinked clone.
  it("Alt+drag after an Alt+click duplicates only the selected member", async () => {
    const { getByText, container } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
      selectedLayerId: layer.id,
    });

    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 30, altKey: true });

    expect(
      container.querySelectorAll('[data-duplicate-preview="true"]'),
    ).toHaveLength(1);

    fireEvent.pointerUp(window, { clientX: 400, clientY: 30, altKey: true });

    await waitFor(() => {
      expect(ipcMocks.pasteLayers).toHaveBeenCalledWith(
        [layer.id],
        5_000_000,
        track.id,
      );
    });
  });

  // A collision on ANY destination refuses the whole set — here the sibling's
  // landing spot overlaps the untouched sources — and nothing is created.
  it("blocks a whole-link duplicate when one member's destination collides", () => {
    const { getByText, container } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
    });
    act(() => setLayerSelection(layer.id, [layer.id, linkedLayer.id]));
    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    // At 3 s Clip A's copy (3–5 s) overlaps the untouched Clip B (2–4 s);
    // Clip B's own copy (5–7 s) is clear. One member colliding is enough.
    fireEvent.pointerMove(window, { clientX: 240, clientY: 30, altKey: true });

    const previews = Array.from(
      container.querySelectorAll<HTMLElement>('[data-duplicate-preview="true"]'),
    );
    expect(previews).toHaveLength(2);
    expect(previews.every((ghost) => ghost.dataset.dragValidity === "collision")).toBe(
      true,
    );

    fireEvent.pointerUp(window, { clientX: 240, clientY: 30, altKey: true });
    expect(ipcMocks.pasteLayers).not.toHaveBeenCalled();
  });

  it("blocks an Alt+drag duplicate that would overlap its source", () => {
    const { getByText, container } = renderTimeline({
      tracks: [track],
      selectedLayerId: layer.id,
    });
    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30, altKey: true });

    const preview = container.querySelector(
      '[data-duplicate-preview="true"]',
    ) as HTMLElement;
    expect(source.style.left).toBe("0px");
    expect(preview.dataset.dragValidity).toBe("collision");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30, altKey: true });
    expect(ipcMocks.pasteLayers).not.toHaveBeenCalled();
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("shows a collision state and blocks an existing visual clip move before IPC", () => {
    const { getByText } = renderTimeline({
      tracks: [linkedTrack],
      links: [],
      selectedLayerId: linkedLayer.id,
    });
    const moving = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    // Move Clip B from [2s, 4s) to [1s, 3s), overlapping Clip A [0s, 2s).
    fireEvent.pointerDown(moving, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(moving.dataset.dragValidity).toBe("collision");
    expect(
      moving.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).not.toBeNull();

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("allows an existing visual clip to move over audio on the same track", () => {
    const audio: LayerSummary = {
      ...layer,
      id: "audio-1",
      label: "Audio bed",
      kind: "Audio",
      t_start_us: 1_900_000,
      t_end_us: 2_000_000,
      params: {
        kind: "Audio",
        media_id: "media-audio",
        media_label: "audio.wav",
        src_in_us: 0,
        src_out_us: 100_000,
        gain_db: staticNum(0),
        pan: staticNum(0),
        fade_in_us: 0,
        fade_out_us: 0,
        mute: false,
        role: "music",
      },
    };
    const movingVisual: LayerSummary = {
      ...linkedLayer,
      id: "moving-visual",
      label: "Moving visual",
    };
    const mixedTrack: TrackSummary = {
      ...track,
      layers: [audio, movingVisual],
    };
    const { getByText } = renderTimeline({
      tracks: [mixedTrack],
      selectedLayerId: movingVisual.id,
    });
    const moving = getByText("Moving visual").closest(
      ".timeline-layer",
    ) as HTMLElement;

    fireEvent.pointerDown(moving, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(moving.dataset.dragValidity).toBe("valid");
    expect(
      moving.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).toBeNull();

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      movingVisual.id,
      track.id,
      1_000_000,
      false,
    );
  });

  it("marks every link ghost invalid when a sibling would collide", () => {
    const anchor: LayerSummary = {
      ...layer,
      id: "link-anchor",
      label: "Link anchor",
      t_start_us: 0,
      t_end_us: 1_000_000,
    };
    const sibling: LayerSummary = {
      ...linkedLayer,
      id: "link-sibling",
      label: "Link sibling",
      t_start_us: 2_000_000,
      t_end_us: 3_000_000,
    };
    const blocker: LayerSummary = {
      ...layer,
      id: "link-blocker",
      label: "Blocker",
      t_start_us: 4_000_000,
      t_end_us: 5_000_000,
    };
    const collisionTrack: TrackSummary = {
      ...track,
      layers: [anchor, sibling, blocker],
    };
    const collisionLink: LinkSummary = {
      id: "collision-link",
      label: null,
      layer_ids: [anchor.id, sibling.id],
    };
    const { getByText } = renderTimeline({
      tracks: [collisionTrack],
      links: [collisionLink],
      selectedLayerId: anchor.id,
    });
    const anchorBlock = getByText("Link anchor").closest(
      ".timeline-layer",
    ) as HTMLElement;
    const siblingBlock = getByText(/Link siblin/).closest(
      ".timeline-layer",
    ) as HTMLElement;

    // +2s keeps the two link members adjacent, but moves the sibling onto Blocker.
    fireEvent.pointerDown(anchorBlock, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 30 });

    expect(anchorBlock.dataset.dragValidity).toBe("collision");
    expect(siblingBlock.dataset.dragValidity).toBe("collision");
    expect(
      anchorBlock.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).not.toBeNull();
    expect(
      siblingBlock.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).toBeNull();

    fireEvent.pointerUp(window, { clientX: 160, clientY: 30 });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it.each(["AbRoll", "AllTracks"] as const)(
    "renders the same duration-sized media ghost in %s mode",
    (displayMode) => {
      useAppSettingsStore.setState((s) => ({
        settings: { ...s.settings, display_mode: displayMode },
      }));
      const payload = mediaDragPayload(sourceMedia);
      useMediaDragStore.getState().begin(payload);
      const { container } = renderTimeline({ media: [sourceMedia] });
      const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 1040,
        top: 0,
        bottom: 64,
        width: 1040,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const dataTransfer = {
        types: [MEDIA_DRAG_TYPE],
        dropEffect: "copy",
        getData: () => JSON.stringify(payload),
      };

      // At 80 px/s this pointer maps to 3s only after subtracting the
      // 32px cursor-in-ghost offset. The 3s source therefore spans 3s→6s.
      const dragOver = createEvent.dragOver(lane, { dataTransfer });
      Object.defineProperty(dragOver, "clientX", {
        value: MEDIA_DRAG_CURSOR_OFFSET_PX + 240,
      });
      fireEvent(lane, dragOver);

      const ghost = container.querySelector(
        '[data-testid="media-drop-ghost"]',
      ) as HTMLElement;
      expect(ghost.dataset.validity).toBe("valid");
      expect(ghost.dataset.startUs).toBe("3000000");
      expect(ghost.dataset.endUs).toBe("6000000");
      expect(ghost.style.left).toBe("240px");
      expect(ghost.style.width).toBe("240px");
      expect(ghost.classList.contains("media-drop-ghost")).toBe(true);
      expect(useMediaDragStore.getState().absorptionTarget).toMatchObject({
        left: 254,
        top: 18,
        width: 36,
        height: 20,
      });
    },
  );

  it("transfers media ghost and lane focus exclusively between A-roll and B-roll", () => {
    const bRollTrack: TrackSummary = {
      ...track,
      id: "track-2",
      label: "S2",
      role: "b-roll",
      layers: [],
    };
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({
      tracks: [track, bRollTrack],
      media: [sourceMedia],
    });
    const lanes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="track-lane"]'),
    );
    expect(lanes).toHaveLength(2);
    const [aRollLane, bRollLane] = lanes as [HTMLElement, HTMLElement];
    vi.spyOn(aRollLane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 0,
      bottom: 64,
      width: 1040,
      height: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(bRollLane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 64,
      bottom: 128,
      width: 1040,
      height: 64,
      x: 0,
      y: 64,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "copy",
      getData: () => JSON.stringify(payload),
    };
    const dragOver = (lane: HTMLElement, clientY: number) => {
      const event = createEvent.dragOver(lane, { dataTransfer });
      Object.defineProperties(event, {
        clientX: { value: MEDIA_DRAG_CURSOR_OFFSET_PX + 240 },
        clientY: { value: clientY },
      });
      fireEvent(lane, event);
    };
    const laneStates = () =>
      lanes.map((lane) => ({
        focused:
          lane.classList.contains("outline-blue-300/80") ||
          lane.classList.contains("bg-blue-500/10"),
        ghostCount: lane.querySelectorAll('[data-testid="media-drop-ghost"]')
          .length,
      }));

    dragOver(aRollLane, 32);
    const onARoll = laneStates();

    // The incoming lane must claim the one active focus without depending on
    // the outgoing lane first receiving a trustworthy dragleave event.
    dragOver(bRollLane, 96);
    const onBRoll = laneStates();

    dragOver(aRollLane, 32);
    const backOnARoll = laneStates();

    expect([onARoll, onBRoll, backOnARoll]).toEqual([
      [
        { focused: true, ghostCount: 1 },
        { focused: false, ghostCount: 0 },
      ],
      [
        { focused: false, ghostCount: 0 },
        { focused: true, ghostCount: 1 },
      ],
      [
        { focused: true, ghostCount: 1 },
        { focused: false, ghostCount: 0 },
      ],
    ]);
  });

  it("marks a collision and blocks the drop before IPC", () => {
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({ media: [sourceMedia] });
    const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 0,
      bottom: 64,
      width: 1040,
      height: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "copy",
      getData: () => JSON.stringify(payload),
    };

    const dragOver = createEvent.dragOver(lane, { dataTransfer });
    // start=1s, end=4s; overlaps the existing visual clip at [0s,2s).
    Object.defineProperty(dragOver, "clientX", {
      value: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
    });
    fireEvent(lane, dragOver);
    expect(
      container.querySelector('[data-testid="media-drop-ghost"]')
        ?.getAttribute("data-validity"),
    ).toBe("collision");

    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", {
      value: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
    });
    fireEvent(lane, drop);
    expect(ipcMocks.addMediaLayer).not.toHaveBeenCalled();
  });

  // -------- The drop strip (ADR 0042) --------

  const stripOf = (container: HTMLElement): HTMLElement => {
    const strip = container.querySelector(
      '[data-testid="timeline-drop-strip"]',
    ) as HTMLElement;
    // jsdom lays nothing out; the strip needs a box for the pointer-to-time math.
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 0,
      bottom: 14,
      width: 1040,
      height: 14,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    return strip;
  };

  it("reserves the strip's row in flow and keeps it inert with no drag in flight", () => {
    const { container } = renderTimeline({});
    const strip = container.querySelector(
      '[data-testid="timeline-drop-strip"]',
    ) as HTMLElement;
    const spacer = container.querySelector(
      '[data-testid="timeline-drop-strip-header"]',
    ) as HTMLElement;

    // Both columns paint the row, or every header below it loses its lane.
    expect(strip.style.height).toBe("14px");
    expect(spacer.style.height).toBe(strip.style.height);
    expect(strip.dataset.armed).toBe("false");
    expect(strip.textContent).toBe("");
  });

  it("spawns a lane and places the clip when a media drag is released on the strip", async () => {
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({ media: [sourceMedia] });
    const strip = stripOf(container);
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "none",
      getData: () => JSON.stringify(payload),
    };
    const at = MEDIA_DRAG_CURSOR_OFFSET_PX + 240;

    const dragOver = createEvent.dragOver(strip, { dataTransfer });
    Object.defineProperty(dragOver, "clientX", { value: at });
    fireEvent(strip, dragOver);

    // The strip owns the highlight through the same claim protocol the lanes
    // use, and a lane that does not exist yet cannot collide.
    expect(useMediaDragStore.getState().dropTargetTrackId).toBe(SPAWN_TRACK_ID);
    const ghost = container.querySelector(
      '[data-testid="timeline-drop-strip-ghost"]',
    ) as HTMLElement;
    expect(ghost.dataset.validity).toBe("spawn");
    expect(ghost.dataset.startUs).toBe("3000000");
    expect(ghost.dataset.endUs).toBe("6000000");
    expect(
      container.querySelector('[data-testid="timeline-drop-strip-hint"]'),
    ).not.toBeNull();

    const drop = createEvent.drop(strip, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: at });
    fireEvent(strip, drop);

    await waitFor(() => {
      expect(ipcMocks.addTrack).toHaveBeenCalledOnce();
      expect(ipcMocks.addMediaLayer).toHaveBeenCalledWith(
        "spawned-track",
        sourceMedia.id,
        3_000_000,
      );
    });
  });

  it("leaves a lane drop landing on that lane, with no lane spawned", async () => {
    const emptyTrack: TrackSummary = { ...track, layers: [] };
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({
      tracks: [emptyTrack],
      media: [sourceMedia],
    });
    const lane = container.querySelector(
      '[data-testid="track-lane"]',
    ) as HTMLElement;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 14,
      bottom: 78,
      width: 1040,
      height: 64,
      x: 0,
      y: 14,
      toJSON: () => ({}),
    } as DOMRect);
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "none",
      getData: () => JSON.stringify(payload),
    };
    const at = MEDIA_DRAG_CURSOR_OFFSET_PX + 240;

    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: at });
    fireEvent(lane, drop);

    await waitFor(() => {
      expect(ipcMocks.addMediaLayer).toHaveBeenCalledWith(
        emptyTrack.id,
        sourceMedia.id,
        3_000_000,
      );
    });
    expect(ipcMocks.addTrack).not.toHaveBeenCalled();
  });

  // -------- The strip's OTHER event model: a pointer-driven clip drag --------
  //
  // A media-pool drag is HTML5 drag-and-drop and a clip drag is pointer-driven,
  // and they converge on this one row. These cases exist because the failure the
  // ticket predicted is one mechanism working while the other silently does
  // nothing: every one of them would still pass on the placement policy alone.

  /// The strip above the lanes, laid out the way it renders. The lanes follow it
  /// in visual order, so lane i owns `[14 + 56i, 70 + 56i)`.
  const stubRaiseLayout = (container: HTMLElement): HTMLElement => {
    const strip = stripOf(container); // band [0, 14)
    container
      .querySelectorAll('[data-testid="track-lane"]')
      .forEach((el, i) => stubRect(el, 14 + i * 56, 70 + i * 56));
    return strip;
  };

  const stripState = (strip: HTMLElement) => ({
    armed: strip.dataset.armed,
    lit: strip.dataset.lit,
    hints: strip.querySelectorAll('[data-testid="timeline-drop-strip-hint"]')
      .length,
  });

  it("lights the strip and raises an existing clip onto a fresh lane", async () => {
    const { container, getByText } = renderTimeline({
      selectedLayerId: layer.id,
    });
    const strip = stubRaiseLayout(container);
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    // Straight up out of the lane's band [14, 70) into the strip's [0, 14).
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 7 });

    // Armed and lit from a drag that publishes to no media-drag store.
    expect(stripState(strip)).toEqual({ armed: "true", lit: "true", hints: 1 });
    // `spawn` is a destination being created, not a refusal — the chip must not
    // wear the collision chrome or the gesture reads as blocked.
    expect(block.dataset.dragValidity).toBe("spawn");
    expect(
      block.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).toBeNull();

    fireEvent.pointerUp(window, { clientX: 80, clientY: 7 });

    await waitFor(() => {
      expect(ipcMocks.moveLayersToNewTrack).toHaveBeenCalledWith([layer.id]);
    });
    // The one create-and-move operation, never decomposed into add-then-move.
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(ipcMocks.addTrack).not.toHaveBeenCalled();
  });

  it("raises a whole link onto the ONE new lane", async () => {
    const { container, getByText } = renderTimeline({
      tracks: [linkedTrack],
      links: [link],
      selectedLayerId: layer.id,
    });
    stubRaiseLayout(container);
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 7 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 7 });

    // The drag's own subject set, exactly as a cross-lane move would carry it.
    await waitFor(() => {
      expect(ipcMocks.moveLayersToNewTrack).toHaveBeenCalledWith([
        layer.id,
        linkedLayer.id,
      ]);
    });
  });

  // Two lanes, one clip each, linked — the shape a raise has to judge as a set
  // rather than one clip at a time. `tracks` is bottom-of-z-stack first, so the
  // SECOND entry renders in the top lane band.
  const twoLaneLink = (
    lower: LayerSummary,
    upper: LayerSummary,
    upperTrack: Partial<TrackSummary> = {},
  ) => ({
    tracks: [
      { ...track, id: "lane-lower", label: "Lower", layers: [lower] },
      {
        ...track,
        id: "lane-upper",
        label: "Upper",
        role: null,
        layers: [upper],
        ...upperTrack,
      },
    ] as TrackSummary[],
    links: [
      { id: "raise-link", label: null, layer_ids: [lower.id, upper.id] },
    ] as LinkSummary[],
  });

  it("refuses a subject set that would overlap itself on the one new lane", () => {
    const anchor: LayerSummary = { ...layer, id: "raise-anchor", label: "Anchor" };
    const overlapping: LayerSummary = {
      ...layer,
      id: "raise-overlap",
      label: "Overlapping",
      t_start_us: 1_000_000,
      t_end_us: 3_000_000,
    };
    const { container, getByText } = renderTimeline({
      ...twoLaneLink(anchor, overlapping),
      selectedLayerId: anchor.id,
    });
    stubRaiseLayout(container);
    // "Anchor" lives on the lower lane, which renders SECOND — band [70, 126).
    const block = getByText("Anchor").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 98 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 7 });

    // `collision` out-ranks `spawn`: one empty lane cannot hold both.
    expect(block.dataset.dragValidity).toBe("collision");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 7 });
    expect(ipcMocks.moveLayersToNewTrack).not.toHaveBeenCalled();
  });

  it("refuses a raise whose subject sits on a locked lane", () => {
    const anchor: LayerSummary = { ...layer, id: "raise-anchor", label: "Anchor" };
    const pinned: LayerSummary = {
      ...layer,
      id: "raise-pinned",
      label: "Pinned",
      t_start_us: 3_000_000,
      t_end_us: 4_000_000,
    };
    const { container, getByText } = renderTimeline({
      ...twoLaneLink(anchor, pinned, { locked: true }),
      selectedLayerId: anchor.id,
    });
    stubRaiseLayout(container);
    const block = getByText("Anchor").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 98 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 7 });

    // The times do not overlap, so `locked` is the only verdict that can refuse
    // this — and it out-ranks `spawn`, which is why the strip is not a way around
    // a lock rather than a case anyone had to branch on.
    expect(block.dataset.dragValidity).toBe("locked");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 7 });
    expect(ipcMocks.moveLayersToNewTrack).not.toHaveBeenCalled();
  });

  it("never offers the strip to a clip on a locked lane", () => {
    const lockedTrack: TrackSummary = { ...track, locked: true };
    const { container, getByText } = renderTimeline({
      tracks: [lockedTrack],
      selectedLayerId: layer.id,
    });
    const strip = stubRaiseLayout(container);
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 7 });

    // The gesture never armed, so there is nothing for the strip to offer.
    expect(stripState(strip)).toEqual({ armed: "false", lit: "false", hints: 0 });

    fireEvent.pointerUp(window, { clientX: 80, clientY: 7 });
    expect(ipcMocks.moveLayersToNewTrack).not.toHaveBeenCalled();
  });

  it("withholds the strip from an Alt+drag duplicate", async () => {
    const { container, getByText } = renderTimeline({
      selectedLayerId: layer.id,
    });
    const strip = stubRaiseLayout(container);
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 0,
      clientY: 40,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 7, altKey: true });

    // A duplicate lowers to `pasteLayers`, which needs a lane that exists, so the
    // strip stays dark and the copy lands on the source's own lane.
    //
    // The fallback is not a silent surprise, which is what makes it defensible:
    // the duplicate ghost renders on that source lane at the dragged position
    // (asserted below), so the row and the time the copy will take are both on
    // screen before release. Suppressing the release instead would leave the
    // gesture showing a landing spot it then refuses to use.
    expect(stripState(strip)).toEqual({ armed: "true", lit: "false", hints: 0 });
    const ghost = container.querySelector(
      '[data-duplicate-preview="true"]',
    ) as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost.style.left).toBe("320px");

    fireEvent.pointerUp(window, { clientX: 320, clientY: 7, altKey: true });

    await waitFor(() => {
      expect(ipcMocks.pasteLayers).toHaveBeenCalledWith(
        [layer.id],
        4_000_000,
        track.id,
      );
    });
    expect(ipcMocks.moveLayersToNewTrack).not.toHaveBeenCalled();
  });
});

describe("Timeline clip label fallback", () => {
  beforeEach(() => {
    clearLayerSelection();
    setPlayheadTimeUs(0);
    useAppSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        display_mode: "AllTracks",
        tail_snap_enabled: true,
        tail_snap_strength_px: 12,
      },
    }));
  });
  afterEach(() => {
    cleanup();
  });

  // 2s at the default 80px/s → 160px wide, past LAYER_FULL_LABEL_MIN_PX so
  // the full (untruncated) label renders.
  const unnamedVideo: LayerSummary = {
    ...tinyVideoLayer,
    id: "video-unnamed",
    label: null,
    t_end_us: 2_000_000,
  };

  const unnamedImage: LayerSummary = {
    ...tinyVideoLayer,
    id: "image-unnamed",
    label: null,
    kind: "ImageOverlay",
    t_end_us: 2_000_000,
    params: {
      kind: "ImageOverlay",
      media_id: "media-img",
      media_label: "photo.jpg",
      x: staticNum(0),
      y: staticNum(0),
      scale_x: staticNum(1),
      scale_y: staticNum(1),
      scale_linked: true,
      rotation_deg: staticNum(0),
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      opacity: staticNum(1),
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };

  const trackWith = (l: LayerSummary): TrackSummary => ({ ...track, layers: [l] });

  it("an unnamed video clip falls back to its media file name", () => {
    const { getByText } = renderTimeline({ tracks: [trackWith(unnamedVideo)] });
    expect(getByText("media.mov")).toBeTruthy();
  });

  it("an unnamed image overlay falls back to its media file name", () => {
    const { getByText } = renderTimeline({ tracks: [trackWith(unnamedImage)] });
    expect(getByText("photo.jpg")).toBeTruthy();
  });

  it("a user-set label still wins over the media file name", () => {
    const named: LayerSummary = { ...unnamedVideo, id: "video-named", label: "Hero shot" };
    const { getByText, queryByText } = renderTimeline({ tracks: [trackWith(named)] });
    expect(getByText("Hero shot")).toBeTruthy();
    expect(queryByText("media.mov")).toBeNull();
  });

  it("an empty media file name falls back to the kind label", () => {
    const videoParams = unnamedVideo.params as Extract<
      LayerSummary["params"],
      { kind: "VideoClip" }
    >;
    const noName: LayerSummary = {
      ...unnamedVideo,
      id: "video-empty-media-label",
      params: { ...videoParams, media_label: "" },
    };
    const { getByText } = renderTimeline({ tracks: [trackWith(noName)] });
    expect(getByText("Video")).toBeTruthy();
  });

  const textLayerParams: Extract<LayerSummary["params"], { kind: "Text" }> = {
    kind: "Text",
    content: "Once upon a time",
    font_family: "Inter",
    font_size_px: 48,
    weight: 400,
    italic: false,
    align: "Center",
    anchor_x: staticNum(0.5),
    anchor_y: staticNum(0.5),
    color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
    x: staticNum(0),
    y: staticNum(0),
    scale_x: staticNum(1),
    scale_y: staticNum(1),
    scale_linked: true,
    rotation_deg: staticNum(0),
    opacity: staticNum(1),
    outline: null,
    shadow: null,
    box_w: null,
    box_h: null,
    valign: "Middle",
    line_height: 0,
    letter_spacing: 0,
  };
  const unnamedText: LayerSummary = {
    ...tinyVideoLayer,
    id: "text-unnamed",
    label: null,
    kind: "Text",
    t_end_us: 2_000_000,
    params: textLayerParams,
  };

  // The regression this exists for: a Text block used to carry TWO strings —
  // the preview drew the content, the chip drew the kind word "Text" — on the
  // same baseline, at the same 10px, from the same 8px inset, separated only by
  // the chip's fade-to-transparent scrim. Asserting the block's WHOLE text
  // content is what pins it; `getByText(content)` alone passed even then,
  // because the content was present either way.
  it("an unnamed text layer draws exactly one string: its own words", () => {
    const { getByText } = renderTimeline({ tracks: [trackWith(unnamedText)] });
    const block = getByText("Once upon a time").closest(".timeline-layer");
    expect(block?.textContent).toBe("Once upon a time");
  });

  it("a renamed text layer shows the name, and keeps the words in the tooltip", () => {
    const named: LayerSummary = { ...unnamedText, id: "text-named", label: "Opening title" };
    const { getByText, queryByText } = renderTimeline({ tracks: [trackWith(named)] });
    expect(getByText("Opening title")).toBeTruthy();
    // The words are gone from the surface — the tooltip is the one place they
    // survive, which is why LayerBlock appends them to `title` for Text.
    expect(queryByText("Once upon a time")).toBeNull();
    const block = getByText("Opening title").closest(".timeline-layer");
    expect(block?.getAttribute("title")).toContain("Once upon a time");
  });
});

/// Integration cover for the follow wiring — the unit tests
/// (`followPlayhead.test.ts`, `hooks/useFollowPlayhead.test.ts`) own the page
/// geometry and the gating; what only shows up here is whether Timeline hands
/// the hook the RIGHT measurements (lane viewport, canvas width) and the right
/// scrub boundary.
describe("Timeline follow-playhead", () => {
  // jsdom lays nothing out: `clientWidth` is 0 (→ a zero-width viewport, which
  // the follow correctly declines to page) and a `scrollLeft` write on a box
  // with no layout is dropped. Stub the width, and read the outcome off the
  // scroll store, which the hook publishes to on every page.
  const LANE_VIEWPORT_PX = 1000;
  let clientWidth: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearLayerSelection();
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    setTimelineScrollLeftPx(null, 0);
    clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(LANE_VIEWPORT_PX + HEADER_COL_PX);
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AllTracks", timeline_follow_playhead: true },
    }));
  });
  afterEach(() => {
    clientWidth.mockRestore();
    cleanup();
  });

  // 60 s @ the mocked 80 px/s view state = a 4800 px canvas, so a playhead at
  // 13 s (1040 px) is off the right edge of the opening [0, 1000) window and
  // the page target is not clamped by either end stop.
  const LONG = { durationUs: 60_000_000 };

  it("pages the view when the playhead leaves the right edge", () => {
    renderTimeline(LONG);

    act(() => setPlayheadTimeUs(5_000_000)); // 400 px — inside the window
    expect(timelineScrollLeftPx(null)).toBe(0);

    act(() => setPlayheadTimeUs(13_000_000)); // 1040 px — past it
    expect(timelineScrollLeftPx(null)).toBe(960);
  });

  it("holds the view still across a ruler scrub drag", () => {
    const { container } = renderTimeline(LONG);
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;

    fireEvent.pointerDown(ruler, { button: 0, clientX: 200 });
    act(() => setPlayheadTimeUs(13_000_000));
    expect(timelineScrollLeftPx(null)).toBe(0);

    fireEvent.pointerUp(window, { clientX: 200 });
    act(() => setPlayheadTimeUs(13_100_000));
    expect(timelineScrollLeftPx(null)).toBe(968);
  });

  it("leaves the view alone when the pref is off", () => {
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, timeline_follow_playhead: false },
    }));
    renderTimeline(LONG);

    act(() => setPlayheadTimeUs(13_000_000));
    expect(timelineScrollLeftPx(null)).toBe(0);
  });
});

/// Integration cover for the keyboard-zoom wiring — the step ladder and the
/// anchor are unit-tested (`zoom.test.ts`, `hooks/useTimelineView.test.ts`).
/// What only shows up here is whether the keys reach the handler at all: the
/// action is dispatched by Timeline's own `useShortcuts` instance, and its
/// effect on the view is a re-laid-out canvas.
describe("Timeline keyboard zoom", () => {
  const LANE_VIEWPORT_PX = 1000;
  let clientWidth: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearLayerSelection();
    // Deliberately left null: these bindings are UNSCOPED, so they have to fire
    // with no panel owning the focused region.
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    setTimelineScrollLeftPx(null, 0);
    clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(LANE_VIEWPORT_PX + HEADER_COL_PX);
  });
  afterEach(() => {
    clientWidth.mockRestore();
    cleanup();
  });

  // 60 s @ the mocked 80 px/s view state = a 4800 px canvas, plus the post-roll
  // padding (35 % of the 1000 px lane) = 5150 px. Each press scales the content
  // half by two; the padding is a function of the lane, so it doesn't move.
  const LONG = { durationUs: 60_000_000 };
  const canvasWidth = (container: HTMLElement): string =>
    (container.querySelector('[data-testid="timeline-canvas"]') as HTMLElement)
      .style.width;
  const press = (key: string, target: Element | Window = window) =>
    fireEvent.keyDown(target, { key, code: key === "=" ? "Equal" : "Minus" });

  it("zooms in on = and back out on -", () => {
    const { container } = renderTimeline(LONG);
    expect(canvasWidth(container)).toBe("5150px");

    press("=");
    expect(canvasWidth(container)).toBe("9950px");

    press("-");
    expect(canvasWidth(container)).toBe("5150px");
  });

  // Bare keys must stay typeable: `-` is a character a numeric inspector field
  // needs, and the dispatcher's default for a non-chord binding is to stand
  // down inside a text editor. Cheap guard on a property `defs.ts` claims.
  it("stays out of the way while a text field is focused", () => {
    const { container } = renderTimeline(LONG);
    const input = document.createElement("input");
    document.body.appendChild(input);

    press("=", input);
    expect(canvasWidth(container)).toBe("5150px");

    input.remove();
  });
});

/// The marquee's wiring: which surfaces arm it, what arms and disarms it, and
/// what the box does to the selection once it exists. The rules the box obeys
/// are proved from hand-fed rows in `marquee.test.ts`; what is proved here is
/// that the rows handed to them are the rendered lanes, in the box's own
/// coordinate space.
describe("Timeline marquee", () => {
  const keyedTrack: TrackSummary = {
    ...track,
    layers: [
      {
        ...tinyVideoLayer,
        id: "keyed-1",
        label: "Keyed",
        // Two seconds — 160 px at the default zoom — so a box drawn inside the
        // chip's own span still lands clear of the left auto-scroll band.
        t_end_us: 2_000_000,
        params: {
          kind: "VideoClip",
          media_id: "media-1",
          media_label: "media.mov",
          src_in_us: 0,
          src_out_us: 2_000_000,
          x: staticNum(0),
          y: staticNum(0),
          scale_x: staticNum(1),
          scale_y: staticNum(1),
          scale_linked: true,
          rotation_deg: staticNum(0),
          anchor_x: { mode: "Static", value: 0.5 },
          anchor_y: { mode: "Static", value: 0.5 },
          // The one keyed param, so the track offers exactly one sub-lane row.
          opacity: {
            mode: "Keyframed",
            value: [{ id: "kf-1", t_us: 0, value: 1, interp: { kind: "Linear" } }],
          },
          speed: 1,
          flip_h: false,
          flip_v: false,
          fade_in_us: 0,
          fade_out_us: 0,
        },
      },
    ],
  };

  // Three keys at three values on one property, so an expanded sub-lane draws
  // three vertically distinguishable dots for a box to take a subset of. Parked
  // at 1 s so their x sits clear of the left auto-scroll band.
  const multiKeyTrack: TrackSummary = {
    ...track,
    id: "multi-key-track",
    layers: [
      {
        ...keyedTrack.layers[0]!,
        t_start_us: 1_000_000,
        t_end_us: 3_000_000,
        params: {
          ...(keyedTrack.layers[0]!.params as Extract<
            LayerSummary["params"],
            { kind: "VideoClip" }
          >),
          opacity: {
            mode: "Keyframed",
            value: [
              { id: "kf-hi", t_us: 0, value: 1, interp: { kind: "Linear" } },
              { id: "kf-mid", t_us: 500_000, value: 0.5, interp: { kind: "Linear" } },
              { id: "kf-lo", t_us: 1_000_000, value: 0, interp: { kind: "Linear" } },
            ],
          },
        },
      },
    ],
  };

  /// A VideoClip layer whose only keyed param is `opacity`, so its track offers
  /// exactly one sub-lane row however many of these it holds.
  function opacityKeyedLayer(
    id: string,
    tStartUs: number,
    keys: { id: string; t_us: number; value: number }[],
  ): LayerSummary {
    return {
      ...keyedTrack.layers[0]!,
      id,
      t_start_us: tStartUs,
      t_end_us: tStartUs + 2_000_000,
      params: {
        ...(keyedTrack.layers[0]!.params as Extract<
          LayerSummary["params"],
          { kind: "VideoClip" }
        >),
        opacity: {
          mode: "Keyframed",
          value: keys.map((k) => ({ ...k, interp: { kind: "Linear" as const } })),
        },
      },
    };
  }

  // Two layers drawing into ONE sub-lane row, sequential in time so nothing
  // overlaps. At the default 80 px/s their four keys sit at canvas x 80/160
  // (kl-a, starting at 1 s) and 240/320 (kl-b, at 3 s). The values are all
  // distinct, so an emptied track collapsing to the WRONG one shows up.
  const twoLayerKeyTrack: TrackSummary = {
    ...track,
    id: "two-layer-track",
    layers: [
      opacityKeyedLayer("kl-a", 1_000_000, [
        { id: "a1", t_us: 0, value: 1 },
        { id: "a2", t_us: 1_000_000, value: 0.25 },
      ]),
      opacityKeyedLayer("kl-b", 3_000_000, [
        { id: "b1", t_us: 0, value: 0.8 },
        { id: "b2", t_us: 1_000_000, value: 0.5 },
      ]),
    ],
  };

  // One keyed layer each, so expanding both gives two sub-lane rows a single
  // box can cross — the case a per-track Delete handler answered twice.
  const twoKeyedTracks: TrackSummary[] = [
    {
      ...track,
      id: "kt-1",
      label: "K1",
      layers: [opacityKeyedLayer("kl-1", 1_000_000, [{ id: "one", t_us: 0, value: 1 }])],
    },
    {
      ...track,
      id: "kt-2",
      label: "K2",
      layers: [opacityKeyedLayer("kl-2", 1_000_000, [{ id: "two", t_us: 0, value: 0.5 }])],
    },
  ];

  // Two lanes a single box can cross, plus one clip parked beyond every box
  // below — the primary that does NOT survive a sweep.
  const clipA: LayerSummary = { ...layer, id: "clip-a", label: "A" };
  const clipFar: LayerSummary = {
    ...layer,
    id: "clip-far",
    label: "Far",
    t_start_us: 3_000_000,
    t_end_us: 4_000_000,
  };
  const clipB: LayerSummary = { ...layer, id: "clip-b", label: "B" };
  const laneATrack: TrackSummary = {
    ...track,
    id: "track-a",
    label: "A",
    layers: [clipA, clipFar],
  };
  const laneBTrack: TrackSummary = {
    ...track,
    id: "track-b",
    label: "B",
    role: "b-roll",
    layers: [clipB],
  };
  const twoLanes = [laneATrack, laneBTrack];

  beforeEach(() => {
    clearLayerSelection();
    clearKeyframeSelection();
    clearKeyframeFocus();
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    setTool("select");
    ipcMocks.updateParamTracksMulti.mockClear();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AllTracks" },
    }));
  });
  afterEach(() => {
    setTool("select");
    cleanup();
  });

  function stubRect(
    el: Element,
    r: { left: number; top: number; right: number; bottom: number },
  ) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...r,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  // jsdom lays nothing out, and the box IS a rect subtraction — so the canvas
  // gets an origin deliberately away from (0, 0): a dropped `- rect.left` then
  // shows up as a wrong x instead of passing by coincidence. The scroll host's
  // rect matters too, because every pointer position below has to sit clear of
  // both edge bands or the auto-scroll pump would run.
  function stubMarqueeLayout(container: HTMLElement): HTMLElement {
    const canvas = container.querySelector(
      '[data-testid="timeline-canvas"]',
    ) as HTMLElement;
    stubRect(canvas, { left: 200, top: 100, right: 1240, bottom: 500 });
    stubRect(canvas.closest(".overflow-auto")!, {
      left: 0,
      top: 80,
      right: 1240,
      bottom: 520,
    });
    return canvas;
  }

  /// Lay the rendered lanes out as `DEFAULT_TRACK_HEIGHT` bands starting at the
  /// canvas's own top, in VISUAL order — the reverse of the data-model order,
  /// so the first band belongs to the LAST track passed in. The bands therefore
  /// begin at canvas y 0 while their client rects begin at 100, which is the
  /// point: a hit-test that forgot to convert reads every row a whole canvas
  /// origin too low.
  function stubLaneRows(container: HTMLElement) {
    const lanes = Array.from(
      container.querySelectorAll('[data-testid="track-lane"]'),
    );
    lanes.forEach((lane, i) => {
      stubRect(lane, {
        left: 200,
        right: 1240,
        top: 100 + i * DEFAULT_TRACK_HEIGHT,
        bottom: 100 + (i + 1) * DEFAULT_TRACK_HEIGHT,
      });
    });
  }

  const marquee = (container: HTMLElement) =>
    container.querySelector('[data-testid="timeline-marquee"]');

  const selection = () => {
    const current = currentSelection();
    return {
      primary: primaryLayerIdOf(current),
      ids: [...layerIdsOf(current)].sort(),
    };
  };

  /// Press `el`, then travel. One move is enough: the arm gate is displacement
  /// from the press, not a count of events.
  function sweep(
    el: Element,
    from: [number, number],
    to: [number, number],
    button = 0,
  ) {
    fireEvent.pointerDown(el, { button, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  }

  const release = (to: [number, number]) =>
    fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });

  /// Press and release without travel: the background click.
  function pressAndRelease(el: Element, at: [number, number]) {
    fireEvent.pointerDown(el, { button: 0, clientX: at[0], clientY: at[1] });
    release(at);
  }

  it("draws no box below the arm threshold", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [402, 200]);

    expect(marquee(container)).toBeNull();
    release([402, 200]);
  });

  it("draws a lane-background box in canvas coordinates", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [404, 260]);

    const box = marquee(container)!;
    expect(box.getAttribute("data-kind")).toBe("clip");
    // Canvas origin (200, 100), so the press is at (200, 100) in its space and
    // the 4 × 60 px of travel is the box's extent. What the overlay does with
    // those four numbers is `MarqueeOverlay.test.tsx`'s subject; this asserts
    // the coordinate SPACE, which is the part only a mounted Timeline can get
    // wrong.
    expect((box as HTMLElement).style.left).toBe("200px");
    expect((box as HTMLElement).style.top).toBe("100px");
    expect((box as HTMLElement).style.width).toBe("4px");
    expect((box as HTMLElement).style.height).toBe("60px");
    release([404, 260]);
  });

  it("draws a clip box from the drop strip", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const strip = container.querySelector(
      '[data-testid="timeline-drop-strip"]',
    )!;

    sweep(strip, [400, 120], [420, 300]);

    expect(marquee(container)?.getAttribute("data-kind")).toBe("clip");
    release([420, 300]);
  });

  it("draws a clip box from the scroll body", () => {
    const { container } = renderTimeline({});
    const canvas = stubMarqueeLayout(container);

    sweep(canvas.parentElement!, [400, 400], [500, 300]);

    expect(marquee(container)?.getAttribute("data-kind")).toBe("clip");
    release([500, 300]);
  });

  it("draws a keyframe box from a sub-lane row", () => {
    const { container } = renderTimeline({ tracks: [keyedTrack] });
    fireEvent.click(container.querySelector('[data-testid="kf-lane-twirl"]')!);
    stubMarqueeLayout(container);
    const row = container.querySelector('[data-testid="kf-sublane"]')!;

    sweep(row, [400, 200], [460, 210]);

    // "keyframe" and not "clip" is also the proof that the row's handler stops
    // the pointerdown: the scroll body's anchor would otherwise overwrite it.
    expect(marquee(container)?.getAttribute("data-kind")).toBe("keyframe");
    release([460, 210]);
  });

  it("drops the box on Escape", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [440, 240]);
    expect(marquee(container)).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(marquee(container)).toBeNull();
  });

  it("drops the box on release", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [440, 240]);
    expect(marquee(container)).not.toBeNull();

    release([440, 240]);
    expect(marquee(container)).toBeNull();
  });

  it("ignores a non-primary button", () => {
    const { container } = renderTimeline({});
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [440, 240], 2);

    expect(marquee(container)).toBeNull();
    release([440, 240]);
  });

  it("stands down in blade mode", () => {
    setTool("blade");
    // The prop is a separate thread from `DockWorkspace`; the anchor gates on
    // the store, which is why the hook takes no `bladeMode`.
    const { container } = renderTimeline({ bladeMode: true });
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [400, 200], [440, 240]);

    expect(marquee(container)).toBeNull();
    release([440, 240]);
  });

  it("keeps a press on the ruler a scrub and only a scrub", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ onSeek, selectedLayerId: layer.id });
    stubMarqueeLayout(container);
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;

    sweep(ruler, [400, 90], [440, 240]);

    expect(onSeek).toHaveBeenCalled();
    expect(marquee(container)).toBeNull();
    // The ruler is not a background click either: seeking never deselects.
    expect(selection()).toEqual({ primary: layer.id, ids: [layer.id] });
    release([440, 240]);
    expect(selection()).toEqual({ primary: layer.id, ids: [layer.id] });
  });

  it("selects every clip the box touches, across lanes", () => {
    const { container } = renderTimeline({ tracks: twoLanes });
    stubMarqueeLayout(container);
    stubLaneRows(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [250, 130], [300, 200]);
    release([300, 200]);

    // `clip-far` starts at 3s — inside a swept lane, outside the swept x range.
    expect(selection()).toEqual({
      primary: "clip-a",
      ids: ["clip-a", "clip-b"],
    });
  });

  it("keeps a surviving primary, and promotes the first hit otherwise", () => {
    const { container } = renderTimeline({
      tracks: twoLanes,
      selectedLayerId: "clip-b",
    });
    stubMarqueeLayout(container);
    stubLaneRows(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [250, 130], [300, 200]);
    release([300, 200]);
    expect(selection()).toEqual({
      primary: "clip-b",
      ids: ["clip-a", "clip-b"],
    });

    setLayerSelection("clip-far", ["clip-far"]);
    sweep(lane, [250, 130], [300, 200]);
    release([300, 200]);
    expect(selection()).toEqual({
      primary: "clip-a",
      ids: ["clip-a", "clip-b"],
    });
  });

  it("clears the selection when the box takes nothing", () => {
    const { container } = renderTimeline({
      tracks: twoLanes,
      selectedLayerId: "clip-a",
    });
    stubMarqueeLayout(container);
    stubLaneRows(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    // Canvas x 500 → 560: past every chip, still clear of the right edge band.
    sweep(lane, [700, 130], [760, 200]);
    release([760, 200]);

    expect(selection()).toEqual({ primary: null, ids: [] });
  });

  it("clears the layer selection on a sub-threshold press in a lane", () => {
    const { container } = renderTimeline({
      tracks: twoLanes,
      selectedLayerId: "clip-a",
    });
    stubMarqueeLayout(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    pressAndRelease(lane, [700, 130]);

    expect(selection()).toEqual({ primary: null, ids: [] });
  });

  it("clears only the keyframe selection on a sub-threshold press in a sub-lane", () => {
    const { container } = renderTimeline({
      tracks: [keyedTrack],
      selectedLayerId: "keyed-1",
    });
    fireEvent.click(container.querySelector('[data-testid="kf-lane-twirl"]')!);
    stubMarqueeLayout(container);
    selectKeyframe({ layerId: "keyed-1", paramKey: "opacity", kfId: "kf-1" });
    const row = container.querySelector('[data-testid="kf-sublane"]')!;

    pressAndRelease(row, [400, 200]);

    expect(getSelectedKeyframes()).toEqual([]);
    // The clip stays selected, so the Attribute panel stays on what it was
    // inspecting.
    expect(selection()).toEqual({ primary: "keyed-1", ids: ["keyed-1"] });
  });

  it("hands the Delete after a clip marquee to the clips, not a stale keyframe", () => {
    const { container } = renderTimeline({
      tracks: [keyedTrack],
      selectedLayerId: "keyed-1",
    });
    fireEvent.click(container.querySelector('[data-testid="kf-lane-twirl"]')!);
    stubMarqueeLayout(container);
    stubLaneRows(container);
    // Every sub-selection Delete stands down outside the timeline region
    // (ADR 0041), so the region has to be armed for the race to exist at all.
    setActiveRegion("timeline");
    const lane = container.querySelector('[data-testid="track-lane"]')!;
    const kf = { layerId: "keyed-1", paramKey: "opacity", kfId: "kf-1" };

    // Control: with the keyframe selection standing, Delete commits param
    // tracks — the keyframe path won the race and the layer's Delete was eaten.
    // Inside `act` both times, because the capture-phase handler is registered
    // by an effect: without the flush the race would not be armed and the
    // assertion below it would pass against anything.
    act(() => selectKeyframe(kf));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(ipcMocks.updateParamTracksMulti).toHaveBeenCalledTimes(1);

    act(() => selectKeyframe(kf));
    ipcMocks.updateParamTracksMulti.mockClear();
    sweep(lane, [250, 130], [300, 200]);
    release([300, 200]);

    expect(selection()).toEqual({ primary: "keyed-1", ids: ["keyed-1"] });
    expect(getSelectedKeyframes()).toEqual([]);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(ipcMocks.updateParamTracksMulti).not.toHaveBeenCalled();
  });

  it("restores the selection that stood at pointerdown on Escape", () => {
    const { container } = renderTimeline({
      tracks: twoLanes,
      selectedLayerId: "clip-far",
    });
    stubMarqueeLayout(container);
    stubLaneRows(container);
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    sweep(lane, [250, 130], [300, 200]);
    expect(selection()).toEqual({
      primary: "clip-a",
      ids: ["clip-a", "clip-b"],
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(selection()).toEqual({ primary: "clip-far", ids: ["clip-far"] });
  });

  it("restores a transition chip selection on Escape", () => {
    const { container } = renderTimeline({ tracks: twoLanes });
    stubMarqueeLayout(container);
    stubLaneRows(container);
    setTransitionSelection("transition-1");
    const lane = container.querySelector('[data-testid="track-lane"]')!;

    // The box evicts the chip on its way in: layer and transition selection are
    // mutually exclusive.
    sweep(lane, [250, 130], [300, 200]);
    expect(transitionIdOf(currentSelection())).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(transitionIdOf(currentSelection())).toBe(
      "transition-1",
    );
  });

  it("selects the diamonds a sub-lane box covers, and moves nothing else", () => {
    const seek = vi.fn();
    const transport = { play() {}, pause() {}, seek, isPlaying: () => false };
    registerTransport(transport);
    const { container } = renderTimeline({
      tracks: [multiKeyTrack],
      selectedLayerId: "keyed-1",
    });
    fireEvent.click(container.querySelector('[data-testid="kf-lane-twirl"]')!);
    // Focus is what expands the row to `KF_SUBLANE_EXPANDED_H`, and the height
    // is what spreads the three dots apart.
    act(() => setKeyframeFocus("keyed-1", "opacity"));
    stubMarqueeLayout(container);
    const row = container.querySelector('[data-testid="kf-sublane"]')!;
    // Client [300, 372) → canvas [200, 272). The dots then draw at canvas y
    // 206 / 236 / 266 and x 80 / 120 / 160, so a box that forgot to convert the
    // row into canvas space takes nothing at all.
    stubRect(row, { left: 200, right: 1240, top: 300, bottom: 372 });

    // Canvas y 202 → 220: the top dot alone, which is the whole point of the
    // expanded row's second axis.
    sweep(row, [270, 302], [370, 320]);
    expect(getSelectedKeyframes().map((k) => k.kfId)).toEqual(["kf-hi"]);

    fireEvent.pointerMove(window, { clientX: 370, clientY: 370 });
    release([370, 370]);
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "keyed-1", paramKey: "opacity", kfId: "kf-hi" },
      { layerId: "keyed-1", paramKey: "opacity", kfId: "kf-mid" },
      { layerId: "keyed-1", paramKey: "opacity", kfId: "kf-lo" },
    ]);
    // A selection gesture and nothing more: no seek, no focus move, and the
    // clip the Attribute panel is on stays selected.
    expect(seek).not.toHaveBeenCalled();
    expect(playheadTimeUs()).toBe(0);
    expect(useKeyframeFocusStore.getState()).toEqual({
      layerId: "keyed-1",
      paramKey: "opacity",
    });
    expect(selection()).toEqual({ primary: "keyed-1", ids: ["keyed-1"] });
    releaseTransport(transport);
  });

  /// Expands every rendered track's sub-lanes and lays the resulting rows out as
  /// 24 px collapsed bands from client y 300 down. A collapsed row hit-tests on
  /// x alone, so these tests state the x arithmetic and nothing else.
  function expandAndStubSubLaneRows(container: HTMLElement): HTMLElement[] {
    for (const twirl of container.querySelectorAll('[data-testid="kf-lane-twirl"]')) {
      fireEvent.click(twirl);
    }
    stubMarqueeLayout(container);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="kf-sublane"]'),
    ) as HTMLElement[];
    rows.forEach((row, i) => {
      stubRect(row, { left: 200, right: 1240, top: 300 + i * 30, bottom: 324 + i * 30 });
    });
    return rows;
  }

  /// The app-level delete-selected-layer shortcut's stand-in: a BUBBLE-phase
  /// window listener, which is the phase `useShortcuts` dispatches bare keys in.
  /// The timeline's keyframe Delete is a capture-phase listener that calls
  /// `stopImmediatePropagation`, so preemption means this never runs.
  function armAppDeleteSpy() {
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    return { spy, release: () => window.removeEventListener("keydown", spy) };
  }

  it("deletes every key a box swept across two layers in ONE op", () => {
    const { container } = renderTimeline({
      tracks: [twoLayerKeyTrack],
      selectedLayerId: "kl-a",
    });
    const [row] = expandAndStubSubLaneRows(container);
    setActiveRegion("timeline");
    const { spy: appDelete, release: releaseSpy } = armAppDeleteSpy();

    // Positive control: with no keyframe selection standing, the keystroke
    // reaches the app-level listener — so the assertion below is about the
    // preemption and not about a listener that was never wired.
    fireEvent.keyDown(window, { key: "Delete" });
    expect(appDelete).toHaveBeenCalledTimes(1);
    appDelete.mockClear();

    // Canvas x [50, 350) takes all four keys; the row's band is crossed at
    // canvas y 202.
    sweep(row!, [250, 302], [550, 320]);
    release([550, 320]);
    expect(getSelectedKeyframes().map((k) => `${k.layerId}/${k.kfId}`)).toEqual([
      "kl-a/a1",
      "kl-a/a2",
      "kl-b/b1",
      "kl-b/b2",
    ]);

    fireEvent.keyDown(window, { key: "Delete" });
    releaseSpy();

    // One op for two layers — one undo entry — carrying an entry per
    // (layer, param), each emptied track collapsing to its OWN last value.
    expect(ipcMocks.updateParamTracksMulti).toHaveBeenCalledTimes(1);
    expect(ipcMocks.updateParamTracksMulti.mock.calls[0]![0]).toEqual([
      ["kl-a", "opacity", { mode: "Static", value: 0.25 }],
      ["kl-b", "opacity", { mode: "Static", value: 0.5 }],
    ]);
    expect(appDelete).not.toHaveBeenCalled();
    expect(getSelectedKeyframes()).toEqual([]);
  });

  it("still issues ONE op for a selection spanning two expanded tracks", () => {
    const { container } = renderTimeline({
      tracks: twoKeyedTracks,
      selectedLayerId: "kl-1",
    });
    const rows = expandAndStubSubLaneRows(container);
    expect(rows).toHaveLength(2);
    setActiveRegion("timeline");

    // Canvas y [202, 250) crosses both rows ([200, 224) and [230, 254)); canvas
    // x [50, 200) takes the one key each layer carries, at 80.
    sweep(rows[0]!, [250, 302], [400, 350]);
    release([400, 350]);
    expect(getSelectedKeyframes().map((k) => k.kfId).sort()).toEqual(["one", "two"]);

    fireEvent.keyDown(window, { key: "Delete" });

    // The hazard this replaced: one armed handler per track, each stopping the
    // event dead after committing its own subset. Entry order reads DOWN the
    // screen — visual order is the reverse of the data-model order, so the
    // second track's row is the upper one.
    expect(ipcMocks.updateParamTracksMulti).toHaveBeenCalledTimes(1);
    expect(ipcMocks.updateParamTracksMulti.mock.calls[0]![0]).toEqual([
      ["kl-2", "opacity", { mode: "Static", value: 0.5 }],
      ["kl-1", "opacity", { mode: "Static", value: 1 }],
    ]);
  });

  /// The interps the batch committed, per entry.
  function committedInterps(): [string, string[]][] {
    const entries = ipcMocks.updateParamTracksMulti.mock.calls[0]![0] as [
      string,
      string,
      AnimTrack<number>,
    ][];
    return entries.map(([layerId, , t]) => [
      layerId,
      t.mode === "Keyframed" ? t.value.map((k) => k.interp.kind) : [],
    ]);
  }

  const diamond = (container: HTMLElement, kfId: string) =>
    container.querySelector(`.kf-sublane-diamond[data-kf-id="${kfId}"]`)!;

  it("right-clicking a diamond inside the selection eases the whole selection", () => {
    const { container } = renderTimeline({
      tracks: [twoLayerKeyTrack],
      selectedLayerId: "kl-a",
    });
    const [row] = expandAndStubSubLaneRows(container);

    sweep(row!, [250, 302], [550, 320]);
    release([550, 320]);
    expect(getSelectedKeyframes()).toHaveLength(4);

    fireEvent.contextMenu(diamond(container, "a1"));
    // The diamond's own handler would have narrowed the selection to `a1` on its
    // way to the menu; the row answers first precisely so it cannot.
    expect(getSelectedKeyframes()).toHaveLength(4);
    fireEvent.click(screen.getByTestId("easing-cmd-hold"));

    expect(ipcMocks.updateParamTracksMulti).toHaveBeenCalledTimes(1);
    expect(committedInterps()).toEqual([
      ["kl-a", ["Hold", "Hold"]],
      ["kl-b", ["Hold", "Hold"]],
    ]);
  });

  it("right-clicking a diamond outside the selection eases that key alone", () => {
    const { container } = renderTimeline({
      tracks: [twoLayerKeyTrack],
      selectedLayerId: "kl-a",
    });
    const [row] = expandAndStubSubLaneRows(container);

    // Canvas x [50, 200) reaches kl-a's pair (80, 160) and neither of kl-b's.
    sweep(row!, [250, 302], [400, 320]);
    release([400, 320]);
    expect(getSelectedKeyframes().map((k) => k.kfId)).toEqual(["a1", "a2"]);

    fireEvent.contextMenu(diamond(container, "b1"));
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "kl-b", paramKey: "opacity", kfId: "b1" },
    ]);
    fireEvent.click(screen.getByTestId("easing-cmd-hold"));

    expect(ipcMocks.updateParamTracksMulti).toHaveBeenCalledTimes(1);
    expect(committedInterps()).toEqual([["kl-b", ["Hold", "Linear"]]]);
  });
});

describe("Timeline link chrome", () => {
  // Data order [lower, upper] → `upper` renders as the TOP row.
  const lowerTrack: TrackSummary = { ...track, id: "track-lower", layers: [layer] };
  const upperTrack: TrackSummary = {
    ...track,
    id: "track-upper",
    role: "b-roll",
    layers: [linkedLayer],
  };
  const hiddenTrack: TrackSummary = {
    ...track,
    id: "track-hidden",
    role: null,
    transient: true,
    layers: [linkedLayer],
  };
  const blockOf = (label: string) =>
    screen.getByText(label).closest(".timeline-layer") as HTMLElement;

  beforeEach(() => {
    clearLayerSelection();
    setActiveRegion(null);
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AllTracks", tail_snap_enabled: false },
    }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a linked clip carries its link id and, when wide enough for its full label, the chain glyph", () => {
    renderTimeline({ tracks: [linkedTrack], links: [link] });
    const first = blockOf("Clip A");
    expect(first.getAttribute("data-link-id")).toBe(link.id);
    expect(first.querySelector('[data-testid="link-glyph"]')).not.toBeNull();
    expect(screen.queryByTestId("link-tab")).toBeNull();
  });

  it("an unlinked clip carries neither the id nor the glyph", () => {
    renderTimeline({ tracks: [linkedTrack], links: [] });
    const first = blockOf("Clip A");
    expect(first.hasAttribute("data-link-id")).toBe(false);
    expect(first.querySelector('[data-testid="link-glyph"]')).toBeNull();
  });

  it("a labelled link draws its tab once, on the top-most visible member", () => {
    renderTimeline({
      tracks: [lowerTrack, upperTrack],
      links: [{ ...link, label: "Pair" }],
    });
    const tabs = screen.getAllByTestId("link-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.textContent).toBe("Pair");
    expect(blockOf("Clip B").contains(tabs[0]!)).toBe(true);
    expect(screen.queryByTestId("link-hidden-badge")).toBeNull();
  });

  it("in A/B Roll the visible member counts its filtered-out siblings; All Tracks counts none", () => {
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AbRoll" },
    }));
    const { unmount } = renderTimeline({ tracks: [lowerTrack, hiddenTrack], links: [link] });
    expect(screen.queryByText("Clip B")).toBeNull();
    const badge = screen.getByTestId("link-hidden-badge");
    expect(badge.textContent).toBe("+1");
    expect(blockOf("Clip A").contains(badge)).toBe(true);
    unmount();

    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AllTracks" },
    }));
    renderTimeline({ tracks: [lowerTrack, hiddenTrack], links: [link] });
    expect(screen.queryByTestId("link-hidden-badge")).toBeNull();
  });

  it("clicking the badge reveals the first hidden member's lane and leaves the selection alone", () => {
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AbRoll" },
    }));
    // Through `apply`: the reveal resolves the lane's composition off the
    // store's index, which only `apply` builds.
    useProjectStore.getState().apply(
      summaryFixture({ root: { tracks: [lowerTrack, hiddenTrack] } }),
    );
    const reveal = vi.fn();
    const unregister = registerRevealTrack(reveal);
    try {
      renderTimeline({ tracks: [lowerTrack, hiddenTrack], links: [link] });
      act(() => setLayerSelection(layer.id, [layer.id, linkedLayer.id]));
      fireEvent.click(screen.getByTestId("link-hidden-badge"));
      expect(reveal).toHaveBeenCalledTimes(1);
      expect(reveal).toHaveBeenCalledWith(hiddenTrack.id, null);
      expect(primaryLayerIdOf(currentSelection())).toBe(layer.id);
      expect(new Set(layerIdsOf(currentSelection()))).toEqual(
        new Set([layer.id, linkedLayer.id]),
      );
    } finally {
      unregister();
      useProjectStore.setState({ summary: null });
    }
  });

  it("a move drag carries the hidden-subject count on the dragged member", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AbRoll" },
    }));
    renderTimeline({
      tracks: [lowerTrack, hiddenTrack],
      links: [link],
      selectedLayerId: layer.id,
    });
    const block = blockOf("Clip A");
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 30 });
    // Armed: the ghost moved a whole second.
    expect(block.style.left).toBe("80px");
    expect(block.getAttribute("data-drag-validity")).toBe("valid");
    expect(block.querySelector('[data-testid="link-hidden-badge"]')?.textContent).toBe("+1");
    fireEvent.pointerUp(window, { clientX: 160, clientY: 30 });
  });

  it("the layer context menu offers a link rename only for a linked clip", async () => {
    renderTimeline({ tracks: [linkedTrack], links: [link] });
    fireEvent.contextMenu(blockOf("Clip A"), { clientX: 40, clientY: 30 });
    await waitFor(() => expect(screen.queryByText("Rename link…")).not.toBeNull());
    fireEvent.click(screen.getByText("Rename link…"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Link name")).not.toBeNull(),
    );
    // The editor opens on the anchor member's tab even for an unlabelled link.
    expect(screen.queryByTestId("link-tab-anchor")).not.toBeNull();
  });
});

/// One moment, read in this Panel's coordinates (ADR 0053 decision 2). The
/// projection itself is unit-tested (`render/timeProjection.test.ts`,
/// `state/playheadProjection.test.ts`); what only shows up here is whether the
/// Panel draws through it — and stops drawing when its Group is off screen.
describe("Timeline playhead projection", () => {
  const G1 = "comp-g1";
  /// 80 px/s from the mocked view state, so one second of this Group's own
  /// clock is 80 px along its ruler.
  const PX_PER_SEC = 80;

  const g1Layer: LayerSummary = {
    ...layer,
    id: "inner-g1",
    label: "Inside",
    t_end_us: 5_000_000,
  };
  const g1Track: TrackSummary = { ...track, id: "t-g1", layers: [g1Layer] };

  /// A 4 s placement of the 5 s Group at root 12 s, so root 13 s is the Group's
  /// own 1 s and root 3 s is nowhere on it.
  const groupClip: LayerSummary = {
    ...layer,
    id: "ref-g1",
    label: "Group 1",
    kind: "CompositionRef",
    t_start_us: 12_000_000,
    t_end_us: 16_000_000,
    params: {
      kind: "CompositionRef",
      composition_id: G1,
      composition_label: null,
      src_in_us: 0,
      src_out_us: 4_000_000,
      x: staticNum(0),
      y: staticNum(0),
      scale_x: staticNum(1),
      scale_y: staticNum(1),
      scale_linked: true,
      rotation_deg: staticNum(0),
      opacity: staticNum(1),
      anchor_x: staticNum(0.5),
      anchor_y: staticNum(0.5),
    },
  };

  function renderGroupTimeline(onSeek: (tUs: number) => void) {
    useProjectStore.getState().apply(
      summaryFixture({
        project_id: "p-projection",
        root: {
          duration_us: 60_000_000,
          tracks: [{ ...track, id: "t-root", layers: [groupClip] }],
        },
        groups: [
          {
            id: G1,
            label: "Lower third",
            ordinal: 1,
            width: 1920,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            duration_us: 5_000_000,
            duration_pinned: false,
            fps_locked: false,
            tracks: [g1Track],
            markers: [],
            transitions: [],
            links: [],
          },
        ],
      }),
    );
    openComposition(G1, "ref-g1");
    return render(
      <Timeline
        compositionId={G1}
        tracks={[g1Track]}
        links={[]}
        durationUs={5_000_000}
        keybindings={{}}
        fpsNum={30}
        fpsDen={1}
        bladeMode={false}
        media={[]}
        importing={new Set()}
        proxyState={new Map()}
        previewDecodable={new Set()}
        onExitBlade={vi.fn()}
        onSeek={onSeek}
        onMutated={vi.fn().mockResolvedValue(undefined)}
      />,
    );
  }

  beforeEach(() => {
    clearLayerSelection();
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    setTimelineScrollLeftPx(G1, 0);
  });
  afterEach(() => {
    cleanup();
    useProjectStore.getState().apply(null);
  });

  it("draws the moment at the offset its anchor gives it, and tracks it there", () => {
    const { container } = renderGroupTimeline(vi.fn());
    const playhead = container.querySelector<HTMLElement>(
      '[data-testid="timeline-playhead"]',
    )!;

    act(() => setPlayheadTimeUs(13_000_000));
    expect(playhead.style.left).toBe(`${PX_PER_SEC}px`);
    expect(playhead.style.display).toBe("block");

    act(() => setPlayheadTimeUs(14_000_000));
    expect(playhead.style.left).toBe(`${2 * PX_PER_SEC}px`);
  });

  it("draws nothing at a moment its placement does not reach", () => {
    const { container } = renderGroupTimeline(vi.fn());
    const playhead = container.querySelector<HTMLElement>(
      '[data-testid="timeline-playhead"]',
    )!;

    act(() => setPlayheadTimeUs(13_000_000));
    expect(playhead.style.display).toBe("block");

    // Past the Group clip's end: the Group is off screen, so it has no position
    // and a line would have to invent one.
    act(() => setPlayheadTimeUs(17_000_000));
    expect(playhead.style.display).toBe("none");
  });

  it("scrubs the film, not a second playhead of its own", () => {
    const onSeek = vi.fn();
    const { container } = renderGroupTimeline(onSeek);
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;

    // 80 px along this Group's ruler is its own 1 s, which is root 13 s.
    fireEvent.pointerDown(ruler, { button: 0, clientX: PX_PER_SEC });
    fireEvent.pointerUp(window, { clientX: PX_PER_SEC });

    expect(onSeek).toHaveBeenCalledWith(13_000_000);
  });
});

// A Panel is one composition (ADR 0053), so every gesture that reaches the
// backend has to name THIS Panel's — not whichever tab holds the keyboard, and
// not the one the pointer wandered into.
describe("a gesture names the Panel it happened in", () => {
  const GROUP = "comp-group";
  const ROOT = "comp-root";

  beforeEach(() => {
    clearLayerSelection();
    setActiveRegion(null);
    setPlayheadTimeUs(0);
    ipcMocks.addTrack.mockClear();
    ipcMocks.addGroupLayer.mockClear();
    ipcMocks.addMediaLayer.mockClear();
    ipcMocks.moveLayer.mockClear();
    ipcMocks.pasteLayers.mockClear();
    ipcMocks.logEmit.mockClear();
    // The keyboard is in the root while every drop below lands in the Group.
    useCompositionAnchorStore.setState({
      anchors: new Map([
        [ROOT, []],
        [GROUP, [{ layerId: "ref-group", compositionId: GROUP }]],
      ]),
      focusedId: ROOT,
    });
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "AllTracks" },
    }));
  });
  afterEach(() => {
    useMediaDragStore.getState().end();
    cleanup();
  });

  /// The strip laid out the way it renders, since jsdom lays nothing out. The
  /// strip is the drop that spawns a lane, which is the only media drop whose
  /// composition is visible over IPC — a lane drop names a track, and a track id
  /// already fixes the composition.
  const stripOf = (container: HTMLElement): HTMLElement => {
    const strip = container.querySelector(
      '[data-testid="timeline-drop-strip"]',
    ) as HTMLElement;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 1040, top: 0, bottom: 14,
      width: 1040, height: 14, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    return strip;
  };

  const dropOnStrip = (strip: HTMLElement, payload: unknown) => {
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "none",
      getData: () => JSON.stringify(payload),
    };
    const drop = createEvent.drop(strip, { dataTransfer });
    Object.defineProperty(drop, "clientX", {
      value: MEDIA_DRAG_CURSOR_OFFSET_PX + 240,
    });
    fireEvent(strip, drop);
  };

  it("spawns the dropped clip's lane in this Panel, leaving the keyboard where it was", async () => {
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({
      compositionId: GROUP,
      media: [sourceMedia],
    });
    dropOnStrip(stripOf(container), payload);

    await waitFor(() => expect(ipcMocks.addTrack).toHaveBeenCalledWith(GROUP));
    // A drop is a local act: taking the keyboard would take the inspector and
    // the picture with it, which is the opposite of what dropping into a
    // background timeline is for.
    expect(useCompositionAnchorStore.getState().focusedId).toBe(ROOT);
  });

  it("places a dropped Group in this Panel, so the actor's cross-check agrees", async () => {
    const payload = compositionDragPayload(
      { id: "comp-inner", duration_us: 2_000_000 },
      "Lower third",
    );
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({ compositionId: GROUP });
    dropOnStrip(stripOf(container), payload);

    await waitFor(() =>
      expect(ipcMocks.addGroupLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          compositionId: GROUP,
          sourceCompositionId: "comp-inner",
          trackId: "spawned-track",
        }),
      ),
    );
    expect(useCompositionAnchorStore.getState().focusedId).toBe(ROOT);
  });

  it("stands down for a clip dragged onto another Panel, and refuses a COPY there", () => {
    const { container, getByText } = renderTimeline({
      compositionId: ROOT,
      selectedLayerId: layer.id,
    });
    const lane = container.querySelector(
      '[data-testid="track-lane"]',
    ) as HTMLElement;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 480, top: 14, bottom: 70,
      width: 480, height: 56, x: 0, y: 14, toJSON: () => ({}),
    } as DOMRect);
    // The Group's Panel, side by side with this one: same rows, different
    // composition. Its band overlaps this timeline's in y, which is the whole
    // reason the lane hit-test cannot answer this on its own.
    const neighbour = document.createElement("div");
    document.body.appendChild(neighbour);
    vi.spyOn(neighbour, "getBoundingClientRect").mockReturnValue({
      left: 500, right: 1000, top: 0, bottom: 200,
      width: 500, height: 200, x: 500, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const unregister = registerTimelineSurface(GROUP, neighbour);

    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 40 });
    fireEvent.pointerUp(window, { clientX: 720, clientY: 40 });

    // A plain move over the neighbour: this Panel sends nothing and says
    // nothing. The crossing is the DESTINATION Panel's commit, off its own
    // claim (`ForeignDragGhost.tsx`) — none is mounted here — so a line saying
    // a clip cannot cross would contradict what the user is about to watch
    // happen.
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(ipcMocks.logEmit).not.toHaveBeenCalled();

    // Alt held is a different gesture: a copy mints ids, which is a second
    // mutation rather than a parameter of the move, so it is refused at the
    // gesture and explained on the status bar.
    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 40,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 40 });

    expect(ipcMocks.logEmit).toHaveBeenCalledWith(
      expect.objectContaining({ i18n_key: "log.cross_composition_copy" }),
    );
    // One line for the crossing, not one per pointer event.
    fireEvent.pointerMove(window, { clientX: 720, clientY: 40 });
    expect(ipcMocks.logEmit).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(window, { clientX: 720, clientY: 40 });
    expect(ipcMocks.pasteLayers).not.toHaveBeenCalled();

    unregister();
    neighbour.remove();
  });

  // One `window` keydown listener per mounted Panel, and `scope: "timeline"`
  // is a KIND — so every open timeline passes the same region test. Only the
  // focused Panel may answer, or a two-tab workspace runs each handler twice:
  // both would zoom, and a toggle would undo itself.
  describe("a timeline-scoped shortcut answers only in the focused Panel", () => {
    beforeEach(() => {
      setActiveRegion("timeline");
    });

    it("stays silent in a Panel the keyboard is not in", () => {
      renderTimeline({ compositionId: GROUP, tracks: [linkedTrack] });

      fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true });

      expect(new Set(layerIdsOf(currentSelection()))).toEqual(
        new Set(),
      );
    });

    it("answers in the Panel that holds the keyboard", () => {
      renderTimeline({ compositionId: ROOT, tracks: [linkedTrack] });

      fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true });

      expect(new Set(layerIdsOf(currentSelection()))).toEqual(
        new Set([layer.id, linkedLayer.id]),
      );
    });
  });
});


// Two timeline Panels are two mounts of this component, and its command
// provider hands the registry the same ten ids from each of them (ADR 0053).
// Ungated that was a duplicate-id collision on EVERY `listCommands()` call
// — and `getCommand` calls it once per lookup, so the Quick Actions strip
// alone re-discovered it ~25 times a render and flooded the console. Which of
// the two answers is `commands/registry.test.ts`'s half; this is the wiring:
// however many Panels are open, the catalogue sees the ids exactly once.
describe("Timeline command provider with two Panels open", () => {
  const ROOT = "comp-root";
  const GROUP = "comp-group";
  // Every id Timeline's provider contributes, so a new one added without the
  // gate fails here rather than reintroducing the storm quietly.
  const TIMELINE_COMMAND_IDS = [
    "selectAll",
    "deselectAll",
    "toggleLinkSelected",
    "nudgeAudioSampleBack",
    "nudgeAudioSampleForward",
    "nudgeAudioMsBack",
    "nudgeAudioMsForward",
    "resyncAudioToVideo",
    "zoomTimelineIn",
    "zoomTimelineOut",
  ];

  const focus = (compositionId: string) =>
    useCompositionAnchorStore.setState({
      anchors: new Map([
        [ROOT, []],
        [GROUP, [{ layerId: "ref-group", compositionId: GROUP }]],
      ]),
      focusedId: compositionId,
    });

  beforeEach(() => {
    clearLayerSelection();
    setActiveRegion(null);
    focus(ROOT);
  });
  afterEach(cleanup);

  const timelineIdCounts = () => {
    const ids = listCommands().map((c) => c.id);
    return TIMELINE_COMMAND_IDS.map((id) => ids.filter((x) => x === id).length);
  };

  it("contributes each id exactly once, and says nothing on the console", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderTimeline({ compositionId: ROOT });
    renderTimeline({ compositionId: GROUP });

    expect(timelineIdCounts()).toEqual(TIMELINE_COMMAND_IDS.map(() => 1));
    // The storm itself: one lookup used to be one warning per duplicated id.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("still contributes each id exactly once after focus moves to the other Panel", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderTimeline({ compositionId: ROOT });
    renderTimeline({ compositionId: GROUP });

    act(() => focus(GROUP));

    expect(timelineIdCounts()).toEqual(TIMELINE_COMMAND_IDS.map(() => 1));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
