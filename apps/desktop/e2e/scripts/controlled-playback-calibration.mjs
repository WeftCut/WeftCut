// Local GPU benchmark. One isolated process, no normal app/project bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { _electron as electron } from '@playwright/test';
import { electronBinPath } from '../lib/electron-bin.mjs';
import { readFixture } from './gen-playback-calibration-fixture.mjs';
import { PLAYBACK_CALIBRATION } from '../../src/shared/playback-calibration.ts';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = readFixture();
const plan = { protocol: PLAYBACK_CALIBRATION, fixtureSha256: fixture.sha256,
  isolation: 'dedicated-process; memory-scenes; fresh-pools-per-cell', history: false, adaptive: false };
const id = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
if (process.argv.includes('--plan-only')) { console.log(JSON.stringify({ id, ...plan }, null, 2)); process.exit(0); }
const main = path.join(desktop, 'out/main/calibration.js');
if (!fs.existsSync(main)) throw new Error('Build with VITE_WEFTCUT_E2E=1 before running calibration');
const dir = path.resolve(desktop, '../../.scratch/performance-calibration', `controlled-${new Date().toISOString().replaceAll(':', '-')}`);
fs.mkdirSync(dir, { recursive: true });
const inputPath = path.join(dir, 'input.json');
fs.writeFileSync(inputPath, JSON.stringify({ fixture, planId: id, protocol: PLAYBACK_CALIBRATION }));
fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ id, ...plan }, null, 2));
let app;
let report = { state: 'starting', cells: PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: 'not-run', reasons: [] })) };
const errors = [];
const started = performance.now();
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const save = () => {
  const result = { planId: id, elapsedIncludingLaunchMs: performance.now() - started, ...report, errors };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Controlled playback calibration</title>
    <style>body{max-width:1100px;margin:40px auto;background:#191919;color:#eee;font:15px system-ui}td,th{padding:10px;text-align:left;border-bottom:1px solid #444}pre{white-space:pre-wrap}</style>
    <h1>Controlled playback calibration</h1><p>H.264 · 4K · 60 fps · fixed 1–8 streams. Experimental screening, not a sustained-stability guarantee.</p>
    <p>State: ${escape(result.state)} · elapsed ${(result.elapsedIncludingLaunchMs / 1000).toFixed(2)} s</p>
    <table><tr><th>Streams</th><th>Result</th><th>Sample ms</th><th>Dropped / late</th><th>Longest hold ms</th><th>GPU</th></tr>
    ${result.cells.map(c => `<tr><td>${c.count}</td><td>${escape(c.status)}</td><td>${c.wallMs?.toFixed(0) ?? '—'}</td><td>${c.dropped ?? '—'} / ${c.late ?? '—'}</td><td>${c.maxHeldMs?.toFixed(1) ?? '—'}</td><td>${escape(c.devices?.[0]?.adapter?.name ?? 'Unknown')}</td></tr>`).join('')}</table>
    <details><summary>Complete report</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre></details>`);
};
const markIncomplete = (reason, state = 'error') => {
  report.state = state; report.error = reason; report.recommendation = null;
  for (const cell of report.cells) if (cell.status === 'not-run') cell.reasons = [reason];
};
const stop = () => { markIncomplete('Cancelled by user', 'cancelled'); save(); app?.process().kill(); process.exitCode = 1; };
process.once('SIGINT', stop);
const watchdog = setTimeout(() => { markIncomplete('Run watchdog expired'); save(); app?.process().kill(); }, 360_000);
try {
  // Clear tuning overrides: they must not silently change the recorded protocol.
  const env = { ...process.env, WEFTCUT_CALIBRATION_INPUT: inputPath };
  for (const key of Object.keys(env)) if (key.startsWith('WEFTCUT_HW_') || key.startsWith('WEFTCUT_FORCE_')) delete env[key];
  app = await electron.launch({ executablePath: electronBinPath(), args: [main, `--user-data-dir=${path.join(dir, 'profile')}`], env, timeout: 30_000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let completed = 0;
  while (true) {
    const next = await page.evaluate(() => window.__calibrationReport);
    if (next) { report = next; save(); }
    const count = report.cells.filter(c => c.status !== 'not-run').length;
    if (count !== completed) {
      completed = count;
      console.log(`${count}/8: ${report.cells.filter(c => c.status !== 'not-run').at(-1)?.status}`);
    }
    if (['complete', 'error'].includes(report.state)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await page.screenshot({ path: path.join(dir, 'result.png') });
  if (report.state !== 'complete' || report.cells.some(c => c.status === 'invalid')) process.exitCode = 1;
} catch (error) {
  if (!['cancelled', 'error'].includes(report.state)) markIncomplete(String(error));
  errors.push(String(error)); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (report.state === 'error') markIncomplete(report.error ?? 'Calibration stopped');
  save();
  if (app) {
    const kill = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } catch { /* process may already have stopped */ }
    clearTimeout(kill);
  }
  console.log(`Report: ${path.join(dir, 'report.html')}`);
}
