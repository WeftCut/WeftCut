import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook, rootSummary } from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// An AV source: `add_media_layer` auto-pairs it into a linked video + Audio
// layer on the one track, which is the only way to mint a link without a
// second clip.
const FIXTURE = path.resolve(__dirname, "../fixtures/media/test_1080p_30fps_audio.mp4");

interface LinkSummary {
  tracks: Array<{
    id: string;
    role: string | null;
    layers: Array<{ id: string; params: { kind: string } }>;
  }>;
  links: Array<{ id: string; label: string | null; layer_ids: string[] }>;
}

const snapshot = (page: Page) => rootSummary<LinkSummary>(page);

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  await waitForHook(page, "getSelectedLayerIds");
  const ids = (await page.evaluate(() =>
    (window as any).__weftcutTest.getSelectedLayerIds(),
  )) as string[];
  return ids.slice().sort();
};

test.describe("link visibility under A/B Roll display", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  // The spec's Problem 2, end to end: a link member on a filtered lane is
  // invisible under the default display, so the visible member has to say it
  // exists. The badge is asserted through the DOM because that is where the
  // defect lives — the state was always right, the screen was not — and the
  // reveal is checked against the lane's own `data-track-id` because the
  // reveal path is single-lane by design and a wrong lane would still be A
  // lane. Selection is read through the hook: revealing must not select.
  test("a filtered-out member is counted on the visible member, and the badge reveals its lane without selecting", async () => {
    test.setTimeout(150_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-link-vis-"),
        name: "e2e-link-vis-" + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const s0 = await snapshot(page);
      const aRoll = s0.tracks.find((t) => t.role === "a-roll");
      expect(aRoll, "the blank skeleton carries an A roll").toBeTruthy();
      // On the A roll, not a fresh lane: the pair must start on a lane the
      // default A/B Roll display renders, or nothing is visible to badge.
      const videoLayerId = await invokeCmd<string>(page, "add_media_layer", {
        trackId: aRoll!.id,
        mediaId,
        tStartUs: 0,
      });

      const s1 = await snapshot(page);
      const audioLayerId = s1.tracks
        .flatMap((t) => t.layers)
        .find((l) => l.params.kind === "Audio")?.id;
      expect(audioLayerId, "the AV source should have auto-paired an Audio layer").toBeTruthy();
      const link = s1.links.find(
        (l) => l.layer_ids.includes(videoLayerId) && l.layer_ids.includes(audioLayerId!),
      );
      expect(link, "video and audio halves should share one link").toBeTruthy();

      // Both members visible on one lane: no badge, and the clip is addressable
      // by its link.
      const videoClip = page.locator(`.timeline-layer[data-link-id="${link!.id}"]`);
      await expect(videoClip).toHaveCount(2);
      await expect(page.locator('[data-testid="link-hidden-badge"]')).toHaveCount(0);

      // The separated audio lands on a transient (role-less) lane, which the
      // A/B Roll filter does not render.
      const audioTrackId = await invokeCmd<string>(page, "separate_audio_to_new_track", {
        layerId: audioLayerId,
      });
      const audioLane = page.locator(`[data-testid="track-lane"][data-track-id="${audioTrackId}"]`);
      await expect(audioLane).toHaveCount(0);
      await expect(videoClip).toHaveCount(1);

      const badge = page.locator('[data-testid="link-hidden-badge"]');
      await expect(badge).toHaveText("+1");
      await expect(videoClip.locator('[data-testid="link-hidden-badge"]')).toHaveCount(1);

      // A selection to preserve: a plain click on the video takes the whole
      // link, audio half included even though it is off screen.
      const clipBox = await videoClip.boundingBox();
      if (!clipBox) throw new Error("video clip has no layout box");
      await page.mouse.click(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
      const before = await selectedLayerIds(page);
      expect(before).toEqual([videoLayerId, audioLayerId!].sort());

      // Raw pointer at the badge's centre: `locator.click()` scrolls the target
      // into view first, and a tab hanging off a clip at t = 0 sits at the scroll
      // origin, where that scroll can slide it under the sticky header column.
      const badgeBox = await badge.boundingBox();
      if (!badgeBox) throw new Error("badge has no layout box");
      await page.mouse.click(badgeBox.x + badgeBox.width / 2, badgeBox.y + badgeBox.height / 2);
      await expect(audioLane).toBeVisible();
      await expect(audioLane.locator(`.timeline-layer[data-link-id="${link!.id}"]`)).toHaveCount(1);
      // Revealed, so no longer hidden: the count has nothing left to say.
      await expect(badge).toHaveCount(0);
      expect(await selectedLayerIds(page)).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
