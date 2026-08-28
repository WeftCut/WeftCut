import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from "./helpers/driver";

/**
 * Groups in the media pool: the reuse surface, and the orphan's home
 * (spec § Group semantics; ADR 0052, and the failure ADR 0042 refused for
 * tracks — state holding an entity no surface can remove).
 *
 * Driven through the real UI: pre-compose with `Ctrl+G`, place a second instance
 * by dragging the pool row onto a lane, delete the clips, delete the composition
 * from the row's own menu. State is read back off the live `project_summary`, so
 * no id is hard-coded and nothing asserts on a renderer mirror.
 *
 * `test_1080p_30fps_audio.mp4` is the AV source `add_media_layer` auto-pairs
 * into a linked video + Audio layer on one lane — the cheapest "select an A/V
 * pair" the acceptance starts from.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  "../fixtures/media/test_1080p_30fps_audio.mp4",
);
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const PROJECT_NAME = "e2e-group-media-pool";

interface WireLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  params: { kind: string; composition_id?: string };
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

const rootOf = (s: Wire): WireComposition => {
  const root = s.compositions[s.root_id];
  if (!root) throw new Error("summary carries no root composition");
  return root;
};
const groupIdsOf = (s: Wire): string[] =>
  Object.keys(s.compositions).filter((id) => id !== s.root_id);
const layersOf = (c: WireComposition): WireLayer[] =>
  c.tracks.flatMap((t) => t.layers);
const groupClipsOf = (c: WireComposition): WireLayer[] =>
  layersOf(c).filter((l) => l.params.kind === "CompositionRef");
const trackWithRole = (c: WireComposition, role: string): string => {
  const t = c.tracks.find((x) => x.role === role);
  if (!t) throw new Error(`composition ${c.id} has no ${role} track`);
  return t.id;
};

const poolRow = (page: Page, compositionId: string): Locator =>
  page.locator(`[data-composition-id="${compositionId}"]`);

// Raw pointer at the centre rather than `locator.click()`: that scrolls the
// target into view first, and a clip at t = 0 sits at the scroll origin, where
// the scroll can slide it under the sticky header column.
const clickCentre = async (page: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/// Drive the pool → timeline HTML5 drag the way the app's own handlers see it.
/// Not `locator.dragTo`: the two ends live in different dock panels, and the
/// row's payload exists only because its `dragstart` handler ran — so the gesture
/// has to keep ONE DataTransfer alive across all three events, parked on
/// `window` between them (`timeline-drop-strip.spec.ts` states the same rule).
///
/// Each event is its own `page.evaluate` on purpose. Fired back to back in one
/// task, React has not committed the drag the row just began, so the lane's
/// `dragover` still sees no active drag and never claims the highlight.
const beginGroupRowDrag = (page: Page, compositionId: string) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-composition-id="${id}"]`);
    if (!row) throw new Error(`pool row ${id} missing from the DOM`);
    const rect = row.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    (window as unknown as { __groupDragTransfer: DataTransfer }).__groupDragTransfer =
      dataTransfer;
    row.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
  }, compositionId);

const fireOnLane = (
  page: Page,
  args: { trackId: string; type: "dragover" | "drop"; clientX: number },
) =>
  page.evaluate((a) => {
    const lane = document.querySelector(
      `[data-testid="track-lane"][data-track-id="${a.trackId}"]`,
    );
    if (!lane) throw new Error(`lane ${a.trackId} missing from the DOM`);
    const rect = lane.getBoundingClientRect();
    lane.dispatchEvent(
      new DragEvent(a.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: (window as unknown as { __groupDragTransfer: DataTransfer })
          .__groupDragTransfer,
        clientX: a.clientX,
        clientY: rect.y + rect.height / 2,
      }),
    );
  }, args);

/// The lane's x for a point two thirds along it — comfortably clear of a clip at
/// t = 0 and inside the visible strip at whatever zoom the app opened on, which
/// a hard-coded timecode is not.
const laneDropX = async (page: Page, trackId: string): Promise<number> => {
  const lane = page.locator(
    `[data-testid="track-lane"][data-track-id="${trackId}"]`,
  );
  await expect(lane).toBeVisible();
  const box = await lane.boundingBox();
  if (!box) throw new Error("lane has no layout box");
  return box.x + (box.width * 2) / 3;
};

/// Pre-compose the A/V pair on the A roll and return the ids the rest reads.
async function precomposeAPair(page: Page) {
  const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
  const s0 = await wire(page);
  const aRoll = trackWithRole(rootOf(s0), "a-roll");
  const videoLayerId = await invokeCmd<string>(page, "add_media_layer", {
    trackId: aRoll,
    mediaId,
    tStartUs: 0,
  });
  const videoClip = page.locator(
    `.timeline-layer[data-layer-id="${videoLayerId}"]`,
  );
  await expect(videoClip).toBeVisible();
  // The click selects the whole link (both members) AND lands focus on the
  // timeline, which the timeline-scoped chord needs.
  await clickCentre(page, videoClip);
  await page.keyboard.press(`${MOD}+G`);
  await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);
  const s1 = await wire(page);
  return { groupId: groupIdsOf(s1)[0]!, bRoll: trackWithRole(rootOf(s1), "b-roll") };
}

test.describe("Groups in the media pool", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("a pool row places a second instance, and the orphan it becomes is deletable", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-group-pool-"),
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const { groupId, bRoll } = await precomposeAPair(page);

      // ── The row: derived name, its duration, one reference ───────────────
      const row = poolRow(page, groupId);
      await expect(row).toBeVisible();
      await expect(row).toContainText("Group 1");
      await expect(row).toContainText("1 ref");
      await expect(row).toHaveAttribute("data-ref-count", "1");
      await expect(row.locator('[data-testid="group-pool-unused"]')).toHaveCount(0);

      // ── Drag it onto B roll: a second Group clip at its own offset ───────
      const dropX = await laneDropX(page, bRoll);
      await beginGroupRowDrag(page, groupId);
      await fireOnLane(page, { trackId: bRoll, type: "dragover", clientX: dropX });

      const ghost = page.locator('[data-testid="media-drop-ghost"]');
      await expect(ghost).toHaveAttribute("data-validity", "valid");
      // The ghost is the Group CLIP's size: the composition's own duration at
      // the current zoom, which is what makes the drop predictable.
      const before = await wire(page);
      const groupDurationUs = before.compositions[groupId]!.duration_us;
      const ghostStartUs = Number(await ghost.getAttribute("data-start-us"));
      const ghostEndUs = Number(await ghost.getAttribute("data-end-us"));
      expect(ghostEndUs - ghostStartUs).toBe(groupDurationUs);
      expect(ghostStartUs).toBeGreaterThan(0);

      await fireOnLane(page, { trackId: bRoll, type: "drop", clientX: dropX });
      await expect
        .poll(async () => groupClipsOf(rootOf(await wire(page))).length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(2);

      const s2 = await wire(page);
      const clips = groupClipsOf(rootOf(s2));
      // One composition, two instances — reuse, not a copy.
      expect(groupIdsOf(s2)).toEqual([groupId]);
      expect(clips.map((l) => l.params.composition_id)).toEqual([groupId, groupId]);
      const placed = rootOf(s2).tracks.find((t) => t.id === bRoll)!.layers;
      expect(placed).toHaveLength(1);
      // The commit landed where the ghost said it would, spanning the whole
      // composition (`src` is `[0, duration_us)`, so the clip is its length).
      expect(placed[0]!.t_start_us).toBe(ghostStartUs);
      expect(placed[0]!.t_end_us - placed[0]!.t_start_us).toBe(groupDurationUs);
      await expect(row).toContainText("2 refs");
      await expect(row).toHaveAttribute("data-ref-count", "2");

      // ── Delete both clips: the row dims and tags itself unused ───────────
      await invokeCmd(page, "delete_layers", { layerIds: clips.map((l) => l.id) });
      await expect(row).toHaveAttribute("data-ref-count", "0");
      await expect(row).toContainText("0 refs");
      await expect(row.locator('[data-testid="group-pool-unused"]')).toHaveCount(1);
      // The composition itself survives its last clip — that IS the orphan.
      expect(groupIdsOf(await wire(page))).toEqual([groupId]);

      // ── Delete from the row's own menu, and one undo brings it back ──────
      await row.click({ button: "right" });
      await page.getByText("Delete Group", { exact: true }).click();
      await expect.poll(async () => groupIdsOf(await wire(page))).toEqual([]);
      await expect(poolRow(page, groupId)).toHaveCount(0);

      await invokeCmd(page, "project_undo", {});
      await expect.poll(async () => groupIdsOf(await wire(page))).toEqual([groupId]);
      await expect(poolRow(page, groupId)).toHaveCount(1);
    } finally {
      await app.close();
    }
  });

  test("dragging a Group into itself is refused at the drop target, not at release", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-group-pool-cycle-"),
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const { groupId } = await precomposeAPair(page);

      // Stand inside the Group. The hook is the by-id `openComposition`, which is
      // what a pool row's `Open` calls; the double-click path is
      // group-timeline.spec.ts's.
      await waitForHook(page, "setOpenComposition");
      expect(
        await page.evaluate(
          (id) => (window as any).__weftcutTest.setOpenComposition(id),
          groupId,
        ),
      ).toBe(true);
      await expect.poll(async () => {
        const open = await page.evaluate(() =>
          (window as any).__weftcutTest.getOpenComposition(),
        );
        return (open as { id: string } | null)?.id ?? null;
      }).toBe(groupId);

      const s0 = await wire(page);
      const inner = s0.compositions[groupId]!;
      const innerB = trackWithRole(inner, "b-roll");
      const layersBefore = layersOf(inner).length;

      const dropX = await laneDropX(page, innerB);
      await beginGroupRowDrag(page, groupId);
      await fireOnLane(page, { trackId: innerB, type: "dragover", clientX: dropX });

      // Refused at the TARGET: the ghost says why before the pointer is released.
      const ghost = page.locator('[data-testid="media-drop-ghost"]');
      await expect(ghost).toHaveAttribute("data-validity", "cycle");
      await expect(ghost).toContainText("cannot contain itself");

      // And releasing does nothing at all — not a refusal after the fact.
      await fireOnLane(page, { trackId: innerB, type: "drop", clientX: dropX });
      await expect
        .poll(async () => layersOf((await wire(page)).compositions[groupId]!).length, {
          timeout: 10_000,
          intervals: [250, 500],
        })
        .toBe(layersBefore);
      expect(groupIdsOf(await wire(page))).toEqual([groupId]);
    } finally {
      await app.close();
    }
  });
});
