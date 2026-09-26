import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { invokeCmd, launchApp, newProject, tmpDir } from "./helpers/driver";

/**
 * A subtitle document is pool media (ADR 0077): importing it lands a `Subtitle`
 * item in the pool and touches no track, and dragging that item onto the
 * timeline takes only the drop TIME — released over a picture lane, its cues
 * still go to the caption tracks, the document's 0 at the drop.
 *
 * The drag is fired as raw HTML5 events on one DataTransfer parked on `window`,
 * each in its own `page.evaluate`, for the reasons `group-media-pool.spec.ts`
 * gives.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
// One cue, one second into the document.
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nFrom the pool\n";

interface WireLayer { id: string; t_start_us: number; t_end_us: number }
interface WireTrack { id: string; role?: string | null; layers: WireLayer[] }
interface Wire { root_id: string; compositions: Record<string, { tracks: WireTrack[] }> }

const rootTracks = async (page: Page): Promise<WireTrack[]> => {
  const s = await invokeCmd<Wire>(page, "project_summary", {});
  return s.compositions[s.root_id]!.tracks;
};
const captionLayers = async (page: Page): Promise<WireLayer[]> =>
  (await rootTracks(page)).filter((t) => t.role === "caption").flatMap((t) => t.layers);

const beginPoolDrag = (page: Page, mediaId: string) =>
  page.evaluate((id) => {
    const card = document.querySelector(`[data-media-id="${id}"]`);
    if (!card) throw new Error(`pool card ${id} missing from the DOM`);
    const rect = card.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    (window as unknown as { __subtitleDrag: DataTransfer }).__subtitleDrag = dataTransfer;
    card.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true, cancelable: true, dataTransfer,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
    }));
  }, mediaId);

const fireOnLane = (page: Page, a: { trackId: string; type: "dragover" | "drop"; clientX: number }) =>
  page.evaluate((args) => {
    const lane = document.querySelector(`[data-testid="track-lane"][data-track-id="${args.trackId}"]`);
    if (!lane) throw new Error(`lane ${args.trackId} missing from the DOM`);
    const rect = lane.getBoundingClientRect();
    lane.dispatchEvent(new DragEvent(args.type, {
      bubbles: true, cancelable: true,
      dataTransfer: (window as unknown as { __subtitleDrag: DataTransfer }).__subtitleDrag,
      clientX: args.clientX, clientY: rect.y + rect.height / 2,
    }));
  }, a);

test("a subtitle pools on import and lays its cues on the caption tracks where it is dropped", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir("weftcut-e2e-subtitle-drop-"), name: "subtitle-drop", canvas: CANVAS });
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

    const srt = path.join(tmpDir("weftcut-e2e-subtitle-src-"), "scene.srt");
    fs.writeFileSync(srt, SRT, "utf8");
    const mediaId = await invokeCmd<string>(page, "import_media", { path: srt });

    // ── Import pools it, and nothing reaches the timeline ────────────────
    const card = page.locator(`[data-media-id="${mediaId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("scene.srt");
    expect(await captionLayers(page)).toEqual([]);

    // ── Drag it over the A roll: accepted, the ghost a marker at the drop ─
    const aRoll = (await rootTracks(page)).find((t) => t.role === "a-roll")!.id;
    const lane = page.locator(`[data-testid="track-lane"][data-track-id="${aRoll}"]`);
    const box = (await lane.boundingBox())!;
    const dropX = box.x + (box.width * 2) / 3;
    await beginPoolDrag(page, mediaId);
    await fireOnLane(page, { trackId: aRoll, type: "dragover", clientX: dropX });
    const ghost = page.locator('[data-testid="media-drop-ghost"]');
    await expect(ghost).toHaveAttribute("data-validity", "valid");
    const dropUs = Number(await ghost.getAttribute("data-start-us"));
    expect(dropUs).toBeGreaterThan(0);
    expect(Number(await ghost.getAttribute("data-end-us"))).toBe(dropUs);

    // ── Drop: the cue lands on a caption track, offset by the drop time ──
    await fireOnLane(page, { trackId: aRoll, type: "drop", clientX: dropX });
    await expect.poll(async () => (await captionLayers(page)).length, { timeout: 20_000 }).toBe(1);
    const [cue] = await captionLayers(page);
    // Each cue edge snaps to the frame grid on its own, so allow one frame.
    expect(Math.abs(cue!.t_start_us - (dropUs + 1_000_000))).toBeLessThanOrEqual(33_334);
    expect(Math.abs(cue!.t_end_us - (dropUs + 2_000_000))).toBeLessThanOrEqual(33_334);
    // The lane it was released over is left as it was.
    expect((await rootTracks(page)).find((t) => t.id === aRoll)!.layers).toEqual([]);
    // The item stays in the pool — applying copied the cues.
    await expect(card).toBeVisible();
  } finally {
    await app.close();
  }
});
