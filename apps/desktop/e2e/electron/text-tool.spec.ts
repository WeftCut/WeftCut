// The Text tool, driven through the real preview (ADR 0067): a click on empty
// frame creates a Text layer centred on the click and opens the inline editor
// on it; a click on existing text opens the editor on THAT layer and creates
// nothing; and the click that closes an open editor creates nothing either.
//
// Every gate here reads BOTH sides — what the preview shows (the editor, its
// value) and what the project holds (layer count, the stored position) — for
// the reason `text-box-gizmo.spec.ts` gives: a tool that opened an editor but
// stacked a second placeholder under it would look right on screen.

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  invokeCmd,
  launchApp,
  newProject,
  summary,
  textBoxProbe,
  tmpDir,
} from "./helpers/driver";

const CANVAS = { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 };
const DURATION_US = 4_000_000;

interface TextLayerWire {
  id: string;
  params: {
    kind: string;
    content?: string;
    x?: { mode: string; value: number };
    y?: { mode: string; value: number };
  };
}

async function textLayers(page: Page): Promise<TextLayerWire[]> {
  const s = await summary(page);
  return (s.tracks.flatMap((t) => t.layers) as unknown as TextLayerWire[]).filter(
    (l) => l.params.kind === "Text",
  );
}

async function layerCount(page: Page): Promise<number> {
  return (await summary(page)).layer_count;
}

/// The preview mounts its canvas only once the project has a layer, and the
/// gizmo probe — which the tool's hit test and `textBoxProbe` both read — is
/// registered by that canvas. Same two waits `text-box-gizmo.spec.ts` makes.
async function waitForCanvas(page: Page): Promise<void> {
  await expect(page.locator(".pixi-preview-canvas")).toBeVisible();
  await expect(page.getByTestId("pixi-preview-initializing")).toBeHidden();
}

/// Arm the tool from the Quick Actions strip and wait for its click surface —
/// which is sized to the canvas box, so it is visible only once the preview has
/// a canvas and the surface has followed it.
async function armTextTool(page: Page): Promise<{ surface: Locator; box: { width: number; height: number } }> {
  await waitForCanvas(page);
  const button = page.locator('[data-quick-action="selectTextTool"]');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveAttribute("aria-checked", "true");
  const surface = page.getByTestId("preview-text-tool");
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error("text tool surface has no box");
  return { surface, box };
}

test("a click on empty frame creates text centred on the click and opens the editor", async ({}, testInfo) => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-text-tool-"),
      name: `text-tool-${Date.now()}`,
      canvas: CANVAS,
    });
    // The tool is disabled with no layer, because the preview mounts no canvas
    // until something is staged. A Color layer is not Text, so with it staged
    // every click is still a click on empty frame.
    await invokeCmd(page, "add_color_layer", { tStartUs: 0, durationUs: DURATION_US });
    const { surface, box } = await armTextTool(page);

    // Off-centre on purpose, so a layer that landed at the default centre
    // would fail the position gate.
    const fx = 0.25;
    const fy = 0.3;
    await surface.click({ position: { x: box.width * fx, y: box.height * fy } });
    const input = page.getByTestId("preview-inline-text-editor").locator("textarea");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Text");

    const [made] = await textLayers(page);
    if (!made) throw new Error("the click created no Text layer");
    // Composition pixels per client pixel; the gate allows two client pixels
    // of pointer rounding.
    const scale = CANVAS.width / box.width;
    expect(Math.abs(made.params.x!.value - CANVAS.width * fx)).toBeLessThan(2 * scale);
    expect(Math.abs(made.params.y!.value - CANVAS.height * fy)).toBeLessThan(2 * scale);
    expect(await layerCount(page)).toBe(2);

    await input.fill("From the tool");
    await page.screenshot({ path: testInfo.outputPath("text-tool-editing.png") });
    await input.press("ControlOrMeta+Enter");
    await expect(input).toBeHidden();
    await expect
      .poll(async () => (await textLayers(page)).find((l) => l.id === made.id)?.params.content)
      .toBe("From the tool");
    // Creation and the first edit are two history entries, as from the menu.
    await invokeCmd(page, "project_undo", {});
    await expect
      .poll(async () => (await textLayers(page)).find((l) => l.id === made.id)?.params.content)
      .toBe("Text");
    await invokeCmd(page, "project_undo", {});
    await expect.poll(() => layerCount(page)).toBe(1);
    // The tool stays armed throughout.
    await expect(page.locator('[data-quick-action="selectTextTool"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
  } finally {
    await app.close();
  }
});

test("a click on existing text edits it, and the click that closes the editor creates nothing", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-text-tool-edit-"),
      name: `text-tool-edit-${Date.now()}`,
      canvas: CANVAS,
    });
    // Placed through the same wire the tool uses, at the frame's centre.
    const existing = await invokeCmd<string>(page, "add_text_layer", {
      tStartUs: 0,
      durationUs: DURATION_US,
      content: "Existing",
      x: CANVAS.width / 2,
      y: CANVAS.height / 2,
    });
    // The hit test reads the compositor's measured footprint, so the layer has
    // to be staged before a click can find it.
    await waitForCanvas(page);
    await expect
      .poll(async () => (await textBoxProbe(page, existing)).natural?.w ?? 0)
      .toBeGreaterThan(0);
    const { surface, box } = await armTextTool(page);
    const input = page.getByTestId("preview-inline-text-editor").locator("textarea");

    await surface.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Existing");
    expect(await layerCount(page)).toBe(1);

    // Empty frame, well clear of the title. This press closes the editor and
    // is spent doing so.
    const empty = { x: box.width * 0.1, y: box.height * 0.1 };
    await surface.click({ position: empty });
    await expect(input).toBeHidden();
    expect(await layerCount(page)).toBe(1);

    // The SAME point again, with no editor open: now it creates. Ending on a
    // count of two is what proves the closing press made nothing — had it, this
    // would be three.
    await surface.click({ position: empty });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Text");
    await expect.poll(() => layerCount(page)).toBe(2);
    const made = (await textLayers(page)).find((l) => l.id !== existing);
    if (!made) throw new Error("the second click created no Text layer");
    const scale = CANVAS.width / box.width;
    expect(Math.abs(made.params.x!.value - CANVAS.width * 0.1)).toBeLessThan(2 * scale);
    expect(Math.abs(made.params.y!.value - CANVAS.height * 0.1)).toBeLessThan(2 * scale);

    // Escape in the editor finishes the edit (the placeholder is untouched, so
    // nothing is written); a second Escape leaves the tool.
    await input.press("Escape");
    await expect(input).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-quick-action="selectTool"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(surface).toBeHidden();
  } finally {
    await app.close();
  }
});
