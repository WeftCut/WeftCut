// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// pickColor (imported for its store) transitively imports ../ipc — stub the
// one symbol it uses so jsdom never loads the real bridge.
vi.mock("../ipc", () => ({ logEmit: vi.fn(async () => {}) }));
const { screenPick, screenPickAvailable } = vi.hoisted(() => ({
  screenPick: vi.fn(async () => ({kind:'picked' as const,hex:'#123456'})),
  screenPickAvailable: vi.fn(() => true),
}));
vi.mock("./screenPick", () => ({ screenPick, screenPickAvailable }));

import { PickOverlayHost } from "./PickOverlayHost";
import { usePickSessionStore, type PickSession } from "./pickColor";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

// jsdom 25 does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerMove carries a usable .clientX/.clientY (same shim as
// Timeline.interaction.test.tsx / KeyframeCurveGraph.test.tsx).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

// rAF → run-now so hover sampling is synchronous under test.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePickSessionStore.setState({ session: null, screenPicking: false, screenError: null });
  const s = getPreviewSampler();
  if (s) clearPreviewSampler(s);
  vi.clearAllMocks();
});

// Canvas occupies client [100,100)–[200,200); composition is 10×10 all-green.
const green = new Uint8Array(10 * 10 * 4);
for (let i = 0; i < green.length; i += 4) { green[i + 1] = 255; green[i + 3] = 255; }
const sampler: PreviewSampler = {
  captureFrame: async () => ({ pixels: green, width: 10, height: 10 }),
  mapClientToComposition: (x, y) =>
    x >= 100 && x < 200 && y >= 100 && y < 200
      ? { x: Math.floor((x - 100) / 10), y: Math.floor((y - 100) / 10) }
      : null,
  canvasRect: () =>
    ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 } as DOMRect),
};

// Snapshot: 1×1 red; scale 1 (any outside-canvas point samples it, clamped).
const snap = {
  data: { data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 } as unknown as ImageData,
  scaleX: 1,
  scaleY: 1,
};

function seedSession(overrides: Partial<PickSession> = {}): { settle: ReturnType<typeof vi.fn>; onHover: ReturnType<typeof vi.fn> } {
  const settle = vi.fn();
  const onHover = vi.fn();
  usePickSessionStore.setState({
    session: {
      opts: { onHover },
      comp: { pixels: green, width: 10, height: 10 },
      snap,
      settle,
      ...overrides,
    },
  });
  return { settle, onHover };
}

describe("PickOverlayHost", () => {
  it('samples the effect texture at its composition offset', () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession({ opts: { effectInput: { layerId: 'L1', effectId: 'E1' } },
      comp: { pixels: new Uint8Array([12, 34, 56, 255]), width: 1, height: 1,
        region: { x: 5, y: 5, width: 1, height: 1 } } });
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId('colorpick-overlay'), { clientX: 150, clientY: 150 });
    expect(settle).toHaveBeenCalledWith({ hex: '#0c2238', source: 'effect-input' });
  });

  it('does not substitute the editor screenshot when effect input is unavailable', () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession({ opts: { effectInput: { layerId: 'L1', effectId: 'E1' } }, comp: null });
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId('colorpick-overlay'), { clientX: 150, clientY: 150 });
    expect(settle).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('does not substitute a covered or transparent region with screenshot pixels', () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession({ opts: { effectInput: { layerId: 'L1', effectId: 'E1' } },
      comp: { pixels: new Uint8Array(4), width: 1, height: 1, region: { x: 5, y: 5, width: 1, height: 1 } } });
    render(<PickOverlayHost />);
    for (const clientX of [120, 150]) fireEvent.click(screen.getByTestId('colorpick-overlay'), { clientX, clientY: 150 });
    expect(settle).not.toHaveBeenCalled();
  });

  it("renders nothing without a session", () => {
    render(<PickOverlayHost />);
    expect(screen.queryByTestId("colorpick-overlay")).toBeNull();
  });

  it("click inside the canvas commits the composition sample", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId("colorpick-overlay"), { clientX: 150, clientY: 150 });
    expect(settle).toHaveBeenCalledWith({ hex: "#00ff00", source: "composition" });
  });

  it("click outside the canvas commits the snapshot sample", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId("colorpick-overlay"), { clientX: 10, clientY: 10 });
    expect(settle).toHaveBeenCalledWith({ hex: "#ff0000", source: "ui" });
  });

  it("hover fires onHover with the sampled hex", () => {
    registerPreviewSampler(sampler);
    const { onHover } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.pointerMove(screen.getByTestId("colorpick-overlay"), { clientX: 150, clientY: 150 });
    expect(onHover).toHaveBeenCalledWith("#00ff00");
  });

  it("Escape settles null", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(settle).toHaveBeenCalledWith(null);
  });

  it("S keeps ownership while hiding the in-app overlay, then settles the desktop result", async () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.keyDown(window, { key: "s" });
    expect(usePickSessionStore.getState().session).not.toBeNull();
    expect(usePickSessionStore.getState().screenPicking).toBe(true);
    expect(screen.queryByTestId('colorpick-overlay')).toBeNull();
    fireEvent.blur(window); // the desktop overlay takes focus intentionally
    expect(settle).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(settle).toHaveBeenCalledWith({ hex: "#123456", source: "screen" }),
    );
  });

  it("modified S chords (Ctrl+S) do NOT trigger the screen handoff", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(usePickSessionStore.getState().session).not.toBeNull();
    expect(screenPick).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("letterbox bars inside the canvas rect fall through to the snapshot", () => {
    // Same rect as `sampler`, but the top 20px band maps to nothing
    // (composition letterbox) — a click there must sample the window snapshot.
    registerPreviewSampler({
      ...sampler,
      mapClientToComposition: (x, y) =>
        y >= 120 && y < 200 && x >= 100 && x < 200
          ? { x: Math.floor((x - 100) / 10), y: Math.floor((y - 120) / 10) }
          : null,
    });
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId("colorpick-overlay"), { clientX: 150, clientY: 110 });
    expect(settle).toHaveBeenCalledWith({ hex: "#ff0000", source: "ui" });
  });
});
