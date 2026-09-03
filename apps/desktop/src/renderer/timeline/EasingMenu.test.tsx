// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next with en-US translations so t(key) resolves
import type { AnimTrack, Interpolation, Keyframe, LayerSummary, TrackSummary } from "../ipc";
import { EASING_PRESETS, applySegmentEasing, segmentEasing } from "../../shared/easing";
import { clearTrackPreview, getTrackPreview } from "../keyframe/easingPreviewStore";
import {
  clearKeyframeSelection,
  getSelectedKeyframes,
  setKeyframeSelection,
  type SelectedKeyframe,
} from "../keyframe/selectionStore";
import {
  KeyframeBatchContext,
  batchParamTrackEntries,
  type KeyframeBatch,
  type KeyframeGroupEdit,
} from "./keyframeBatch";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";

// Stub AppSlider to a controlled range input so jsdom can drive onValueChange
// (drag) and onValueCommitted (release) deterministically — Base UI's real
// slider needs pointer capture jsdom doesn't implement (mirrors the
// RoleMixerPanel.test.tsx stub).
vi.mock("../components/AppSlider", () => ({
  AppSlider: ({
    value,
    min,
    max,
    step,
    ariaLabel,
    onValueChange,
    onValueCommitted,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    ariaLabel?: string;
    onValueChange: (v: number) => void;
    onValueCommitted?: (v: number) => void;
  }) => (
    <input
      type="range"
      role="slider"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.currentTarget.value))}
      onPointerUp={(e) => onValueCommitted?.(Number(e.currentTarget.value))}
    />
  ),
}));

import { EasingMenu } from "./EasingMenu";

afterEach(() => {
  cleanup();
  clearTrackPreview();
  // The menu reads the shared keyframe selection to decide whether it has one
  // current interpolation to report; a leaked selection would silence the
  // checkmark assertions in every test after it.
  clearKeyframeSelection();
});

type Keyframed = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

const baseKeys: Keyframe<number>[] = [
  { id: "k0", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
  { id: "k1", t_us: 1_000_000, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
];
const track: Keyframed = {
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: baseKeys,
};

/// Same two keys with the k0 → k1 segment's easing swapped — each test states
/// only the easing under test, written the way a commit writes it.
function trackWith(interp: Interpolation): Keyframed {
  const [k0, k1] = applySegmentEasing(baseKeys[0]!, baseKeys[1], interp);
  return { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [k0, k1!] };
}

/// The easing of the segment leaving `id`, read back the way the menu reads it
/// (a last key has no segment; its own class stands in).
function easingOf(keys: readonly Keyframe<number>[], id: string): Interpolation {
  const i = keys.findIndex((k) => k.id === id);
  return segmentEasing(keys[i]!, keys[i + 1] ?? keys[i]!);
}

function presetInterp(id: string): Interpolation {
  return EASING_PRESETS.find((p) => p.id === id)!.interp;
}

/// The next track one group gets. The menu hands up the group edit that EVERY
/// selected group runs, so folding that edit over `base` is the same statement
/// these assertions always made.
function editedTrack(
  onApply: ReturnType<typeof vi.fn>,
  base: AnimTrack<number>,
  kfIds: string[] = ["k0"],
  call = 0,
): Keyframed {
  const edit = onApply.mock.calls[call]![0] as KeyframeGroupEdit;
  const next = edit(base as Keyframed, kfIds, 0);
  expect(next.mode).toBe("Keyframed");
  return next as Keyframed;
}

function layerWith(id: string, opacity: AnimTrack<number>): LayerSummary {
  return {
    id,
    kind: "VideoClip",
    label: null,
    t_start_us: 0,
    t_end_us: 2_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "VideoClip", opacity } as unknown as LayerSummary["params"],
    effects: [],
  };
}

function trackSummary(layers: LayerSummary[]): TrackSummary {
  return {
    id: "t1", kind: "Video", label: null, enabled: true, locked: false,
    muted: false, solo: false, role: null, transient: false, layers,
  };
}

/// The menu the way its owner mounts it: under the Timeline's batch provider,
/// with the right-clicked key already in the selection. `tracks` default to
/// one layer `L1` whose `opacity` is the menu's own track, so the fold finds
/// the group the selection names.
function renderMenu(
  props: Partial<React.ComponentProps<typeof EasingMenu>> & { track?: AnimTrack<number> },
  opts: { selection?: SelectedKeyframe[]; tracks?: TrackSummary[]; commit?: KeyframeBatch["commit"] } = {},
) {
  const trk = props.track ?? track;
  const kfId = props.kfId ?? "k0";
  const tracks = opts.tracks ?? [trackSummary([layerWith("L1", trk)])];
  setKeyframeSelection(opts.selection ?? [{ layerId: "L1", paramKey: "opacity", kfId }]);
  const batch: KeyframeBatch = {
    commit: opts.commit ?? (() => {}),
    fold: (edit) => batchParamTrackEntries({ selected: getSelectedKeyframes(), tracks, edit }),
  };
  return render(
    <KeyframeBatchContext.Provider value={batch}>
      <EasingMenu
        x={0}
        y={0}
        track={trk}
        kfId={kfId}
        onApply={props.onApply ?? (() => {})}
        onClose={props.onClose ?? (() => {})}
      />
    </KeyframeBatchContext.Provider>,
  );
}

/// Two keys selected across two layers, so the menu is in its multi-key form
/// and the fold has two groups to preview.
function twoLayerSelection(second: AnimTrack<number> = track) {
  return {
    selection: [
      { layerId: "L1", paramKey: "opacity", kfId: "k0" },
      { layerId: "L2", paramKey: "opacity", kfId: "k0" },
    ],
    tracks: [trackSummary([layerWith("L1", track), layerWith("L2", second)])],
  };
}

/// Whether a row carries the check glyph (`MenuItem` renders an icon, not text).
const checked = (testId: string) =>
  screen.getByTestId(testId).querySelector(".app-menu-item-check svg") !== null;

/// Tier 2 opens only through the Tier-1 "Easing library…" row — same as a user.
function openGallery() {
  fireEvent.click(screen.getByTestId("easing-open-gallery"));
}

function previewOf(layerId = "L1"): Keyframed {
  const p = getTrackPreview(layerId, "opacity");
  expect(p, `preview for ${layerId}`).not.toBeNull();
  expect(p!.mode).toBe("Keyframed");
  return p as Keyframed;
}

function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((acc, k) => acc?.[k], obj);
}

describe("EasingMenu — tier 1 command menu", () => {
  it("right-click opens the compact command menu, not the preset wall", () => {
    renderMenu({});
    expect(screen.getByTestId("easing-command-menu")).toBeTruthy();
    // The five NLE commands + Smooth + the library row — and zero gallery chips.
    for (const id of ["linear", "hold", "ease_in", "ease_out", "ease_in_out"]) {
      expect(screen.getByTestId(`easing-cmd-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("easing-smooth")).toBeTruthy();
    expect(screen.getByTestId("easing-open-gallery")).toBeTruthy();
    expect(screen.queryAllByTestId("easing-preset-chip")).toHaveLength(0);
  });

  it("a command commits the table's baked interp verbatim and closes", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    renderMenu({ onApply, onClose });
    fireEvent.click(screen.getByTestId("easing-cmd-ease_in_out"));
    const next = editedTrack(onApply, track);
    expect(easingOf(next.value, "k0")).toEqual(presetInterp("ease_in_out"));
    expect(onClose).toHaveBeenCalled();
  });

  it("checkmarks exactly the command the reverse lookup names", () => {
    renderMenu({ track: trackWith(presetInterp("ease_in")) });
    expect(checked("easing-cmd-ease_in")).toBe(true);
    expect(checked("easing-cmd-ease_out")).toBe(false);
    expect(checked("easing-open-gallery")).toBe(false);
  });

  it("a gallery-only preset checkmarks the library row instead of a command", () => {
    renderMenu({ track: trackWith(presetInterp("ease_in_out_quint")) });
    expect(checked("easing-open-gallery")).toBe(true);
    for (const id of ["linear", "hold", "ease_in", "ease_out", "ease_in_out"]) {
      expect(checked(`easing-cmd-${id}`)).toBe(false);
    }
  });

  it("Smooth commits Auto on the selection and closes", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    renderMenu({ onApply, onClose });
    fireEvent.click(screen.getByTestId("easing-smooth"));
    expect(onApply).toHaveBeenCalledTimes(1);
    const next = editedTrack(onApply, track);
    expect(next.value[0]!.in.mode).toBe("Auto");
    expect(next.value[0]!.out.mode).toBe("Auto");
    expect(next.value[0]!.continuity).toBe("Smooth");
    expect(onClose).toHaveBeenCalled();
  });

  it("Smooth is checked only when every selected key has an Auto side", () => {
    const auto: Keyframed = {
      ...track,
      value: [
        { ...baseKeys[0]!, in: { ...baseKeys[0]!.in, mode: "Auto" }, out: { ...baseKeys[0]!.out, mode: "Auto" }, continuity: "Smooth", segment: { kind: "Spline" } },
        baseKeys[1]!,
      ],
    };
    renderMenu({ track: auto });
    expect(checked("easing-smooth")).toBe(true);
    cleanup();
    // The same track with the Free key selected as well: one Free key unchecks.
    renderMenu({ track: auto }, {
      selection: [
        { layerId: "L1", paramKey: "opacity", kfId: "k0" },
        { layerId: "L1", paramKey: "opacity", kfId: "k1" },
      ],
    });
    expect(checked("easing-smooth")).toBe(false);
    cleanup();
    renderMenu({});
    expect(checked("easing-smooth")).toBe(false);
  });

  it("Smooth is disabled on a Hold keyframe — no commit possible", () => {
    const onApply = vi.fn();
    renderMenu({ track: trackWith({ kind: "Hold" }), onApply });
    const smooth = screen.getByTestId("easing-smooth");
    expect(smooth.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(smooth);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("reports no current interpolation while several keys are selected", () => {
    renderMenu({ track: trackWith(presetInterp("ease_in")) }, twoLayerSelection());
    // The right-clicked key IS Ease In, and a checkmark here would claim the
    // rest of the selection is too.
    for (const id of ["linear", "hold", "ease_in", "ease_out", "ease_in_out"]) {
      expect(checked(`easing-cmd-${id}`)).toBe(false);
    }
    expect(checked("easing-open-gallery")).toBe(false);
  });

  it("a command reaches every selected key of a group, not just the clicked one", () => {
    const onApply = vi.fn();
    renderMenu({ onApply }, {
      selection: [
        { layerId: "L1", paramKey: "opacity", kfId: "k0" },
        { layerId: "L1", paramKey: "opacity", kfId: "k1" },
      ],
    });
    fireEvent.click(screen.getByTestId("easing-cmd-hold"));
    const next = editedTrack(onApply, track, ["k0", "k1"]);
    for (const id of ["k0", "k1"]) {
      expect(easingOf(next.value, id)).toEqual(presetInterp("hold"));
    }
  });
});

describe("EasingMenu — armed-row preview", () => {
  it("arming a command previews its result on every selected group; disarming clears", () => {
    renderMenu({}, twoLayerSelection());
    const row = screen.getByTestId("easing-cmd-hold");
    fireEvent.mouseOver(row);
    expect(easingOf(previewOf("L1").value, "k0")).toEqual(presetInterp("hold"));
    expect(easingOf(previewOf("L2").value, "k0")).toEqual(presetInterp("hold"));
    fireEvent.mouseOut(row);
    expect(getTrackPreview("L1", "opacity")).toBeNull();
    expect(getTrackPreview("L2", "opacity")).toBeNull();
  });

  it("arming Smooth previews the solved Auto curve, not bare marks", () => {
    // 0 → 10 → 0: the middle key is a peak, so the solved Auto sides are flat
    // (y = 0 leaving on a falling segment is the clamp; the arriving side
    // over the rising segment solves to y = 1). Bare marks would leave the
    // identity thirds in place.
    const peak: Keyframed = {
      ...track,
      value: [
        { ...baseKeys[0]!, value: 0 },
        { ...baseKeys[1]!, id: "k1", t_us: 1_000_000, value: 10 },
        { ...baseKeys[1]!, id: "k2", t_us: 2_000_000, value: 0 },
      ],
    };
    renderMenu({ track: peak, kfId: "k1" });
    fireEvent.mouseOver(screen.getByTestId("easing-smooth"));
    const k1 = previewOf().value[1]!;
    expect(k1.in.mode).toBe("Auto");
    expect(k1.out.mode).toBe("Auto");
    expect(k1.in.y).toBeCloseTo(1, 9);
    expect(k1.out.y).toBeCloseTo(0, 9);
  });

  it("a commit drops the armed preview before it reaches the actor", () => {
    renderMenu({});
    const row = screen.getByTestId("easing-cmd-ease_in");
    fireEvent.mouseOver(row);
    expect(getTrackPreview("L1", "opacity")).not.toBeNull();
    fireEvent.click(row);
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });

  it("closing the menu clears whatever it previewed", () => {
    const { unmount } = renderMenu({});
    fireEvent.mouseOver(screen.getByTestId("easing-cmd-linear"));
    expect(getTrackPreview("L1", "opacity")).not.toBeNull();
    unmount();
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });

  it("previews nothing outside the batch provider — no wrong track rather than a guess", () => {
    setKeyframeSelection([{ layerId: "L1", paramKey: "opacity", kfId: "k0" }]);
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onApply={() => {}} onClose={() => {}} />);
    fireEvent.mouseOver(screen.getByTestId("easing-cmd-hold"));
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });
});

describe("EasingMenu — extrapolation submenus", () => {
  it("offers Extrapolate before on the first key and after on the last, both on a lone key", () => {
    renderMenu({ kfId: "k0" });
    expect(screen.getByRole("menuitem", { name: "Extrapolate before" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Extrapolate after" })).toBeNull();
    cleanup();
    renderMenu({ kfId: "k1" });
    expect(screen.queryByRole("menuitem", { name: "Extrapolate before" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Extrapolate after" })).toBeTruthy();
    cleanup();
    const lone: Keyframed = { ...track, value: [baseKeys[0]!] };
    renderMenu({ track: lone, kfId: "k0" });
    expect(screen.getByRole("menuitem", { name: "Extrapolate before" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Extrapolate after" })).toBeTruthy();
  });

  it("offers neither while several keys are selected — a track-level write needs one track", () => {
    renderMenu({}, twoLayerSelection());
    expect(screen.queryByRole("menuitem", { name: "Extrapolate before" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Extrapolate after" })).toBeNull();
  });

  it("a mode row writes that side of the track's extrapolation, radio-checked at the current one", () => {
    const onApply = vi.fn();
    const loopAfter: Keyframed = { ...track, extrapolate: { before: "Hold", after: "Loop" } };
    renderMenu({ track: loopAfter, kfId: "k1", onApply });
    fireEvent.click(screen.getByRole("menuitem", { name: "Extrapolate after" }));
    const loop = screen.getByTestId("easing-extrap-after-Loop");
    expect(loop.querySelector(".app-menu-item-check svg")).not.toBeNull();
    expect(screen.getByTestId("easing-extrap-after-Hold").querySelector(".app-menu-item-check svg")).toBeNull();
    fireEvent.click(screen.getByTestId("easing-extrap-after-PingPong"));
    const next = editedTrack(onApply, loopAfter, ["k1"]);
    expect(next.extrapolate).toEqual({ before: "Hold", after: "PingPong" });
    // The keys themselves are untouched by a track-level write.
    expect(next.value).toEqual(loopAfter.value);
  });

  it("arming a mode previews the track under it", () => {
    renderMenu({ kfId: "k0" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Extrapolate before" }));
    fireEvent.mouseOver(screen.getByTestId("easing-extrap-before-Offset"));
    expect(previewOf().extrapolate).toEqual({ before: "Offset", after: "Hold" });
  });
});

describe("EasingMenu — tier 2 gallery", () => {
  it("the library row swaps to the gallery without closing the popover", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    openGallery();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("easing-gallery")).toBeTruthy();
    expect(screen.queryByTestId("easing-command-menu")).toBeNull();
  });

  it("renders the whole canonical table as thumbnails, one per preset", () => {
    renderMenu({});
    openGallery();
    const chips = screen.getAllByTestId("easing-preset-chip");
    expect(chips).toHaveLength(EASING_PRESETS.length);
    // Every thumbnail is an engine-sampled curve, not a text label.
    for (const chip of chips) {
      const pts = chip.querySelector("svg polyline")?.getAttribute("points");
      expect(pts, `${chip.getAttribute("aria-label")} thumbnail`).toBeTruthy();
    }
  });

  it("applying a gallery preset writes the table's interp verbatim (no re-derivation)", () => {
    const onApply = vi.fn();
    renderMenu({ onApply });
    openGallery();
    fireEvent.click(screen.getByRole("button", { name: "Expo In" }));
    const next = editedTrack(onApply, track);
    expect(easingOf(next.value, "k0")).toEqual(presetInterp("ease_in_expo"));
  });

  it("marks exactly the thumbnail the reverse lookup names for the current params", () => {
    renderMenu({ track: trackWith(presetInterp("ease_in_sine")) });
    openGallery();
    const pressed = screen.getAllByTestId("easing-preset-chip")
      .filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.getAttribute("aria-label")).toBe("Sine In");
  });

  it("a hand-tuned bezier selects no thumbnail (reverse lookup misses)", () => {
    const custom: Interpolation = { kind: "Bezier", p1: [0.1, 0.2], p2: [0.3, 0.4] };
    renderMenu({ track: trackWith(custom) });
    openGallery();
    const pressed = screen.getAllByTestId("easing-preset-chip")
      .filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(0);
  });

  it("hovering a thumbnail previews it live on the selection; leaving clears", () => {
    renderMenu({});
    openGallery();
    const thumb = screen.getByRole("button", { name: "Bounce Out" });
    fireEvent.mouseOver(thumb);
    expect(easingOf(previewOf().value, "k0")).toEqual(presetInterp("ease_out_bounce"));
    fireEvent.mouseOut(thumb);
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });

  it("closing the menu clears an active hover preview", () => {
    const { unmount } = renderMenu({});
    openGallery();
    fireEvent.mouseOver(screen.getByRole("button", { name: "Back In" }));
    expect(getTrackPreview("L1", "opacity")).not.toBeNull();
    unmount();
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });
});

describe("EasingMenu — elastic parameters (gallery view)", () => {
  const elastic: Interpolation = { kind: "Elastic", dir: "Out", amplitude: 1, period: 0.3 };

  it("shows the amplitude/period sliders only on an Elastic keyframe", () => {
    renderMenu({ track: trackWith(elastic) });
    openGallery();
    expect(screen.getByTestId("easing-elastic-params")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Amplitude" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Period" })).toBeTruthy();
  });

  it("shows no parameter sliders for Bounce (pure preset) or spline kinds", () => {
    renderMenu({ track: trackWith({ kind: "Bounce", dir: "In" }) });
    openGallery();
    expect(screen.queryByTestId("easing-elastic-params")).toBeNull();
    cleanup();
    renderMenu({});
    openGallery();
    expect(screen.queryByTestId("easing-elastic-params")).toBeNull();
  });

  it("hides the sliders while several keys are selected — they tune ONE key", () => {
    renderMenu({ track: trackWith(elastic) }, twoLayerSelection(trackWith(elastic)));
    openGallery();
    expect(screen.queryByTestId("easing-elastic-params")).toBeNull();
    // The wall of curves is still there: a preset applies to the whole selection.
    expect(screen.getAllByTestId("easing-preset-chip")).toHaveLength(EASING_PRESETS.length);
  });

  it("a slider gesture previews live and commits ONE complete Elastic interp on release", () => {
    const onApply = vi.fn();
    renderMenu({ track: trackWith(elastic), onApply });
    openGallery();
    const amp = screen.getByRole("slider", { name: "Amplitude" });
    // Mid-drag: live preview through the store, no commit yet (one undo step
    // per gesture, same convention as a tangent-handle drag).
    fireEvent.change(amp, { target: { value: "2" } });
    expect(onApply).not.toHaveBeenCalled();
    expect(easingOf(previewOf().value, "k0")).toEqual({ kind: "Elastic", dir: "Out", amplitude: 2, period: 0.3 });
    // Release: exactly one commit carrying the COMPLETE interp from the
    // drag-local state — dir and the untouched period included.
    fireEvent.pointerUp(amp);
    expect(onApply).toHaveBeenCalledTimes(1);
    const next = editedTrack(onApply, trackWith(elastic));
    expect(easingOf(next.value, "k0"))
      .toEqual({ kind: "Elastic", dir: "Out", amplitude: 2, period: 0.3 });
    // The release hands the picture back to the committed track.
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });

  it("a period commit keeps the amplitude a previous gesture set (drag-local, not mirror)", () => {
    const onApply = vi.fn();
    const elasticIn: Interpolation = { kind: "Elastic", dir: "In", amplitude: 1, period: 0.3 };
    // The track prop is NEVER refreshed between the two gestures — exactly the
    // stale-mirror window — yet the second commit must carry both new params.
    renderMenu({ track: trackWith(elasticIn), onApply });
    openGallery();
    const amp = screen.getByRole("slider", { name: "Amplitude" });
    fireEvent.change(amp, { target: { value: "1.5" } });
    fireEvent.pointerUp(amp);
    const per = screen.getByRole("slider", { name: "Period" });
    fireEvent.change(per, { target: { value: "0.45" } });
    fireEvent.pointerUp(per);
    expect(onApply).toHaveBeenCalledTimes(2);
    const next = editedTrack(onApply, trackWith(elasticIn), ["k0"], 1);
    expect(easingOf(next.value, "k0"))
      .toEqual({ kind: "Elastic", dir: "In", amplitude: 1.5, period: 0.45 });
  });

  it("closing the menu clears any leftover slider preview", () => {
    const { unmount } = renderMenu({ track: trackWith(elastic) });
    openGallery();
    fireEvent.change(screen.getByRole("slider", { name: "Amplitude" }), { target: { value: "3" } });
    expect(getTrackPreview("L1", "opacity")).not.toBeNull();
    unmount();
    expect(getTrackPreview("L1", "opacity")).toBeNull();
  });
});

describe("EasingMenu — i18n coverage", () => {
  it("every preset/menu/family/extrapolation key resolves in BOTH locales", () => {
    const keys = [
      ...EASING_PRESETS.map((p) => p.labelKey),
      "keyframe.elastic_amplitude",
      "keyframe.elastic_period",
      "keyframe.procedural_badge",
      "keyframe.smooth",
      "keyframe.easing_library",
      "keyframe.continuity_smooth",
      "keyframe.continuity_broken",
      "keyframe.extrapolate_before",
      "keyframe.extrapolate_after",
      "keyframe.extrapolate_hold",
      "keyframe.extrapolate_loop",
      "keyframe.extrapolate_ping_pong",
      "keyframe.extrapolate_offset",
      "keyframe.extrapolate_continue",
      "keyframe.family_classic",
      "keyframe.family_sine",
      "keyframe.family_quad",
      "keyframe.family_cubic",
      "keyframe.family_quart",
      "keyframe.family_quint",
      "keyframe.family_expo",
      "keyframe.family_circ",
      "keyframe.family_back",
      "keyframe.family_elastic",
      "keyframe.family_bounce",
    ];
    for (const key of keys) {
      expect(typeof resolveKey(en, key), `en-US ${key}`).toBe("string");
      expect(typeof resolveKey(zh, key), `zh-CN ${key}`).toBe("string");
      // zh-CN must be translated, not the en string pasted through (Hold/CRF-
      // style intentional identities don't exist in this key set).
      expect(resolveKey(zh, key), `zh-CN ${key} left as English`)
        .not.toBe(resolveKey(en, key));
    }
  });
});
