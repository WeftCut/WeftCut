import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockPanel,
  dragDockTab,
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

/**
 * The flow the whole feature exists for (ADR 0053): **edit inside a Group while
 * watching the film.** One pass through the real UI, end to end —
 *
 *   1. pre-compose a pair and double-click into it: a timeline Panel of its own,
 *      beside the one it was entered from;
 *   2. lock the preview to the film, so the picture stops following the
 *      keyboard;
 *   3. scrub the Group's playhead and watch the FILM move — one moment, read in
 *      the Group's coordinates and drawn in the root's;
 *   4. drag the Group's tab out: two timelines side by side;
 *   5. drop a clip into the Group's timeline while the root holds the keyboard —
 *      the drop lands where it was released, not where the keyboard is;
 *   6. restart: both tabs, both zooms and the lock come back.
 *
 * The fixture is built through the same commands the UI issues, so the only
 * media it needs is one still image for the drop. RED and GREEN inside the
 * Group, BLUE on the film above it: a sampled pixel then names WHICH
 * composition reached the screen, because blue exists only in the root. The
 * frame's own width says the same thing a second way — each composition draws
 * at its own size, and the Group's is deliberately not the root's.
 *
 * Every Panel is addressed by the composition its Panel id names, never by a
 * position in the tab strip: the strip's order is a user's arrangement and
 * changes with each drag.
 *
 * A second flow follows it, on the same split-Panel arrangement and with a
 * fixture of its own: carrying a clip BETWEEN the two timelines by hand.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/// A still image is ready the moment it is in the pool — no proxy — so the card
/// is draggable without waiting on a background job, and `ImageOverlay`
/// identifies the placement unambiguously.
const IMAGE_FIXTURE = path.resolve(
  __dirname,
  "../fixtures/media/test_chart_320x240.png",
);

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
/// The Group's own frame, deliberately not the root's: `w` on a sampled pixel
/// is the renderer's logical size, so it names the composition on screen.
const GROUP_W = 480;
const GROUP_H = 270;
/// Inside both frames, and inside the Group's texture where the root stages it
/// (480×270 centred in 640×360 covers x ∈ [80, 560)). One sample point for
/// every phase, so a phase can never be reading a different pixel.
const SAMPLE_X = 240;
const SAMPLE_Y = 135;

const RED = { r: 255, g: 0, b: 0, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

/// The suite's spelling of the catalogue's `Mod` token (search-palette.spec.ts).
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const PROJECT_NAME = "e2e-composition-tabs";

/// Where the members sit before the pre-compose. The Group therefore lands at
/// 2 s on the film, which is what makes its anchor offset non-zero — a Panel
/// reading root time as its own would agree with the projection at 0 and only
/// there.
const GROUP_START_US = 2_000_000;
const CUT_US = 1_000_000;

interface WireLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  params: { kind: string; composition_id?: string; src_in_us?: number };
}
interface WireComposition {
  id: string;
  duration_us: number;
  tracks: Array<{ id: string; role?: string | null; layers: WireLayer[] }>;
}
interface Wire {
  root_id: string;
  compositions: Record<string, WireComposition>;
  media: Array<{ id: string }>;
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

const trackWithRole = (c: WireComposition, role: string): string => {
  const track = c.tracks.find((t) => t.role === role);
  if (!track) throw new Error(`the blank skeleton carries no ${role}`);
  return track.id;
};

// ── Panels, addressed by the composition their id names ─────────────────────

/// One timeline Panel's body — the focus region, which carries the composition
/// half of its Panel id.
const timelinePanel = (page: Page, compositionId: string): Locator =>
  page.locator(
    `.weft-dock-panel[data-panel-kind="timeline"][data-focus-region-instance="${compositionId}"]`,
  );

/// One timeline Panel's tab, as Dockview's own `.dv-tab` box — the element it
/// marks `draggable`, which is what a tab drag has to grab (see `dockTab` in
/// the driver).
const timelineDvTab = (page: Page, compositionId: string): Locator =>
  page
    .locator(".dv-tab")
    .filter({
      has: page.locator(
        `.weft-dock-tab[data-panel-kind="timeline"][data-panel-instance="${compositionId}"]`,
      ),
    });

/// Every timeline Panel the Dock holds, by composition id, sorted — a
/// background tab stays mounted, so this counts Panels, not what is on screen.
const timelinePanelIds = (page: Page): Promise<string[]> =>
  page
    .locator('.weft-dock-panel[data-panel-kind="timeline"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-focus-region-instance") ?? "").sort(),
    );

/// The same set, but only the Panels actually drawn — two of these is what
/// "side by side" means.
const visibleTimelinePanelIds = (page: Page): Promise<string[]> =>
  page
    .locator(
      '.weft-dock-panel[data-panel-kind="timeline"][data-panel-visible="true"]',
    )
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-focus-region-instance") ?? "").sort(),
    );

/// Every timeline TAB, by the composition its Panel id names.
const timelineTabIds = (page: Page): Promise<string[]> =>
  page
    .locator('.weft-dock-tab[data-panel-kind="timeline"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-panel-instance") ?? "").sort(),
    );

// ── The preview ─────────────────────────────────────────────────────────────

interface Sample {
  r: number;
  g: number;
  b: number;
  a: number;
  w: number;
  h: number;
}

const sample = (page: Page): Promise<Sample> =>
  page.evaluate(
    (p) => (window as any).__weftcutTest.weftcutSampleComposite(p.x, p.y),
    { x: SAMPLE_X, y: SAMPLE_Y },
  );

const playheadUs = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs());

const openCompositionId = (page: Page): Promise<string | null> =>
  page.evaluate(
    () => (window as any).__weftcutTest.getOpenComposition()?.id ?? null,
  );

/// Which layer painted the sampled pixel. Dominance rather than equality: the
/// sample rides the renderer's own 8-bit round trip, and what is under test is
/// WHICH composition reached the screen, not the channel arithmetic.
function primaryOf(px: Sample): string {
  if (px.a < 200) return "clear";
  if (px.r > 200 && px.g < 80 && px.b < 80) return "red";
  if (px.g > 200 && px.r < 80 && px.b < 80) return "green";
  if (px.b > 200 && px.r < 80 && px.g < 80) return "blue";
  return "other";
}

/// What the editor is showing, as one comparable line: the film's moment in
/// ROOT time, the colour at the centre of the frame, and the frame's own width
/// — which names the composition, since each draws at its own size.
async function previewState(page: Page): Promise<string> {
  const rootUs = await playheadUs(page);
  try {
    const px = await sample(page);
    return `${rootUs} ${primaryOf(px)} ${px.w}`;
  } catch {
    // The read-back hook is installed at boot but only answers once
    // `PixiPreview` has registered its bridge. Reported as a state rather than
    // raised, so the poll around this keeps waiting instead of failing on the
    // first round.
    return `${rootUs} no-preview 0`;
  }
}

/// Re-issue `gesture` on every poll round rather than firing it once and then
/// waiting for the picture to catch up. Every seek here reaches the canvas
/// through the playback store's transport, which `PixiPreview` registers only
/// after its async `Application` init — and a seek against an unregistered
/// transport is a SILENT no-op, so the store moves and the canvas does not.
/// Retrying IS the readiness wait, and it also covers the gap around a
/// re-registration. Every gesture below is idempotent, so a repeat costs
/// nothing.
async function settleOn(
  page: Page,
  gesture: () => Promise<void>,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await gesture();
        return previewState(page);
      },
      { timeout: 30_000 },
    )
    .toBe(expected);
}

// ── The media-pool → timeline drag ──────────────────────────────────────────
//
// Not `locator.dragTo`: the two ends live in different dock Panels, and the
// card's payload exists only because its `dragstart` handler ran — so the
// gesture has to keep ONE DataTransfer alive across all three events, parked on
// `window` between them. Each event is its own `page.evaluate` for the reason
// `timeline-drop-strip.spec.ts` states: fired back to back in one task, React
// has not committed the drag the card just began.

const beginMediaCardDrag = (page: Page, mediaId: string) =>
  page.evaluate((id) => {
    const card = document.querySelector(`.media-item[data-media-id="${id}"]`);
    if (!card) throw new Error(`media card ${id} missing from the DOM`);
    const rect = card.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    (window as any).__tabsDragTransfer = dataTransfer;
    card.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
  }, mediaId);

/// Fire one drag event on the drop strip of the Panel showing `compositionId`.
/// The Panel is named, never assumed: with two timelines open there are two
/// drop strips, and `querySelector` would silently take the first.
const fireOnDropStrip = (
  page: Page,
  compositionId: string,
  type: "dragover" | "drop",
) =>
  page.evaluate(
    ({ id, t }) => {
      const strip = document.querySelector(
        `.weft-dock-panel[data-focus-region-instance="${id}"] [data-testid="timeline-drop-strip"]`,
      );
      if (!strip) throw new Error(`drop strip of ${id} missing from the DOM`);
      const rect = strip.getBoundingClientRect();
      strip.dispatchEvent(
        new DragEvent(t, {
          bubbles: true,
          cancelable: true,
          dataTransfer: (window as any).__tabsDragTransfer,
          // 32 px in from the strip's left edge is the cursor-in-ghost offset,
          // so the clip lands at the head of the composition's own timeline.
          clientX: rect.x + 32,
          clientY: rect.y + rect.height / 2,
        }),
      );
    },
    { id: compositionId, t: type },
  );

// ── view.json, read off disk ────────────────────────────────────────────────

interface TabView {
  composition_id: string;
  px_per_sec: number;
}
interface ViewDoc {
  composition_tabs: TabView[];
  active_composition_id: string | null;
  preview_render_target_id: string | null;
}

/// The project's own `view.json`. Null until the first debounced write lands,
/// which is what every read below polls through.
function readViewDoc(workspaceDir: string): ViewDoc | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(workspaceDir, "view.json"), "utf8"),
    ) as ViewDoc;
  } catch {
    return null;
  }
}

/// The zoom `view.json` remembers for one tab, or null when it has no entry.
function tabZoom(doc: ViewDoc | null, compositionId: string): number | null {
  return (
    doc?.composition_tabs.find((t) => t.composition_id === compositionId)
      ?.px_per_sec ?? null
  );
}

/// The width of one Panel's ruler, which is `max(content, viewport) + padding`
/// — content-bound, and so a direct read of the zoom, once the zoom is high
/// enough that ten seconds of lattice outruns any viewport.
async function rulerWidthPx(page: Page, compositionId: string): Promise<number> {
  const box = await timelinePanel(page, compositionId)
    .locator('[data-testid="timeline-ruler"]')
    .boundingBox();
  if (!box) throw new Error(`timeline ${compositionId} has no ruler box`);
  return box.width;
}

/// A ruler this wide can only be a zoomed-in Panel: the timeline always draws
/// at least `MIN_TIMELINE_SECONDS` (10) of lattice, so the ceiling zoom of
/// 2000 px/s puts 20 000 px of ruler on screen where the default 80 px/s puts
/// 800 plus padding.
const ZOOMED_RULER_PX = 15_000;

test.describe("many compositions, one moment", () => {
  test.skip(
    !fs.existsSync(IMAGE_FIXTURE),
    `image fixture not found at ${IMAGE_FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("a Group's timeline and the film's are one moment, side by side, across a restart", async () => {
    test.setTimeout(300_000);
    // Both launches share one userData dir: the recents list that reopens the
    // project and the dock geometry both live there.
    const userDataDir = tmpDir("weftcut-e2e-tabs-data-");
    const parent = tmpDir("weftcut-e2e-tabs-");
    const workspaceDir = path.join(parent, PROJECT_NAME);

    let rootId = "";
    let groupId = "";
    let groupZoomPxPerSec = 0;
    let rootZoomPxPerSec = 0;

    const first = await launchApp({ userDataDir });
    try {
      const page = first.page;
      await newProject(page, {
        parentFolder: parent,
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
      await waitForHook(page, "weftcutSampleComposite");
      await waitForHook(page, "getPlayheadUs");
      await waitForHook(page, "getOpenComposition");

      const s0 = await wire(page);
      rootId = s0.root_id;
      const aRoll = trackWithRole(rootOf(s0), "a-roll");
      const bRoll = trackWithRole(rootOf(s0), "b-roll");

      // ── The pair: RED then GREEN, on the A roll where they are visible ───
      // Named lanes rather than the default overlay placement: an unnamed
      // Color layer lands on a role-less transient lane, which A/B Roll leaves
      // collapsed — and Select All reaches only the lanes that are drawn.
      const redId = await invokeCmd<string>(page, "add_color_layer", {
        trackId: aRoll,
        tStartUs: GROUP_START_US,
        durationUs: CUT_US,
        color: RED,
        width: CANVAS.width,
        height: CANVAS.height,
        compositionId: rootId,
      });
      await invokeCmd<string>(page, "add_color_layer", {
        trackId: aRoll,
        tStartUs: GROUP_START_US + CUT_US,
        durationUs: CUT_US,
        color: GREEN,
        width: CANVAS.width,
        height: CANVAS.height,
        compositionId: rootId,
      });
      await expect
        .poll(async () => layersOf(rootOf(await wire(page))).length)
        .toBe(2);

      // ── Ctrl+G: one Group clip replaces the pair ─────────────────────────
      // The ruler press lands focus on the timeline, which both timeline-scoped
      // chords need; Select All then takes the two lanes it draws.
      await timelinePanel(page, rootId)
        .locator('[data-testid="timeline-ruler"]')
        .click({ position: { x: 120, y: 10 } });
      await page.keyboard.press(`${MOD}+A`);
      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);

      const s1 = await wire(page);
      groupId = groupIdsOf(s1)[0]!;
      // One clip replaced two: the pair moved inside.
      expect(layersOf(rootOf(s1))).toHaveLength(1);
      const groupLayer = layersOf(rootOf(s1))[0]!;
      expect(groupLayer.params.kind).toBe("CompositionRef");
      expect(groupLayer.params.composition_id).toBe(groupId);
      // Pre-compose re-bases its members to the selection's start, so the
      // Group's own timeline is RED [0, 1 s) then GREEN [1 s, 2 s) and its clip
      // spans [2 s, 4 s) on the film with `src_in = 0`. The anchor's offset is
      // therefore exactly the clip's start.
      expect(groupLayer.t_start_us).toBe(GROUP_START_US);
      expect(groupLayer.t_end_us).toBe(GROUP_START_US + 2 * CUT_US);
      expect(groupLayer.params.src_in_us).toBe(0);
      expect(s1.compositions[groupId]!.duration_us).toBe(2 * CUT_US);
      expect(layersOf(s1.compositions[groupId]!).map((l) => l.id)).toContain(redId);

      // ── BLUE on the film, over the Group's second half ───────────────────
      // The B roll draws above the A roll (a later track composites on top), so
      // this covers the Group's picture — and it exists ONLY in the root, which
      // is what makes a blue pixel proof of which composition was rendered.
      await invokeCmd<string>(page, "add_color_layer", {
        trackId: bRoll,
        tStartUs: GROUP_START_US + CUT_US,
        durationUs: CUT_US,
        color: BLUE,
        width: CANVAS.width,
        height: CANVAS.height,
        compositionId: rootId,
      });
      // A frame of its own for the Group, so the frame width names it.
      await invokeCmd(page, "set_composition", {
        compositionId: groupId,
        patch: { width: GROUP_W, height: GROUP_H },
      });

      const s2 = await wire(page);
      // Autofit: the film runs to the last thing on it, which both the Group
      // clip and BLUE end at.
      expect(rootOf(s2).duration_us).toBe(GROUP_START_US + 2 * CUT_US);
      // 4 s at 30 fps is 120 frames, so the playhead's last parking anchor is
      // frame 119 — round(119 × 1e6 / 30) µs. Every End below lands here.
      const LAST_FRAME_US = 3_966_667;

      // ── Park the film on its last frame, then enter the Group ────────────
      const pressEnd = async () => {
        await page.keyboard.press("End");
      };
      await settleOn(page, pressEnd, `${LAST_FRAME_US} blue ${CANVAS.width}`);

      const groupClip = timelinePanel(page, rootId).locator(
        `.timeline-layer[data-layer-id="${groupLayer.id}"]`,
      );
      await expect(groupClip).toBeVisible();
      const clipBox = await groupClip.boundingBox();
      if (!clipBox) throw new Error("the Group clip has no layout box");
      await page.mouse.dblclick(
        clipBox.x + clipBox.width / 2,
        clipBox.y + clipBox.height / 2,
      );

      // A Panel of its own, beside the one it was entered from — the root's is
      // not replaced.
      await expect.poll(() => openCompositionId(page)).toBe(groupId);
      await expect.poll(() => timelinePanelIds(page)).toEqual([rootId, groupId].sort());
      await expect.poll(() => visibleTimelinePanelIds(page)).toEqual([groupId]);

      // The moment did not move, and the preview follows the keyboard: the same
      // 3_966_667 is the Group's own 1_966_667 (3_966_667 − 2_000_000, re-snapped
      // to frame 59), which is inside GREEN [1 s, 2 s). Its frame is its own.
      // End is idempotent here — inside the Group it asks for local 2 s, which
      // is the film's 4 s and clamps to the same last frame — so it doubles as
      // the re-seek `settleOn` needs.
      await settleOn(page, pressEnd, `${LAST_FRAME_US} green ${GROUP_W}`);
      expect((await sample(page)).h).toBe(GROUP_H);

      // ── Lock the preview to the film ─────────────────────────────────────
      // Same moment, same keyboard target — only the picture changes, and it
      // changes to one the Group cannot draw: nothing inside it is blue.
      await page.locator(".preview-target-select").click();
      await page.locator(".app-menu-item").filter({ hasText: /^Timeline$/ }).click();
      await expect(page.locator(".preview-target-select")).toContainText("Timeline");
      await settleOn(page, pressEnd, `${LAST_FRAME_US} blue ${CANVAS.width}`);
      // The keyboard is still inside the Group. That is the whole point.
      expect(await openCompositionId(page)).toBe(groupId);

      // ── Scrub the Group's playhead; the FILM moves ───────────────────────
      // A press 60 px into the Group's own lane is 0.75 s on ITS axis at the
      // default 80 px/s — and 2.75 s on the film's, because the anchor puts the
      // Group's zero at 2 s. A Panel reading root time as its own would have
      // produced 0.75 s, which is not in the window at all.
      const groupRuler = timelinePanel(page, groupId).locator(
        '[data-testid="timeline-ruler"]',
      );
      const groupCanvas = timelinePanel(page, groupId).locator(
        '[data-testid="timeline-canvas"]',
      );
      const rulerBox = await groupRuler.boundingBox();
      const canvasBox = await groupCanvas.boundingBox();
      if (!rulerBox || !canvasBox) throw new Error("the Group's timeline has no layout box");
      // The ruler and the lane are siblings in one scroll body, so a press at
      // the lane's own origin is what the scrub measures from.
      expect(Math.abs(rulerBox.x - canvasBox.x)).toBeLessThan(2);
      const scrubGroupRuler = async () => {
        await page.mouse.click(canvasBox.x + 60, rulerBox.y + rulerBox.height / 2);
      };
      await scrubGroupRuler();

      const scrubbedUs = await playheadUs(page);
      expect(scrubbedUs).toBeGreaterThan(GROUP_START_US);
      expect(scrubbedUs).toBeLessThan(GROUP_START_US + CUT_US);
      // Still the film's picture: RED shows through, because BLUE has not
      // started yet at 2.75 s. The same pixel resolves to the same time, so the
      // press is safe to repeat while the transport comes up.
      await settleOn(page, scrubGroupRuler, `${scrubbedUs} red ${CANVAS.width}`);

      // Home and End on the Group's clock, projected up: its 0 is the film's
      // 2 s, and its 2 s is the film's 4 s, which clamps to the film's own last
      // frame.
      await settleOn(page, async () => {
        await page.keyboard.press("Home");
      }, `${GROUP_START_US} red ${CANVAS.width}`);
      await settleOn(page, pressEnd, `${LAST_FRAME_US} blue ${CANVAS.width}`);

      // ── Drag the Group's tab out: two timelines ──────────────────────────
      await dragDockTab(
        page,
        timelineDvTab(page, groupId),
        dockPanel(page, "preview"),
        "bottom",
      );
      await expect
        .poll(() => visibleTimelinePanelIds(page))
        .toEqual([rootId, groupId].sort());

      // ── A drop lands where it was released ───────────────────────────────
      // The keyboard goes back to the film's timeline first, so the two answers
      // — "the Panel that holds the keyboard" and "the Panel the drop landed
      // on" — disagree, which is the only condition under which this proves
      // anything.
      await timelinePanel(page, rootId)
        .locator('[data-testid="timeline-ruler"]')
        .click({ position: { x: 8, y: 10 } });
      await expect.poll(() => openCompositionId(page)).toBe(rootId);

      await page.waitForFunction(
        () => typeof (window as any).api?.media?.dropped === "function",
      );
      await page.evaluate((p) => (window as any).api.media.dropped([p]), IMAGE_FIXTURE);
      await expect
        .poll(async () => (await wire(page)).media.length, { timeout: 30_000 })
        .toBe(1);
      const mediaId = (await wire(page)).media[0]!.id;
      // `draggable` is the pool's own readiness gate: waiting on it keeps this
      // a gesture a user could actually perform.
      await expect(
        page.locator(`.media-item[data-media-id="${mediaId}"][draggable="true"]`),
      ).toBeVisible({ timeout: 30_000 });

      const rootLayersBefore = layersOf(rootOf(await wire(page))).length;
      const groupLayersBefore = layersOf(
        (await wire(page)).compositions[groupId]!,
      ).length;
      await beginMediaCardDrag(page, mediaId);
      await fireOnDropStrip(page, groupId, "dragover");
      await fireOnDropStrip(page, groupId, "drop");

      await expect
        .poll(
          async () => layersOf((await wire(page)).compositions[groupId]!).length,
          { timeout: 30_000 },
        )
        .toBe(groupLayersBefore + 1);
      const s3 = await wire(page);
      expect(layersOf(rootOf(s3))).toHaveLength(rootLayersBefore);
      const dropped = layersOf(s3.compositions[groupId]!).find(
        (l) => l.params.kind === "ImageOverlay",
      );
      expect(dropped, "the image landed inside the Group").toBeTruthy();
      // And it did not steal the keyboard: a drop is a destination, not a
      // navigation.
      expect(await openCompositionId(page)).toBe(rootId);

      // ── A zoom of its own per tab ────────────────────────────────────────
      // Ctrl+wheel is the per-Panel gesture: it is a DOM event on one timeline,
      // where the keyboard zoom is an app action. One deep tick parks the Group
      // on the 2000 px/s ceiling and leaves the film's tab at the default.
      // Re-measured: the tab drag moved this Panel, so the box taken before it
      // names a rectangle that is no longer there.
      const zoomBox = await groupRuler.boundingBox();
      if (!zoomBox) throw new Error("the Group's ruler has no layout box");
      await page.keyboard.down("Control");
      await page.mouse.move(
        zoomBox.x + Math.min(60, zoomBox.width / 2),
        zoomBox.y + zoomBox.height / 2,
      );
      await page.mouse.wheel(0, -3600);
      await page.keyboard.up("Control");

      await expect
        .poll(() => rulerWidthPx(page, groupId), { timeout: 15_000 })
        .toBeGreaterThan(ZOOMED_RULER_PX);
      expect(await rulerWidthPx(page, rootId)).toBeLessThan(ZOOMED_RULER_PX);

      // ── What `view.json` was left holding ────────────────────────────────
      await expect
        .poll(() => tabZoom(readViewDoc(workspaceDir), groupId), { timeout: 15_000 })
        .toBeGreaterThan(ZOOMED_RULER_PX / 10);
      await expect
        .poll(() => readViewDoc(workspaceDir)?.preview_render_target_id, {
          timeout: 15_000,
        })
        .toBe(rootId);
      const doc = readViewDoc(workspaceDir);
      expect(doc?.composition_tabs.map((t) => t.composition_id).sort()).toEqual(
        [rootId, groupId].sort(),
      );
      expect(doc?.active_composition_id).toBe(rootId);
      groupZoomPxPerSec = tabZoom(doc, groupId)!;
      rootZoomPxPerSec = tabZoom(doc, rootId)!;
      expect(groupZoomPxPerSec).not.toBe(rootZoomPxPerSec);
    } finally {
      await first.app.close();
    }

    // ── Restart: the tabs, their zooms and the lock come back ──────────────
    // The dock geometry does NOT: `workspaces.json` spans every project, so a
    // timeline Panel folds back to one slot there (ADR 0053) and the two
    // timelines return tabbed rather than split. What the project's own
    // `view.json` records is what comes back.
    const second = await launchApp({ userDataDir });
    try {
      const page = second.page;
      // The project this session just made is the newest row, and the row is
      // how a user reopens it.
      await page.locator(".startup-recent-item").first().click({ timeout: 30_000 });
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 30_000 });
      await waitForHook(page, "getOpenComposition");

      await expect
        .poll(() => timelinePanelIds(page), { timeout: 30_000 })
        .toEqual([rootId, groupId].sort());
      await expect.poll(() => timelineTabIds(page)).toEqual([rootId, groupId].sort());
      // The lock survived, and it is shown as the composition it names rather
      // than as "follow focus".
      await expect(page.locator(".preview-target-select")).toContainText("Timeline");
      await expect.poll(() => openCompositionId(page)).toBe(rootId);

      // Each tab is activated before it is measured: the Dock draws one Panel
      // of a tab group at a time, and a hidden Panel has no layout box to read a
      // ruler width off.
      await timelineDvTab(page, rootId).click();
      await expect.poll(() => visibleTimelinePanelIds(page)).toEqual([rootId]);
      expect(await rulerWidthPx(page, rootId)).toBeLessThan(ZOOMED_RULER_PX);

      // The Group's came back at the ceiling it was left on. A Panel that had
      // failed to restore would have mounted at the default — and then written
      // THAT back, which is what makes the document read below a live reading
      // rather than a file that merely survived.
      await timelineDvTab(page, groupId).click();
      await expect.poll(() => visibleTimelinePanelIds(page)).toEqual([groupId]);
      await expect
        .poll(() => rulerWidthPx(page, groupId), { timeout: 15_000 })
        .toBeGreaterThan(ZOOMED_RULER_PX);

      // The tab activation above republished the intent, so the document has
      // been rewritten from the live Panels since the restart — these are the
      // zooms the restored Panels are actually running at, not leftovers.
      await expect
        .poll(() => tabZoom(readViewDoc(workspaceDir), groupId), { timeout: 15_000 })
        .toBe(groupZoomPxPerSec);
      expect(tabZoom(readViewDoc(workspaceDir), rootId)).toBe(rootZoomPxPerSec);
    } finally {
      await second.app.close();
    }
  });
});

// ── A clip carried from one Panel into the other ────────────────────────────
//
// The gesture the side-by-side arrangement invites, and the one direction no op
// could express before `move_layers_to_composition`: OUT of a Group and back
// into the film. The destination Panel owns the whole answer — it resolves the
// landing on its own zoom and its own grid, draws the preview, and commits it —
// so every assertion below is read from the Panel it is about.

/// Where the traveller starts on the film: clear of the Group clip, on the
/// other roll, and far enough along that a landing which ignored the pointer
/// could not accidentally match it.
const TRAVELLER_START_US = 5_000_000;

/// One Panel's lane, named by both ids. With two timelines open a bare
/// `[data-track-id]` is ambiguous — the id is unique, but a locator that does
/// not say which Panel it means invites the next reader to reuse it for one
/// that is not.
const laneOf = (page: Page, compositionId: string, trackId: string): Locator =>
  timelinePanel(page, compositionId).locator(
    `[data-testid="track-lane"][data-track-id="${trackId}"]`,
  );

/// One Panel's chip for one layer. Scoped for the same reason, and because a
/// clip that has just crossed exists in exactly one of the two Panels — asking
/// the wrong one is how a cross-Panel test passes while nothing moved.
const clipOf = (page: Page, compositionId: string, layerId: string): Locator =>
  timelinePanel(page, compositionId).locator(
    `.timeline-layer[data-layer-id="${layerId}"]`,
  );

/// The preview one Panel draws for a clip carried in from the other.
const foreignGhostOf = (page: Page, compositionId: string): Locator =>
  timelinePanel(page, compositionId).locator(
    '[data-testid="timeline-foreign-ghost"]',
  );

const layerById = (c: WireComposition, id: string): WireLayer => {
  const layer = layersOf(c).find((l) => l.id === id);
  if (!layer) throw new Error(`composition ${c.id} holds no layer ${id}`);
  return layer;
};

const trackHolding = (c: WireComposition, layerId: string): string | null =>
  c.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null;

const layerIdsOf = (c: WireComposition): string[] =>
  layersOf(c)
    .map((l) => l.id)
    .sort();

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  const ids = (await page.evaluate(() =>
    (window as any).__weftcutTest.getSelectedLayerIds(),
  )) as string[];
  return ids.slice().sort();
};

/// Every translation key the status log holds. The copy refusal is a log line
/// and not a toast — this app prevents rather than interrupts — so this is
/// where a refused gesture is observable at all.
const logKeys = async (page: Page): Promise<string[]> => {
  const entries = await invokeCmd<Array<{ i18n_key?: string | null }>>(
    page,
    "log_list",
    {},
  );
  return entries.map((e) => e.i18n_key ?? "");
};

/// Take hold of a clip and carry it to a point, leaving the button DOWN: what
/// the destination draws before release is half of what is under test.
///
/// The click first is not ceremony — an unselected clip body serves a short arm
/// delay, and a drag that outran it would arrive as a plain selection click.
/// One event per protocol round trip, as `timeline-raise-to-strip.spec.ts`
/// does: fired inside one page task, React would still be uncommitted from the
/// pointerdown when the move arrived.
async function grabClipTo(
  page: Page,
  clip: Locator,
  to: { x: number; y: number },
  opts: { alt?: boolean } = {},
): Promise<void> {
  await expect(clip).toBeVisible();
  const box = await clip.boundingBox();
  if (!box) throw new Error("the dragged clip has no layout box");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Alt goes down AFTER the selecting click: held through it, the click would
  // be the link-escape select instead, and the drag's own Alt is what makes it
  // a duplicate.
  await page.mouse.click(from.x, from.y);
  if (opts.alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y);
}

async function releaseDrag(
  page: Page,
  opts: { alt?: boolean } = {},
): Promise<void> {
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up("Alt");
}

test.describe("a clip crosses between two timeline Panels", () => {
  test("a drag into the other Panel lands where the pointer said, one undo takes it back, and a refused preview sends nothing", async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-cross-panel-"),
        name: "e2e-cross-panel-drop",
        canvas: CANVAS,
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, {
        timeout: 15_000,
      });
      await waitForHook(page, "getOpenComposition");
      await waitForHook(page, "getSelectedLayerIds");

      // ── Fixture: a pre-composed pair, and one clip left outside it ───────
      // Colour layers only: where a clip lands and what an undo restores is the
      // whole subject, and nothing here waits on media.
      const s0 = await wire(page);
      const rootId = s0.root_id;
      const aRoll = trackWithRole(rootOf(s0), "a-roll");
      const bRoll = trackWithRole(rootOf(s0), "b-roll");
      const colour = (over: Record<string, unknown>) =>
        invokeCmd<string>(page, "add_color_layer", {
          durationUs: CUT_US,
          width: CANVAS.width,
          height: CANVAS.height,
          compositionId: rootId,
          ...over,
        });
      const redId = await colour({
        trackId: aRoll,
        tStartUs: GROUP_START_US,
        color: RED,
      });
      const greenId = await colour({
        trackId: aRoll,
        tStartUs: GROUP_START_US + CUT_US,
        color: GREEN,
      });
      await expect
        .poll(async () => layersOf(rootOf(await wire(page))).length)
        .toBe(2);

      // The ruler press lands focus on the timeline, which both chords need.
      await timelinePanel(page, rootId)
        .locator('[data-testid="timeline-ruler"]')
        .click({ position: { x: 120, y: 10 } });
      await page.keyboard.press(`${MOD}+A`);
      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);

      const s1 = await wire(page);
      const groupId = groupIdsOf(s1)[0]!;
      const groupLayerId = layersOf(rootOf(s1))[0]!.id;
      // Read, never assumed: pre-compose maps each former lane onto one of the
      // new composition's own, and which one is not this spec's business.
      const innerTrackId = trackHolding(s1.compositions[groupId]!, redId)!;

      // The traveller, added AFTER the pre-compose so the Select All above
      // could not have swept it in.
      const travellerId = await colour({
        trackId: bRoll,
        tStartUs: TRAVELLER_START_US,
        color: BLUE,
      });

      // ── Two timelines, side by side ─────────────────────────────────────
      const groupClip = clipOf(page, rootId, groupLayerId);
      await expect(groupClip).toBeVisible();
      const groupClipBox = await groupClip.boundingBox();
      if (!groupClipBox) throw new Error("the Group clip has no layout box");
      await page.mouse.dblclick(
        groupClipBox.x + groupClipBox.width / 2,
        groupClipBox.y + groupClipBox.height / 2,
      );
      await expect.poll(() => openCompositionId(page)).toBe(groupId);
      await dragDockTab(
        page,
        timelineDvTab(page, groupId),
        dockPanel(page, "preview"),
        "bottom",
      );
      await expect
        .poll(() => visibleTimelinePanelIds(page))
        .toEqual([rootId, groupId].sort());
      await expect(laneOf(page, groupId, innerTrackId)).toBeVisible();

      // ── Down: the film's clip into the Group ────────────────────────────
      const redClip = clipOf(page, groupId, redId);
      await expect(redClip).toBeVisible();
      const redBox = await redClip.boundingBox();
      if (!redBox) throw new Error("the Group's first clip has no layout box");
      // RED starts at the Group's own zero and lasts exactly one CUT, so its box
      // IS this Panel's origin and its seconds-to-pixels. Read rather than
      // assumed: each Panel owns its zoom (ADR 0053), and the two here differ.
      const groupPxPerCut = redBox.width;
      const freeInGroup = {
        x: redBox.x + 3 * groupPxPerCut,
        y: redBox.y + redBox.height / 2,
      };

      await grabClipTo(page, clipOf(page, rootId, travellerId), freeInGroup);
      const ghost = foreignGhostOf(page, groupId);
      await expect(ghost).toBeVisible();
      await expect(ghost).toHaveAttribute("data-validity", "valid");
      await expect(ghost).toHaveAttribute("data-track-id", innerTrackId);
      // The DESTINATION's own reading of the pointer, on its own grid. The
      // commit is asserted against this number rather than against arithmetic
      // the spec would have to repeat — and that the two agree IS the subject.
      const landingUs = Number(await ghost.getAttribute("data-start-us"));
      expect(landingUs).toBeGreaterThan(2 * CUT_US);
      await releaseDrag(page);

      await expect
        .poll(
          async () => layersOf((await wire(page)).compositions[groupId]!).length,
          { timeout: 30_000 },
        )
        .toBe(3);
      const s2 = await wire(page);
      const inner2 = s2.compositions[groupId]!;
      expect(layerById(inner2, travellerId).t_start_us).toBe(landingUs);
      expect(trackHolding(inner2, travellerId)).toBe(innerTrackId);
      // And it left the film: the Group clip is all that is left up there.
      expect(layerIdsOf(rootOf(s2))).toEqual([groupLayerId]);
      // Selection and focus followed it. That is what separates a gesture which
      // NAMED the destination from the menu, which clears and stays put.
      expect(await selectedLayerIds(page)).toEqual([travellerId]);
      await expect.poll(() => openCompositionId(page)).toBe(groupId);

      // ── One undo puts it back on its lane, at its time ──────────────────
      await page.keyboard.press(`${MOD}+Z`);
      await expect
        .poll(async () => layersOf(rootOf(await wire(page))).length, {
          timeout: 30_000,
        })
        .toBe(2);
      const s3 = await wire(page);
      expect(layerById(rootOf(s3), travellerId).t_start_us).toBe(
        TRAVELLER_START_US,
      );
      expect(trackHolding(rootOf(s3), travellerId)).toBe(bRoll);
      expect(layerIdsOf(s3.compositions[groupId]!)).toEqual(
        [redId, greenId].sort(),
      );

      // ── Up: a Group member back out into the film ───────────────────────
      // The direction no op could express before this feature — `groups_ungroup`
      // dissolved the Group and replaced every id, and no move could cross.
      const travellerClip = clipOf(page, rootId, travellerId);
      await expect(travellerClip).toBeVisible();
      const travellerBox = await travellerClip.boundingBox();
      if (!travellerBox) throw new Error("the traveller has no layout box");
      // The root Panel's own seconds-to-pixels, read the same way — two CUTs
      // past the traveller's head is free lane on the roll it sits on.
      const freeInRoot = {
        x: travellerBox.x + 2 * travellerBox.width,
        y: travellerBox.y + travellerBox.height / 2,
      };
      await grabClipTo(page, clipOf(page, groupId, redId), freeInRoot);
      const rootGhost = foreignGhostOf(page, rootId);
      await expect(rootGhost).toBeVisible();
      await expect(rootGhost).toHaveAttribute("data-validity", "valid");
      await expect(rootGhost).toHaveAttribute("data-track-id", bRoll);
      const upLandingUs = Number(await rootGhost.getAttribute("data-start-us"));
      await releaseDrag(page);

      await expect
        .poll(async () => layersOf(rootOf(await wire(page))).length, {
          timeout: 30_000,
        })
        .toBe(3);
      const s4 = await wire(page);
      expect(layerById(rootOf(s4), redId).t_start_us).toBe(upLandingUs);
      expect(trackHolding(rootOf(s4), redId)).toBe(bRoll);
      expect(layerIdsOf(s4.compositions[groupId]!)).toEqual([greenId]);
      await expect.poll(() => openCompositionId(page)).toBe(rootId);

      await page.keyboard.press(`${MOD}+Z`);
      await expect
        .poll(async () => layerIdsOf((await wire(page)).compositions[groupId]!), {
          timeout: 30_000,
        })
        .toEqual([redId, greenId].sort());

      // ── A drop on an occupied span does nothing ─────────────────────────
      const redAgain = clipOf(page, groupId, redId);
      await expect(redAgain).toBeVisible();
      const redBoxAgain = await redAgain.boundingBox();
      if (!redBoxAgain) throw new Error("the restored clip has no layout box");
      const ontoRed = {
        x: redBoxAgain.x + redBoxAgain.width / 2,
        y: redBoxAgain.y + redBoxAgain.height / 2,
      };
      await grabClipTo(page, clipOf(page, rootId, travellerId), ontoRed);
      await expect(foreignGhostOf(page, groupId)).toHaveAttribute(
        "data-validity",
        "collision",
      );
      await releaseDrag(page);

      // The red ghost is the whole explanation, and a refused preview sends
      // nothing — so there is not even an undo to make.
      const s5 = await wire(page);
      expect(trackHolding(rootOf(s5), travellerId)).toBe(bRoll);
      expect(layerById(rootOf(s5), travellerId).t_start_us).toBe(
        TRAVELLER_START_US,
      );
      expect(layerIdsOf(s5.compositions[groupId]!)).toEqual(
        [redId, greenId].sort(),
      );

      // ── Alt across Panels is refused, and says why ──────────────────────
      const freeAgain = {
        x: redBoxAgain.x + 3 * redBoxAgain.width,
        y: redBoxAgain.y + redBoxAgain.height / 2,
      };
      await grabClipTo(page, clipOf(page, rootId, travellerId), freeAgain, {
        alt: true,
      });
      // No preview at all: a copy across compositions mints ids and is a
      // mutation of its own, so there is no landing to draw truthfully.
      await expect(foreignGhostOf(page, groupId)).toHaveCount(0);
      await releaseDrag(page, { alt: true });

      await expect
        .poll(() => logKeys(page), { timeout: 30_000 })
        .toContain("log.cross_composition_copy");
      const s6 = await wire(page);
      expect(trackHolding(rootOf(s6), travellerId)).toBe(bRoll);
      expect(layerIdsOf(s6.compositions[groupId]!)).toEqual(
        [redId, greenId].sort(),
      );
    } finally {
      await app.close();
    }
  });
});
