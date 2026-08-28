import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

/**
 * A Group on the timeline: the clip, the two keys, the breadcrumb (spec § Group
 * semantics / § Navigation and scope, ADR 0052).
 *
 * Driven entirely through the real UI — pointer, `Ctrl+G`, `Ctrl+Shift+G`,
 * `Ctrl+Z` — with the state read back off the live `project_summary`, so no id
 * is hard-coded and nothing asserts on a renderer mirror. The one exception is
 * the opacity that blocks Ungroup: setting it is a one-field patch with no
 * gesture worth walking, and the assertion is about the BUTTON it greys out.
 *
 * `test_1080p_30fps_audio.mp4` is the AV source `add_media_layer` auto-pairs
 * into a linked video + Audio layer on one lane, which is the cheapest way to
 * mint the "select an A/V pair" the acceptance starts from.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  "../fixtures/media/test_1080p_30fps_audio.mp4",
);
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
/// The suite's spelling of the catalogue's `Mod` token (search-palette.spec.ts).
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const PROJECT_NAME = "e2e-group-timeline";

/// Only the fields this spec reads, spelled out rather than intersected onto the
/// driver's loose `CompositionSummary`.
interface WireLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  params: {
    kind: string;
    composition_id?: string;
    src_in_us?: number;
    src_out_us?: number;
  };
}
interface WireComposition {
  id: string;
  label: string | null;
  duration_us: number;
  tracks: Array<{ id: string; role?: string | null; layers: WireLayer[] }>;
}
interface Wire {
  root_id: string;
  compositions: Record<string, WireComposition>;
}

const wire = (page: Page) => invokeCmd<Wire>(page, "project_summary", {});

const rootOf = (s: Wire) => {
  const root = s.compositions[s.root_id];
  if (!root) throw new Error("summary carries no root composition");
  return root;
};

/// Every composition that is not the root, by id.
const groupIdsOf = (s: Wire): string[] =>
  Object.keys(s.compositions).filter((id) => id !== s.root_id);

const layersOf = (c: WireComposition): WireLayer[] =>
  c.tracks.flatMap((t) => t.layers);

const trackHolding = (c: WireComposition, layerId: string): string | null =>
  c.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null;

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  await waitForHook(page, "getSelectedLayerIds");
  const ids = (await page.evaluate(() =>
    (window as any).__weftcutTest.getSelectedLayerIds(),
  )) as string[];
  return ids.slice().sort();
};

const openComposition = (page: Page): Promise<{ id: string } | null> =>
  page.evaluate(() => (window as any).__weftcutTest.getOpenComposition());

const crumbs = (page: Page): Promise<string[]> =>
  page
    .locator('[data-testid="timeline-crumb"]')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));

// Raw pointer at the centre rather than `locator.click()`: that scrolls the
// target into view first, and a clip at t = 0 sits at the scroll origin, where
// the scroll can slide it under the sticky header column.
const clickCentre = async (page: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

const doubleClickCentre = async (page: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
};

/// Drag a clip's OUT edge by `dxPx`. The grab point is 2 px inside the right
/// edge — inside `LayerBlock`'s 6 px trim zone, and inside the clip, so the
/// press lands on the block rather than on the lane behind it.
const dragOutEdge = async (page: Page, target: Locator, dxPx: number) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  const y = box.y + box.height / 2;
  const x = box.x + box.width - 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dxPx, y, { steps: 8 });
  await page.mouse.up();
};

test.describe("Group on the timeline", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("Ctrl+G pre-composes a pair, the clip enters, Ctrl+Shift+G puts it back", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-group-"),
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const s0 = await wire(page);
      const aRoll = rootOf(s0).tracks.find((t) => t.role === "a-roll");
      expect(aRoll, "the blank skeleton carries an A roll").toBeTruthy();
      const videoLayerId = await invokeCmd<string>(page, "add_media_layer", {
        trackId: aRoll!.id,
        mediaId,
        tStartUs: 0,
      });
      const s1 = await wire(page);
      const audioLayerId = layersOf(rootOf(s1)).find(
        (l) => l.params.kind === "Audio",
      )?.id;
      expect(audioLayerId, "the AV source should have auto-paired an Audio layer").toBeTruthy();
      const pair = [videoLayerId, audioLayerId!].sort();
      const pairTrackId = trackHolding(rootOf(s1), videoLayerId);
      const clipSpanUs =
        layersOf(rootOf(s1)).find((l) => l.id === videoLayerId)!.t_end_us;

      // ── Ctrl+G: one Group clip replaces the pair ─────────────────────────
      // The click selects the whole link (both members) AND lands focus on the
      // timeline, which the timeline-scoped chord needs.
      const videoClip = page.locator(`.timeline-layer[data-layer-id="${videoLayerId}"]`);
      await expect(videoClip).toBeVisible();
      await clickCentre(page, videoClip);
      expect(await selectedLayerIds(page)).toEqual(pair);

      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);

      const s2 = await wire(page);
      const groupId = groupIdsOf(s2)[0]!;
      const rootLayers = layersOf(rootOf(s2));
      expect(rootLayers).toHaveLength(1);
      const groupLayer = rootLayers[0]!;
      expect(groupLayer.params.kind).toBe("CompositionRef");
      expect(groupLayer.params.composition_id).toBe(groupId);
      // On the pair's own lane, windowed over the whole composition.
      expect(trackHolding(rootOf(s2), groupLayer.id)).toBe(pairTrackId);
      expect(groupLayer.params.src_in_us).toBe(0);
      expect(groupLayer.params.src_out_us).toBe(s2.compositions[groupId]!.duration_us);
      // The pair moved INTO the composition, keeping their span.
      expect(layersOf(s2.compositions[groupId]!).map((l) => l.id).sort()).toEqual(pair);
      expect(s2.compositions[groupId]!.duration_us).toBe(clipSpanUs);

      // The clip names itself after the composition: unnamed ⇒ derived `Group 1`.
      const groupClip = page.locator(`.timeline-layer[data-layer-id="${groupLayer.id}"]`);
      await expect(groupClip).toBeVisible();
      await expect(groupClip).toContainText("Group 1");
      // No hatch and no tick: the window is exactly the composition.
      await expect(groupClip.locator('[data-testid="layer-overhang-tail"]')).toHaveCount(0);
      await expect(groupClip.locator('[data-testid="layer-source-tail-tick"]')).toHaveCount(0);

      // ── Double-click enters; the breadcrumb reads the path ───────────────
      // Hidden at the root, so its appearance is itself the signal.
      await expect(page.locator('[data-testid="timeline-breadcrumb"]')).toHaveCount(0);
      await doubleClickCentre(page, groupClip);
      await expect.poll(() => openComposition(page)).toMatchObject({ id: groupId });
      await expect.poll(() => crumbs(page)).toEqual([PROJECT_NAME, "Group 1"]);

      // ── Ctrl+Z from inside: back to the root, with the pair selected ─────
      // Undoing the pre-compose destroys the open composition, so the scope
      // store falls back — and the selection the switch cleared is put back,
      // because the layers the user asked for are the ones they had.
      await page.keyboard.press(`${MOD}+Z`);
      await expect.poll(() => openComposition(page)).toMatchObject({ id: s2.root_id });
      await expect.poll(() => crumbs(page)).toEqual([]);
      await expect.poll(() => selectedLayerIds(page)).toEqual(pair);
      expect(groupIdsOf(await wire(page))).toHaveLength(0);

      // ── Ctrl+Shift+G on the plain Group restores the pair ────────────────
      // Re-group first: the selection is already the pair, but the chord needs
      // the timeline focused and the undo left focus wherever it was.
      await clickCentre(page, page.locator(`.timeline-layer[data-layer-id="${videoLayerId}"]`));
      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);
      const s3 = await wire(page);
      const regroupedId = layersOf(rootOf(s3))[0]!.id;
      // Pre-compose leaves the new Group layer selected, which is what makes the
      // inverse chord reachable without re-picking the clip.
      expect(await selectedLayerIds(page)).toEqual([regroupedId]);

      await page.keyboard.press(`${MOD}+Shift+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(0);
      const s4 = await wire(page);
      const restored = layersOf(rootOf(s4));
      expect(restored).toHaveLength(2);
      expect(restored.map((l) => l.params.kind).sort()).toEqual(["Audio", "VideoClip"]);
      expect(restored.every((l) => l.t_start_us === 0)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("opacity greys Ungroup out with the reason; the window clamps to the composition and hatches past it", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-group-tail-"),
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const s0 = await wire(page);
      const aRoll = rootOf(s0).tracks.find((t) => t.role === "a-roll");
      const videoLayerId = await invokeCmd<string>(page, "add_media_layer", {
        trackId: aRoll!.id,
        mediaId,
        tStartUs: 0,
      });

      const videoClip = page.locator(`.timeline-layer[data-layer-id="${videoLayerId}"]`);
      await expect(videoClip).toBeVisible();
      await clickCentre(page, videoClip);
      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);

      const s1 = await wire(page);
      const groupId = groupIdsOf(s1)[0]!;
      const groupLayer = layersOf(rootOf(s1))[0]!;
      const compDurationUs = s1.compositions[groupId]!.duration_us;
      const groupClip = page.locator(`.timeline-layer[data-layer-id="${groupLayer.id}"]`);
      const ungroupButton = page.locator('[data-quick-action="ungroupSelected"]');

      // ── A plain Group offers Ungroup ─────────────────────────────────────
      await expect(ungroupButton).toBeEnabled();

      // ── Opacity 0.5 greys it out, and the tooltip names the field ───────
      await invokeCmd(page, "update_layer_params", {
        layerId: groupLayer.id,
        patch: { kind: "CompositionRef", opacity: 0.5 },
      });
      await expect(ungroupButton).toBeDisabled();
      await expect(ungroupButton).toHaveAttribute("aria-label", /opacity/i);
      // Back to 1 and the command returns — the gate reads the live layer, not a
      // decision cached when the clip was selected.
      await invokeCmd(page, "update_layer_params", {
        layerId: groupLayer.id,
        patch: { kind: "CompositionRef", opacity: 1 },
      });
      await expect(ungroupButton).toBeEnabled();

      // ── Trim the out edge IN: content is left over, so the tick appears ──
      await dragOutEdge(page, groupClip, -120);
      await expect
        .poll(async () => layersOf(rootOf(await wire(page)))[0]!.params.src_out_us!, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBeLessThan(compDurationUs);
      await expect(groupClip.locator('[data-testid="layer-source-tail-tick"]')).toHaveCount(1);

      // ── Drag it back out past the composition: it stops AT the duration ──
      await dragOutEdge(page, groupClip, 600);
      await expect
        .poll(async () => layersOf(rootOf(await wire(page)))[0]!.params.src_out_us!, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(compDurationUs);
      await expect(groupClip.locator('[data-testid="layer-overhang-tail"]')).toHaveCount(0);
      await expect(groupClip.locator('[data-testid="layer-source-tail-tick"]')).toHaveCount(0);

      // ── Shrink the composition from inside: the clip hatches its tail ────
      // Trimming the inner video's out edge fans out across the pair's link, so
      // one call shortens both members and the composition's autofit follows.
      // Nothing is refused: overhang is legal in state (ADR 0052 §6) — that rule
      // exists precisely so an edit INSIDE a Group is never blocked by a
      // parent's window.
      const innerVideoId = layersOf(s1.compositions[groupId]!).find(
        (l) => l.params.kind === "VideoClip",
      )!.id;
      await invokeCmd(page, "trim_layer", {
        layerId: innerVideoId,
        edge: "out",
        newTUs: Math.floor(compDurationUs / 2),
        escapeLink: false,
      });
      await expect
        .poll(async () => (await wire(page)).compositions[groupId]!.duration_us)
        .toBeLessThan(compDurationUs);
      await expect(groupClip.locator('[data-testid="layer-overhang-tail"]')).toHaveCount(1);
      // The clip itself did not move: autofit is per composition, and a Group
      // layer's window is independent of what its composition does.
      const s2 = await wire(page);
      expect(layersOf(rootOf(s2))[0]!.t_start_us).toBe(groupLayer.t_start_us);
    } finally {
      await app.close();
    }
  });
});
