// Opt-in local performance gate. Real pointer input, isolated project/profile,
// CDP renderer CPU sampling + Node inspector main sampling, numeric edit traces.
import { _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { ownProcessTree, closeProcessTree } from '../lib/process-cleanup.mjs';

const { values: args } = parseArgs({ options: {
  project: { type: 'string' }, 'user-data': { type: 'string' },
  'work-dir': { type: 'string' }, 'renderer-url': { type: 'string' },
  label: { type: 'string', default: 'measurement' },
  samples: { type: 'string', default: '4' }, 'cpu-profile': { type: 'boolean', default: false },
  'chrome-trace': { type: 'boolean', default: false },
  'max-refresh-ms': { type: 'string', default: '100' },
} });
assert.ok(args.project && args['user-data'] && args['work-dir'],
  'Required: --project <source project> --user-data <source profile> --work-dir <isolated output directory>');
assert.match(args.label, /^[a-zA-Z0-9_-]+$/);
const samples = Number(args.samples), limit = Number(args['max-refresh-ms']);
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 50 && limit > 0);
const source = fs.realpathSync(args.project), sourceProfile = fs.realpathSync(args['user-data']);
const base = path.resolve(args['work-dir']);
const project = path.join(base, 'project'), profile = path.join(base, 'profile');
const overlaps = (a, b) => {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
for (const original of [source, sourceProfile]) {
  assert.ok(!overlaps(original, base) && !overlaps(base, original), 'Work directory must be separate from both originals');
}
fs.mkdirSync(base, { recursive: true });
if (!fs.existsSync(path.join(base, '.gitignore'))) fs.writeFileSync(path.join(base, '.gitignore'), '*\n');
const identityFile = path.join(base, 'source.json');
const identity = { source, sourceProfile };
if (fs.existsSync(identityFile)) assert.deepEqual(JSON.parse(fs.readFileSync(identityFile, 'utf8')), identity);
else {
  assert.ok(!fs.existsSync(project) && !fs.existsSync(profile), 'Use a new work directory for the first capture');
  fs.writeFileSync(identityFile, JSON.stringify(identity));
}
// Write completion flags LAST, so an interrupted copy cannot masquerade as a
// warmed fixture. Ordinary copies, never links to the original writable cache.
if (!fs.existsSync(path.join(base, 'copy-complete'))) {
  console.log('Copying project media/cache and Motif library into the diagnostic workspace…');
  fs.mkdirSync(project, { recursive: true });
  for (const name of ['Media', 'Cache', 'view.json', 'project.wcpr']) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(project, name), { recursive: true });
  }
  fs.mkdirSync(profile, { recursive: true });
  const settingsFile = path.join(sourceProfile, 'app_settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  const library = path.join(settings.data_root || path.join(sourceProfile, 'data'), 'motifs');
  if (fs.existsSync(library)) fs.cpSync(library, path.join(profile, 'data/motifs'), { recursive: true });
  delete settings.data_root;
  fs.writeFileSync(path.join(profile, 'app_settings.json'), JSON.stringify(settings));
  for (const name of ['workspaces.json', 'window_geometry.json']) {
    if (fs.existsSync(path.join(sourceProfile, name))) fs.copyFileSync(path.join(sourceProfile, name), path.join(profile, name));
  }
  fs.writeFileSync(path.join(base, 'copy-complete'), '1');
}
fs.writeFileSync(path.join(profile, 'recents.json'), JSON.stringify({ reopen_on_launch: true,
  entries: [{ path: project, name: 'Diagnostic copy', last_opened: new Date().toISOString() }] }));
const desktop = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
if (args['renderer-url']) env.ELECTRON_RENDERER_URL = args['renderer-url'];
const app = await _electron.launch({ args: [`--user-data-dir=${profile}`, path.join(desktop, 'out/main/index.js')], env });
const tree = ownProcessTree(app.process());
const rows = []; let pending = '';
const collect = chunk => {
  pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop() ?? '';
  for (const line of lines) {
    const prefix = '[DEBUG-edit-latency] ', at = line.indexOf(prefix);
    if (at < 0) continue;
    try { rows.push(JSON.parse(line.slice(at + prefix.length, line.lastIndexOf('}') + 1))); } catch { /* unrelated console */ }
  }
};
app.process().stdout.on('data', collect);
const save = (suffix, data) => fs.writeFileSync(path.join(base, `${args.label}.${suffix}`), JSON.stringify(data, null, 2));
try {
  const page = await app.firstWindow();
  await page.locator('[data-testid="timeline-marker"]').first().waitFor({ timeout: 60_000 });
  await page.bringToFront();
  await page.evaluate(() => localStorage.setItem('weftcut.debug.editTrace', '1'));
  // Warm-cache edits, not startup/inventory time. CPU sampling is optional:
  // compare like-for-like runs, then use a run without it for interaction cost.
  await page.waitForTimeout(12_000);
  const markerId = await page.locator('[data-testid="timeline-marker"]').first().getAttribute('data-marker-id');
  const marker = page.locator(`[data-testid="timeline-marker"][data-marker-id="${markerId}"]`);
  const cdp = await page.context().newCDPSession(page);
  const traceEvents = [];
  if (args['chrome-trace']) {
    cdp.on('Tracing.dataCollected', event => traceEvents.push(...event.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
  }
  if (args['cpu-profile']) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await app.evaluate(async () => {
      const { Session } = process.getBuiltinModule('inspector');
      globalThis.__markerInspector = new Session(); globalThis.__markerInspector.connect();
      for (const method of ['Profiler.enable', 'Profiler.start']) {
        await new Promise((res, rej) => globalThis.__markerInspector.post(method, e => e ? rej(e) : res()));
      }
    });
  }
  for (let i = 0; i < samples; i++) {
    const box = await marker.boundingBox(); assert.ok(box, 'Marker must stay visible');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    try { await page.mouse.move(x + (i % 2 ? -40 : 40), y, { steps: 6 }); }
    finally { await page.mouse.up(); }
    await page.waitForTimeout(2800);
  }
  if (args['cpu-profile']) {
    save('renderer.cpuprofile', (await cdp.send('Profiler.stop')).profile);
    save('main.cpuprofile', await app.evaluate(async () => {
      const result = await new Promise((res, rej) => globalThis.__markerInspector.post('Profiler.stop', (e, r) => e ? rej(e) : res(r)));
      globalThis.__markerInspector.disconnect(); return result.profile;
    }));
  }
  if (args['chrome-trace']) {
    const completed = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end'); await completed;
    save('chrome-trace.json', { traceEvents });
  }
  const commands = rows.filter(r => r.phase === 'main.command.update_marker');
  const measurements = commands.map(command => {
    const find = phase => rows.find(r => r.traceId === command.traceId && r.phase === phase);
    const refresh = find('renderer.refresh'), frames = find('renderer.frames'), saved = find('main.autosave');
    return { commandMs: command.durationMs, refreshMs: refresh?.durationMs,
      saveMs: saved?.durationMs, saveTimerLateMs: saved?.timerLateMs,
      maxFrameGapMs: frames?.maxFrameGapMs, longestTaskMs: frames?.longestTaskMs,
      hidden: frames?.hiddenDuringWindow, complete: command.commandAccepted && refresh?.applied &&
        refresh?.frameOpportunityObserved && !!frames && !!saved };
  });
  save('timings.json', rows); save('summary.json', { cpuProfile: args['cpu-profile'], samples, measurements });
  console.table(measurements);
  assert.equal(measurements.length, samples, 'Every gesture must produce a real marker edit');
  assert.ok(measurements.every(m => m.complete && !m.hidden), 'Missing phases or hidden window invalidate a capture');
  // Verify debounced persistence without forcing a save, which would mask it.
  const live = await page.evaluate(() => window.api.backend.invoke('project_summary', {}));
  const disk = JSON.parse(fs.readFileSync(path.join(project, 'project.wcpr'), 'utf8'));
  for (const [id, comp] of Object.entries(live.compositions)) {
    assert.deepEqual(comp.markers.map(m => [m.id, m.t_us, m.end_t_us]),
      disk.compositions[id].markers.map(m => [m.id, m.t_us, m.end_t_us]), 'Autosave must match the last displayed marker positions');
  }
  assert.ok(measurements.every(m => m.refreshMs < limit), `Post-release refresh exceeds ${limit}ms`);
  assert.ok(measurements.every(m => m.saveTimerLateMs < 100), 'Main event loop delays autosave by over 100ms');
} finally {
  save('timings.json', rows);
  app.process().stdout.off('data', collect);
  await closeProcessTree(tree, () => app.close());
}
