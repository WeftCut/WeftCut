// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  setPausePreview,
  usePausePreviewStore,
  type PausePreviewRegion,
} from "../state/pausePreviewStore";
import { PauseBands } from "./PauseBands";

const SUBJECT = "L1";

/// A 4 s audio clip at 1 s of the composition, drawn at 100 px/s from its own
/// origin — so the clip's start is x = 0 and one drawn pixel is 10 ms.
const renderBands = (
  over: { layerId?: string; loUs?: number; hiUs?: number; pxPerSec?: number } = {},
) =>
  render(
    <PauseBands
      layerId={over.layerId ?? SUBJECT}
      pxPerSec={over.pxPerSec ?? 100}
      blockLeftPx={0}
      tStartUs={1_000_000}
      blockLoUs={over.loUs ?? 1_000_000}
      blockHiUs={over.hiUs ?? 5_000_000}
    />,
  );

const publish = (
  pauses: PausePreviewRegion[],
  over: { padUs?: number; auditioning?: number[] } = {},
) =>
  setPausePreview({
    subjectLayerId: SUBJECT,
    pauses,
    padUs: over.padUs ?? 200_000,
    auditioning: over.auditioning ?? [],
  });

/// 1.5 s → 2.5 s and 3 s → 4 s of the composition.
const TWO_PAUSES: PausePreviewRegion[] = [
  { t_start_us: 1_500_000, t_end_us: 2_500_000 },
  { t_start_us: 3_000_000, t_end_us: 4_000_000 },
];

/// Every band's `[left, width]` in px, rounded off the last few bits of binary
/// float — the band shares its px↔µs axis with the denoise region and neither
/// rounds, so a coordinate arrives as `220.00000000000003` and the assertions
/// are about geometry, not the ULP.
const rects = (testId: string) =>
  screen.queryAllByTestId(testId).map((el) => {
    const px = (value: string) => Math.round(Number.parseFloat(value) * 1e3) / 1e3;
    return [px((el as HTMLElement).style.left), px((el as HTMLElement).style.width)];
  });

afterEach(() => {
  cleanup();
  usePausePreviewStore.setState({ preview: null });
});

describe("PauseBands", () => {
  it("draws one band per pause where the clip plays it", () => {
    publish(TWO_PAUSES);
    renderBands();
    expect(rects("pause-band")).toEqual([
      [50, 100],
      [200, 100],
    ]);
  });

  // The core is what *Remove* cuts; the pad is kept on each side, so the core
  // is exactly two pads narrower than the range it sits in.
  it("insets the core by one pad on each side", () => {
    publish(TWO_PAUSES);
    renderBands();
    expect(rects("pause-band-core")).toEqual([
      [70, 60],
      [220, 60],
    ]);
  });

  it("draws no core for a pause the pads would consume", () => {
    publish([{ t_start_us: 2_000_000, t_end_us: 2_300_000 }]);
    renderBands();
    expect(rects("pause-band")).toEqual([[100, 30]]);
    expect(screen.queryAllByTestId("pause-band-core")).toHaveLength(0);
  });

  it("brightens and outlines only the range being auditioned", () => {
    publish(TWO_PAUSES, { auditioning: [1] });
    renderBands();
    const [quiet, playing] = screen.getAllByTestId("pause-band");
    expect(quiet!.className).toContain("bg-[#e6a028]/25");
    expect(playing!.className).toContain("bg-[#e6a028]/60");
    expect(playing!.className).toContain("outline-[#e6a028]");
  });

  it("draws nothing on a block that is not the subject", () => {
    publish(TWO_PAUSES);
    renderBands({ layerId: "L2" });
    expect(screen.queryByTestId("pause-bands")).toBeNull();
  });

  it("draws nothing while no section is publishing", () => {
    renderBands();
    expect(screen.queryByTestId("pause-bands")).toBeNull();
  });

  // A trim preview narrows the block under bands measured on the committed
  // span: the half that is still on the clip draws, the pause that is wholly
  // off it goes.
  it("stops a band at the block's live edge", () => {
    publish(TWO_PAUSES);
    renderBands({ hiUs: 2_000_000 });
    expect(rects("pause-band")).toEqual([[50, 50]]);
  });

  // A pause of a few hundred milliseconds is a fraction of a pixel once the
  // timeline is zoomed out, and a band nobody can see answers nothing.
  it("keeps a sub-pixel band visible", () => {
    publish([{ t_start_us: 2_000_000, t_end_us: 2_200_000 }], { padUs: 50_000 });
    renderBands({ pxPerSec: 1 });
    expect(rects("pause-band")).toEqual([[1, 1]]);
    expect(rects("pause-band-core")).toEqual([[1.05, 1]]);
  });
});
