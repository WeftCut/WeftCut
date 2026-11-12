import { expect, test } from "@playwright/test";
import {
  invokeCmd,
  launchApp,
  newProject,
  rootSummary,
  tmpDir,
} from "./helpers/driver";

const canvas = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };

test("the timeline magnet stays a one-click toggle and its chevron owns settings", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-timeline-magnet-"), name: "magnet", canvas });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    const magnet = page.locator('button[data-quick-action="toggleTailSnap"]');
    const options = page.locator('button[data-quick-action="timelineSnapOptions"]');
    await expect(magnet).toBeVisible();
    await expect(options).toBeVisible();
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "false");
    // The chevron opens a different interaction; it does not toggle magnetism.
    await options.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "false");
    const dialog = page.getByRole("dialog", { name: "Timeline snapping options" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Hold Ctrl during a drag", { exact: false })).toBeVisible();
    const enabled = dialog.getByRole("switch", { name: "Clip snapping" });
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await enabled.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    const strength = dialog.getByLabel("Snap strength", { exact: true });
    await strength.fill("28");
    await strength.press("Enter");
    await expect.poll(async () => {
      const settings = await invokeCmd<{ tail_snap_strength_px: number }>(page, "app_settings_get");
      return settings.tail_snap_strength_px;
    }).toBe(28);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await app.close();
  }
});

test("a clip drag paints its chosen boundary, Ctrl suspends it, and release clears it", async () => {
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

    await page.keyboard.down("Control");
    await page.mouse.move(toX + 1, fromY);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up("Control");
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

test("blade hover shows a magnetic cut target and Ctrl keeps the frame-grid cut free", async () => {
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
    await page.keyboard.down("Control");
    await page.mouse.move(hoverX + 1, hoverY);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up("Control");
    await page.mouse.move(hoverX, hoverY);
    await expect(guide).toHaveAttribute("data-snap-boundary-us", "3000000");
    // A cut's preview is not a persistent timeline guide.
    await page.mouse.move(lb.x + lb.width + 30, hoverY);
    await expect(guide).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("marker drag shares the same feedback and Ctrl suspension as clip drags", async () => {
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
    await page.keyboard.down("Control");
    await page.mouse.move(toX + 1, y);
    await expect(guide).toHaveCount(0);
    await page.keyboard.up("Control");
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
