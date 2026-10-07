import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Application UI uses shared type roles or scalable rem/em units. Authored
// content and standalone developer fixtures deliberately keep their own scale.
const exceptions = new Set([
  'render/sprite/TextSprite.ts',
  'render/motifs/newDraftSource.ts',
  'calibration.html',
  'public/render-play.html',
]);

it('has no fixed pixel font sizes in application components or styles', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const violations: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      const name = relative(root, path).replaceAll('\\', '/');
      if (!/\.(tsx?|css|html)$/.test(name) || /\.(test|spec|generated)\./.test(name) || exceptions.has(name)) continue;
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (/text-\[\d+(?:\.\d+)?px\]|font-size:\s*\d|fontSize:\s*(?:\d|["']\d)|\bfont:\s*["']?(?:\d+\s+)?\d+(?:\.\d+)?px/.test(line)) {
          violations.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  };
  visit(root);
  expect(violations).toEqual([]);
});
