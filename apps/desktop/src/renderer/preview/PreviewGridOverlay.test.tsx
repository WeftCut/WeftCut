// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectSummary } from "../ipc";
import { DEFAULT_PREVIEW_GRID, type PreviewGridSettings } from "../../shared/preview-grid";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { clearGizmoProbe, registerGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import { PreviewGridOverlayHost } from "./PreviewGridOverlay";

const COMP = { width: 1280, height: 720 };

/// An empty composition: the grid is a property of the frame.
function fixture(): ProjectSummary {
  return summaryFixture({
    project_id: "p1",
    name: "fixture",
    media: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      ...COMP,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 0,
      tracks: [],
      links: [],
      markers: [],
      transitions: [],
    },
  }) as unknown as ProjectSummary;
}

/// The canvas box the probe reports, swapped per case. Null is "no canvas".
let canvas: DOMRect | null = null;
const canvasOf = (width: number, height: number): DOMRect =>
  ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect;
const probe: GizmoProbe = {
  canvasRect: () => canvas,
  naturalSizeOf: () => null,
  textFitOf: () => null,
};

function setGrid(patch: Partial<PreviewGridSettings>): void {
  act(() => {
    useAppSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        safe_area_guides_visible: false,
        preview_grid: { ...s.settings.preview_grid, ...patch },
      },
    }));
  });
}

const frame = () => screen.getByTestId("preview-grid").firstElementChild as SVGSVGElement;
/// The two axis groups, columns first; an axis that is off has none.
const axisOpacity = (index: number) =>
  Number(frame().querySelectorAll("g")[index]?.getAttribute("opacity"));

beforeEach(() => {
  registerGizmoProbe(probe);
  useProjectStore.getState().apply(fixture());
  setGrid({ ...DEFAULT_PREVIEW_GRID, enabled: true });
});

afterEach(() => {
  cleanup();
  clearGizmoProbe(probe);
  useProjectStore.getState().apply(null);
  setGrid(DEFAULT_PREVIEW_GRID);
  canvas = null;
});

describe("PreviewGridOverlay", () => {
  it("lays the grid over the frame where the canvas letterboxes it", async () => {
    // A 4:3 box holding a 16:9 frame: the frame fills the width and is centred
    // vertically, with equal bars above and below.
    canvas = canvasOf(640, 480);
    render(<PreviewGridOverlayHost />);
    await waitFor(() => expect(frame().getAttribute("visibility")).toBe("visible"));
    const fittedHeight = (640 / COMP.width) * COMP.height;
    expect(Number(frame().getAttribute("x"))).toBe(0);
    expect(Number(frame().getAttribute("width"))).toBe(640);
    expect(Number(frame().getAttribute("height"))).toBe(fittedHeight);
    expect(Number(frame().getAttribute("y"))).toBe((480 - fittedHeight) / 2);
    expect(frame().getAttribute("viewBox")).toBe(`0 0 ${COMP.width} ${COMP.height}`);
  });

  it("draws nothing while there is no canvas to fit, and appears once there is one", async () => {
    render(<PreviewGridOverlayHost />);
    expect(frame().getAttribute("visibility")).toBe("hidden");
    canvas = canvasOf(640, 360);
    await waitFor(() => expect(frame().getAttribute("visibility")).toBe("visible"));
  });

  it("fades only an axis whose lines crowd together, and lifts the fade as they spread", async () => {
    const userOpacity = DEFAULT_PREVIEW_GRID.opacity / 100;
    // Three columns stay far apart at any size; 64 rows crowd on a small canvas.
    setGrid({ column_divisions: 3, row_divisions: 64 });
    canvas = canvasOf(320, 180);
    render(<PreviewGridOverlayHost />);
    await waitFor(() => expect(frame().getAttribute("visibility")).toBe("visible"));
    expect(axisOpacity(0)).toBe(userOpacity);
    expect(axisOpacity(1)).toBeGreaterThan(0);
    expect(axisOpacity(1)).toBeLessThan(userOpacity);

    // The same rows on a canvas the frame's own size are far enough apart.
    canvas = canvasOf(COMP.width, COMP.height);
    await waitFor(() => expect(axisOpacity(1)).toBe(userOpacity));
    expect(axisOpacity(0)).toBe(userOpacity);
  });

  it("is absent while the eye hides the lines, or both axes are off", () => {
    canvas = canvasOf(640, 360);
    setGrid({ hidden: true });
    const { rerender } = render(<PreviewGridOverlayHost />);
    expect(screen.queryByTestId("preview-grid")).toBeNull();
    setGrid({ hidden: false, columns: false, rows: false });
    rerender(<PreviewGridOverlayHost />);
    expect(screen.queryByTestId("preview-grid")).toBeNull();
  });
});
