import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
  rootSummary,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A still image is ready the moment it lands in the pool — no proxy job, so no
// background write lands between a gesture and the summary that reads it back.
const IMAGE = path.resolve(__dirname, "../fixtures/media/test_chart_320x240.png");
// The audio-only tone file, for the one case that has to prove the nudge still
// reaches the audio slip when no keyframe is selected.
const TONES = path.resolve(__dirname, "../fixtures/media/test_tones_10s.wav");

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/// The project's rate, and the canonical µs of a frame index on it.
///
/// Duplicated from `frames.ts` rather than imported: an e2e spec runs outside
/// the app's module graph, and the point of writing it out here is that the
/// times the app STORED are asserted against a grid this spec derived
/// independently. A shared constant could drift on both sides at once.
const FPS_NUM = 30;
const FPS_DEN = 1;
const frameUs = (f: number) =>
  Math.floor((f * 1_000_000 * FPS_DEN + FPS_NUM / 2) / FPS_NUM);
/// True when `tUs` is a canonical frame time — every keyframe the app stores
/// must be, whatever gesture produced it.
const onGrid = (tUs: number) => frameUs(Math.round((tUs * FPS_NUM) / (1_000_000 * FPS_DEN))) === tUs;

interface Keyframe {
  id: string;
  t_us: number;
  value: number;
}

interface BatchSummary {
  history: { len: number };
  media: Array<{ id: string; kind: string }>;
  tracks: Array<{
    id: string;
    role: string | null;
    layers: Array<{
      id: string;
      kind: string;
      t_start_us: number;
      t_end_us: number;
      params: Record<string, unknown>;
    }>;
  }>;
}

const snapshot = (page: Page) => rootSummary<BatchSummary>(page);

/// A layer's committed `opacity` track, straight out of the summary — the only
/// observable for what a gesture did. `null` for a track that is still Static.
function opacityTrack(
  s: BatchSummary,
  layerId: string,
): { mode: string; value: Keyframe[] } | null {
  for (const track of s.tracks) {
    for (const layer of track.layers) {
      if (layer.id !== layerId) continue;
      return (layer.params.opacity as { mode: string; value: Keyframe[] }) ?? null;
    }
  }
  return null;
}

const opacityKeys = (s: BatchSummary, layerId: string): Keyframe[] => {
  const t = opacityTrack(s, layerId);
  return t?.mode === "Keyframed" ? t.value : [];
};

/// A key's time by id, or `null` when the key is gone.
const keyTime = (s: BatchSummary, layerId: string, kfId: string): number | null =>
  opacityKeys(s, layerId).find((k) => k.id === kfId)?.t_us ?? null;

const layerStart = (s: BatchSummary, layerId: string): number | null => {
  for (const track of s.tracks) {
    for (const layer of track.layers) if (layer.id === layerId) return layer.t_start_us;
  }
  return null;
};

interface Pt {
  x: number;
  y: number;
}

async function rectOf(l: Locator): Promise<Pt & { w: number; h: number; cx: number; cy: number; bottom: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error("element has no layout box");
  return {
    x: b.x,
    y: b.y,
    w: b.width,
    h: b.height,
    cx: b.x + b.width / 2,
    cy: b.y + b.height / 2,
    bottom: b.y + b.height,
  };
}

/// Create the project, put the fixtures in the pool, and maximize the Timeline
/// Panel. Same shape and same reasons as `timeline-marquee.spec.ts`: import
/// WITHOUT placing, because every case here chooses its own lanes, and maximize
/// while the timeline is still empty so the gesture that maximizes cannot land
/// on a chip.
async function openTimeline(
  page: Page,
  tag: string,
  files: string[],
): Promise<{ mediaIds: string[]; trackIds: string[]; panel: Locator }> {
  await newProject(page, {
    parentFolder: tmpDir(`weftcut-e2e-kfbatch-${tag}-`),
    name: `e2e-kfbatch-${tag}-` + Date.now(),
    canvas: { width: 640, height: 480, fpsNum: FPS_NUM, fpsDen: FPS_DEN },
  });
  // REQUIRED before any pointer gesture: the launch splash is a full-window
  // overlay that outlives the first timeline render.
  await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

  await page.waitForFunction(
    () => typeof (window as any).api?.media?.dropped === "function",
  );
  await page.evaluate((f) => (window as any).api.media.dropped(f), files);
  await expect
    .poll(async () => (await snapshot(page)).media.length, { timeout: 30_000 })
    .toBe(files.length);

  const s = await snapshot(page);
  // The blank skeleton: `tracks[0]` is A roll, `tracks[1]` is B roll, both
  // role-stamped and therefore both RENDERED under the default A/B Roll filter.
  expect(s.tracks.map((t) => t.role)).toEqual(["a-roll", "b-roll"]);

  const panel = dockPanel(page, "timeline");
  await expect(panel).toBeVisible();
  await waitForHook(page, "dockWorkspaceProbe");
  await panel.click();
  await page.keyboard.press("Backquote");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__weftcutTest.dockWorkspaceProbe()?.maximizedPanel ?? null,
      ),
    )
    .toBe("timeline");

  return { mediaIds: s.media.map((m) => m.id), trackIds: s.tracks.map((t) => t.id), panel };
}

const place = (page: Page, trackId: string, mediaId: string, tStartUs: number) =>
  invokeCmd<string>(page, "add_media_layer", { trackId, mediaId, tStartUs });

/// Write `keys` as the layer's `opacity` track. The times are whole 30 fps
/// frames, so the actor's grid snap is the identity and the ids come back
/// verbatim — which is what lets every assertion below name a diamond.
const keyOpacity = (
  page: Page,
  layerId: string,
  keys: ReadonlyArray<{ id: string; t_us: number; value: number }>,
) =>
  invokeCmd(page, "update_layer_param_track", {
    layerId,
    paramKey: "opacity",
    track: {
      mode: "Keyframed",
      value: keys.map((k) => ({
        ...k,
        in: { x: 2 / 3, y: 2 / 3, mode: "Free" },
        out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
        continuity: "Broken",
        segment: { kind: "Linear" },
      })),
      extrapolate: { before: "Hold", after: "Hold" },
    },
  });

/// Open the one track that has keyframes and return its single sub-lane row.
/// The twirl is `disabled` on a track with none, so the enabled one names
/// itself.
async function expandKeyframeLane(page: Page): Promise<Locator> {
  const twirl = page.locator('[data-testid="kf-lane-twirl"]:not([disabled])');
  await expect(twirl).toHaveCount(1);
  await twirl.click();
  const row = page.locator('[data-testid="kf-sublane"]');
  await expect(row).toHaveCount(1);
  return row;
}

const diamond = (page: Page, kfId: string) =>
  page.locator(`.kf-sublane-diamond[data-kf-id="${kfId}"]`);

/// A marquee across the sub-lane row, which is how a spec builds a keyframe
/// selection spanning several keys and layers. One `page.mouse` call per step:
/// the gesture recomputes its result on every pointermove, so firing the whole
/// sequence inside one page task would leave React uncommitted between them.
async function sweepKeys(page: Page, from: Pt, to: Pt): Promise<void> {
  const overlay = page.locator('[data-testid="timeline-marquee"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / 4,
        from.y + ((to.y - from.y) * i) / 4,
      );
      if (i === 1) await expect(overlay).toHaveAttribute("data-kind", "keyframe");
    }
  } finally {
    await page.mouse.up();
  }
  await expect(overlay).toHaveCount(0);
}

/// Press a diamond and drag it horizontally by `dxPx`, optionally with Alt held
/// from the press — the modifier is read at pointerdown and never again, so it
/// has to be down before the button is.
async function dragKey(
  page: Page,
  kfId: string,
  dxPx: number,
  opts: { alt?: boolean } = {},
): Promise<void> {
  const dot = await rectOf(diamond(page, kfId));
  await page.mouse.move(dot.cx, dot.cy);
  if (opts.alt) await page.keyboard.down("Alt");
  await page.mouse.down();
  try {
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(dot.cx + (dxPx * i) / 4, dot.cy);
    }
  } finally {
    await page.mouse.up();
    if (opts.alt) await page.keyboard.up("Alt");
  }
}

/// Park the playhead at `us`. `transportSeekUs` no-ops SILENTLY until the
/// transport registers, and `waitForHook` does not wait for that — so the seek
/// is re-issued inside the poll until the playhead line has actually left the
/// origin.
async function seekTo(page: Page, us: number): Promise<void> {
  await waitForHook(page, "transportSeekUs");
  const playhead = page.locator('[data-testid="timeline-playhead"]');
  const canvas = page.locator('[data-testid="timeline-canvas"]');
  await expect
    .poll(
      async () => {
        await page.evaluate(
          (t) => (window as any).__weftcutTest.transportSeekUs(t),
          us,
        );
        const p = await playhead.boundingBox();
        const c = await canvas.boundingBox();
        return p && c ? Math.round(p.x - c.x) : -1;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(20);
}

// Every RULE these gestures follow is already unit-tested twice over — as pure
// functions over hand-written groups (`keyframe/batchRetime.test.ts`) and in
// jsdom with mocked rects (`Timeline.interaction.test.tsx`). What only the real
// app can answer is whether the pointer travel a user makes reaches those rules
// at all: the drag hook measures a client x against a live px/s, converts it
// through a layer's own start, and commits through the actor's snap-and-dedupe.
// So the assertions here read the STORED track and nothing else.
test.describe("keyframe batch gestures — the pointer and the keys agree", () => {
  test.skip(
    !existsSync(IMAGE),
    `image fixture not found at ${IMAGE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("a group drag stops at the tightest wall and moves every layer by the same delta", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaIds, trackIds } = await openTimeline(page, "wall", [IMAGE]);
      // Both clips on ONE track, so its single `opacity` row draws the diamonds
      // of both layers and one sweep can select across them.
      const lane = trackIds[0]!;
      const near = await place(page, lane, mediaIds[0]!, 1_000_000);
      const far = await place(page, lane, mediaIds[0]!, 5_000_000);
      // A still gets a 3 s (90-frame) span. `n2` sits three frames from its
      // layer's end, `f2` a long way from its own — so the near layer owns the
      // tightest wall and the far one has to stop where it stops.
      await keyOpacity(page, near, [
        { id: "n1", t_us: 0, value: 1 },
        { id: "n2", t_us: frameUs(87), value: 0.5 },
      ]);
      await keyOpacity(page, far, [
        { id: "f1", t_us: 0, value: 1 },
        { id: "f2", t_us: frameUs(15), value: 0.5 },
      ]);

      await expect(page.locator(".timeline-layer")).toHaveCount(2, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      await expect(page.locator(".kf-sublane-diamond")).toHaveCount(4);

      // Sweep all four keys, across both layers. The x bounds clear the outer
      // diamonds by well over their own width, because a press that landed on
      // one would start a dot drag instead of reaching the row's anchor.
      const band = await rectOf(row);
      const n1 = await rectOf(diamond(page, "n1"));
      const f2 = await rectOf(diamond(page, "f2"));
      await sweepKeys(
        page,
        { x: n1.cx - 30, y: band.y + 4 },
        { x: f2.cx + 30, y: band.bottom - 4 },
      );
      await expect(page.locator(".kf-sublane-diamond.is-selected")).toHaveCount(4);

      const before = await snapshot(page);
      // Far more travel than the wall allows: the group has to stop, not clip
      // one member and keep dragging the other.
      await dragKey(page, "n2", 400);

      await expect
        .poll(async () => keyTime(await snapshot(page), near, "n2"), { timeout: 20_000 })
        .toBe(frameUs(90));
      const after = await snapshot(page);
      // ONE shared delta — three frames, the tightest wall in the group — even
      // for the far layer, whose own end was nowhere near.
      expect(keyTime(after, near, "n1")).toBe(frameUs(3));
      expect(keyTime(after, far, "f1")).toBe(frameUs(3));
      expect(keyTime(after, far, "f2")).toBe(frameUs(18));
      expect(after.history.len).toBe(before.history.len + 1);
    } finally {
      await app.close();
    }
  });

  test("Alt-dragging an end key scales the span about the opposite end", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaIds, trackIds } = await openTimeline(page, "scale", [IMAGE]);
      const clip = await place(page, trackIds[0]!, mediaIds[0]!, 1_000_000);
      await keyOpacity(page, clip, [
        { id: "k0", t_us: 0, value: 1 },
        { id: "k1", t_us: frameUs(30), value: 0.5 },
        { id: "k2", t_us: frameUs(60), value: 0 },
      ]);

      await expect(page.locator(".timeline-layer")).toHaveCount(1, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      await expect(page.locator(".kf-sublane-diamond")).toHaveCount(3);

      const band = await rectOf(row);
      const k0 = await rectOf(diamond(page, "k0"));
      const k2 = await rectOf(diamond(page, "k2"));
      await sweepKeys(
        page,
        { x: k0.cx - 30, y: band.y + 4 },
        { x: k2.cx + 30, y: band.bottom - 4 },
      );
      await expect(page.locator(".kf-sublane-diamond.is-selected")).toHaveCount(3);

      const before = await snapshot(page);
      // Alt on the LAST key: the first is the anchor, and dragging left halves
      // the span. Roughly half the on-screen distance between the ends, so the
      // exact factor is whatever the pointer produced — the assertions below
      // are about the SHAPE it preserved, not about a pinned number.
      await dragKey(page, "k2", -Math.round((k2.cx - k0.cx) / 2), { alt: true });

      await expect
        .poll(async () => keyTime(await snapshot(page), clip, "k2"), { timeout: 20_000 })
        .toBeLessThan(frameUs(60));
      const after = await snapshot(page);
      const t0 = keyTime(after, clip, "k0")!;
      const t1 = keyTime(after, clip, "k1")!;
      const t2 = keyTime(after, clip, "k2")!;

      // The anchor did not move; the grabbed end came in; the middle key came
      // in with it and kept its place in the span (the shape-preservation a
      // scale means), and every result landed on the frame grid.
      expect(t0).toBe(0);
      expect(t2).toBeLessThan(frameUs(60));
      expect(t1).toBeGreaterThan(t0);
      expect(t1).toBeLessThan(t2);
      expect((t1 - t0) / (t2 - t0)).toBeGreaterThan(0.45);
      expect((t1 - t0) / (t2 - t0)).toBeLessThan(0.55);
      for (const t of [t0, t1, t2]) expect(onGrid(t)).toBe(true);
      expect(after.history.len).toBe(before.history.len + 1);
    } finally {
      await app.close();
    }
  });

  test("Alt+Arrow nudges keyframes by a frame, and slips audio when none are selected", async () => {
    test.setTimeout(120_000);
    test.skip(
      !existsSync(TONES),
      `audio fixture not found at ${TONES} (run: cd apps/desktop/e2e && npm run fixtures)`,
    );
    const { app, page } = await launchApp();
    try {
      const { mediaIds, trackIds } = await openTimeline(page, "nudge", [IMAGE, TONES]);
      const s0 = await snapshot(page);
      const imageId = s0.media.find((m) => m.kind === "Image")!.id;
      const audioId = s0.media.find((m) => m.kind === "Audio")!.id;
      expect([imageId, audioId].every((id) => mediaIds.includes(id))).toBe(true);

      const clip = await place(page, trackIds[0]!, imageId, 1_000_000);
      const audio = await place(page, trackIds[1]!, audioId, 1_000_000);
      await keyOpacity(page, clip, [{ id: "n0", t_us: frameUs(15), value: 0.5 }]);

      await expect(page.locator(".timeline-layer")).toHaveCount(2, { timeout: 20_000 });
      await expandKeyframeLane(page);
      // Pressing a diamond selects it — the same press that would start a drag,
      // released without travel.
      await diamond(page, "n0").click();
      const audioStart = layerStart(await snapshot(page), audio)!;

      await page.keyboard.press("Alt+ArrowRight");
      await expect
        .poll(async () => keyTime(await snapshot(page), clip, "n0"), { timeout: 20_000 })
        .toBe(frameUs(16));
      // The audio did not move: the key with a keyframe selection standing is
      // the keyframes' key and nothing else's.
      expect(layerStart(await snapshot(page), audio)).toBe(audioStart);

      // Deselect All is the documented way to clear all three selections that
      // arm an edit; then the audio clip alone is selected and the SAME key is
      // pressed again.
      await page.keyboard.press(`${MOD}+Shift+A`);
      await expect(page.locator(".kf-sublane-diamond.is-selected")).toHaveCount(0);
      await page.locator(`.timeline-layer[data-layer-id="${audio}"]`).click();
      await waitForHook(page, "getSelectedLayerId");
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__weftcutTest.getSelectedLayerId()),
        )
        .toBe(audio);

      await page.keyboard.press("Alt+ArrowRight");
      // One SAMPLE at 48 kHz is ~21 µs — far under a frame, which is exactly
      // why the audio tier exists and why the key had to keep reaching it.
      await expect
        .poll(async () => layerStart(await snapshot(page), audio)! - audioStart, {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      const slipped = await snapshot(page);
      expect(layerStart(slipped, audio)! - audioStart).toBeLessThan(frameUs(1));
      // And the keyframe stayed where the first nudge left it.
      expect(keyTime(slipped, clip, "n0")).toBe(frameUs(16));
    } finally {
      await app.close();
    }
  });

  test("copied keyframes paste onto another clip at the playhead, lifting a Static track", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaIds, trackIds } = await openTimeline(page, "clipboard", [IMAGE]);
      const source = await place(page, trackIds[0]!, mediaIds[0]!, 1_000_000);
      const target = await place(page, trackIds[1]!, mediaIds[0]!, 1_000_000);
      await keyOpacity(page, source, [
        { id: "c0", t_us: 0, value: 1 },
        { id: "c1", t_us: frameUs(30), value: 0 },
      ]);

      await expect(page.locator(".timeline-layer")).toHaveCount(2, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      await expect(page.locator(".kf-sublane-diamond")).toHaveCount(2);
      // The target starts Static — the case is that a paste LIFTS it and leaves
      // only the pasted keys behind, with no key at the old constant.
      expect(opacityTrack(await snapshot(page), target)?.mode).toBe("Static");

      const band = await rectOf(row);
      const c0 = await rectOf(diamond(page, "c0"));
      const c1 = await rectOf(diamond(page, "c1"));
      await sweepKeys(
        page,
        { x: c0.cx - 30, y: band.y + 4 },
        { x: c1.cx + 30, y: band.bottom - 4 },
      );
      await expect(page.locator(".kf-sublane-diamond.is-selected")).toHaveCount(2);
      await page.keyboard.press(`${MOD}+c`);

      // Select the target clip and park the playhead one second into it.
      await page.locator(`.timeline-layer[data-layer-id="${target}"]`).click();
      await waitForHook(page, "getSelectedLayerId");
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__weftcutTest.getSelectedLayerId()),
        )
        .toBe(target);
      await seekTo(page, 2_000_000);

      const before = await snapshot(page);
      await page.keyboard.press(`${MOD}+v`);

      await expect
        .poll(async () => opacityTrack(await snapshot(page), target)?.mode, {
          timeout: 20_000,
        })
        .toBe("Keyframed");
      const after = await snapshot(page);
      const pasted = opacityKeys(after, target);
      // Only the pasted keys, at the playhead in the target's own local time
      // (2 s playhead − 1 s clip start), with the copied spacing intact.
      expect(pasted).toHaveLength(2);
      expect(pasted.map((k) => k.t_us)).toEqual([frameUs(30), frameUs(60)]);
      expect(pasted.map((k) => k.value)).toEqual([1, 0]);
      // Fresh ids: a paste mints its own, so a second paste cannot collide with
      // the first.
      expect(pasted.map((k) => k.id).some((id) => id === "c0" || id === "c1")).toBe(false);
      // The source is untouched and the paste is ONE undo entry.
      expect(opacityKeys(after, source).map((k) => k.t_us)).toEqual([0, frameUs(30)]);
      expect(after.history.len).toBe(before.history.len + 1);
    } finally {
      await app.close();
    }
  });
});
