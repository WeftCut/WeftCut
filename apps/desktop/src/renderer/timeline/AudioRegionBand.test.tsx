// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnimTrack, EffectView, LayerSummary } from "../ipc";
import { AudioRegionBand } from "./AudioRegionBand";

// jsdom does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button / .clientX (the same shim
// MarkerLane.test.tsx uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

const staticNum = (value: number): AnimTrack<number> => ({ mode: "Static", value });

/// A denoise effect with whatever region bounds the case needs. Absent keys are
/// the unset state, which is how a card with no region yet reads.
const denoise = (params: Record<string, AnimTrack<number>>): EffectView => ({
  id: "E1",
  kind: "audio.denoise",
  enabled: true,
  params: { strength: staticNum(12), margin: staticNum(8), ...params },
});

/// A 4 s audio clip at 1 s of the composition, playing its media from 3 s — so
/// its source window is 3 s → 7 s and a composition time is never its own
/// source time.
const layerWith = (effects: EffectView[]): LayerSummary => ({
  id: "L1",
  label: null,
  t_start_us: 1_000_000,
  t_end_us: 5_000_000,
  kind: "Audio",
  color_hint: "#5588aa",
  enabled: true,
  locked: false,
  effects,
  params: {
    kind: "Audio",
    media_id: "media-1",
    media_label: "voice.wav",
    src_in_us: 3_000_000,
    src_out_us: 7_000_000,
    gain_db: staticNum(0),
    pan: staticNum(0),
    fade_in_us: 0,
    fade_out_us: 0,
    mute: false,
    role: "dialogue",
  },
});

/// 100 px/s and the block's own origin, which is where the band draws: the
/// clip's start is x = 0, so one drawn pixel is 10 ms of composition.
const renderBand = (
  over: {
    effects?: EffectView[];
    preview?: { t0Us: number; t1Us: number } | null;
    onHandlePointerDown?: (e: unknown, bound: "in" | "out") => void;
  } = {},
) =>
  render(
    <AudioRegionBand
      layer={layerWith(
        over.effects ?? [
          denoise({
            profile_in_us: staticNum(4_000_000),
            profile_out_us: staticNum(5_000_000),
          }),
        ],
      )}
      effectId="E1"
      inKey="profile_in_us"
      outKey="profile_out_us"
      minUs={250_000}
      pxPerSec={100}
      blockLeftPx={0}
      visibleLoUs={3_000_000}
      visibleHiUs={7_000_000}
      preview={over.preview ?? null}
      onHandlePointerDown={over.onHandlePointerDown ?? (() => {})}
    />,
  );

afterEach(cleanup);

describe("AudioRegionBand", () => {
  it("draws the stored bounds where the clip plays them", () => {
    renderBand();
    const band = screen.getByTestId("audio-region-band");
    expect(band.style.left).toBe("100px");
    expect(band.style.width).toBe("100px");
    expect(screen.getByTestId("audio-region-handle-in")).toBeTruthy();
    expect(screen.getByTestId("audio-region-handle-out")).toBeTruthy();
  });

  it("draws nothing until a region exists", () => {
    renderBand({ effects: [denoise({})] });
    expect(screen.queryByTestId("audio-region-band")).toBeNull();
  });

  it("draws nothing for an effect the layer no longer carries", () => {
    renderBand({ effects: [] });
    expect(screen.queryByTestId("audio-region-band")).toBeNull();
  });

  // A trim can pull the clip clean off a region — the bounds survive (source
  // time), so the band has to be the thing that goes.
  it("draws nothing for a region the clip has been trimmed off", () => {
    renderBand({
      effects: [
        denoise({
          profile_in_us: staticNum(8_000_000),
          profile_out_us: staticNum(8_500_000),
        }),
      ],
    });
    expect(screen.queryByTestId("audio-region-band")).toBeNull();
  });

  it("stops a half-visible region at the edge of what the clip plays", () => {
    renderBand({
      effects: [
        denoise({
          profile_in_us: staticNum(2_000_000),
          profile_out_us: staticNum(4_000_000),
        }),
      ],
    });
    const band = screen.getByTestId("audio-region-band");
    expect(band.style.left).toBe("0px");
    expect(band.style.width).toBe("100px");
  });

  // The gesture's promise outranks the stored pair for the length of a drag and
  // the round trip that follows it.
  it("paints the preview over the stored bounds", () => {
    renderBand({ preview: { t0Us: 3_500_000, t1Us: 4_000_000 } });
    const band = screen.getByTestId("audio-region-band");
    expect(band.style.left).toBe("250px");
    expect(band.style.width).toBe("50px");
  });

  // Resolved exactly as the release resolves it, so the band shows the minimum
  // span the commit will write rather than the hairline the pointer drew.
  it("expands a preview shorter than the minimum span", () => {
    renderBand({ preview: { t0Us: 2_000_000, t1Us: 2_050_000 } });
    expect(screen.getByTestId("audio-region-band").style.width).toBe("25px");
  });

  it("reports which bound a handle press belongs to", () => {
    const onHandlePointerDown = vi.fn();
    renderBand({ onHandlePointerDown });
    fireEvent.pointerDown(screen.getByTestId("audio-region-handle-in"));
    fireEvent.pointerDown(screen.getByTestId("audio-region-handle-out"));
    expect(onHandlePointerDown.mock.calls.map((call) => call[1])).toEqual(["in", "out"]);
  });
});
