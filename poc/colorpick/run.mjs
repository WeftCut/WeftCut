// Standalone capability probe; does not launch or mutate the editor/project.
import { build } from 'esbuild';
import { _electron } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { electronBinPath } from '../../apps/desktop/e2e/lib/electron-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });
await build({ entryPoints: [path.join(here, 'effects.ts')], bundle: true,
  platform: 'browser', format: 'iife', outfile: path.join(out, 'effects.js') });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: electronBinPath(),
  args: [path.join(here, 'main.cjs')], env, timeout: 30000 });
const osInput = process.platform === 'win32';
function windowsProbe(action, title = '', x = 0, y = 0) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(here, 'windows-input.ps1'), '-Action', action, '-Title', title,
    '-X', String(x), '-Y', String(y)], { encoding: 'utf8', windowsHide: true }).trim());
}
const report = { at: new Date().toISOString(), input: osInput ? 'Win32 SendInput click/Escape; CDP hover' : 'Playwright/CDP (not OS SendInput)' };
try {
  const controller = await app.firstWindow();
  await controller.waitForFunction(() => window.ready);
  report.environment = await app.evaluate(async () => globalThis.probe.environment());
  if (osInput) report.environment.physicalScreens = windowsProbe('screens');
  console.log('ENVIRONMENT', JSON.stringify(report.environment));
  report.effects = await controller.evaluate(() => window.runEffectsProbe());
  console.log('EFFECTS', JSON.stringify(report.effects));
  await app.evaluate(() => globalThis.probe.fixtures());
  report.capture = await app.evaluate(() => globalThis.probe.begin());
  if (report.environment.displays.length === 1 && osInput) {
    const physical = [].concat(report.environment.physicalScreens)[0];
    report.capture[0].nativeSize = report.capture[0].actual.width === physical.width
      && report.capture[0].actual.height === physical.height;
    report.capture[0].physicalReference = physical;
  }
  console.log('CAPTURE', JSON.stringify(report.capture));
  const overlays = app.windows().filter(p => p.url().includes('mode=overlay'));
  report.overlays = [];
  for (let i = 0; i < overlays.length; i++) {
    const page = overlays[i];
    await page.waitForFunction(() => window.ready);
    const size = await page.evaluate(() => window.sampleExtent);
    await page.mouse.move(size.w - 4, size.h - 4);
    await page.waitForFunction(() => document.querySelector('#hex').textContent.startsWith('#'));
    const evidence = await page.evaluate(() => ({ hit: window.lastHit,
      magnifier: document.querySelector('#mag').getBoundingClientRect().toJSON(),
      width: innerWidth, height: innerHeight }));
    evidence.fits = evidence.magnifier.right <= size.w && evidence.magnifier.bottom <= size.h;
    report.overlays.push(evidence);
    // Only our generated fixture is visible beneath this overlay.
    await page.screenshot({ path: path.join(out, `overlay-${i}.png`),
      clip: { x: 0, y: 0, width: size.w, height: size.h } });
  }
  report.desktopEvidence = await app.evaluate(() => globalThis.probe.overlayEvidence());
  if (osInput) report.osClick = windowsProbe('click', await overlays.at(-1).title(), 120, 100);
  else await overlays.at(-1).mouse.click(120, 100);
  await controller.waitForFunction(() => window.lastResult !== undefined);
  report.commit = await app.evaluate(() => globalThis.probe.state());
  const newWindow = app.waitForEvent('window');
  await app.evaluate(() => globalThis.probe.begin());
  const again = await newWindow;
  await again.waitForFunction(() => window.ready);
  if (osInput) report.osCancel = windowsProbe('escape', await again.title());
  else await again.keyboard.press('Escape');
  await controller.waitForFunction(() => window.lastResult === null);
  report.cancel = await app.evaluate(() => globalThis.probe.state());
  report.pass = report.capture.every(c => c.nativeSize && c.checkerMismatches === 0)
    && report.overlays.every(o => o.fits)
    && report.commit.settles === 1 && report.cancel.settles === 2
    && report.commit.overlayCount === 0 && report.cancel.overlayCount === 0
    && report.commit.fixtureClicks === 0 && report.commit.originFocused
    && report.cancel.originFocused && report.effects.confirmed
    && (!osInput || (report.commit.result.px === 120 && report.commit.result.py === 100));
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log('RESULT', JSON.stringify(report));
  if (process.argv.includes('--interactive')) {
    await app.evaluate(() => globalThis.probe.removeFixtures());
    console.log('Interactive controller open; click Start to sample your desktop. Close it to finish.');
    await app.waitForEvent('close', { timeout: 0 });
  }
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await app.close().catch(() => {});
}
