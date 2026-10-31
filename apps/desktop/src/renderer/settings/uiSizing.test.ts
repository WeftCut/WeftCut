import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Application chrome sizes through the layout theme
// (docs/ui-tokens.md#layout-themes): CSS through `--ui-px` and the tokens in
// styles/layout-theme.css, icons through AppIcon roles, JS geometry through the
// baselines in settings/uiMetrics.ts. These scans keep fixed sizes from
// creeping back in. A CSS length that must stay in real pixels carries a
// same-line `/* fixed-px: <reason> */` marker.

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(pattern: RegExp): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      const name = relative(root, path).replaceAll('\\', '/');
      if (pattern.test(name) && !/\.(test|spec|generated)\./.test(name)) {
        out.push({ name, text: readFileSync(path, 'utf8') });
      }
    }
  };
  visit(root);
  return out;
}

/** Comment bodies blanked out, line structure kept. */
const stripCssComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

// Hairlines, strokes, shadows, effects and corner radii keep real pixels.
const FIXED_PX_PROPERTY =
  /^(--)?[\w-]*(border|outline|shadow|radius|stroke|filter|focus-ring|underline-offset)[\w-]*$/;
// A leading minus is part of the length: negative offsets centre and overhang.
const PX = /(?<![\w.])-?(\d+(?:\.\d+)?)px\b/g;

describe('UI sizing follows the layout theme', () => {
  it('uses --ui-px instead of fixed pixel lengths in application CSS', () => {
    const violations: string[] = [];
    for (const { name, text } of sources(/\.css$/)) {
      // The token sheet defines the scale itself.
      if (name === 'styles/layout-theme.css') continue;
      const raw = text.split('\n');
      stripCssComments(text).split('\n').forEach((line, index) => {
        if (raw[index]!.includes('fixed-px:') || /^\s*@(media|container)\b/.test(line)) return;
        for (const declaration of line.split(/[{};]/)) {
          const colon = declaration.indexOf(':');
          if (colon < 0) continue;
          const property = declaration.slice(0, colon).trim();
          if (FIXED_PX_PROPERTY.test(property)) continue;
          const lengths = [...declaration.slice(colon + 1).matchAll(PX)];
          if (lengths.some(([, value]) => !['0', '0.5', '1'].includes(value!))) {
            violations.push(`${name}:${index + 1}: ${declaration.trim()}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('uses --ui-px in Tailwind arbitrary lengths', () => {
    // Scale-based utilities are rem and already follow the theme; arbitrary
    // pixel values do not. Radii and borders keep real pixels, as in CSS.
    const arbitrary = /(?<![\w-])-?(?!rounded|border|outline|ring|shadow|stroke)[a-z]+(?:-[a-z]+)*-\[-?(\d+(?:\.\d+)?)px\]/g;
    const violations: string[] = [];
    for (const { name, text } of sources(/\.tsx?$/)) {
      text.split('\n').forEach((line, index) => {
        for (const [match, value] of line.matchAll(arbitrary)) {
          if (Number(value) > 1 && !/^-?text-/.test(match)) violations.push(`${name}:${index + 1}: ${match}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('sizes icons by AppIcon role, never by pixel', () => {
    const violations: string[] = [];
    for (const { name, text } of sources(/\.tsx$/)) {
      text.split('\n').forEach((line, index) => {
        if (/\bsize=\{\s*\d/.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  // Glyphs drawn directly: the gizmo's rotate glyph lives in SVG user space and
  // is sized from UI_METRICS.gizmo; the media group glyph is fluid (media.css).
  const DIRECT_ICON_FILES = new Set(['preview/TransformGizmo.tsx', 'panels/MediaPool.tsx']);

  it('renders lucide glyphs through AppIcon', () => {
    const violations: string[] = [];
    for (const { name, text } of sources(/\.tsx$/)) {
      if (DIRECT_ICON_FILES.has(name)) continue;
      const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)]
        .flatMap(([, list]) => list!.split(','))
        .map((item) => item.trim().split(/\s+as\s+/).pop()!.trim())
        .filter((item) => item && !item.startsWith('type '));
      for (const icon of imported) {
        const tag = new RegExp(`<${icon}[\\s/>]`);
        text.split('\n').forEach((line, index) => {
          if (tag.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps literal pixel numbers out of UI-scale arithmetic', () => {
    // Files that read the UI scale; a bare number next to it is a baseline that
    // belongs in uiMetrics.ts.
    const scaled = /\b\d+(?:\.\d+)?\s*\*\s*(?:scale|uiScale|useUiScale\(\)|getUiScale\(\))(?!\w)|\b(?:scale|uiScale)\s*\*\s*\d|\bui(?:Pixels|Scaled)\(\s*\d/;
    const violations: string[] = [];
    for (const { name, text } of sources(/\.tsx?$/)) {
      if (!/settings\/layoutTheme['"]/.test(text) && name !== 'settings/layoutTheme.ts') continue;
      text.split('\n').forEach((line, index) => {
        if (scaled.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});
