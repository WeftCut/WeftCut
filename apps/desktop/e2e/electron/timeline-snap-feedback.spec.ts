import { expect, test } from "@playwright/test";
import {
  invokeCmd,
  launchApp,
  newProject,
  rootSummary,
  tmpDir,
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

test("a clip drag paints its chosen boundary, Mod suspends it, and release clears it", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-snap-guide-"), name: "guide", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", { patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 } });
    // Ordinary color clips have no proxy jobs; the drag can be inspected while live.
    const target = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 3_000_000, durationUs: 1_000_000,
    });
    const moving = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0, durationUs: 1_000_000,
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
    // Move the source's END to within five screen pixels of the target's START.
    // We assert the chosen boundary, not any assumed timeline zoom or pixel gap.
    const toX = fromX + dest.x - (source.x + source.width) - 5;
    const guide = page.getByTestId("timeline-snap-guide");
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, fromY, { steps: 5 });
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");

    await page.keyboard.down(MOD);
    await page.mouse.move(toX + 1, fromY);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up(MOD);
    await page.mouse.move(toX, fromY);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    await page.mouse.up();
    await expect(guide).toHaveCount(0);

    await expect.poll(async () => {
      const s = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }> }>(page);
      return s.tracks.flatMap((t) => t.layers).find((layer) => layer.id === moving)?.t_start_us ?? null;
    }).toBe(2_000_000);
  } finally {
    await app.close();
  }
});

test("blade hover shows a magnetic cut target and Mod keeps the frame-grid cut free", async () => {
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
    const lb = await long.boundingBox();
    const bb = await boundary.boundingBox();
    if (!lb || !bb) throw new Error("missing blade fixture geometry");
    await page.locator('button[data-quick-action="toggleBladeMode"]').click();
    const guide = page.getByTestId("timeline-snap-guide");
    const hoverY = lb.y + lb.height / 2;
    const hoverX = bb.x - 5;
    await page.mouse.move(hoverX, hoverY);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    await page.keyboard.down(MOD);
    await page.mouse.move(hoverX + 1, hoverY);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up(MOD);
    await page.mouse.move(hoverX, hoverY);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    // A cut's preview is not a persistent timeline guide.
    await page.mouse.move(lb.x + lb.width + 30, hoverY);
    await expect(guide).toHaveCount(0);
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
    const guide = page.getByTestId("timeline-snap-guide");
    await page.mouse.move(x, y);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    await page.mouse.move(x - 40, y);
    await page.keyboard.down(MOD);
    try {
      await page.mouse.move(x, y);
      await expect(guide).toHaveCount(0);
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
test("pointercancel abandons an in-progress clip drag and clears the magnetic guide", async () => {
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
    await page.evaluate(() => window.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerType: "mouse" }),
    ));
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

// Regresses a vertical-only move: an existing edge alignment is still a
// meaningful magnetic target even though the clip must not shift in time.
test("moving a clip straight onto another track shows an already-aligned snap target", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-timeline-vertical-guide-"),
      name: "vertical-guide", canvas,
    });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await invokeCmd(page, "app_settings_set", {
      patch: { tail_snap_enabled: true, tail_snap_strength_px: 30 },
    });
    const targetTrackId = await invokeCmd<string>(page, "add_track", {});
    const movingTrackId = await invokeCmd<string>(page, "add_track", {});
    const targetId = await invokeCmd<string>(page, "add_color_layer", {
      trackId: targetTrackId, tStartUs: 2_000_000, durationUs: 1_000_000,
    });
    const movingId = await invokeCmd<string>(page, "add_color_layer", {
      trackId: movingTrackId, tStartUs: 0, durationUs: 2_000_000,
    });
    const display = page.locator('button[data-quick-action="toggleDisplayMode"]');
    if (await display.getAttribute("aria-pressed") === "true") await display.click();
    const source = page.locator(`.timeline-layer[data-layer-id="${movingId}"]`);
    const target = page.locator(`.timeline-layer[data-layer-id="${targetId}"]`);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const sb = await source.boundingBox(), tb = await target.boundingBox();
    if (!sb || !tb) throw new Error("missing source or target lane");
    const x = sb.x + sb.width / 2;
    const y = sb.y + sb.height / 2;
    const toY = tb.y + tb.height / 2;
    const guide = page.getByTestId("timeline-snap-guide");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, toY, { steps: 6 });
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "2000000");

    await page.keyboard.down(MOD);
    await page.mouse.move(x, toY + 1);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up(MOD);
    await page.mouse.move(x, toY);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "2000000");

    await page.mouse.up();
    await expect(guide).toHaveCount(0);
    await expect.poll(async () => {
      const summary = await rootSummary<{
        tracks: Array<{ id: string; layers: Array<{ id: string; t_start_us: number }> }>;
      }>(page);
      const track = summary.tracks.find((item) => item.layers.some((layer) => layer.id === movingId));
      const layer = track?.layers.find((item) => item.id === movingId);
      return { trackId: track?.id, timeUs: layer?.t_start_us };
    }).toEqual({ trackId: targetTrackId, timeUs: 0 });
  } finally {
    await app.close();
  }
});
