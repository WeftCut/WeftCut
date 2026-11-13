import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  invokeCmd,
  launchApp,
  newProject,
  rootSummary,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

const canvas = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("the timeline magnet is a plain one-click snap toggle; strength stays in Settings", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-magnet-"), name: "magnet", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    const magnet = page.locator('button[data-quick-action="toggleTailSnap"]');
    await expect(magnet).toBeVisible();
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('button[data-quick-action="timelineSnapOptions"]')).toHaveCount(0);
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("dialog", { name: /Timeline snapping/i })).toHaveCount(0);
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    const settings = await invokeCmd<{ tail_snap_strength_px: number }>(page, "app_settings_get");
    expect(settings.tail_snap_strength_px).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

for (const direction of ["right", "left"] as const) {
  test(`a clip drag to the ${direction} shows its target and can suspend snapping with Mod`, async () => {
    const { app, page } = await launchApp();
    try {
      await newProject(page, { parentFolder: tmpDir("weftcut-timeline-snap-guide-"), name: "guide", canvas });
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
      await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
      const right = direction === "right";
      const boundaryUs = right ? 3_000_000 : 4_000_000;
      // Ordinary color clips have no proxy jobs; the drag can be inspected while live.
      const target = await invokeCmd<string>(page, "add_color_layer", {
        tStartUs: 3_000_000, durationUs: 1_000_000,
      });
      const moving = await invokeCmd<string>(page, "add_color_layer", {
        tStartUs: right ? 0 : 5_000_000, durationUs: 1_000_000,
      });
      const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
      if (await display.getAttribute("aria-pressed") === "true") await display.click();
      const sourceClip = page.locator(`.timeline-layer[data-layer-id="${moving}"]`);
      const targetClip = page.locator(`.timeline-layer[data-layer-id="${target}"]`);
      await expect(sourceClip).toBeVisible();
      await expect(targetClip).toBeVisible();
      const source = await sourceClip.boundingBox();
      const dest = await targetClip.boundingBox();
      if (!source || !dest) throw new Error("timeline clips missing bounds");
      const fromX = source.x + source.width / 2;
      const fromY = source.y + source.height / 2;
      // Approach the facing edge from the gap between the clips.
      const toX = right
        ? fromX + dest.x - (source.x + source.width) - 5
        : fromX + dest.x + dest.width - source.x + 5;
      const guide = page.getByTestId("timeline-snap-guide");
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(toX, fromY, { steps: 5 });
      await expect(guide).toHaveAttribute("data-snap-boundary-us", String(boundaryUs));

      await page.keyboard.down(MOD);
      await page.mouse.move(toX + 1, fromY);
      await expect(guide).toHaveCount(0);
      await page.keyboard.up(MOD);
      await page.mouse.move(toX, fromY);
      await expect(guide).toHaveAttribute("data-snap-boundary-us", String(boundaryUs));
      await page.mouse.up();
      await expect(guide).toHaveCount(0);

      await expect.poll(async () => {
        const s = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }> }>(page);
        return s.tracks.flatMap((t) => t.layers).find((layer) => layer.id === moving)?.t_start_us ?? null;
      }).toBe(right ? 2_000_000 : 4_000_000);
    } finally {
      await app.close();
    }
  });
}

test("the blade mark carries its snap, sits on the time it cuts at and is solid over the cut clip only", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-blade-guide-"), name: "blade-guide", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
    const longId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0, durationUs: 5_000_000,
    });
    const boundaryId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 3_000_000, durationUs: 1_000_000,
    });
    const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
    if (await display.getAttribute("aria-pressed") === "true") await display.click();
    const long = page.locator(`.timeline-layer[data-layer-id="${longId}"]`);
    const boundary = page.locator(`.timeline-layer[data-layer-id="${boundaryId}"]`);
    await expect(long).toBeVisible();
    await expect(boundary).toBeVisible();
    const blade = page.locator('button[data-quick-action="toggleBladeMode"]');
    await blade.click();
    await expect(blade).toHaveAttribute("aria-checked", "true");
    const lb = await long.boundingBox();
    const bb = await boundary.boundingBox();
    if (!lb || !bb) throw new Error("missing blade fixture geometry");
    const mark = page.getByTestId("timeline-blade-mark");
    const hoverY = lb.y + lb.height / 2;
    const hoverX = bb.x - 5;
    await long.hover({ position: { x: hoverX - lb.x, y: lb.height / 2 } });
    await expect(mark).toHaveAttribute("data-snapped", "true");
    await expect(mark).toHaveAttribute("data-at-us", "3000000");
    // Blade mode draws no separate guide: the mark itself shows the snap.
    await expect(page.getByTestId("timeline-snap-guide")).toHaveCount(0);
    // One Time mark geometry: the cut's left edge is where the target clip
    // begins, and the line starts at the ruler's bottom edge.
    const snappedBox = await mark.boundingBox();
    const ruler = await page.getByTestId("timeline-ruler").boundingBox();
    if (!snappedBox || !ruler) throw new Error("missing blade mark geometry");
    expect(Math.abs(snappedBox.x - bb.x)).toBeLessThan(0.01);
    expect(Math.abs(snappedBox.y - (ruler.y + ruler.height))).toBeLessThan(0.01);
    const cut = page.getByTestId("timeline-blade-cut");
    await expect(cut).toHaveCount(1);
    await expect(cut).toHaveAttribute("data-layer-id", longId);

    await page.keyboard.down(MOD);
    await page.mouse.move(hoverX + 1, hoverY);
    await expect(mark).toHaveAttribute("data-snapped", "false");
    await page.keyboard.up(MOD);
    await page.mouse.move(hoverX, hoverY);
    await expect(mark).toHaveAttribute("data-snapped", "true");

    // A cut snapped to the playhead covers the playhead's pixels.
    await waitForHook(page, "transportSeekUs");
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(1_500_000));
    const playhead = await page.getByTestId("timeline-playhead").boundingBox();
    if (!playhead) throw new Error("missing playhead geometry");
    await page.mouse.move(playhead.x + 4, hoverY);
    await expect(mark).toHaveAttribute("data-at-us", "1500000");
    const atPlayhead = await mark.boundingBox();
    if (!atPlayhead) throw new Error("missing blade mark geometry");
    expect(Math.abs(atPlayhead.x - playhead.x)).toBeLessThan(0.01);
    expect(atPlayhead.width).toBe(playhead.width);

    await page.mouse.move(lb.x + lb.width + 30, hoverY);
    await expect(mark).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("marker drag shares the same feedback and Mod suspension as clip drags", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-marker-guide-"), name: "marker-guide", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
    const boundaryId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 3_000_000, durationUs: 1_000_000,
    });
    const markerId = await invokeCmd<string>(page, "add_marker", { tUs: 2_000_000, label: "Test marker" });
    const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
    if (await display.getAttribute("aria-pressed") === "true") await display.click();
    const marker = page.locator(`[data-testid="timeline-marker"][data-marker-id="${markerId}"]`);
    const clip = page.locator(`.timeline-layer[data-layer-id="${boundaryId}"]`);
    await expect(marker).toBeVisible();
    await expect(clip).toBeVisible();
    const mb = await marker.boundingBox();
    const cb = await clip.boundingBox();
    if (!mb || !cb) throw new Error("missing marker or target geometry");
    const x = mb.x + Math.min(mb.width / 2, 2), y = mb.y + mb.height / 2;
    const toX = x + cb.width * 0.95;
    const guide = page.getByTestId("timeline-snap-guide");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(toX, y, { steps: 5 });
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    // The guide reaches the marker it aligns, not only the clip lanes.
    const guideBox = await guide.boundingBox();
    if (!guideBox) throw new Error("missing guide geometry");
    expect(guideBox.y).toBeLessThanOrEqual(mb.y);
    expect(guideBox.y + guideBox.height).toBeGreaterThanOrEqual(cb.y + cb.height);
    await page.keyboard.down(MOD);
    await page.mouse.move(toX + 1, y);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up(MOD);
    await page.mouse.move(toX, y);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    await page.mouse.up();
    await expect(guide).toHaveCount(0);
    await expect.poll(async () => {
      const s = await rootSummary<{ markers: Array<{ id: string; t_us: number }> }>(page);
      return s.markers.find((marker) => marker.id === markerId)?.t_us ?? null;
    }).toBe(3_000_000);
  } finally {
    await app.close();
  }
});

// Modifier must be held BEFORE pointerdown: Ctrl+press on macOS opens the OS
// context menu, so a mid-drag-only test misses the regression from #156.
test("a clip drag with Mod held before press bypasses magnetic snap without opening a menu", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-prepress-drag-"), name: "prepress-drag", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
    const targetId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 3_000_000, durationUs: 1_000_000,
    });
    const movingId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0, durationUs: 1_000_000,
    });
    const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
    if (await display.getAttribute("aria-pressed") === "true") await display.click();
    const moving = page.locator(`.timeline-layer[data-layer-id="${movingId}"]`);
    const target = page.locator(`.timeline-layer[data-layer-id="${targetId}"]`);
    await expect(moving).toBeVisible();
    await expect(target).toBeVisible();
    const source = await moving.boundingBox();
    const dest = await target.boundingBox();
    if (!source || !dest) throw new Error("missing prepress clip geometry");
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    const toX = x + dest.x - (source.x + source.width) - 5;
    const guide = page.getByTestId("timeline-snap-guide");
    await page.mouse.move(x, y);
    await page.keyboard.down(MOD);
    try {
      await page.mouse.down();
      await page.mouse.move(toX, y, { steps: 5 });
      await expect(guide).toHaveCount(0);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.mouse.up();
    } finally {
      await page.keyboard.up(MOD);
    }
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    const summary = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }> }>(page);
    expect(summary.tracks.flatMap((t) => t.layers).find((layer) => layer.id === movingId)?.t_start_us).not.toBe(2_000_000);
  } finally {
    await app.close();
  }
});

test("a blade click with Mod held before press cuts on the frame grid and opens no context menu", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-prepress-blade-"), name: "prepress-blade", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
    const longId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0, durationUs: 5_000_000,
    });
    const boundaryId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 3_000_000, durationUs: 1_000_000,
    });
    const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
    if (await display.getAttribute("aria-pressed") === "true") await display.click();
    const long = page.locator(`.timeline-layer[data-layer-id="${longId}"]`);
    const boundary = page.locator(`.timeline-layer[data-layer-id="${boundaryId}"]`);
    await expect(long).toBeVisible();
    await expect(boundary).toBeVisible();
    const lb = await long.boundingBox();
    const bb = await boundary.boundingBox();
    if (!lb || !bb) throw new Error("missing prepress blade geometry");
    await page.locator('button[data-quick-action="toggleBladeMode"]').click();
    const x = bb.x - 5;
    const y = lb.y + lb.height / 2;
    const mark = page.getByTestId("timeline-blade-mark");
    await page.mouse.move(x, y);
    await expect(mark).toHaveAttribute("data-snapped", "true");
    await page.mouse.move(x - 40, y);
    await page.keyboard.down(MOD);
    try {
      await page.mouse.move(x, y);
      await expect(mark).toHaveAttribute("data-snapped", "false");
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.getByRole("menu")).toHaveCount(0);
    } finally {
      await page.keyboard.up(MOD);
    }
    await expect.poll(async () => {
      const s = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }> }>(page);
      return s.tracks.flatMap((t) => t.layers).length;
    }).toBeGreaterThan(2);
    const summary = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }> }>(page);
    const starts = summary.tracks.flatMap((t) => t.layers).map((layer) => layer.t_start_us);
    expect(starts.some((v) => v > 2_500_000 && v < 3_000_000)).toBe(true);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// This is intentional beyond #156's visual contract: a browser cancellation
// must abandon the gesture and clear its guide, never commit an abandoned drag.
for (const cancelWith of ["pointercancel", "Escape", "blade tool"] as const) {
  test(`${cancelWith} abandons an in-progress clip drag and clears the magnetic guide`, async () => {
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-timeline-snap-pointercancel-"),
        name: "snap-pointercancel",
        canvas,
      });
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
      await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
      const targetId = await invokeCmd<string>(page, "add_color_layer", {
        tStartUs: 3_000_000, durationUs: 1_000_000,
      });
      const movingId = await invokeCmd<string>(page, "add_color_layer", {
        tStartUs: 0, durationUs: 1_000_000,
      });
      const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
      if (await display.getAttribute("aria-pressed") === "true") await display.click();
      const sourceClip = page.locator(`.timeline-layer[data-layer-id="${movingId}"]`);
      const targetClip = page.locator(`.timeline-layer[data-layer-id="${targetId}"]`);
      await expect(sourceClip).toBeVisible();
      await expect(targetClip).toBeVisible();
      const source = await sourceClip.boundingBox();
      const target = await targetClip.boundingBox();
      if (!source || !target) throw new Error("timeline clips missing bounds");
      const fromX = source.x + source.width / 2;
      const fromY = source.y + source.height / 2;
      const toX = fromX + target.x - (source.x + source.width) - 5;
      const guide = page.getByTestId("timeline-snap-guide");
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(toX, fromY, { steps: 5 });
      await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
      switch (cancelWith) {
        case "pointercancel":
          await page.evaluate(() => window.dispatchEvent(
            new PointerEvent("pointercancel", { bubbles: true, pointerType: "mouse" }),
          ));
          break;
        case "Escape":
          await page.keyboard.press("Escape");
          break;
        case "blade tool":
          await page.keyboard.press("c");
          await expect(page.locator('button[data-quick-action="toggleBladeMode"]')).toHaveAttribute("aria-checked", "true");
          break;
      }
      await expect(guide).toHaveCount(0);
      await page.mouse.up();
      const summary = await rootSummary<{
        tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }>;
      }>(page);
      expect(summary.tracks.flatMap((track) => track.layers)
        .find((layer) => layer.id === movingId)?.t_start_us).toBe(0);
    } finally {
      await app.close();
    }
  });
}

for (const { fpsNum, fpsDen } of [canvas, { fpsNum: 30_000, fpsDen: 1001 }]) {
  const alignments = fpsDen === 1 ? ["aligned", "adjacent-frame"] : ["aligned", "adjacent-frame", "sample-grid"];
  for (const alignment of alignments) {
    const aligned = alignment !== "adjacent-frame";
    test(`reversing a track-only drag at ${fpsNum}/${fpsDen} fps (${alignment} edge)`, async () => {
      const { app, page } = await launchApp();
      try {
        await newProject(page, {
          parentFolder: tmpDir("weftcut-timeline-vertical-guide-"),
          name: "vertical-guide",
          canvas: { ...canvas, fpsNum, fpsDen },
        });
        await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
        await invokeCmd(page, "app_settings_set", {
          patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 },
        });
        const targetTrackId = await invokeCmd<string>(page, "add_track", {});
        const movingTrackId = await invokeCmd<string>(page, "add_track", {});
        // Keep the source lane available after the first move empties it.
        await invokeCmd(page, "add_color_layer", {
          trackId: movingTrackId, tStartUs: 4_000_000, durationUs: 1_000_000,
        });
        const frameUs = (index: number) => Math.round(index * 1_000_000 * fpsDen / fpsNum);
        const boundaryUs = frameUs(aligned ? 61 : 62);
        const targetId = alignment === "sample-grid"
          ? await invokeCmd<string>(page, "add_media_layer", {
              trackId: targetTrackId, tStartUs: boundaryUs,
              mediaId: await invokeCmd<string>(page, "import_media", {
                path: fileURLToPath(new URL("../fixtures/media/test_tones_10s.wav", import.meta.url)),
              }),
            })
          : await invokeCmd<string>(page, "add_color_layer", {
              trackId: targetTrackId, tStartUs: boundaryUs, durationUs: 1_000_000,
            });
        if (alignment === "sample-grid") {
          const summary = await rootSummary<{
            tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }>;
          }>(page);
          const audio = summary.tracks.flatMap((track) => track.layers).find((layer) => layer.id === targetId);
          expect(audio?.t_start_us).toBeDefined();
          expect(audio?.t_start_us).not.toBe(boundaryUs);
        }
        const startUs = frameUs(15);
        const endUs = frameUs(61);
        const movingId = await invokeCmd<string>(page, "add_color_layer", {
          trackId: movingTrackId, tStartUs: startUs, durationUs: endUs - startUs,
        });
        const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
        if (await display.getAttribute("aria-pressed") === "true") await display.click();
        const moving = page.locator(`.timeline-layer[data-layer-id="${movingId}"]`);
        const target = page.locator(`.timeline-layer[data-layer-id="${targetId}"]`);
        await expect(moving).toBeVisible();
        await expect(target).toBeVisible();
        const box = await moving.boundingBox();
        if (!box) throw new Error("missing moving clip geometry");
        const x = box.x + box.width / 2;
        const lane = (id: string) => page.locator(`[data-testid="track-lane"][data-track-id="${id}"]`);
        const centerY = async (id: string) => {
          const rect = await lane(id).boundingBox();
          if (!rect) throw new Error("missing destination lane");
          return rect.y + rect.height / 2;
        };
        const guide = page.getByTestId("timeline-snap-guide");
        const assertFeedback = async () => {
          if (aligned) await expect(guide).toHaveAttribute("data-snap-boundary-us", String(boundaryUs));
          else await expect(guide).toHaveCount(0);
        };
        for (const [from, to] of [[movingTrackId, targetTrackId], [targetTrackId, movingTrackId]]) {
          const fromY = await centerY(from);
          const toY = await centerY(to);
          await moving.click({ position: { x: box.width / 2, y: box.height / 2 } });
          await page.mouse.move(x, fromY);
          await page.mouse.down();
          await page.mouse.move(x, toY, { steps: 6 });
          await expect(lane(to).locator(moving)).toBeVisible();
          await assertFeedback();
          // Back over its own lane the clip is home with its time unchanged: its
          // edges sit on the same target as over the other lane, or on none.
          await page.mouse.move(x, fromY, { steps: 6 });
          await assertFeedback();
          await page.mouse.move(x, toY, { steps: 6 });
          await assertFeedback();
          await page.mouse.up();
          await expect(guide).toHaveCount(0);

          await expect.poll(async () => {
            const summary = await rootSummary<{
              tracks: Array<{ id: string; layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }>;
            }>(page);
            const track = summary.tracks.find((item) => item.layers.some((layer) => layer.id === movingId));
            const layer = track?.layers.find((item) => item.id === movingId);
            return { trackId: track?.id, start: layer?.t_start_us, end: layer?.t_end_us };
          }).toEqual({ trackId: to, start: startUs, end: endUs });
        }
      } finally {
        await app.close();
      }
    });
  }
}
