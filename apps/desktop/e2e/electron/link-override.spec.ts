import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from "./helpers/driver";

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

const snapshot = (page: Page) => invokeCmd<LinkSummary>(page, "project_summary", {});

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  await waitForHook(page, "getSelectedLayerIds");
  const ids = (await page.evaluate(() =>
    (window as any).__weftcutTest.getSelectedLayerIds(),
  )) as string[];
  return ids.slice().sort();
};

const trackHolding = (s: LinkSummary, layerId: string): string | null =>
  s.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null;

// Raw pointer at the centre rather than `locator.click()`: that scrolls the
// target into view first, and a clip at t = 0 sits at the scroll origin, where
// the scroll can slide it under the sticky header column.
const clickCentre = async (page: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

test.describe("link override", () => {
  test.skip(
    !existsSync(FIXTURE),
    `AV fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  // The switch stands in for a held Alt. The status chip is the state probe —
  // it is the one place the mode is stated rather than implied — and the two
  // gestures a linked pair changes most (click, drag) are exercised on each
  // side of the toggle so "restored" is asserted, not assumed.
  test("toggling it makes a plain click select one member and a drag move one; toggling back restores the link", async () => {
    test.setTimeout(150_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-link-override-"),
        name: "e2e-link-override-" + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

      const mediaId = await invokeCmd<string>(page, "import_media", { path: FIXTURE });
      const s0 = await snapshot(page);
      const aRoll = s0.tracks.find((t) => t.role === "a-roll");
      const bRoll = s0.tracks.find((t) => t.role === "b-roll");
      expect(aRoll && bRoll, "the blank skeleton carries an A roll and a B roll").toBeTruthy();
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
      const link = s1.links.find((l) => l.layer_ids.includes(videoLayerId));
      expect(link, "video and audio halves should share one link").toBeTruthy();
      const pair = [videoLayerId, audioLayerId!].sort();

      const chip = page.locator('[data-testid="link-override-chip"]');
      // `.first()` is the video: the pair's first layer on the lane, drawn as
      // the top slice.
      const videoClip = page.locator(`.timeline-layer[data-link-id="${link!.id}"]`).first();
      await expect(videoClip).toBeVisible();

      // Links in force: a plain click takes the whole pair, and the click also
      // lands focus on the timeline, which the timeline-scoped chord needs.
      await expect(chip).toHaveCount(0);
      await clickCentre(page, videoClip);
      expect(await selectedLayerIds(page)).toEqual(pair);
      const accentOn = await videoClip.evaluate((el) => getComputedStyle(el).borderLeftColor);

      await page.keyboard.press("Alt+Shift+G");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText("Links off");
      // The canvas says so too: the accent dims (its colour changes) while on.
      await expect
        .poll(() => videoClip.evaluate((el) => getComputedStyle(el).borderLeftColor))
        .not.toBe(accentOn);

      // Plain click, one member.
      await clickCentre(page, videoClip);
      expect(await selectedLayerIds(page)).toEqual([videoLayerId]);

      // Drag the video down onto the B roll: only it changes lane, the audio
      // stays put. Vertical, so no horizontal room is needed and the audio half
      // cannot collide with anything.
      const bLane = page.locator(`[data-testid="track-lane"][data-track-id="${bRoll!.id}"]`);
      await expect(bLane).toBeVisible();
      const clipBox = await videoClip.boundingBox();
      const laneBox = await bLane.boundingBox();
      if (!clipBox || !laneBox) throw new Error("clip or lane has no layout box");
      const x = clipBox.x + clipBox.width / 2;
      await page.mouse.move(x, clipBox.y + clipBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, laneBox.y + laneBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(async () => trackHolding(await snapshot(page), videoLayerId), {
          timeout: 20_000,
          intervals: [250, 500, 1000],
        })
        .toBe(bRoll!.id);
      const s2 = await snapshot(page);
      expect(trackHolding(s2, audioLayerId!)).toBe(aRoll!.id);
      // The link itself is untouched — the override escapes, it never dissolves.
      expect([...s2.links.find((l) => l.id === link!.id)!.layer_ids].sort()).toEqual(pair);

      // Off again: chip gone, and a plain click on the moved video takes its
      // audio partner with it once more.
      const movedClip = bLane.locator(`.timeline-layer[data-link-id="${link!.id}"]`);
      await expect(movedClip).toHaveCount(1);
      await clickCentre(page, movedClip);
      await page.keyboard.press("Alt+Shift+G");
      await expect(chip).toHaveCount(0);
      await clickCentre(page, movedClip);
      expect(await selectedLayerIds(page)).toEqual(pair);
    } finally {
      await app.close();
    }
  });
});
