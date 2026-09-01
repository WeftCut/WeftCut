// @vitest-environment jsdom
// jsdom for the composition-gate case alone: the hooks under test are
// React subscriptions, and `renderHook` is the only way to read what one
// actually returns rather than what its selector was written to return.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useForeignDropStripAnchorUs,
  useIsForeignDropClaimed,
  useIsLayerDragging,
  useIsLayerMoveDragging,
  useLayerDragForStrip,
  useLayerDragStore,
  moveLandings,
  type DragState,
  type DragSubject,
} from "./layerDragStore";
import { SPAWN_TRACK_ID } from "./placement";

afterEach(() => {
  useLayerDragStore.getState().end();
});

const subjects: DragSubject[] = [
  {
    layerId: "a",
    trackId: "t1",
    originalTStart: 0,
    originalTEnd: 1_000_000,
    kind: "VideoClip",
    name: "Clip A",
    locked: false,
  },
  {
    layerId: "b",
    trackId: "t2",
    originalTStart: 0,
    originalTEnd: 1_000_000,
    kind: "Audio",
    name: "Clip B",
    locked: false,
  },
];

/// One pointermove's worth of gesture. Mirrors `evaluatePointer`: the seed's
/// fields and `subjects` are carried by reference, and only the four fields the
/// pointer can move are rebuilt.
function stateAt(
  deltaUs: number,
  over: string | null = null,
  conflicting: string[] = [],
  compositionId = "comp-a",
): DragState {
  return {
    kind: "move",
    compositionId,
    layerId: "a",
    trackId: "t1",
    trackKind: "Video",
    startX: 100,
    startY: 50,
    grabOffsetUs: 0,
    originalTStart: 0,
    originalTEnd: 1_000_000,
    deltaUs,
    overTrackId: over,
    duplicate: false,
    escapeLink: false,
    wasSelectedAtPointerDown: true,
    selectedAtPointerDown: new Set<string>(),
    subjects,
    validity: "valid",
    conflictingLayerIds: conflicting,
    hiddenSubjectCount: 0,
  };
}

describe("layerDragStore", () => {
  it("begin publishes the armed gesture and its pointer", () => {
    useLayerDragStore.getState().begin(stateAt(0), 120, 60);
    expect(useLayerDragStore.getState().drag?.layerId).toBe("a");
    expect(useLayerDragStore.getState().pointer).toEqual({
      clientX: 120,
      clientY: 60,
    });
  });

  it("end clears both halves", () => {
    useLayerDragStore.getState().begin(stateAt(0), 120, 60);
    useLayerDragStore.getState().end();
    expect(useLayerDragStore.getState().drag).toBeNull();
    expect(useLayerDragStore.getState().pointer).toBeNull();
  });

  it("end on a store that never armed is a no-op, not a write", () => {
    const before = useLayerDragStore.getState();
    useLayerDragStore.getState().end();
    expect(useLayerDragStore.getState()).toBe(before);
  });

  it("a value-identical publish does not write", () => {
    useLayerDragStore.getState().begin(stateAt(0), 120, 60);
    useLayerDragStore.getState().publish(stateAt(33_333, "t2", ["c"]));
    const afterMove = useLayerDragStore.getState();
    // A fresh state object carrying the same values — what a pointer wiggle
    // inside one frame produces. State identity is the assertion because
    // zustand notifies subscribers on every write it accepts.
    useLayerDragStore.getState().publish(stateAt(33_333, "t2", ["c"]));
    expect(useLayerDragStore.getState()).toBe(afterMove);
    useLayerDragStore.getState().publish(stateAt(66_666, "t2", ["c"]));
    expect(useLayerDragStore.getState()).not.toBe(afterMove);
  });

  it("moveVisual ignores a repeated pixel, and a pointer with no gesture", () => {
    useLayerDragStore.getState().moveVisual(10, 10);
    expect(useLayerDragStore.getState().pointer).toBeNull();
    useLayerDragStore.getState().begin(stateAt(0), 120, 60);
    useLayerDragStore.getState().moveVisual(121, 61);
    const afterMove = useLayerDragStore.getState();
    useLayerDragStore.getState().moveVisual(121, 61);
    expect(useLayerDragStore.getState()).toBe(afterMove);
  });

  it("keeps one subjects reference across a whole gesture while the delta moves", () => {
    // This identity IS the mechanism behind "a pointermove does not re-render
    // every lane": `useLayerMoveDragSubjects` is an atomic selector on it, and
    // `dragLayerById` — a prop every lane receives — memoizes on what it
    // returns. Rebuild `subjects` per event and every lane wakes per event.
    useLayerDragStore.getState().begin(stateAt(0), 120, 60);
    const armed = useLayerDragStore.getState().drag?.subjects;
    const deltas: number[] = [];
    for (const deltaUs of [33_333, 66_666, 100_000]) {
      useLayerDragStore.getState().publish(stateAt(deltaUs));
      const drag = useLayerDragStore.getState().drag;
      expect(drag?.subjects).toBe(armed);
      deltas.push(drag?.deltaUs ?? -1);
    }
    expect(deltas).toEqual([33_333, 66_666, 100_000]);
  });

  // Two timeline Panels read ONE module-level store (ADR 0053). The hooks keyed
  // on a layer or track id sort themselves out, those ids being project-unique;
  // these three ask "is a drag happening", which without the gate is true next
  // door as well — a neighbour that arms its drop strip, shows a grabbing
  // cursor and drives the monitor for a gesture that never touched it.
  it("shows a gesture only to the composition it started in", () => {
    useLayerDragStore
      .getState()
      .begin(stateAt(0, SPAWN_TRACK_ID, [], "comp-a"), 120, 60);

    expect(renderHook(() => useIsLayerDragging("comp-a")).result.current).toBe(true);
    expect(renderHook(() => useIsLayerDragging("comp-b")).result.current).toBe(false);

    expect(renderHook(() => useIsLayerMoveDragging("comp-a")).result.current).toBe(true);
    expect(renderHook(() => useIsLayerMoveDragging("comp-b")).result.current).toBe(false);

    // The landings this feeds are on the DRAG's axis, so the Panel that does
    // not share it must read null rather than draw a ghost on its own grid.
    expect(
      renderHook(() => useLayerDragForStrip("comp-a")).result.current?.layerId,
    ).toBe("a");
    expect(
      renderHook(() => useLayerDragForStrip("comp-b")).result.current,
    ).toBeNull();
  });

  it("floors a move at zero as ONE body, through the mutation's arithmetic", () => {
    // `moveLandings` is what every surface that PROMISES a landing calls — the
    // move projection and the drop strip's ghost — so the two rules it wraps are
    // pinned here rather than at each caller: the anchor's requested head goes
    // through its own lattice, and the set stops as one body at zero.
    const drag = {
      ...stateAt(0),
      layerId: "late",
      originalTStart: 1_000_000,
      originalTEnd: 2_000_000,
      subjects: [
        {
          ...subjects[0]!,
          layerId: "early",
          originalTStart: 500_000,
          originalTEnd: 1_000_000,
        },
        {
          ...subjects[0]!,
          layerId: "late",
          originalTStart: 1_000_000,
          originalTEnd: 2_000_000,
        },
      ],
    } satisfies DragState;

    // 2 s left, which would put the earliest member 1.5 s before zero.
    const landed = moveLandings(drag, -2_000_000, { num: 30, den: 1 });

    // The earliest lands on 0 and the 500 ms between them survives. A per-member
    // clamp would have flattened both onto zero.
    expect(landed.byLayerId.get("early")).toEqual({
      tStartUs: 0,
      tEndUs: 500_000,
    });
    expect(landed.byLayerId.get("late")).toEqual({
      tStartUs: 500_000,
      tEndUs: 1_500_000,
    });
    // The anchor's landed head — the ONE number the commit sends and the hint
    // shows, and it is the anchor's, not the set's earliest.
    expect(landed.anchorTStartUs).toBe(500_000);
  });

  it("hands the strip nothing while the pointer is over a lane", () => {
    // The gate that keeps a raise's ghost out of the row until the row is the
    // destination — and keeps the strip out of every OTHER pointermove.
    useLayerDragStore.getState().begin(stateAt(0, "t2"), 120, 60);
    expect(
      renderHook(() => useLayerDragForStrip("comp-a")).result.current,
    ).toBeNull();
  });

  // The drop strip's OTHER arming condition. The gate above is what keeps a
  // Panel from arming for its neighbour's gesture, so the destination needs a
  // second reason to arm at all — the CLAIM, which is its own statement that a
  // release here would land, and the only evidence of the crossing it may read.
  it("arms the Panel that claimed the drop, and no other", () => {
    useLayerDragStore.getState().begin(stateAt(0, null, [], "comp-a"), 120, 60);
    useLayerDragStore.getState().claimDropTarget({
      compositionId: "comp-b",
      trackId: SPAWN_TRACK_ID,
      anchorTStartUs: 500_000,
      validity: "spawn",
    });

    expect(renderHook(() => useIsForeignDropClaimed("comp-b")).result.current).toBe(true);
    // Not the Panel the gesture belongs to: its own strip answers to the
    // gesture, and a Panel is never a destination for itself.
    expect(renderHook(() => useIsForeignDropClaimed("comp-a")).result.current).toBe(false);
    expect(
      renderHook(() => useForeignDropStripAnchorUs("comp-b")).result.current,
    ).toBe(500_000);

    // Over a lane the strip stays armed but unlit: the head named there belongs
    // to a row the strip does not own.
    useLayerDragStore.getState().claimDropTarget({
      compositionId: "comp-b",
      trackId: "t9",
      anchorTStartUs: 500_000,
      validity: "valid",
    });
    expect(renderHook(() => useIsForeignDropClaimed("comp-b")).result.current).toBe(true);
    expect(
      renderHook(() => useForeignDropStripAnchorUs("comp-b")).result.current,
    ).toBeNull();
  });
});
