import { expect, test, type Locator, type Page } from "@playwright/test";
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from "./helpers/driver";

/**
 * *Move to… ›* — the crossing reached by NAMING a destination
 * (spec § Group semantics, ADR 0052 and ADR 0053).
 *
 * One timeline Panel throughout. Entering a Group swaps which composition the
 * Panel shows, and that is the point of this gesture: carrying clips out of a
 * Group and back into the film needs no second timeline, no split, and no
 * pointer aimed at a destination.
 *
 * Colour layers only, so nothing here waits on media: where clips land and what
 * an undo restores is the whole subject, and a linked pair says everything a
 * decoded one would.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
/// The suite's spelling of the catalogue's `Mod` token (search-palette.spec.ts).
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const PROJECT_NAME = "e2e-move-to-composition";
/// Where the film's playhead stands when the clips are moved: a frame boundary
/// at 30 fps, so the destination's re-snap is the identity and a wrong landing
/// cannot hide inside a rounding.
const PLAYHEAD_US = 1_000_000;

/// Only the fields this spec reads.
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
  links: Array<{ id: string; layer_ids: string[] }>;
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

const groupIdsOf = (s: Wire): string[] =>
  Object.keys(s.compositions).filter((id) => id !== s.root_id);

const layersOf = (c: WireComposition): WireLayer[] =>
  c.tracks.flatMap((t) => t.layers);

const layerById = (c: WireComposition, id: string): WireLayer => {
  const layer = layersOf(c).find((l) => l.id === id);
  if (!layer) throw new Error(`composition ${c.id} holds no layer ${id}`);
  return layer;
};

const trackHolding = (c: WireComposition, layerId: string): string | null =>
  c.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null;

const trackWithRole = (c: WireComposition, role: string): string => {
  const track = c.tracks.find((t) => t.role === role);
  if (!track) throw new Error(`the skeleton carries no ${role} lane`);
  return track.id;
};

/// The layer ids of the link holding `layerId`, sorted — `[]` when nothing does.
const linkMembersOf = (c: WireComposition, layerId: string): string[] =>
  (c.links.find((l) => l.layer_ids.includes(layerId))?.layer_ids ?? [])
    .slice()
    .sort();

const selectedLayerIds = async (page: Page): Promise<string[]> => {
  const ids = (await page.evaluate(() =>
    (window as any).__weftcutTest.getSelectedLayerIds(),
  )) as string[];
  return ids.slice().sort();
};

const openComposition = (page: Page): Promise<{ id: string } | null> =>
  page.evaluate(() => (window as any).__weftcutTest.getOpenComposition());

const clip = (page: Page, layerId: string): Locator =>
  page.locator(`.timeline-layer[data-layer-id="${layerId}"]`);

// Raw pointer at the centre rather than `locator.click()`: that scrolls the
// target into view first, and the scroll can slide a clip under the sticky
// header column (group-timeline.spec.ts).
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

const rightClickCentre = async (page: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no layout box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
};

/// Park the film on `us` and wait for the store to agree. The seek is re-issued
/// every round because `transportSeek` on a not-yet-registered transport is a
/// SILENT no-op, so retrying IS the readiness wait (group-render-nested.spec.ts).
async function seekAndSettle(page: Page, us: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(
          (t) => (window as any).__weftcutTest.transportSeekUs(t),
          us,
        );
        return page.evaluate(() =>
          (window as any).__weftcutTest.getPlayheadUs(),
        );
      },
      { timeout: 20_000 },
    )
    .toBe(us);
}

test.describe("Move to…", () => {
  test("the clip menu carries a selection out of a Group to the film's playhead, and one undo takes it back", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await newProject(page, {
        parentFolder: tmpDir("weftcut-e2e-move-to-comp-"),
        name: PROJECT_NAME,
        canvas: CANVAS,
      });
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render.
      await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });
      await waitForHook(page, "getSelectedLayerIds");
      await waitForHook(page, "getOpenComposition");
      await waitForHook(page, "transportSeekUs");
      await waitForHook(page, "getPlayheadUs");

      // ── Fixture: a linked pair on the B roll, pre-composed ───────────────
      // Away from t = 0 and apart from each other, so a landing that ignored
      // either the playhead or the set's mutual geometry could not pass.
      const s0 = await wire(page);
      const bRoll = trackWithRole(rootOf(s0), "b-roll");
      const aId = await invokeCmd<string>(page, "add_color_layer", {
        trackId: bRoll,
        tStartUs: 3_000_000,
        durationUs: 1_000_000,
      });
      const bId = await invokeCmd<string>(page, "add_color_layer", {
        trackId: bRoll,
        tStartUs: 5_000_000,
        durationUs: 1_000_000,
      });
      await invokeCmd(page, "links_create", { layerIds: [aId, bId] });
      const pair = [aId, bId].sort();

      // The click selects the whole link, AND lands focus on the timeline,
      // which the timeline-scoped chord needs.
      await expect(clip(page, aId)).toBeVisible();
      await clickCentre(page, clip(page, aId));
      expect(await selectedLayerIds(page)).toEqual(pair);
      await page.keyboard.press(`${MOD}+G`);
      await expect.poll(async () => groupIdsOf(await wire(page)).length).toBe(1);

      const s1 = await wire(page);
      const groupId = groupIdsOf(s1)[0]!;
      const groupLayer = layersOf(rootOf(s1)).find(
        (l) => l.params.kind === "CompositionRef",
      )!;
      const inner0 = s1.compositions[groupId]!;
      // Read rather than assumed: pre-compose rebases the set onto the new
      // composition's own zero, and the phase between the two members is what
      // the move has to preserve.
      const phaseUs =
        layerById(inner0, bId).t_start_us - layerById(inner0, aId).t_start_us;
      const innerTrackId = trackHolding(inner0, aId);
      expect(linkMembersOf(inner0, aId)).toEqual(pair);

      // ── Park the film, then enter the Group ──────────────────────────────
      // The seek happens with the ROOT focused, so the transport's clock and
      // the film's are the same one; entering a Group afterwards changes which
      // composition reads that moment, never the moment itself (ADR 0053 §2).
      await seekAndSettle(page, PLAYHEAD_US);
      await doubleClickCentre(page, clip(page, groupLayer.id));
      await expect.poll(() => openComposition(page)).toMatchObject({ id: groupId });

      // ── Select the pair inside and open the submenu ──────────────────────
      await expect(clip(page, aId)).toBeVisible();
      await clickCentre(page, clip(page, aId));
      expect(await selectedLayerIds(page)).toEqual(pair);
      await rightClickCentre(page, clip(page, aId));
      // HOVER, not click: Base UI opens a submenu through hover intent, and a
      // popup opened by a right-click only admits mouse-enter once the pointer
      // has moved inside it (`TransitionUi.test.tsx` records the same machinery
      // as the reason its submenu content is untestable under jsdom). A click
      // on the trigger races that gate and dismisses the whole menu.
      await page
        .locator(".app-submenu-trigger")
        .filter({ hasText: /^Move to…$/ })
        .hover();

      // The root is named as the film's own timeline: it has no name of its
      // own. Waited for before anything is asserted about the submenu, since
      // its popup is portalled and mounts on open.
      const rootRow = page.locator(".app-menu-item").filter({ hasText: /^Timeline$/ });
      await expect(rootRow).toBeVisible();

      // The composition the clips are already in is a ROW, greyed and saying
      // so — a missing row would teach nothing about where they are.
      await expect(
        page.locator(".app-menu-item[data-disabled]").filter({ hasText: /^Group 1$/ }),
      ).toHaveCount(1);
      await expect(
        page.locator(".app-menu-item").filter({ hasText: /^Group 1$/ }),
      ).toHaveAttribute("title", /already here/i);

      await rootRow.click();

      // ── They arrive at the film's playhead, on a lane that was free ──────
      await expect
        .poll(async () => layersOf(rootOf(await wire(page))).length)
        .toBe(3);
      const s2 = await wire(page);
      const root2 = rootOf(s2);
      expect(layerById(root2, aId).t_start_us).toBe(PLAYHEAD_US);
      expect(layerById(root2, bId).t_start_us).toBe(PLAYHEAD_US + phaseUs);
      expect(layerById(root2, aId).t_end_us - layerById(root2, aId).t_start_us).toBe(
        1_000_000,
      );
      // One source track, so one destination lane — and nothing else on it
      // overlaps them, which is what "a lane that was free" means.
      const landedOn = trackHolding(root2, aId);
      expect(trackHolding(root2, bId)).toBe(landedOn);
      const neighbours = root2.tracks
        .find((t) => t.id === landedOn)!
        .layers.filter((l) => l.id !== aId && l.id !== bId);
      for (const other of neighbours) {
        for (const moved of [layerById(root2, aId), layerById(root2, bId)]) {
          expect(
            other.t_start_us >= moved.t_end_us || other.t_end_us <= moved.t_start_us,
          ).toBe(true);
        }
      }
      // The link came with them.
      expect(linkMembersOf(root2, aId)).toEqual(pair);
      expect(layersOf(s2.compositions[groupId]!)).toHaveLength(0);

      // The layers left this composition, so the selection cannot survive; the
      // view stays where the gesture happened, because the user never pointed
      // at the destination.
      expect(await selectedLayerIds(page)).toEqual([]);
      await expect.poll(() => openComposition(page)).toMatchObject({ id: groupId });

      // ── One Ctrl+Z restores their lane, their times and their link ───────
      await page.keyboard.press(`${MOD}+Z`);
      await expect
        .poll(async () => layersOf((await wire(page)).compositions[groupId]!).length)
        .toBe(2);
      const s3 = await wire(page);
      const inner3 = s3.compositions[groupId]!;
      expect(layerById(inner3, aId).t_start_us).toBe(
        layerById(inner0, aId).t_start_us,
      );
      expect(layerById(inner3, bId).t_start_us).toBe(
        layerById(inner0, bId).t_start_us,
      );
      expect(trackHolding(inner3, aId)).toBe(innerTrackId);
      expect(trackHolding(inner3, bId)).toBe(innerTrackId);
      expect(linkMembersOf(inner3, aId)).toEqual(pair);
      expect(layersOf(rootOf(s3)).map((l) => l.id)).toEqual([groupLayer.id]);
    } finally {
      await app.close();
    }
  });
});
