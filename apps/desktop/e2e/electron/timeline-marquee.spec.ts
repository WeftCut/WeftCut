import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A still image is ready the moment it lands in the pool — no proxy job, so
// nothing background-dispatches while a sweep is in flight and `history.len`
// counts only what this spec asked for. `timeline-raise-to-strip.spec.ts` picks
// it for the same reason.
const FIXTURE = path.resolve(__dirname, "../fixtures/media/test_chart_320x240.png");

/// Row heights the sub-lane cases assert they actually got. Duplicated from
/// `KeyframeLane.tsx` rather than imported: an e2e spec runs outside the app's
/// module graph, and the point of stating them here is that the row was
/// MEASURED at the height the hit-test believed — a shared constant could drift
/// on both sides at once and prove nothing.
const KF_SUBLANE_H = 24;
const KF_SUBLANE_EXPANDED_H = 72;

interface Keyframe {
  id: string;
  t_us: number;
  value: number;
}

interface MarqueeSummary {
  history: { len: number };
  media: Array<{ id: string }>;
  tracks: Array<{
    id: string;
    role: string | null;
    layers: Array<{ id: string; t_start_us: number; t_end_us: number; params: Record<string, unknown> }>;
  }>;
}

const snapshot = (page: Page) => invokeCmd<MarqueeSummary>(page, "project_summary", {});

/// A layer's committed `opacity` keyframes, straight out of the summary — the
/// only observable this spec has for "which diamonds survived". Empty for a
/// track that collapsed back to Static.
function opacityKeys(s: MarqueeSummary, layerId: string): Keyframe[] {
  for (const track of s.tracks) {
    for (const layer of track.layers) {
      if (layer.id !== layerId) continue;
      const t = layer.params.opacity as { mode: string; value: Keyframe[] } | undefined;
      return t?.mode === "Keyframed" ? t.value : [];
    }
  }
  return [];
}

const keyIds = (s: MarqueeSummary, layerId: string): string[] =>
  opacityKeys(s, layerId).map((k) => k.id);

interface Pt {
  x: number;
  y: number;
}

interface Rect extends Pt {
  w: number;
  h: number;
  cx: number;
  cy: number;
  right: number;
  bottom: number;
}

async function rectOf(l: Locator): Promise<Rect> {
  const b = await l.boundingBox();
  if (!b) throw new Error("element has no layout box");
  return {
    x: b.x,
    y: b.y,
    w: b.width,
    h: b.height,
    cx: b.x + b.width / 2,
    cy: b.y + b.height / 2,
    right: b.x + b.width,
    bottom: b.y + b.height,
  };
}

/// Create the project, put the fixture in the pool, and maximize the Timeline
/// Panel. Returns the pool id and the blank skeleton's two track ids in DATA
/// order.
///
/// Import WITHOUT placing, because every case here needs several clips on lanes
/// it chooses: `importAndPlaceMedia` mints a fresh lane per clip, and a fresh
/// lane carries no role, which the default A/B Roll filter then hides.
///
/// Maximizing is not cosmetic and it happens while the timeline is still empty
/// on purpose. Three of the four cases need a lane band, a 72 px sub-lane row
/// and several hundred px of ruler on screen at once, which the default layout's
/// share of a 1440×900 window does not reliably give; and the gesture that
/// maximizes starts with a click, which on a populated timeline could land on a
/// chip or the ruler instead of blank space.
async function openTimeline(
  page: Page,
  tag: string,
): Promise<{ mediaId: string; trackIds: string[]; panel: Locator }> {
  await newProject(page, {
    parentFolder: tmpDir(`weftcut-e2e-marquee-${tag}-`),
    name: `e2e-marquee-${tag}-` + Date.now(),
    canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
  });
  // REQUIRED before any pointer gesture: the launch splash is a full-window
  // overlay that outlives the first timeline render, so every mouse event below
  // would land on it instead of a lane.
  await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

  await page.waitForFunction(
    () => typeof (window as any).api?.media?.dropped === "function",
  );
  await page.evaluate((p) => (window as any).api.media.dropped([p]), FIXTURE);
  await expect
    .poll(async () => (await snapshot(page)).media.length, { timeout: 30_000 })
    .toBe(1);

  const s = await snapshot(page);
  // The blank skeleton: `tracks[0]` is A roll, `tracks[1]` is B roll, both
  // role-stamped and therefore both RENDERED under the default A/B Roll filter.
  // `visualOrderedTracks` reverses the data order, so `tracks[1]` draws ABOVE
  // `tracks[0]` — which is what lets a case put its expanded track over the lane
  // it sweeps without touching the display mode.
  expect(s.tracks.map((t) => t.role)).toEqual(["a-roll", "b-roll"]);

  const panel = dockPanel(page, "timeline");
  await expect(panel).toBeVisible();
  await waitForHook(page, "dockWorkspaceProbe");
  // Click first so the window's keyboard focus sits on a non-editable surface —
  // the same precondition `dock-integration-acceptance.spec.ts` establishes for
  // the focus/maximize chords. On the empty timeline the click is a zero-travel
  // marquee, i.e. the background click, clearing a selection that is already
  // empty.
  await panel.click();
  await page.keyboard.press("Backquote");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__weftcutTest.dockWorkspaceProbe()?.maximizedPanel ?? null,
      ),
    )
    .toBe("timeline");

  return { mediaId: s.media[0]!.id, trackIds: s.tracks.map((t) => t.id), panel };
}

/// Place the pooled image on `trackId` at `tStartUs`. A still gets a 3 s span,
/// so at the default 80 px/s every clip below is 240 px wide.
const place = (page: Page, trackId: string, mediaId: string, tStartUs: number) =>
  invokeCmd<string>(page, "add_media_layer", { trackId, mediaId, tStartUs });

/// Write `keys` as the layer's `opacity` track. Layer-local times are whole
/// 30 fps frames, so the actor's grid snap is the identity and the ids come back
/// verbatim — which is what lets every assertion below name a diamond.
const keyOpacity = (
  page: Page,
  layerId: string,
  keys: ReadonlyArray<{ id: string; t_us: number; value: number }>,
) =>
  invokeCmd(page, "update_layer_param_track", {
    layerId,
    paramKey: "opacity",
    // Linear throughout: `computeValueRange` samples eased segments for
    // overshoot, and a padded range derived from a curve nobody asked about
    // would move the diamonds' y for a reason the case is not testing.
    track: {
      mode: "Keyframed",
      value: keys.map((k) => ({ ...k, interp: { kind: "Linear" } })),
    },
  });

/// Open the one track that has keyframes, and return its single sub-lane row.
/// The twirl is `disabled` on a track with none, so the enabled one names itself
/// — no index a change in row order could strand.
async function expandKeyframeLane(page: Page): Promise<Locator> {
  const twirl = page.locator('[data-testid="kf-lane-twirl"]:not([disabled])');
  await expect(twirl).toHaveCount(1);
  await twirl.click();
  const row = page.locator('[data-testid="kf-sublane"]');
  await expect(row).toHaveCount(1);
  return row;
}

const diamond = (page: Page, kfId: string) =>
  page.locator(`.kf-sublane-diamond[data-kf-id="${kfId}"]`);

/// Both endpoints of a sweep must stay clear of the horizontal auto-scroll bands
/// — 28 px inside the scroll host on the right, and on the left measured from the
/// sticky header column's RIGHT edge, which is the canvas's left edge while
/// scrollLeft is 0. Inside a band the rAF pump keeps growing the box under a
/// pointer that has stopped, so it would take more than the case describes. This
/// is one guard in one place rather than a pair of assertions per case, and it is
/// what turns "this Panel is too narrow for the gesture on this OS" into a
/// pointed failure instead of a mystery selection.
async function assertClearOfAutoScroll(page: Page, ...points: Pt[]): Promise<void> {
  const bounds = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="timeline-canvas"]');
    const host = canvas?.closest(".overflow-auto");
    if (!canvas || !host) return null;
    return {
      canvasLeft: canvas.getBoundingClientRect().left,
      hostRight: host.getBoundingClientRect().right,
    };
  });
  expect(bounds, "timeline canvas and its scroll host must both be mounted").not.toBeNull();
  for (const p of points) {
    expect(p.x).toBeGreaterThan(bounds!.canvasLeft + 30);
    expect(p.x).toBeLessThan(bounds!.hostRight - 40);
  }
}

/// A real pointer sweep: press, several moves, release. One `page.mouse` call
/// per step, because the gesture recomputes the selection from scratch on every
/// pointermove — firing the sequence inside one page task would leave React
/// uncommitted between them, so the box the press began would not exist yet when
/// the move arrived.
///
/// The overlay assertion after the FIRST step is what separates "the box never
/// armed" from "the box armed and took nothing", and it reads `data-kind` because
/// the anchor surface — not the geometry — is what decides which population the
/// box is sweeping (ADR 0051).
async function dragBox(
  page: Page,
  from: Pt,
  to: Pt,
  kind: "clip" | "keyframe",
): Promise<void> {
  await assertClearOfAutoScroll(page, from, to);
  const overlay = page.locator('[data-testid="timeline-marquee"]');
  const steps = 4;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
      );
      if (i === 1) await expect(overlay).toHaveAttribute("data-kind", kind);
    }
  } finally {
    await page.mouse.up();
  }
  await expect(overlay).toHaveCount(0);
}

const selectedLayerId = async (page: Page): Promise<string | null> => {
  await waitForHook(page, "getSelectedLayerId");
  return page.evaluate(() => (window as any).__weftcutTest.getSelectedLayerId());
};

// Everything about the marquee's RULES is already covered twice over — by pure
// functions fed hand-written rows (`timeline/marquee.test.ts`) and by jsdom with
// mocked rects (`Timeline.interaction.test.tsx`). This spec covers the one class
// neither can touch: whether the rectangle the code measures is the rectangle it
// believes it measured.
//
// That is `geometry.ts`'s `trackIdAtClientY` LANDMINE verbatim — an arithmetic
// y-table that drifted a full row per expanded track and passed every unit test
// in the repo, because a mocked rect supplies the number the code is supposed to
// derive. The marquee has four such beliefs, each of which passes a mocked test
// while being wrong: lane rows need the canvas's own `top` subtracted, chip x is
// already canvas-relative and must NOT be adjusted, `valueToY` is row-local and
// needs the row's measured top added back, and a row must be measured at its
// real height. So the assertions here are few and layout-dependent, and no rule
// is re-tested.
test.describe("timeline marquee — the rectangles are the ones we think they are", () => {
  test.skip(
    !existsSync(FIXTURE),
    `image fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  );

  test("a clip box sweeps the lane under an expanded track, and one gesture stays one op", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaId, trackIds } = await openTimeline(page, "clips");
      // `lower` draws BELOW `upper` (see openTimeline). The swept lane carries
      // two clips; the lane ABOVE it carries the third, over the SAME x span.
      // That is what makes the case discriminating: the expanded track's
      // sub-lane strip sits between the two lanes, so an arithmetic y-table
      // would put every band below it a full row out — and the box would take
      // the wrong lane's clip, or nothing at all.
      const [lower, upper] = trackIds as [string, string];
      const keyed = await place(page, upper, mediaId, 1_000_000);
      const first = await place(page, lower, mediaId, 1_000_000);
      const second = await place(page, lower, mediaId, 4_000_000);
      await keyOpacity(page, keyed, [
        { id: "kx-0", t_us: 0, value: 1 },
        { id: "kx-1", t_us: 1_000_000, value: 0 },
      ]);

      const chips = page.locator(".timeline-layer");
      await expect(chips).toHaveCount(3, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      // Focus the property so the row opens to `KF_SUBLANE_EXPANDED_H`. A 24 px
      // strip would leave the swept lane's chip band still overlapping the band
      // an unadjusted table computes, so the case would pass either way; at
      // 72 px the drifted reading selects nothing and the test fails when it
      // should. The navigator's ► is the surface that moves focus without
      // touching the timeline body.
      await page.locator('[data-testid="kf-nav-next"]').click();
      await expect
        .poll(async () => Math.round((await rectOf(row)).h))
        .toBe(KF_SUBLANE_EXPANDED_H);

      const lanes = page.locator('[data-testid="track-lane"]');
      await expect(lanes).toHaveCount(2);
      const top = await rectOf(lanes.nth(0));
      const bottom = await rectOf(lanes.nth(1));
      const strip = await rectOf(row);
      // The configuration this case is about, asserted rather than assumed.
      expect(strip.y).toBeGreaterThanOrEqual(top.bottom - 1);
      expect(strip.bottom).toBeLessThanOrEqual(bottom.y + 1);

      // Sort the three chips by the lane they landed on, using the strip as the
      // divider — the ids come from the placement, the positions from the DOM,
      // and this is where the two are made to agree.
      const boxes = await Promise.all([0, 1, 2].map((i) => rectOf(chips.nth(i))));
      const swept = boxes.filter((b) => b.cy > strip.bottom).sort((a, b) => a.x - b.x);
      const above = boxes.filter((b) => b.cy < strip.y);
      expect(swept).toHaveLength(2);
      expect(above).toHaveLength(1);
      // The survivor starts at the same x as the first swept clip, so a row that
      // drifted upward by the strip's height would take IT.
      expect(Math.abs(above[0]!.x - swept[0]!.x)).toBeLessThan(2);

      // Blank lane space to the left of the first swept chip, down and across to
      // inside the second one. Both endpoints stay in the swept lane's chip band,
      // and the box has extent on BOTH axes — the hit-test is half-open, so a
      // zero-height sweep takes nothing.
      const from = { x: swept[0]!.x - 35, y: bottom.y + 12 };
      const to = { x: swept[1]!.x + 15, y: bottom.y + 44 };
      expect(to.y - from.y).toBeGreaterThan(8);
      expect(to.y).toBeLessThan(bottom.bottom);

      const before = await snapshot(page);
      await dragBox(page, from, to, "clip");

      await page.keyboard.press("Delete");
      // What the delete LEFT is the observable: a LayerBlock carries no layer
      // id, so the swept SET is only ever visible from outside the renderer
      // through what the op did with it. Asserting the whole surviving set at
      // once is what makes both directions fail — a box that over-reached into
      // the lane above would take `keyed`, and one that under-reached would
      // leave `first` or `second` standing.
      const survivors = (s: MarqueeSummary): string[] =>
        s.tracks.flatMap((t) => t.layers).map((l) => l.id).sort();
      await expect
        .poll(async () => survivors(await snapshot(page)).join(","), { timeout: 20_000 })
        .toBe(keyed);

      const after = await snapshot(page);
      expect([first, second].filter((id) => survivors(after).includes(id))).toEqual([]);
      // The whole point of `delete_layers`: one gesture is one undo entry, and
      // the cheap guard against it decomposing into a `delete_layer` per clip.
      expect(after.history.len).toBe(before.history.len + 1);
    } finally {
      await app.close();
    }
  });

  test("a collapsed sub-lane box sweeps keyframes across two layers, and Delete is one undo entry", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaId, trackIds } = await openTimeline(page, "kf-collapsed");
      // Both clips on ONE track, so its single `opacity` row draws the diamonds
      // of both layers — the geometry that forces the selection to be
      // cross-layer, with no unusual gesture on the user's part.
      const lane = trackIds[0]!;
      const early = await place(page, lane, mediaId, 1_000_000);
      const late = await place(page, lane, mediaId, 5_000_000);
      await keyOpacity(page, early, [
        { id: "a0", t_us: 0, value: 1 },
        { id: "a1", t_us: 1_000_000, value: 0.75 },
        { id: "a2", t_us: 2_000_000, value: 0.5 },
      ]);
      await keyOpacity(page, late, [
        { id: "b0", t_us: 0, value: 0.5 },
        { id: "b1", t_us: 1_000_000, value: 0.25 },
        { id: "b2", t_us: 2_000_000, value: 0 },
      ]);

      await expect(page.locator(".timeline-layer")).toHaveCount(2, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      await expect(page.locator(".kf-sublane-diamond")).toHaveCount(6);
      // Left COLLAPSED — no focus, no `kf-nav-next` click. A collapsed row
      // hit-tests x alone against any vertical overlap with its band, and the
      // height is the input that rule reads, so the case is only the case at 24.
      const band = await rectOf(row);
      expect(Math.round(band.h)).toBe(KF_SUBLANE_H);

      // The box's x bounds are the MIDPOINTS between measured diamonds, so what
      // it takes is decided by where the dots actually drew rather than by this
      // spec re-deriving `timeToXPx`.
      const a1 = await rectOf(diamond(page, "a1"));
      const a2 = await rectOf(diamond(page, "a2"));
      const b1 = await rectOf(diamond(page, "b1"));
      const b2 = await rectOf(diamond(page, "b2"));
      const from = { x: (a1.cx + a2.cx) / 2, y: band.y + 6 };
      const to = { x: (b1.cx + b2.cx) / 2, y: band.y + 18 };
      // The press must not land on a diamond — that starts a dot drag, which
      // stops its own pointerdown and never reaches the row's anchor.
      expect(Math.abs(from.x - a1.cx)).toBeGreaterThan(a1.w);
      expect(Math.abs(from.x - a2.cx)).toBeGreaterThan(a2.w);

      const before = await snapshot(page);
      await dragBox(page, from, to, "keyframe");
      await page.keyboard.press("Delete");

      // `a2` from one layer and `b0`+`b1` from the other: the box crossed a layer
      // boundary the user never had to think about.
      await expect
        .poll(async () => keyIds(await snapshot(page), early).join(","), {
          timeout: 20_000,
        })
        .toBe("a0,a1");
      const after = await snapshot(page);
      expect(keyIds(after, late)).toEqual(["b2"]);
      // The cross-layer op's contract, observed from outside: one entry for one
      // gesture, however many layers it spanned.
      expect(after.history.len).toBe(before.history.len + 1);

      await invokeCmd(page, "project_undo", {});
      const undone = await snapshot(page);
      expect(keyIds(undone, early)).toEqual(["a0", "a1", "a2"]);
      expect(keyIds(undone, late)).toEqual(["b0", "b1", "b2"]);
    } finally {
      await app.close();
    }
  });

  test("an expanded sub-lane box takes the low keys and leaves the high one", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaId, trackIds } = await openTimeline(page, "kf-value-axis");
      const clip = await place(page, trackIds[0]!, mediaId, 1_000_000);
      // 0 → 1 → 0, so the three dots draw at two distinctly different heights.
      await keyOpacity(page, clip, [
        { id: "lo-in", t_us: 0, value: 0 },
        { id: "hi", t_us: 1_000_000, value: 1 },
        { id: "lo-out", t_us: 2_000_000, value: 0 },
      ]);

      await expect(page.locator(".timeline-layer")).toHaveCount(1, { timeout: 20_000 });
      const row = await expandKeyframeLane(page);
      await page.locator('[data-testid="kf-nav-next"]').click();
      await expect
        .poll(async () => Math.round((await rectOf(row)).h))
        .toBe(KF_SUBLANE_EXPANDED_H);
      const band = await rectOf(row);

      const hi = await rectOf(diamond(page, "hi"));
      const loIn = await rectOf(diamond(page, "lo-in"));
      const loOut = await rectOf(diamond(page, "lo-out"));
      // The value axis is real and inverted: equal values draw at one y, and a
      // higher opacity draws HIGHER on screen. Stated first, because everything
      // below aims at the gap this asserts exists.
      expect(Math.abs(loIn.cy - loOut.cy)).toBeLessThan(2);
      expect(hi.cy).toBeLessThan(loIn.cy - 20);

      // The full time range in x, but only the row's LOWER portion in y: from
      // just inside the row's bottom edge up to halfway between the low keys and
      // the high one.
      const yLow = band.bottom - 2;
      const yMid = (loIn.cy + hi.cy) / 2;
      expect(yLow).toBeGreaterThan(loIn.cy + 1);
      expect(yMid).toBeGreaterThan(hi.cy + 5);
      expect(yMid).toBeLessThan(loIn.cy - 5);
      const from = { x: loOut.cx + 40, y: yLow };
      const to = { x: loIn.cx - 30, y: yMid };
      expect(Math.abs(from.x - loOut.cx)).toBeGreaterThan(loOut.w);

      const before = await snapshot(page);
      await dragBox(page, from, to, "keyframe");
      await page.keyboard.press("Delete");

      // The whole case, in one assertion. It fails if `vmin`/`vmax` came from the
      // wrong keys, if the row-local-to-canvas subtraction is off, if the
      // diamond's centre was read as its top edge (the `margin-top: -3.5px`
      // cancellation), or if the row was measured at the collapsed height — and
      // every one of those passes a mocked-rect test.
      await expect
        .poll(async () => keyIds(await snapshot(page), clip).join(","), {
          timeout: 20_000,
        })
        .toBe("hi");
      expect((await snapshot(page)).history.len).toBe(before.history.len + 1);
    } finally {
      await app.close();
    }
  });

  test("the band below the last track anchors a box, and clears on a click", async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      const { mediaId, trackIds, panel } = await openTimeline(page, "band");
      const clip = await place(page, trackIds[0]!, mediaId, 1_000_000);
      const chipEl = page.locator(".timeline-layer");
      await expect(chipEl).toHaveCount(1, { timeout: 20_000 });

      const lanes = page.locator('[data-testid="track-lane"]');
      await expect(lanes).toHaveCount(2);
      const last = await rectOf(lanes.nth(1));
      const chip = await rectOf(chipEl.first());
      const panelBox = await rectOf(panel);
      // `min-h-full` on the lanes' container is what hands the leftover space to
      // the scrolling body, which is already the `clip` anchor. Owned by the
      // scroll ROOT instead, that band reached no anchor at all and was dead.
      // jsdom has no layout, so this is the only layer that can see it.
      expect(panelBox.bottom - last.bottom).toBeGreaterThan(120);
      const bandY = last.bottom + 60;

      // Press in the band, drag UP across the clip — sideways too, because a
      // box with zero width takes nothing by the same half-open rule that makes
      // a box abutting a chip's edge leave it alone.
      await dragBox(
        page,
        { x: chip.cx - 30, y: bandY },
        { x: chip.cx + 30, y: chip.cy },
        "clip",
      );
      expect(await selectedLayerId(page)).toBe(clip);

      // Press and release in the same band with no travel: below the 3 px arm
      // threshold the gesture IS the background click, which is now the only
      // path that clears from the background (the root's `onClick` is gone).
      await page.mouse.move(chip.cx, bandY);
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => selectedLayerId(page)).toBeNull();

      // Park the playhead in open lane space so the knock-on effect below is
      // measurable away from the header column's edge — and visible in the
      // screenshot.
      await waitForHook(page, "transportSeekUs");
      await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(2_500_000));

      // The two knock-on effects of that `min-h-full`, measured rather than
      // eyeballed: the playhead line and the header column's right divider run
      // the Panel's full height instead of stopping at the last lane, which is
      // what every other NLE does.
      const playhead = await rectOf(page.locator('[data-testid="timeline-playhead"]'));
      expect(playhead.bottom).toBeGreaterThan(last.bottom + 100);
      const headerColumnBottom = await page.evaluate(() => {
        const corner = document.querySelector('[data-testid="timeline-ruler-corner"]');
        return corner?.parentElement?.getBoundingClientRect().bottom ?? null;
      });
      expect(headerColumnBottom).not.toBeNull();
      expect(headerColumnBottom!).toBeGreaterThan(last.bottom + 100);

      // Attached, not compared: there is no baseline to diff against, and the
      // question a human asked of this change ("does the full-height playhead
      // look right?") is not one a pixel assertion answers.
      const shot = test.info().outputPath("band-below-last-track.png");
      await panel.screenshot({ path: shot });
      await test.info().attach("band-below-last-track", {
        path: shot,
        contentType: "image/png",
      });
    } finally {
      await app.close();
    }
  });
});
