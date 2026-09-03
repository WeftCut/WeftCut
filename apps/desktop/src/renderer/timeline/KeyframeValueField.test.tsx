// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack, Rgba, TrackSummary } from "../ipc";
import { COLOR_FILL, OPACITY } from "../keyframe/descriptors";
import { KeyframeValueField } from "./KeyframeValueField";
import { clearKeyframeFocus } from "../keyframe/focusStore";

afterEach(() => {
  cleanup();
  clearKeyframeFocus();
  vi.clearAllMocks();
});

const opacityTrack: AnimTrack<number> = {
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: [{ id: "a", t_us: 0, value: 0.5, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
};
const oneClip = (params: Record<string, AnimTrack<number>>): TrackSummary =>
  ({ layers: [{ id: "L1", t_start_us: 0, t_end_us: 2_000_000, params }] }) as unknown as TrackSummary;

function renderField(currentTimeUs: number, onCommit = vi.fn()) {
  render(
    <KeyframeValueField
      track={oneClip({ opacity: opacityTrack })}
      desc={OPACITY}
      currentTimeUs={currentTimeUs}
      fpsNum={30}
      fpsDen={1}
      onCommitParamTrack={onCommit}
    />,
  );
  return onCommit;
}

describe("KeyframeValueField", () => {
  it("renders a number field (not a slider) showing the value at the playhead", () => {
    renderField(0);
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).value).toBe("0.5");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("commits an upserted key at the snapped playhead through onCommitParamTrack", async () => {
    const onCommit = renderField(0);
    const el = screen.getByLabelText("Opacity");
    await userEvent.clear(el);
    await userEvent.type(el, "0.8");
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [layerId, paramKey, next] = onCommit.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(paramKey).toBe("opacity");
    expect(next.mode).toBe("Keyframed");
    expect(next.value[0].value).toBe(0.8);
  });

  it("places the key at the playhead's layer-local (t_start-relative, frame-snapped) time", async () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [{ id: "a", t_us: 0, value: 0.5, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
    };
    const tr = {
      layers: [{ id: "L1", t_start_us: 1_000_000, t_end_us: 3_000_000, params: { opacity: track } }],
    } as unknown as TrackSummary;
    const onCommit = vi.fn();
    render(
      <KeyframeValueField
        track={tr}
        desc={OPACITY}
        currentTimeUs={1_500_000}
        fpsNum={30}
        fpsDen={1}
        onCommitParamTrack={onCommit}
      />,
    );
    const el = screen.getByLabelText("Opacity");
    await userEvent.clear(el);
    await userEvent.type(el, "0.8");
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, , next] = onCommit.mock.calls[0]!;
    expect(next.mode).toBe("Keyframed");
    // local time = 1_500_000 - 1_000_000 = 500_000us, which is exactly frame 15 @30fps,
    // so a NEW key is upserted at t_us 500_000 (the original key at t_us 0 is kept).
    expect(next.value.some((k: { t_us: number; value: number }) => k.t_us === 500_000 && k.value === 0.8)).toBe(true);
    expect(next.value).toHaveLength(2);
  });

  it("disables the field off the clip span", () => {
    renderField(3_000_000); // beyond t_end_us
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).disabled).toBe(true);
  });

  it("renders nothing when the target clip is ambiguous (two keyframed, none focused)", () => {
    const tr = {
      layers: [
        { id: "L1", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
        { id: "L2", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
      ],
    } as unknown as TrackSummary;
    const { container } = render(
      <KeyframeValueField track={tr} desc={OPACITY} currentTimeUs={0} fpsNum={30} fpsDen={1} onCommitParamTrack={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ── The colour row ───────────────────────────────────────────────────────────
// A colour has no number field, so the row swaps the widget rather than the
// commit rule: the same auto-key at the same frame-snapped playhead, written
// through the same sink.
describe("KeyframeValueField on a colour param", () => {
  const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
  const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
  const colorTrack: AnimTrack<Rgba> = {
    mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
    value: [
      { id: "a", t_us: 0, value: RED, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: GREEN, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
    ],
  };
  const colorClip = () =>
    ({ layers: [{ id: "L1", kind: "Color", t_start_us: 0, t_end_us: 2_000_000, params: { kind: "Color", color: colorTrack } }] }) as unknown as TrackSummary;

  function renderColorField(currentTimeUs: number, onCommit = vi.fn()) {
    render(
      <KeyframeValueField
        track={colorClip()}
        desc={COLOR_FILL}
        currentTimeUs={currentTimeUs}
        fpsNum={30}
        fpsDen={1}
        onCommitParamTrack={onCommit}
      />,
    );
    return onCommit;
  }

  it("shows a swatch, not a number field, holding the colour at the playhead", () => {
    renderColorField(0);
    const swatch = screen.getByLabelText("Color") as HTMLInputElement;
    expect(swatch.type).toBe("color");
    expect(swatch.value).toBe("#ff0000");
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("shows the OkLab mix mid-segment, the value the preview is showing", () => {
    renderColorField(500_000);
    const hex = (screen.getByLabelText("Color") as HTMLInputElement).value;
    const n = parseInt(hex.slice(1), 16);
    // The sRGB average of red and green would be #808000; the OkLab mix the
    // engine returns is markedly lighter on both channels.
    expect((n >> 16) & 0xff).toBeGreaterThan(190);
    expect((n >> 8) & 0xff).toBeGreaterThan(150);
    expect(n & 0xff).toBe(0);
  });

  it("commits a colour key at the frame-snapped playhead through onCommitParamTrack", () => {
    const onCommit = renderColorField(500_000);
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#0000ff" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [layerId, paramKey, next] = onCommit.mock.calls[0]!;
    expect([layerId, paramKey]).toEqual(["L1", "color"]);
    expect(next.value).toHaveLength(3);
    expect(next.value.find((k: { t_us: number }) => k.t_us === 500_000).value).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("disables the swatch off the clip span", () => {
    renderColorField(3_000_000);
    expect((screen.getByLabelText("Color") as HTMLInputElement).disabled).toBe(true);
  });

  it("drops the eyedropper — a pick belongs in the inspector row, not an 80px cell", () => {
    renderColorField(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
