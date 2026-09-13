import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium } from "playwright";

const dockviewCssPath = new URL(
  "../../../node_modules/dockview-react/dist/styles/dockview.css",
  import.meta.url,
);
const menuCssPath = new URL(
  "../src/renderer/styles/menu.css",
  import.meta.url,
);
const appCssPath = new URL("../src/renderer/app.css", import.meta.url);
const rendererPath = fileURLToPath(
  new URL("../src/renderer/", import.meta.url),
);

async function tsxFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return tsxFilesUnder(path);
      return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return nested.flat();
}

/// The --layer-* tokens app.css §Stacking declares — the one place an
/// app-owned overlay's z-index is decided, so guarding them guards the
/// dialogs, drawers and palettes this file never names.
function layerTokens(appCss) {
  return new Map(
    [...appCss.matchAll(/^\s*(--layer-[\w-]+):\s*(\d+)\s*;/gm)].map(
      ([, name, value]) => [name, Number(value)],
    ),
  );
}

/// An authored z-index, which may be a bare integer, `var(--token)`, or the
/// `calc(var(--token) + N)` that a backdrop/popup pair uses. Anything else
/// returns NaN so the caller's assertion names it rather than passing.
function resolveZ(body, tokens) {
  const value = /^\s*z-index:\s*([^;]+);/m.exec(body ?? "")?.[1]?.trim();
  if (value === undefined) return NaN;
  if (/^\d+$/.test(value)) return Number(value);
  const calc = /^calc\(\s*var\((--layer-[\w-]+)\)\s*\+\s*(\d+)\s*\)$/.exec(value);
  if (calc) return (tokens.get(calc[1]) ?? NaN) + Number(calc[2]);
  const named = /^var\((--layer-[\w-]+)\)$/.exec(value);
  return named ? (tokens.get(named[1]) ?? NaN) : NaN;
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Executable doesn't exist")
    ) {
      return chromium.launch({ channel: "chrome", headless: true });
    }
    throw error;
  }
}

test("every app popup Positioner stacks above Dockview resize sashes", async () => {
  const [dockviewCss, menuCss, appCss, rendererFiles] = await Promise.all([
    readFile(dockviewCssPath, "utf8"),
    readFile(menuCssPath, "utf8"),
    readFile(appCssPath, "utf8"),
    tsxFilesUnder(rendererPath),
  ]);
  const sashRule = /\.dv-split-view-container \.dv-sash-container \.dv-sash\s*\{(?<body>[^}]*)\}/s.exec(
    dockviewCss,
  );
  const popupRule = /\.app-popup-positioner\s*\{(?<body>[^}]*)\}/s.exec(
    menuCss,
  );
  const sashZ = Number(
    /^\s*z-index:\s*(\d+)\s*;/m.exec(
      sashRule?.groups?.body ?? "",
    )?.[1],
  );
  const tokens = layerTokens(appCss);
  const popupZ = resolveZ(popupRule?.groups?.body, tokens);

  assert.ok(Number.isFinite(sashZ), "Dockview sash z-index was not found");
  assert.ok(tokens.size > 0, "app.css declared no --layer-* tokens");
  assert.ok(Number.isFinite(popupZ), "app popup z-index was not found");
  for (const [name, value] of tokens) {
    assert.ok(
      value > sashZ,
      `${name} (${value}) must exceed Dockview sash z-index ${sashZ}`,
    );
  }
  assert.ok(
    popupZ > sashZ,
    `app popup z-index ${popupZ} must exceed Dockview sash z-index ${sashZ}`,
  );

  const uncovered = [];
  let positionerCount = 0;
  for (const file of rendererFiles) {
    const source = await readFile(file, "utf8");
    const tags = source.match(/<[A-Za-z]+\.Positioner\b[^>]*>/gs) ?? [];
    positionerCount += tags.length;
    if (tags.some((tag) => !tag.includes('className="app-popup-positioner"'))) {
      uncovered.push(file);
    }
  }

  assert.ok(positionerCount > 0, "no Base UI Positioners were found");
  assert.deepEqual(
    uncovered,
    [],
    `Positioners missing app-popup-positioner:\n${uncovered.join("\n")}`,
  );
});

test(
  "app popup receives the pointer above a Dockview resize sash",
  { skip: process.env.POPUP_LAYERING_STATIC_ONLY === "1" },
  async (t) => {
    const [dockviewCss, menuCss, appCss] = await Promise.all([
      readFile(dockviewCssPath, "utf8"),
      readFile(menuCssPath, "utf8"),
      readFile(appCssPath, "utf8"),
    ]);
    const tokens = layerTokens(appCss);
    const browser = await launchBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 400, height: 240 },
    });

    await page.setContent(`
    <style>${dockviewCss}</style>
    <style>
      /* menu.css names a token rather than a number, so the page needs the
         app.css §Stacking block the app loads — without it the var() is
         undefined, the declaration is dropped, and the utility below wins. */
      :root { ${[...tokens].map(([name, value]) => `${name}: ${value};`).join(" ")} }
      /* Tailwind's generated utility used by every current popup Positioner. */
      .z-50 { z-index: 50; }
      ${menuCss}

      #dock { position: absolute; inset: 0; }
      #dock-sash { left: 100px; top: 0; }
      #popup-positioner { position: fixed; left: 80px; top: 40px; }
    </style>
    <div id="dock" class="dv-split-view-container dv-horizontal">
      <div class="dv-sash-container">
        <div id="dock-sash" class="dv-sash dv-enabled"></div>
      </div>
    </div>
    <div id="popup-positioner" class="z-50 app-popup-positioner">
      <div class="app-menu-list">
        <div class="app-menu-item">Media action</div>
      </div>
    </div>
  `);

    const hit = await page.evaluate(() => {
      const target = document.elementFromPoint(102, 55);
      return {
        className:
          target instanceof HTMLElement ? target.className : String(target),
        insideMenu: target?.closest(".app-menu-list") !== null,
      };
    });

    assert.equal(
      hit.insideMenu,
      true,
      `expected the popup to receive the pointer, hit ${hit.className}`,
    );
  },
);
