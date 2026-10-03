import { expect, test } from "@playwright/test";
import { invokeCmd, launchApp, newProject, rootSummary, tmpDir, waitForHook } from "./helpers/driver";

// Real keyboard dispatch matters: Chromium may run microtasks between native
// capture listeners and React. jsdom alone cannot catch Escape committing on
// the focus-region release before the title's cancel handler runs.
test("property title commits, cancels, clears and follows undo", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-properties-"),
      name: "Properties",
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 },
    });
    const layerId = await invokeCmd<string>(page, "add_text_layer", {
      tStartUs: 0, durationUs: 4_000_000, content: "A day by the sea",
    });
    await waitForHook(page, "revealLayer");
    await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId);
    const panel = page.locator(".attribute-panel");
    const title = panel.getByRole("textbox", { name: "Label", exact: true });
    const storedLabel = async () => {
      const project = await rootSummary<{ tracks: Array<{ layers: Array<{ id: string; label: string | null }> }> }>(page);
      return project.tracks.flatMap((track) => track.layers).find((layer) => layer.id === layerId)?.label;
    };

    await expect(title).toHaveAttribute("placeholder", "A day by the sea");
    await title.fill("Opening title");
    await title.press("Enter");
    await expect.poll(storedLabel).toBe("Opening title");
    await title.fill("Discard this edit");
    await title.press("Escape");
    await expect(title).toHaveValue("Opening title");
    await expect.poll(storedLabel).toBe("Opening title");

    await title.fill("");
    await title.press("Enter");
    await expect.poll(storedLabel).toBe("");
    await expect(title).toHaveValue("");
    await expect(title).toHaveAttribute("placeholder", "A day by the sea");
    await invokeCmd(page, "project_undo");
    await expect(title).toHaveValue("Opening title");

    const lock = panel.getByRole("button", { name: "Locked", exact: true });
    await lock.click();
    await expect(lock).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("Duration", { exact: true })).toBeDisabled();
    await lock.click();
    await expect(panel.getByLabel("Duration", { exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});
