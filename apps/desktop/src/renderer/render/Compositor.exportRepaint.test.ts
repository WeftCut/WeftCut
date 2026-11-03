import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";
import { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
import { summaryFixture } from "../testing/summaryFixture";

// Who may composite: export's frame driver alone, preview's async arrivals too.
// Why a stray export repaint matters: `Compositor.scheduleRepaint`.

const stat = (value: number) => ({ mode: "Static" as const, value });

const image: LayerSummary = {
  id: "still",
  label: "Still",
  kind: "ImageOverlay",
  t_start_us: 0,
  t_end_us: 1_000_000,
  color_hint: "#000000",
  enabled: true,
  locked: false,
  effects: [],
  params: {
    kind: "ImageOverlay",
    media_id: "image",
    media_label: "Still",
    graphic_role: null,
    x: stat(0),
    y: stat(0),
    scale_x: stat(1),
    scale_y: stat(1),
    scale_linked: true,
    rotation_deg: stat(0),
    anchor_x: stat(0.5),
    anchor_y: stat(0.5),
    opacity: stat(1),
    fade_in_us: 0,
    fade_out_us: 0,
  },
};

const summary = summaryFixture({
  root: {
    tracks: [
      {
        id: "visual",
        label: null,
        kind: "Video",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: "a-roll",
        transient: false,
        layers: [image],
      },
    ],
  },
});

describe("Compositor repaint ownership", () => {
  let compositor: Compositor;
  let rafCallbacks: FrameRequestCallback[];

  function open(mode: "export" | "preview"): void {
    compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
      originalAssetUrl: () => "/still.png",
      sourceColor: () => undefined,
      mediaById: () => undefined,
    });
    compositor.setProject(summary);
  }

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafCallbacks.push(cb));
    vi.spyOn(ImageOverlaySprite.prototype, "loadFromAsset").mockResolvedValue();
  });

  afterEach(() => {
    compositor.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("export: an image finishing its preload queues no repaint", async () => {
    open("export");
    await compositor.preloadImages();
    expect(rafCallbacks).toHaveLength(0);
  });

  it("export: the frame driver's own composite still sweeps", () => {
    open("export");
    const sweep = vi.spyOn(compositor.rootNode(), "compositeVisual").mockImplementation(() => {});
    compositor.compositeFrame(0);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("preview: an image finishing its preload repaints, coalescing later arrivals", async () => {
    open("preview");
    await compositor.preloadImages();
    expect(rafCallbacks).toHaveLength(1);
    compositor.scheduleRepaint();
    expect(rafCallbacks).toHaveLength(1);
  });
});
