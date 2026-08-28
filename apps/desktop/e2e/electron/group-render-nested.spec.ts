import { expect, test, type Page } from "@playwright/test";
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from "./helpers/driver";

/**
 * A Group renders as one picture composited from its own timeline (ADR 0052 §
 * Rendering): a `CompositionNode` per Group LAYER draws that composition into a
 * `RenderTexture`, and the parent stages the texture like any other visual.
 * Three things follow that nothing flatter can express, and all three are read
 * off the LIVE Pixi canvas here rather than from the project:
 *
 *   1. Two placements of ONE composition are two nodes. At a single playhead
 *      they are looking at different frames of the same content, so the pixels
 *      differ — which is the whole reason a node is per layer and not per
 *      composition.
 *   2. Nesting composes the transforms. A half-scale Group inside a half-scale
 *      Group puts its content at a QUARTER size; applying only the outer one
 *      would fill twice the area, so the empty half is the assertion.
 *   3. The preview follows the OPEN composition. Opening the Group draws it at
 *      its own frame size, unscaled — `w`/`h` on the sample is the renderer's
 *      logical size, so it says which composition is on screen. Export is
 *      unaffected and always renders the root.
 *
 * The fixture is built through the same commands the UI issues, so no media and
 * no on-disk project are needed: two full-frame Color layers cut at 1 s, then
 * `groups_create` over both. RED before the cut, GREEN after — so a sample's
 * colour names WHICH FRAME of the Group's timeline reached that pixel.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const RED = { r: 255, g: 0, b: 0, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const CUT_US = 1_000_000;

interface Sample {
  r: number;
  g: number;
  b: number;
  a: number;
  w: number;
  h: number;
}

interface Wire {
  root_id: string;
  compositions: Record<
    string,
    {
      id: string;
      width: number;
      height: number;
      tracks: Array<{ id: string; layers: Array<{ id: string }> }>;
    }
  >;
}

const wire = (page: Page) => invokeCmd<Wire>(page, "project_summary", {});

/// One pixel of the LIVE composite, in composition pixels.
const sample = (page: Page, x: number, y: number): Promise<Sample> =>
  page.evaluate(
    (p) => (window as any).__weftcutTest.weftcutSampleComposite(p.x, p.y),
    { x, y },
  );

/// The global transport, which is what the UI's own seeks go through
/// (`state/playbackStore.ts`) — and it emits the time, so the playhead store
/// below is a real settle signal.
const seek = (page: Page, us: number): Promise<void> =>
  page.evaluate((t) => (window as any).__weftcutTest.transportSeekUs(t), us);

const playheadUs = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs());

const openComposition = (page: Page): Promise<{ id: string } | null> =>
  page.evaluate(() => (window as any).__weftcutTest.getOpenComposition());

/// Park the playhead on `us` and wait for the store to agree — every sample
/// below re-composites at the engine's position, so the position has to have
/// landed before the pixels mean anything.
async function seekAndSettle(page: Page, us: number): Promise<void> {
  await seek(page, us);
  await expect.poll(() => playheadUs(page)).toBe(us);
}

/// Static scalar tracks for one layer's transform — the same channels every
/// visual kind carries, a Group layer included.
async function setTransform(
  page: Page,
  layerId: string,
  t: { x: number; y: number; scale: number },
): Promise<void> {
  const entries: Array<[string, number]> = [
    ["x", t.x],
    ["y", t.y],
    ["scale_x", t.scale],
    ["scale_y", t.scale],
  ];
  for (const [paramKey, value] of entries) {
    await invokeCmd(page, "update_layer_param_track", {
      layerId,
      paramKey,
      track: { mode: "Static", value },
    });
  }
}

/// Assert a pixel is the given full-strength primary. Dominance rather than
/// equality: the sample rides the renderer's own 8-bit round trip, and what is
/// under test is WHICH layer painted the pixel, not the channel arithmetic.
function expectPrimary(px: Sample, which: "red" | "green", where: string): void {
  expect(px.a, `${where}: opaque`).toBeGreaterThan(200);
  if (which === "red") {
    expect(px.r, `${where}: red`).toBeGreaterThan(200);
    expect(px.g, `${where}: not green`).toBeLessThan(80);
  } else {
    expect(px.g, `${where}: green`).toBeGreaterThan(200);
    expect(px.r, `${where}: not red`).toBeLessThan(80);
  }
}

/// Nothing painted here. `extract` renders the stage into a fresh transparent
/// target, so an uncovered pixel comes back with alpha 0 — the app's opaque
/// black window background is never in the buffer.
function expectEmpty(px: Sample, where: string): void {
  expect(px.a, `${where}: uncovered`).toBeLessThan(16);
}

test("a Group composites its own timeline: twice over, nested, and as the open composition", async () => {
  test.setTimeout(240_000);
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-group-render-"),
      name: "e2e-group-render-" + Date.now(),
      canvas: CANVAS,
    });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
    await waitForHook(page, "weftcutSampleComposite");
    await waitForHook(page, "transportSeekUs");
    await waitForHook(page, "setOpenComposition");
    await waitForHook(page, "getOpenComposition");

    const rootId = (await wire(page)).root_id;

    // ── Fixture: RED then GREEN, pre-composed into one Group ───────────────
    const redId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0,
      durationUs: CUT_US,
      color: RED,
      compositionId: rootId,
    });
    const greenId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: CUT_US,
      durationUs: CUT_US,
      color: GREEN,
      compositionId: rootId,
    });
    const group = await invokeCmd<{ composition_id: string; layer_id: string }>(
      page,
      "groups_create",
      { layerIds: [redId, greenId] },
    );
    const groupId = group.composition_id;
    // Pre-compose re-bases its members to the selection's start, so the Group's
    // own timeline is RED [0, 1 s) then GREEN [1 s, 2 s) and the Group layer
    // spans [0, 2 s) on the root reading it from 0.
    const afterGroup = await wire(page);
    expect(Object.keys(afterGroup.compositions)).toHaveLength(2);
    expect(afterGroup.compositions[groupId]!.width).toBe(CANVAS.width);

    // ── 1. The same Group placed twice, at one playhead ────────────────────
    // A stays at 0; B is a second placement one second later, on a lane of its
    // own so both are live at once. Quarter-frame transforms keep them from
    // occluding each other — z-order would otherwise hide the answer.
    const laneB = await invokeCmd<string>(page, "add_track", { compositionId: rootId });
    const pasted = await invokeCmd<{ clones: Array<{ source: string; clone: string }> }>(
      page,
      "paste_layers",
      { layerIds: [group.layer_id], tStartUs: CUT_US, targetTrackId: laneB },
    );
    const layerA = group.layer_id;
    const layerB = pasted.clones[0]!.clone;
    await setTransform(page, layerA, { x: 0, y: 0, scale: 0.5 });
    await setTransform(page, layerB, { x: CANVAS.width / 2, y: CANVAS.height / 2, scale: 0.5 });

    // At 1.2 s: A is 1.2 s into the Group (GREEN), B only 0.2 s in (RED). One
    // playhead, one composition, two frames of it on screen.
    await seekAndSettle(page, 1_200_000);
    await expect
      .poll(async () => (await sample(page, 80, 45)).g, { timeout: 20_000 })
      .toBeGreaterThan(200);
    expectPrimary(await sample(page, 80, 45), "green", "placement A (top-left)");
    expectPrimary(
      await sample(page, CANVAS.width - 80, CANVAS.height - 45),
      "red",
      "placement B (bottom-right)",
    );

    // Past A's own end the top-left quadrant goes empty while B, still a second
    // behind, has only just crossed the Group's cut — the two placements run on
    // independent clocks, and B's own picture advanced RED → GREEN.
    await seekAndSettle(page, 2_500_000);
    expectEmpty(await sample(page, 80, 45), "placement A past its own end");
    expectPrimary(
      await sample(page, CANVAS.width - 80, CANVAS.height - 45),
      "green",
      "placement B past the Group's cut",
    );

    // ── 2. Nested two deep, a transform on each level ──────────────────────
    // Pre-composing placement A alone wraps it in a second Group; A keeps its
    // half-scale inside, and the wrapper takes another half. Composed, the
    // content lands in a QUARTER-frame box.
    const nest = await invokeCmd<{ composition_id: string; layer_id: string }>(
      page,
      "groups_create",
      { layerIds: [layerA] },
    );
    expect(Object.keys((await wire(page)).compositions)).toHaveLength(3);
    await setTransform(page, nest.layer_id, { x: 0, y: 0, scale: 0.5 });

    await seekAndSettle(page, 1_200_000);
    const quarterW = CANVAS.width / 4;
    const quarterH = CANVAS.height / 4;
    await expect
      .poll(async () => (await sample(page, quarterW / 2, quarterH / 2)).g, { timeout: 20_000 })
      .toBeGreaterThan(200);
    expectPrimary(
      await sample(page, quarterW / 2, quarterH / 2),
      "green",
      "nested content inside the quarter box",
    );
    // Halfway out: inside where ONE half-scale would have drawn, outside where
    // two do. This pixel is what tells the two apart.
    expectEmpty(
      await sample(page, quarterW + 20, quarterH + 20),
      "past the quarter box, where a single transform would still paint",
    );

    // ── 3. Opening the Group draws it at its own size ──────────────────────
    // Give the Group a frame of its own first: `w`/`h` on the sample is the
    // renderer's logical size, so it names the composition on screen.
    const GROUP_W = 480;
    const GROUP_H = 270;
    await invokeCmd(page, "set_composition", {
      compositionId: groupId,
      patch: { width: GROUP_W, height: GROUP_H },
    });
    expect(
      await page.evaluate((id) => (window as any).__weftcutTest.setOpenComposition(id), groupId),
    ).toBe(true);
    await expect.poll(() => openComposition(page)).toMatchObject({ id: groupId });
    // The switch restarts the Group at its own 0 (compositionScopeStore).
    await expect.poll(() => playheadUs(page)).toBe(0);

    await expect
      .poll(async () => (await sample(page, GROUP_W / 2, GROUP_H / 2)).w, { timeout: 20_000 })
      .toBe(GROUP_W);
    const opened = await sample(page, GROUP_W / 2, GROUP_H / 2);
    expect(opened.h).toBe(GROUP_H);
    expectPrimary(opened, "red", "the open Group at its own frame 0");
    // Unscaled: the content reaches the far corner of the Group's own frame,
    // where the placed picture on the root covered a quarter box.
    expectPrimary(
      await sample(page, GROUP_W - 4, GROUP_H - 4),
      "red",
      "the open Group's far corner",
    );

    // Its own clock, too: past the Group's cut the frame is GREEN.
    await seekAndSettle(page, 1_200_000);
    await expect
      .poll(async () => (await sample(page, GROUP_W / 2, GROUP_H / 2)).g, { timeout: 20_000 })
      .toBeGreaterThan(200);
    expectPrimary(
      await sample(page, GROUP_W / 2, GROUP_H / 2),
      "green",
      "the open Group past its cut",
    );

    // ── Back to the root: its frame, and the placements again ─────────────
    expect(
      await page.evaluate((id) => (window as any).__weftcutTest.setOpenComposition(id), rootId),
    ).toBe(true);
    await expect.poll(() => openComposition(page)).toMatchObject({ id: rootId });
    await expect
      .poll(async () => (await sample(page, 8, 8)).w, { timeout: 20_000 })
      .toBe(CANVAS.width);
    expect((await sample(page, 8, 8)).h).toBe(CANVAS.height);
  } finally {
    await app.close();
  }
});
