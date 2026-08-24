import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import { launchApp, newProject, tmpDir } from "./helpers/driver";

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };

/// Wide enough that the default contextual Group has room to spare, then narrow
/// enough that it cannot hold its tabs. The narrow width is past the point where
/// the Group stops shrinking (Dockview clamps it), so anything narrower measures
/// identically — no threshold is being tuned here.
const ROOMY_PX = 1280;
const SQUEEZED_PX = 620;

interface StripTab {
  kind: string;
  start: number;
  end: number;
  width: number;
  /// Its label overflows its own box, so the ellipsis rule has fired.
  truncated: boolean;
  active: boolean;
}

/**
 * A Group's tab strip, measured. Every number the assertions use comes from the
 * DOM itself — the overlay's own width, each tab's computed `min-width` — because
 * tab widths are font metrics and those differ across the three CI platforms.
 * Anything compared against a literal here would be a threshold that holds on
 * one runner and flakes on the others.
 */
interface StripProbe {
  scrollStart: number;
  viewportSize: number;
  contentSize: number;
  overlaySize: number;
  edges: string[];
  tabs: StripTab[];
}

function probeStrip(group: Locator): Promise<StripProbe> {
  return group.evaluate((el) => {
    const scroller = el.querySelector<HTMLElement>(".dv-tabs-container");
    if (!scroller) throw new Error("group has no tab strip");
    const overlays = [...el.querySelectorAll<HTMLElement>(".weft-tabstrip-edge")];
    return {
      scrollStart: scroller.scrollLeft,
      viewportSize: scroller.clientWidth,
      contentSize: scroller.scrollWidth,
      // Read off the rendered overlay rather than restated: the component sizes
      // itself from the one constant the geometry also reads.
      overlaySize: overlays[0]?.getBoundingClientRect().width ?? 0,
      edges: overlays.map((o) => o.dataset.toward ?? "").sort(),
      tabs: [...scroller.querySelectorAll<HTMLElement>(":scope > .dv-tab")].map((tab) => {
        const label = tab.querySelector<HTMLElement>(".weft-dock-tab-label");
        return {
          kind:
            tab.querySelector<HTMLElement>("[data-panel-kind]")?.dataset.panelKind ?? "",
          start: tab.offsetLeft,
          end: tab.offsetLeft + tab.offsetWidth,
          width: tab.offsetWidth,
          // The label's own overflow, not the tab's width against a number: the
          // claim is about the text, and only the text can report on it.
          truncated: label ? label.scrollWidth > label.clientWidth + 0.5 : false,
          active: tab.classList.contains("dv-active-tab"),
        };
      }),
    };
  });
}

/// The band a reader can actually use: the viewport minus whichever overlays are
/// painted right now.
function band(probe: StripProbe): [number, number] {
  const leading = probe.edges.includes("start") ? probe.overlaySize : 0;
  const trailing = probe.edges.includes("end") ? probe.overlaySize : 0;
  return [
    probe.scrollStart + leading,
    probe.scrollStart + probe.viewportSize - trailing,
  ];
}

function readable(probe: StripProbe, kind: string): boolean {
  const tab = probe.tabs.find((t) => t.kind === kind);
  if (!tab) return false;
  const [from, to] = band(probe);
  return tab.start >= from - 0.5 && tab.end <= to + 0.5;
}

const edgeButton = (page: Page, toward: "start" | "end"): Locator =>
  page.locator(`.weft-tabstrip-edge[data-toward="${toward}"] > button`);

async function setWindowWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setBounds({ x: 0, y: 0, width: w, height: 800 });
  }, width);
}

/**
 * Overflow on a tab strip is announced at BOTH ends by a floating overlay, and
 * nowhere else — the hidden-tabs dropdown is gone, and reaching a Panel by name
 * belongs to the View menu (ADR 0050).
 *
 * This has to be an e2e: jsdom reports every layout measurement as zero, so
 * "does it overflow", "where does a step land" and "did an activated tab come to
 * rest under the overlay" have no meaning there. The geometry underneath is
 * unit-tested in `lib/edgeOverflow.test.ts`; what this checks is that it is
 * wired to a real strip.
 */
test("a squeezed tab strip keeps every title whole and announces both ends", async () => {
  const { app, page } = await launchApp();
  try {
    // The layout is built for whatever viewport is current, so pin the window
    // BEFORE the project opens.
    await setWindowWidth(app, ROOMY_PX);
    await newProject(page, {
      parentFolder: tmpDir("weftcut-tab-overflow-"),
      name: "dock-tab-overflow",
      canvas: CANVAS,
    });
    // REQUIRED before any pointer gesture: the splash overlay outlives the first
    // dock render and swallows mousedown while the target is visible.
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

    const group = page
      .locator(".dv-groupview")
      .filter({ has: page.locator('.weft-dock-tab[data-panel-kind="attribute"]') });

    // ① A strip with room to spare is visually untouched: no gradient, no arrow.
    // The contextual Group ships two tabs — Attribute and Effect; the Playhead
    // Panel has a group of its own above them in the baseline.
    await expect(page.locator(".weft-tabstrip-edge")).toHaveCount(0);
    expect((await probeStrip(group)).tabs).toHaveLength(2);

    // More tabs, from the View menu — which is where reaching a Panel by name
    // lives now. All three land in the contextual Group, so no drag is needed and
    // no other Group is emptied.
    for (const name of ["Caption", "Role Mixer", "Agent"]) {
      await page.locator(".menu-trigger").nth(2).click();
      await page.locator(".app-menu-item").filter({ hasText: new RegExp(`^${name}$`) }).click();
    }
    await expect(group.locator(".dv-tabs-container > .dv-tab")).toHaveCount(5);
    await setWindowWidth(app, SQUEEZED_PX);

    // Home the strip: opening a Panel activates it, which scrolls to reach its
    // tab. Written directly rather than walked with the arrow — arriving is
    // setup, and clicking an arrow that unmounts on the last step races its own
    // effect.
    await group.evaluate((el) => {
      el.querySelector<HTMLElement>(".dv-tabs-container")!.scrollLeft = 0;
    });

    /* ② Squeezed past what its tabs need, the strip scrolls — and not one title
     * has been truncated to get there. A tab is the only place a Panel is named,
     * so the strip gives up width it does not have rather than a name; only the
     * trailing end, the one still hiding something, is dressed. */
    await expect(edgeButton(page, "end")).toHaveCount(1);
    await expect(page.locator('.weft-tabstrip-edge[data-toward="start"]')).toHaveCount(0);
    const squeezed = await probeStrip(group);
    expect(squeezed.contentSize).toBeGreaterThan(squeezed.viewportSize);
    expect(squeezed.overlaySize).toBeGreaterThan(0);
    // Listed, not counted: a failure has to name the tab that ellipsized.
    expect(squeezed.tabs.filter((t) => t.truncated)).toEqual([]);

    // ③ One step reveals the off-screen tab WHOLE — the step lands on a tab
    // boundary, never mid-tab — and the far end dresses itself once there is
    // something behind the reader.
    const offscreen = squeezed.tabs.find((t) => t.end > band(squeezed)[1])!;
    expect(readable(squeezed, offscreen.kind)).toBe(false);
    await edgeButton(page, "end").click();
    await expect(page.locator('.weft-tabstrip-edge[data-toward="start"]')).toHaveCount(1);
    expect(readable(await probeStrip(group), offscreen.kind)).toBe(true);

    /* ④ Walking the trailing arrow terminates, and every click moves the strip.
     *
     * Both halves are one failure with two faces: a strip parked as far right as
     * the browser will take it whose geometry still reads "not at the end". The
     * overlay never retires, and the arrow — whose step target the browser clamps
     * back to the offset the strip already sits at — becomes a button that does
     * nothing, forever.
     *
     * What the walk gates is that symptom: a step always advances, and the end
     * stop is reachable. It does NOT gate the arithmetic underneath. The end stop
     * is judged against `scrollWidth - clientWidth`, two integers that between
     * them can name an offset the browser refuses to scroll to — but whether they
     * overstate it at all depends on the content's fractional widths, and for
     * some tab sets they understate it instead, leaving this walk to terminate
     * even with the tolerance set wrong. `lib/edgeOverflow.test.ts` pins the
     * arithmetic with measured numbers, which is where that belongs. */
    await group.evaluate((el) => {
      el.querySelector<HTMLElement>(".dv-tabs-container")!.scrollLeft = 0;
    });
    const trailing = page.locator('.weft-tabstrip-edge[data-toward="end"]');
    // One step per tab is generous: a step reveals at least one whole tab, so a
    // walk unfinished by now is not going to finish.
    for (let step = 0; step < squeezed.tabs.length; step += 1) {
      if ((await trailing.count()) === 0) break;
      const before = (await probeStrip(group)).scrollStart;
      await edgeButton(page, "end").click();
      // Settling here is also what keeps the next iteration's click off an
      // element that is unmounting under it.
      await expect
        .poll(async () => (await probeStrip(group)).scrollStart)
        .toBeGreaterThan(before);
    }
    await expect(trailing).toHaveCount(0);
    await expect(page.locator('.weft-tabstrip-edge[data-toward="start"]')).toHaveCount(1);

    /* ⑤ Activating a partly-hidden tab must leave it readable. Dockview parks a
     * newly activated tab flush with the scrollport edge — exactly where the
     * leading overlay sits — so without a correction the tab a user just asked
     * for lands under the arrow that hides it.
     *
     * The scroll offset is set rather than clicked to. The arrows only stop on
     * tab boundaries, and from every one of those the flush park either lands at
     * zero (where there is no leading overlay to hide under) or clamps to the end
     * stop — so no sequence of arrow clicks can reach the state this corrects.
     * The wheel reaches any offset, which is what makes it a real state; setting
     * it is just the deterministic way to arrive.
     *
     * The offsets come from the probe, not from literals: tab widths are font
     * metrics and a choreographed version would hold on one CI platform and
     * flake on the others. */
    const home = await probeStrip(group);
    const maxScroll = home.contentSize - home.viewportSize;
    const straddle = 8;
    const victim = home.tabs.find(
      (t) =>
        !t.active &&
        // Far enough in that parking flush leaves it under the leading overlay…
        t.start > home.overlaySize + 0.5 &&
        // …and near enough that the park is not clamped to the end stop.
        t.start + straddle <= maxScroll &&
        // …with room left to click once the overlay has taken its bite.
        t.width > home.overlaySize + 12,
    );
    expect(victim, "no tab can be parked under the leading overlay").toBeTruthy();
    const scrollTo = victim!.start + straddle;
    await group.evaluate((el, offset) => {
      el.querySelector<HTMLElement>(".dv-tabs-container")!.scrollLeft = offset;
    }, scrollTo);
    await expect(page.locator('.weft-tabstrip-edge[data-toward="start"]')).toHaveCount(1);

    const uncovered = victim!.end - scrollTo - home.overlaySize;
    await group
      .locator(`.dv-tabs-container > .dv-tab:has([data-panel-kind="${victim!.kind}"])`)
      .click({ position: { x: straddle + home.overlaySize + uncovered / 2, y: 14 } });

    // Polled: Dockview parks the tab synchronously on the click, and the
    // correction lands on the following React commit.
    await expect
      .poll(async () => readable(await probeStrip(group), victim!.kind))
      .toBe(true);
    // Not vacuous: the flush park Dockview performed was `scrollLeft = start`,
    // so a smaller offset is the correction having moved it.
    expect((await probeStrip(group)).scrollStart).toBeLessThan(victim!.start);
  } finally {
    await app.close();
  }
});
