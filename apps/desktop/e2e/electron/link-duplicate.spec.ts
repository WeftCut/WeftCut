import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCmd, launchApp, newProject, tmpDir, rootSummary } from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// An AV source: `add_media_layer` auto-pairs it into a linked video + Audio
// layer on the one track, which is the only way to mint a link without a
// second clip.
const FIXTURE = path.resolve(__dirname, "../fixtures/media/test_1080p_30fps_audio.mp4");

interface LinkSummary {
  tracks: Array<{
    id: string;
    role: string | null;
    layers: Array<{ id: string; t_start_us: number; t_end_us: number }>;
  }>;
  links: Array<{ id: string; label: string | null; layer_ids: string[] }>;
  history: { cursor: number; len: number; can_undo: boolean };
}

const snapshot = (page: Page) => rootSummary<LinkSummary>(page);
const layerIds = (s: LinkSummary): string[] =>
  s.tracks.flatMap((t) => t.layers.map((l) => l.id)).sort();
const spanOf = (s: LinkSummary, layerId: string) => {
  const layer = s.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId);
  if (!layer) throw new Error(`layer ${layerId} missing from summary`);
  return [layer.t_start_us, layer.t_end_us] as const;
};

test.describe("whole-link duplicate", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  // Premiere's Alt+drag on a linked clip copies both halves. The gesture is
  // driven with real pointer input so the arm delay, the per-member ghosts and
  // the release all run the shipped code; the outcome is read from the project,
  // where the one thing N `paste_layer` calls could never give — one undo for
  // the pair — is observable as a single history row.
  test("Alt+drag on a linked A/V pair clones both, links the clones to each other, and undoes as one step", async () => {
    test.setTimeout(150_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-link-dup-"),
        name: "e2e-link-dup-" + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const s0 = await snapshot(page);
      const aRoll = s0.tracks.find((t) => t.role === "a-roll");
      expect(aRoll, "the blank skeleton carries an A roll").toBeTruthy();
      const videoLayerId = await invokeCmd<string>(page, "add_media_layer", {
        trackId: aRoll!.id,
        mediaId,
        tStartUs: 0,
      });
      // Trimmed to 1 s (the trim fans out, so both halves shrink): the pair is
      // then narrow at any zoom the panel opens at, and a drag of two clip
      // widths clears its own footprint without the spec having to zoom.
      await invokeCmd(page, "trim_layer", {
        layerId: videoLayerId,
        edge: "out",
        newTUs: 1_000_000,
        escapeLink: false,
      });

      const s1 = await snapshot(page);
      const sourceIds = layerIds(s1);
      expect(sourceIds).toHaveLength(2);
      const sourceLink = s1.links.find((l) => l.layer_ids.includes(videoLayerId));
      expect(sourceLink, "video and audio halves should share one link").toBeTruthy();
      expect(sourceLink!.layer_ids).toHaveLength(2);
      const sourceSpans = new Map(sourceIds.map((id) => [id, spanOf(s1, id)]));
      const historyLenBefore = s1.history.len;

      // Either half will do as the dragged seed — both are subjects. `.first()`
      // is the video (the pair's first layer on the lane).
      const clip = page.locator(`.timeline-layer[data-link-id="${sourceLink!.id}"]`).first();
      await expect(clip).toBeVisible();
      const clipBox = await clip.boundingBox();
      if (!clipBox) throw new Error("clip has no layout box");
      const startX = clipBox.x + clipBox.width / 2;
      const y = clipBox.y + clipBox.height / 2;

      // Real mouse input, one protocol round trip per step, with Alt held for
      // the whole gesture: Alt at pointerdown is what makes it a duplicate.
      await page.keyboard.down("Alt");
      try {
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(startX + clipBox.width * 2, y, { steps: 4 });
        // The intermediate state, button still down: one ghost per member, the
        // audio half included, both on this lane at the dragged position.
        await expect(page.locator('[data-duplicate-preview="true"]')).toHaveCount(2);
        await page.mouse.up();
      } finally {
        await page.keyboard.up("Alt");
      }

      await expect
        .poll(async () => layerIds(await snapshot(page)).length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(4);

      const s2 = await snapshot(page);
      const cloneIds = layerIds(s2).filter((id) => !sourceIds.includes(id));
      expect(cloneIds).toHaveLength(2);
      // The clones are linked to EACH OTHER and never to their sources.
      const cloneLink = s2.links.find((l) => cloneIds.every((id) => l.layer_ids.includes(id)));
      expect(cloneLink, "the two clones should share a link").toBeTruthy();
      expect(cloneLink!.id).not.toBe(sourceLink!.id);
      expect([...cloneLink!.layer_ids].sort()).toEqual([...cloneIds].sort());
      const sourceLinkAfter = s2.links.find((l) => l.id === sourceLink!.id);
      expect(sourceLinkAfter, "the source link survives").toBeTruthy();
      expect([...sourceLinkAfter!.layer_ids].sort()).toEqual(sourceIds);
      // Sources untouched, clones clear of them.
      for (const id of sourceIds) expect(spanOf(s2, id)).toEqual(sourceSpans.get(id));
      for (const id of cloneIds) expect(spanOf(s2, id)[0]).toBeGreaterThanOrEqual(1_000_000);
      // ONE history row for the whole gesture.
      expect(s2.history.len).toBe(historyLenBefore + 1);

      // …so ONE undo removes both clones and their link, and nothing else.
      await invokeCmd(page, "project_undo", {});
      await expect
        .poll(async () => layerIds(await snapshot(page)).length, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(2);
      const s3 = await snapshot(page);
      expect(layerIds(s3)).toEqual(sourceIds);
      expect(s3.links.map((l) => l.id)).toEqual([sourceLink!.id]);
    } finally {
      await app.close();
    }
  });
});
