// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveLayersToComposition: vi.fn(),
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, moveLayersToComposition: mocks.moveLayersToComposition };
});

import "../i18n"; // the refusal badge reads t(...)
import type { LayerSummary, TrackSummary } from "../ipc";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
} from "../state/selectionStore";
import { compositionFixture, summaryFixture } from "../testing/summaryFixture";
import { ForeignDragGhost } from "./ForeignDragGhost";
import {
  useLayerDragFor,
  useLayerDragForTrack,
  useLayerDragStore,
  useIsLayerMoveDragging,
  useLayerDragStripAnchorUs,
  useLayerMoveDragSubjects,
  type DragState,
  type DragSubject,
} from "./layerDragStore";
import { SPAWN_TRACK_ID } from "./placement";
import { registerTimelineSurface } from "./timelineSurfaces";

const SRC = "comp-source";
const DEST = "comp-dest";

// The destination Panel's zoom. The source Panel is at 25 px/s — a quarter of
// this — and that number never reaches the component, which is the property
// under test: a clip's on-screen length is the destination's business.
const DEST_PX_PER_SEC = 100;

// jsdom lays nothing out, so every box the resolution measures is given one.
// Side by side, sharing every row: the arrangement that makes a lane hit-test's
// `clientY` band unable to tell the two Panels apart.
const SRC_SURFACE = { left: 0, right: 500, top: 0, bottom: 300 };
const DEST_SURFACE = { left: 600, right: 1100, top: 0, bottom: 300 };
// The canvas starts below the destination's ruler; times are measured from its
// left edge, so `clientX 733` is 133 px = 1.33 s into this composition.
const DEST_CANVAS = { left: 600, right: 1100, top: 20, bottom: 300 };
const DEST_STRIP = { left: 600, right: 1100, top: 20, bottom: 34 };
const DEST_LANE_1 = { left: 600, right: 1100, top: 34, bottom: 90 };
const DEST_LANE_2 = { left: 600, right: 1100, top: 90, bottom: 146 };

const OVER_LANE_1 = { clientX: 733, clientY: 60 };
const OVER_LANE_2 = { clientX: 733, clientY: 120 };
const OVER_STRIP = { clientX: 733, clientY: 26 };
const OVER_SOURCE = { clientX: 200, clientY: 60 };

// 1.33 s rounded onto the destination's own grid: 25 fps, so 40 000 µs a frame.
const LANDING_AT_25FPS = 1_320_000;
// The same pointer on a 30 fps destination — a different lattice, a different
// answer. Neither composition round-trips into the other (ADR 0037).
const LANDING_AT_30FPS = 1_333_333;

const releases: Array<() => void> = [];
const detach: HTMLElement[] = [];

afterEach(() => {
  cleanup();
  useLayerDragStore.getState().end();
  while (releases.length > 0) releases.pop()!();
  while (detach.length > 0) detach.pop()!.remove();
  // The commit reaches three module-level stores; a test that seeded them must
  // not decide what the next one starts from.
  useProjectStore.getState().apply(null);
  clearLayerSelection();
  mocks.moveLayersToComposition.mockReset();
  vi.restoreAllMocks();
});

function boxed(box: { left: number; right: number; top: number; bottom: number }) {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect);
  return el;
}

function layer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  kind: "Color" | "Audio" = "Color",
): LayerSummary {
  return {
    id,
    kind,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind } as LayerSummary["params"],
    effects: [],
  };
}

function track(id: string, layers: LayerSummary[], locked = false): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

/// The dragged clip: 1 s → 3 s in the SOURCE composition, so 2 s long wherever
/// it is drawn.
const ANCHOR: DragSubject = {
  layerId: "src-a",
  trackId: "s-1",
  originalTStart: 1_000_000,
  originalTEnd: 3_000_000,
  kind: "VideoClip",
  name: "Beach",
  locked: false,
};
/// Its linked partner, half a second behind it and half a second long.
const PARTNER: DragSubject = {
  layerId: "src-b",
  trackId: "s-2",
  originalTStart: 3_500_000,
  originalTEnd: 4_000_000,
  kind: "Audio",
  name: "Beach audio",
  locked: false,
};

function dragState(over: Partial<DragState> = {}): DragState {
  return {
    kind: "move",
    compositionId: SRC,
    layerId: ANCHOR.layerId,
    trackId: ANCHOR.trackId,
    trackKind: "Video",
    startX: 200,
    startY: 60,
    originalTStart: ANCHOR.originalTStart,
    originalTEnd: ANCHOR.originalTEnd,
    deltaUs: 0,
    overTrackId: null,
    duplicate: false,
    escapeLink: false,
    wasSelectedAtPointerDown: true,
    selectedAtPointerDown: new Set<string>(),
    subjects: [ANCHOR],
    validity: "valid",
    conflictingLayerIds: [],
    hiddenSubjectCount: 0,
    ...over,
  };
}

function mountGhost(
  opts: {
    fpsNum?: number;
    tracks?: TrackSummary[];
    pointer?: { clientX: number; clientY: number };
    drag?: Partial<DragState>;
    tailSnap?: boolean;
    /// Rendered beside the ghost, subscribing the way this Panel's lanes and
    /// blocks do. Used by the render-set check.
    probe?: React.ReactNode;
  } = {},
) {
  const canvas = boxed(DEST_CANVAS);
  const strip = boxed(DEST_STRIP);
  const lanes = new Map<string, HTMLElement>([
    ["d-1", boxed(DEST_LANE_1)],
    ["d-2", boxed(DEST_LANE_2)],
  ]);
  document.body.appendChild(canvas);
  detach.push(canvas);

  const srcSurface = boxed(SRC_SURFACE);
  const destSurface = boxed(DEST_SURFACE);
  releases.push(registerTimelineSurface(SRC, srcSurface));
  releases.push(registerTimelineSurface(DEST, destSurface));

  const tracks = opts.tracks ?? [track("d-1", []), track("d-2", [])];
  const pointer = opts.pointer ?? OVER_LANE_1;
  // Published BEFORE the mount, so the first render already has a gesture to
  // resolve — a drag is always in flight by the time the pointer arrives here.
  useLayerDragStore.getState().begin(
    dragState(opts.drag),
    pointer.clientX,
    pointer.clientY,
  );

  render(
    <>
      <ForeignDragGhost
        compositionId={DEST}
        tracks={tracks}
        orderedTracks={tracks.map((t) => ({ track: t, isRoleSectionStart: false }))}
        laneEls={{ current: lanes }}
        dropStripEl={{ current: strip }}
        canvasRef={{ current: canvas }}
        pxPerSec={DEST_PX_PER_SEC}
        fpsNum={opts.fpsNum ?? 25}
        fpsDen={1}
        snapTracks={tracks}
        links={[]}
        linkByLayerId={new Map()}
        // Off unless a test is about the boundary snap, so the grid's answer
        // stands alone. On, the 8 px pull is 80 000 µs wide at this zoom.
        tailSnapEnabled={opts.tailSnap ?? false}
        tailSnapStrengthPx={8}
      />
      {opts.probe}
    </>,
    { container: canvas },
  );

  const ghosts = () =>
    Array.from(
      canvas.querySelectorAll<HTMLElement>(
        '[data-testid="timeline-foreign-ghost"]',
      ),
    );
  return {
    ghosts,
    only: () => {
      const found = ghosts();
      expect(found).toHaveLength(1);
      return found[0]!;
    },
    move: (to: { clientX: number; clientY: number }) =>
      act(() => {
        useLayerDragStore.getState().moveVisual(to.clientX, to.clientY);
      }),
    /// The release, as the host performs it: `end()` first — that handler was
    /// registered when the gesture armed, so it runs before this Panel's — and
    /// the `pointerup` in the SAME task, before React has re-rendered either
    /// Panel. Awaited, because the commit is async and the selection and focus
    /// only follow once it resolves.
    ///
    /// Carries coordinates, because the release re-asks which Panel it is over
    /// from the event rather than trusting the last pointermove. Defaults to
    /// wherever this gesture was pointing.
    release: async (at: { clientX: number; clientY: number } = pointer) => {
      await act(async () => {
        useLayerDragStore.getState().end();
        fireEvent.pointerUp(window, { clientX: at.clientX, clientY: at.clientY });
      });
    },
    claim: () => useLayerDragStore.getState().claim,
  };
}

describe("ForeignDragGhost", () => {
  it("draws the clip at the DESTINATION's zoom, not the Panel it came from", () => {
    const ghost = mountGhost().only();

    // 2 s at 100 px/s. The source Panel is at 25 px/s, where the same clip is
    // 50 px — the number this would show if the width rode across.
    expect(ghost.style.width).toBe("200px");
    expect(ghost.style.left).toBe(`${(LANDING_AT_25FPS / 1_000_000) * 100}px`);
    expect(ghost.textContent).toContain("Beach");
  });

  it("snaps the landing on the DESTINATION's frame grid", () => {
    expect(mountGhost({ fpsNum: 25 }).only().dataset.startUs).toBe(
      String(LANDING_AT_25FPS),
    );
    cleanup();
    useLayerDragStore.getState().end();

    // Same pointer, same zoom, a different rate: the answer moves with the
    // destination's lattice and nothing else.
    expect(mountGhost({ fpsNum: 30 }).only().dataset.startUs).toBe(
      String(LANDING_AT_30FPS),
    );
    expect(LANDING_AT_30FPS % 40_000).not.toBe(0);
  });

  it("reads an occupied span as a collision", () => {
    const view = mountGhost({
      tracks: [
        track("d-1", [layer("dest-standing", 2_000_000, 4_000_000)]),
        track("d-2", []),
      ],
    });

    expect(view.only().dataset.validity).toBe("collision");
    // The verdict travels to the claim, not only to the chrome.
    expect(view.claim()?.validity).toBe("collision");
  });

  it("reads a locked destination lane as locked", () => {
    const view = mountGhost({
      tracks: [track("d-1", []), track("d-2", [], true)],
      pointer: OVER_LANE_2,
    });

    expect(view.only().dataset.validity).toBe("locked");
    expect(view.claim()?.trackId).toBe("d-2");
  });

  it("reads the drop strip as a lane being spawned", () => {
    const view = mountGhost({ pointer: OVER_STRIP });

    const ghost = view.only();
    expect(ghost.dataset.validity).toBe("spawn");
    expect(ghost.dataset.trackId).toBe(SPAWN_TRACK_ID);
    // A destination being created, not a refusal — no red, no badge.
    expect(ghost.style.outline).toBe("");
    expect(ghost.textContent).not.toContain("Overlap");
    expect(view.claim()?.trackId).toBe(SPAWN_TRACK_ID);
  });

  it("lands every member on the one hit lane, holding its phase to the anchor", () => {
    const view = mountGhost({
      drag: { subjects: [ANCHOR, PARTNER] },
      pointer: OVER_LANE_2,
    });

    const [first, second] = view.ghosts();
    expect(view.ghosts()).toHaveLength(2);
    expect(first!.dataset.startUs).toBe(String(LANDING_AT_25FPS));
    // 2.5 s behind the anchor in the source, 2.5 s behind it here.
    expect(second!.dataset.startUs).toBe(String(LANDING_AT_25FPS + 2_500_000));
    // Both on the row the pointer picked: the primitive puts every source block
    // on a named destination lane, whatever lane it came from.
    expect(first!.dataset.trackId).toBe("d-2");
    expect(second!.dataset.trackId).toBe("d-2");
    expect(second!.style.width).toBe("50px");
  });

  it("reads a locked MEMBER of the dragged link as locked", () => {
    // The seed can never be locked — a locked block refuses `pointerdown` — so
    // the only way a lock reaches this Panel is on a link member dragged along
    // with it, and this Panel holds no summary to discover it in. The
    // in-composition projection refuses the same set, so a green ghost here
    // would be the two halves of one gesture disagreeing.
    const view = mountGhost({
      drag: { subjects: [ANCHOR, { ...PARTNER, locked: true }] },
    });

    expect(view.ghosts()).toHaveLength(2);
    // The whole set wears the refusal: a lock refuses the move outright rather
    // than moving the unlocked half.
    for (const ghost of view.ghosts()) {
      expect(ghost.dataset.validity).toBe("locked");
    }
  });

  it("stops the set as one body at zero, rather than clamping each member", () => {
    // A member that starts BEFORE the anchor, which is what makes the two
    // behaviours differ: dragged far enough left, it is the one that runs out
    // of room first.
    const early: DragSubject = {
      ...PARTNER,
      originalTStart: 500_000,
      originalTEnd: 900_000,
    };
    const view = mountGhost({
      drag: { subjects: [ANCHOR, early] },
      // The canvas's own left edge — time zero in this composition.
      pointer: { clientX: DEST_CANVAS.left, clientY: 60 },
    });

    const [first, second] = view.ghosts();
    // Clamping per member would put BOTH at zero and flatten the 500 ms
    // between them. Worse, it would draw a landing the commit refuses:
    // `applyMoveLayersToComposition` refuses a member before zero outright and
    // never clamps, so the ghost has to stop where the command still accepts.
    expect(second!.dataset.startUs).toBe("0");
    // 520 000, not the 500 000 the raw shift arrives at: the anchor's landing
    // re-snaps on the DESTINATION's frame grid, and 500 000 µs is half a frame
    // at 25 fps. The command lands it on 520 000 for the same reason, so this is
    // the number the ghost has to promise — the two do not round trip at a rate
    // whose frame the shift is not a multiple of, and the ghost's job is to say
    // what will happen rather than what was asked for.
    expect(first!.dataset.startUs).toBe("520000");
  });

  it("snaps to a boundary THIS composition owns", () => {
    // A clip in the destination whose head sits one frame off the grid answer,
    // inside the pull. Nothing in the source composition is a target here — the
    // targets are read from this Panel's own lanes.
    const view = mountGhost({
      tracks: [
        track("d-1", [layer("dest-neighbour", 1_280_000, 1_600_000)]),
        track("d-2", []),
      ],
      pointer: OVER_LANE_2,
      tailSnap: true,
    });

    expect(view.only().dataset.startUs).toBe("1280000");
    // Proof it is the boundary and not the grid: the grid alone answers a frame
    // later.
    expect(LANDING_AT_25FPS).toBe(1_320_000);
  });

  it("draws nothing while Alt is held, and claims nothing", () => {
    const view = mountGhost({ drag: { duplicate: true } });

    // A copy across compositions is a different mutation, not a parameter of
    // this one, so there is nothing truthful to preview.
    expect(view.ghosts()).toHaveLength(0);
    expect(view.claim()).toBeNull();
  });

  it("stays out of a gesture that belongs to this composition", () => {
    const view = mountGhost({ drag: { compositionId: DEST } });

    // The in-composition ghost owns that drag; a second one here would double it.
    expect(view.ghosts()).toHaveLength(0);
    expect(view.claim()).toBeNull();
  });

  it("draws nothing while the pointer is still over the Panel it came from", () => {
    const view = mountGhost({ pointer: OVER_SOURCE });

    expect(view.ghosts()).toHaveLength(0);
    expect(view.claim()).toBeNull();

    view.move(OVER_LANE_1);
    expect(view.ghosts()).toHaveLength(1);
    expect(view.claim()).toEqual({
      compositionId: DEST,
      trackId: "d-1",
      anchorTStartUs: LANDING_AT_25FPS,
      validity: "valid",
    });

    // And lets go again on the way out — the claim is the pointer's location,
    // not a latch.
    view.move(OVER_SOURCE);
    expect(view.claim()).toBeNull();
  });

  it("commits the drop to THIS composition, at the landing the ghost drew", async () => {
    const view = mountGhost({
      drag: { subjects: [ANCHOR, PARTNER] },
      pointer: OVER_LANE_2,
    });
    // The preview and the commit are one act: whatever the ghost's anchor block
    // shows is the time the command is asked for.
    expect(view.ghosts()[0]!.dataset.startUs).toBe(String(LANDING_AT_25FPS));

    await view.release();

    expect(mocks.moveLayersToComposition).toHaveBeenCalledTimes(1);
    expect(mocks.moveLayersToComposition).toHaveBeenCalledWith(
      // Every subject crosses — a move fans out across the whole link.
      [ANCHOR.layerId, PARTNER.layerId],
      DEST,
      // The anchor the ghost positions from, so the landing and the anchor
      // cannot disagree.
      ANCHOR.layerId,
      LANDING_AT_25FPS,
      "d-2",
    );
  });

  it("sends `spawn` for the drop strip, never the sentinel", async () => {
    const view = mountGhost({ pointer: OVER_STRIP });
    expect(view.only().dataset.trackId).toBe(SPAWN_TRACK_ID);

    await view.release();

    // `SPAWN_TRACK_ID` is the hit-test's word for a lane that does not exist
    // yet; the command's is `"spawn"`, and the sentinel would be a
    // `TrackNotFound`.
    expect(mocks.moveLayersToComposition).toHaveBeenCalledWith(
      [ANCHOR.layerId],
      DEST,
      ANCHOR.layerId,
      LANDING_AT_25FPS,
      "spawn",
    );
  });

  it("sends nothing when the landing collides", async () => {
    const view = mountGhost({
      tracks: [
        track("d-1", [layer("dest-standing", 2_000_000, 4_000_000)]),
        track("d-2", []),
      ],
    });
    expect(view.only().dataset.validity).toBe("collision");

    await view.release();

    // The red ghost is the whole explanation, exactly as in-composition.
    expect(mocks.moveLayersToComposition).not.toHaveBeenCalled();
  });

  it("sends nothing when the destination lane is locked", async () => {
    const view = mountGhost({
      tracks: [track("d-1", []), track("d-2", [], true)],
      pointer: OVER_LANE_2,
    });
    expect(view.only().dataset.validity).toBe("locked");

    await view.release();

    expect(mocks.moveLayersToComposition).not.toHaveBeenCalled();
  });

  it("sends nothing when the release lands over no row", async () => {
    // Inside the Panel, below its last lane: the ghost drew nothing there, and
    // no preview means no commit. Bouncing onto a free lane is what the command
    // does for a MENU, which has no ghost to contradict.
    const view = mountGhost({ pointer: { clientX: 733, clientY: 200 } });

    expect(view.ghosts()).toHaveLength(0);
    expect(view.claim()).toMatchObject({ trackId: null, validity: "collision" });

    await view.release();

    expect(mocks.moveLayersToComposition).not.toHaveBeenCalled();
  });

  it("commits from a store the host has already emptied", async () => {
    // THE ordering guard. Both Panels listen for `pointerup` on `window`, and
    // the host's listener — registered when the gesture armed — runs first and
    // calls `end()`, which clears `drag`, `pointer` AND `claim`. A release that
    // read the store would find nothing and commit nothing, silently, with the
    // ghost still looking right up to the moment it vanished.
    const view = mountGhost({ pointer: OVER_LANE_1 });

    await view.release();

    expect(useLayerDragStore.getState().drag).toBeNull();
    expect(useLayerDragStore.getState().claim).toBeNull();
    expect(mocks.moveLayersToComposition).toHaveBeenCalledWith(
      [ANCHOR.layerId],
      DEST,
      ANCHOR.layerId,
      LANDING_AT_25FPS,
      "d-1",
    );
  });

  it("sends nothing when the lift happens back over the Panel it came from", async () => {
    // A pointer that leaves between the last `pointermove` and the lift. Both
    // Panels decide from the SAME event, so exactly one may act — and over the
    // host, the one that acts is the host, with an ordinary in-composition
    // move. A release trusting its last resolved landing would commit here too,
    // and the clip would be moved twice, by two ops, into two history rows.
    const view = mountGhost({ pointer: OVER_LANE_1 });

    await view.release(OVER_SOURCE);

    expect(mocks.moveLayersToComposition).not.toHaveBeenCalled();
  });

  it("takes the selection and the keyboard to where the clips landed", async () => {
    // A destination that is a real composition of a real project: focus refuses
    // an id the summary does not carry.
    useProjectStore.getState().apply(
      summaryFixture({
        root: { id: SRC },
        groups: [compositionFixture({ id: DEST })],
      }),
    );
    expect(useCompositionAnchorStore.getState().focusedId).toBe(SRC);

    const view = mountGhost({ drag: { subjects: [ANCHOR, PARTNER] } });
    await view.release();

    // Both follow the drop, where the *Move to composition ›* menu clears the
    // selection and stays put: the difference is that this gesture named the
    // destination with the pointer.
    expect(useCompositionAnchorStore.getState().focusedId).toBe(DEST);
    const selection = currentSelection();
    expect(primaryLayerIdOf(selection)).toBe(ANCHOR.layerId);
    expect([...layerIdsOf(selection)].sort()).toEqual(
      [ANCHOR.layerId, PARTNER.layerId].sort(),
    );
  });

  it("wakes only itself: a foreign pointermove renders no lane, block or strip", () => {
    let probeRenders = 0;
    /// Every store subscription this Panel's own lanes, blocks and drop strip
    /// make, keyed on ids of ITS composition.
    function PanelProbe(): null {
      useLayerDragForTrack("d-1");
      useLayerDragFor("dest-standing");
      useIsLayerMoveDragging(DEST);
      useLayerDragStripAnchorUs(DEST);
      useLayerMoveDragSubjects();
      probeRenders += 1;
      return null;
    }
    const view = mountGhost({ probe: <PanelProbe /> });

    expect(probeRenders).toBe(1);
    const before = view.only().dataset.startUs;

    view.move({ clientX: 833, clientY: 60 });
    view.move({ clientX: 933, clientY: 60 });

    // The ghost followed the pointer; nothing else in the Panel heard about it.
    expect(view.only().dataset.startUs).not.toBe(before);
    expect(probeRenders).toBe(1);
  });
});
