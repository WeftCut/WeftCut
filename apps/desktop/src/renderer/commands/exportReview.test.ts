import { describe, expect, it, vi } from "vitest";
import { exportReviewCommands, exportReviewShortcuts } from "./exportReview";
import type { CommandDef } from "./registry";

const command = (id: string): CommandDef => ({ id, labelKey: id, run: vi.fn() });

describe("the export review lock", () => {
  it("keeps transport and view commands and locks everything else, including ids it has never seen", () => {
    const [play, zoom, split, unknown] = exportReviewCommands(
      [command("togglePlay"), command("zoomTimelineIn"), command("splitAtPlayhead"), command("aCommandAddedLater")],
      true,
    );
    expect(play!.enabled?.() ?? true).toBe(true);
    expect(zoom!.enabled?.() ?? true).toBe(true);
    expect(split!.enabled!()).toBe(false);
    expect(unknown!.enabled!()).toBe(false);

    const handlers = { togglePlay: vi.fn(), nudgeBack: vi.fn() };
    expect(Object.keys(exportReviewShortcuts(handlers, true))).toEqual(["togglePlay"]);
  });

  // The preview's grid and its snapping are view preferences beside the safe
  // areas: none of the three touches the project the export is reading.
  it("keeps the preview's view toggles available", () => {
    const ids = ["toggleSafeAreaGuides", "togglePreviewGrid", "togglePreviewSnap"];
    for (const locked of exportReviewCommands(ids.map(command), true)) {
      expect(locked.enabled?.() ?? true).toBe(true);
    }
  });

  it("changes nothing while no export holds the project", () => {
    const commands = [command("splitAtPlayhead")];
    const handlers = { nudgeBack: vi.fn() };
    expect(exportReviewCommands(commands, false)).toBe(commands);
    expect(exportReviewShortcuts(handlers, false)).toBe(handlers);
  });
});
