// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/// The guard for the LANDMINE documented on `SubMenu` in `Menu.tsx`: a detached
/// `Menu.Root open` context menu that holds a submenu MUST also set
/// `highlightItemOnHover={false}`, or the submenu is unreachable by mouse — it
/// opens on hover and closes again the moment the pointer travels toward it.
///
/// A source sweep rather than a render test because the failure only exists in
/// a real browser: it needs Base UI's hover intent, genuine pointer geometry,
/// and the roving DOM focus that jsdom's zero-sized layout never produces. A
/// jsdom test of these menus passes either way, which is precisely how the bug
/// shipped. So the invariant is checked where it IS visible — in the source.
const RENDERER = path.resolve(__dirname, "..");

/// Menubar menus are exempt, and must stay exempt: they keep the pointer
/// highlight and their submenus work, because only the detached context-menu
/// Roots reproduce the close (`SubMenu`'s LANDMINE says why). Listed by hand so
/// adding a menubar menu is a deliberate entry rather than a silent pass.
const MENUBAR_MENUS = ["app/ViewMenu.tsx"];

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [full] : [];
  });
}

describe("context menus holding a submenu", () => {
  it("switch off the pointer highlight, so the submenu can be reached", () => {
    const offenders = tsxFiles(RENDERER)
      .filter((file) => !file.endsWith(".test.tsx"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("<SubMenu"))
      .map((file) => path.relative(RENDERER, file).split(path.sep).join("/"))
      .filter((rel) => !MENUBAR_MENUS.includes(rel))
      .filter(
        (rel) =>
          !fs
            .readFileSync(path.join(RENDERER, rel), "utf8")
            .includes("highlightItemOnHover={false}"),
      );
    expect(offenders).toEqual([]);
  });

  it("finds the menus it is meant to be guarding", () => {
    const withSubmenu = tsxFiles(RENDERER)
      .filter((file) => !file.endsWith(".test.tsx"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("<SubMenu"))
      .map((file) => path.relative(RENDERER, file).split(path.sep).join("/"));
    // A sweep that matched nothing would pass forever; pin the count so a
    // moved or renamed menu re-opens this question instead of going quiet.
    expect(withSubmenu.length).toBeGreaterThanOrEqual(4);
    expect(withSubmenu).toContain("timeline/LayerContextMenu.tsx");
  });
});
