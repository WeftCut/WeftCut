import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { hashCacheKey } from '../../../src/shared/motifs/cacheKey.ts';
import common from './common.cjs';
import { electronBinPath } from '../../lib/electron-bin.mjs';

const { desktop, output: report, writeJson, sanitize } = common;
const requestedCases = process.argv.find(a => a.startsWith('--cases='))?.slice(8) ?? process.env.ISSUE62_CASES;
const includeVideo = process.argv.includes('--all');
const durationMs = Number(process.argv.find(a => a.startsWith('--duration-ms='))?.split('=')[1] ?? 60000);
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 60000) throw new Error('duration-ms must be 1000–60000');
const outputName = process.env.ISSUE62_OUTPUT ?? 'preview-result.json';
if (path.basename(outputName) !== outputName) throw new Error('ISSUE62_OUTPUT must be a filename');
fs.mkdirSync(path.join(report, '.private'), { recursive: true });
const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: common.repository }).trim(), durationMs, startedAt: new Date().toISOString(), cases: [] };
const env = { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1', ELECTRON_RENDERER_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
const record = () => writeJson(outputName, result);
const rasterModule = fs.readdirSync(path.join(desktop, 'out/renderer/assets')).find(n => /^motifRasterCache-.*\.js$/.test(n));
const invoke = (page, command, args = {}) => page.evaluate(([c, a]) => window.api.backend.invoke(c, a), [command, args]);
async function poll(fn, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const r = await fn(); if (r) return r; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Condition timeout');
}

if (!rasterModule) throw new Error('Build the E2E bundle before running this benchmark.');
for (const width of [1920, 3840]) if (!fs.existsSync(path.join(report, `frames-${width}/29.wfrm`))) throw new Error('Run prepare.mjs first.');

async function cacheSnapshot(page) {
  return page.evaluate(async url => {
    const values = Object.values(await import(url));
    const caches = values.filter(v => v && typeof v.capacityBytes === 'function' && typeof v.getFrame === 'function');
    const cache = caches.sort((a, b) => b.size() - a.size())[0];
    const budget = values.find(v => v && typeof v.ownerAllowance === 'function' && typeof v.snapshot === 'function');
    if (!cache || !budget) throw new Error('Built cache diagnostics changed; update this benchmark.');
    return { capacity: cache.capacityBytes(), frames: cache.size(), aggregate: budget.snapshot() };
  }, pathToFileURL(path.join(desktop, 'out/renderer/assets', rasterModule)).href);
}

let activeApp, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true; process.exitCode = 130; activeApp?.process().kill('SIGTERM');
});

for (const scenario of [
  { name: 'group-motif-full', resolution: 'full', motif: 3840, group: true },
  { name: 'group-motif-half', resolution: 'half', motif: 3840, group: true },
  { name: 'group-motif-quarter', resolution: 'quarter', motif: 3840, group: true },
  { name: 'hidden-group-half', resolution: 'half', motif: 3840, group: true, hidden: true },
  { name: 'shape-root-half', resolution: 'half' },
  { name: 'shape-group-half', resolution: 'half', group: true },
  { name: 'root-motif-4k-half', resolution: 'half', motif: 3840, trace: true },
  { name: 'root-motif-1080-half', resolution: 'half', motif: 1920, trace: true },
  { name: 'root-motif-4k-full', resolution: 'full', motif: 3840 },
  { name: 'root-two-motifs-4k-half', resolution: 'half', motif: 3840, motifs: 2 },
  { name: 'root-motif-4k-cache2048-half', resolution: 'half', motif: 3840, cache: 2048 },
  { name: 'video-group-motif-full', resolution: 'full', motif: 3840, group: true, video: true },
  { name: 'video-group-motif-half', resolution: 'half', motif: 3840, group: true, video: true },
  { name: 'video-group-motif-quarter', resolution: 'quarter', motif: 3840, group: true, video: true },
  { name: 'video-hidden-group-half', resolution: 'half', motif: 3840, group: true, hidden: true, video: true },
].filter(s => requestedCases ? requestedCases.split(',').includes(s.name) : includeVideo || !s.video)) {
  if (stopping) break;
  const profile = fs.mkdtempSync(path.join(report, '.private/profile-'));
  const app = activeApp = await electron.launch({ executablePath: electronBinPath(), args: [`--user-data-dir=${profile}`, '--lang=en-US', path.join(desktop, 'out/main/index.js')], env, timeout: 60000 });
  const watchdog = setTimeout(() => app.process().kill('SIGTERM'), 600000);
  const row = { ...scenario, durationMs, logs: [], pageErrors: [] };
  result.cases.push(row); record();
  try {
    const page = await app.firstWindow();
    page.on('console', m => { if (/application init/.test(m.text())) row.logs.push(m.text()); });
    page.on('pageerror', e => row.pageErrors.push(e.message));
    await page.waitForFunction(() => !!window.__weftcutTest?.newProjectAndEnter);
    await page.evaluate(() => {
      window.__PIXI_APP_INIT__ = app => { window.__issue62App = app; };
      window.__PIXI_RENDERER_INIT__ = renderer => {
        const original = renderer.render.bind(renderer);
        const targets = new Map(); window.__issue62Targets = targets;
        renderer.render = options => {
          if (options?.target?.source) {
            const s = options.target.source, key = `${s.pixelWidth}x${s.pixelHeight}@${s.resolution}`;
            targets.set(key, (targets.get(key) ?? 0) + 1);
          }
          return original(options);
        };
      };
    });
    await page.evaluate(parentFolder => window.__weftcutTest.newProjectAndEnter({ parentFolder, name: 'Preview', canvas: { width: 3840, height: 2160, fpsNum: 30000, fpsDen: 1001 } }), profile);
    await invoke(page, 'app_settings_set', { patch: { playback_resolution: scenario.resolution, prebake_motifs: false,
      ...(scenario.cache ? { performance: { motif_cache_mib: scenario.cache }, resource_policy: { memory_mib: 8192 } } : {}) } });
    await invoke(page, 'update_project_settings', { patch: { prefer_proxies: true } });
    const root = (await invoke(page, 'project_summary')).root_id;
    await invoke(page, 'add_color_layer', { compositionId: root, tStartUs: 0, durationUs: 61_000_000, color: { r: 22, g: 36, b: 52, a: 255 } });
    if (scenario.video) {
      const media = await invoke(page, 'import_media', { path: path.join(report, 'footage-4k.mp4') });
      await poll(async () => {
        const summary = await invoke(page, 'project_summary');
        const item = summary.media.find(item => item.id === media);
        row.media = item && { kind: item.kind, width: item.width, height: item.height, codec: item.codec, route: item.decode_route.route, proxyReady: !!item.decode_route.quick_proxy };
        return item?.decode_route?.quick_proxy && fs.existsSync(item.decode_route.quick_proxy);
      }, 180000);
      row.videoLayer = await page.evaluate(mediaId => window.__weftcutTest.placeMediaLayer({ mediaId }), media);
      await poll(async () => {
        const s = await page.evaluate(() => window.api.resources.status());
        return s.cpu_threads === 0 && s.waiting === 0;
      }, 180000);
    }
    const layerIds = [];
    row.keys = [];
    if (scenario.motif) for (let n = 0; n < (scenario.motifs ?? 1); n++) {
      const w = scenario.motif, h = w * 9 / 16;
      // Distinct Motifs, so each layer has its own cache key and frame stream.
      const manifest = { id: `periodic-overlay-${n}`, name: `Periodic overlay ${n}`, version: 1, size: [w, h], default_duration_s: 61, props_schema: {} };
      const html = `<!doctype html><style>html,body{margin:0;background:transparent}#box{position:absolute;background:rgba(220,70,110,.5019607843);width:${Math.floor(w/5)}px;height:${Math.floor(h/5)}px;top:${Math.floor(h/3)}px}</style><div id="box"></div><script>motif.define({frame(t){document.querySelector('#box').style.left=Math.floor((Math.round(t*30000/1001)%30)*${w}/40)+'px'}})</script>`;
      const draft = await invoke(page, 'open_motif_draft', { source: { kind: 'empty', name: manifest.name } });
      await invoke(page, 'update_motif_files', { draft_id: draft.draft_id, expected_revision: draft.revision, files: [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'index.html', text: html }] });
      const info = await invoke(page, 'read_motif', { id: draft.draft_id });
      const installed = await invoke(page, 'install_motif', { draft_id: draft.draft_id, expected_revision: info.revision });
      const layer = await page.evaluate(motifId => window.__weftcutTest.addMotifLayer({ motifId, durationUs: 61_000_000 }), installed.motif_id);
      layerIds.push(layer);
      const key = await page.evaluate(id => window.__weftcutTest.cacheKeyForLayer(id), layer);
      const hashDir = path.join(profile, 'Preview/Cache/raster', hashCacheKey(key));
      fs.mkdirSync(hashDir, { recursive: true });
      const frameCount = Math.round(61 * 30000 / 1001);
      for (let i = 0; i < frameCount; i++) fs.copyFileSync(path.join(report, `frames-${w}`, `${i%30}.wfrm`), path.join(hashDir, `${i}.wfrm`));
      row.keys.push(key); row.key = row.keys[0]; row.persistedFrames = frameCount;
    }
    if (!scenario.motif) {
      const shape = await invoke(page, 'add_color_layer', { compositionId: root, tStartUs: 0, durationUs: 61_000_000, color: { r: 220, g: 70, b: 110, a: 128 } });
      layerIds.push(shape);
    }
    if (scenario.group) {
      const group = await invoke(page, 'groups_create', { layerIds });
      if (scenario.hidden) await invoke(page, 'set_layers_enabled', { layerIds: [group.layer_id], enabled: false });
      row.group = group;
    }
    const workspace = await invoke(page, 'workspace_dir');
    await page.evaluate(path => window.__weftcutTest.motifReopenProject({ path }), workspace);
    await invoke(page, 'app_settings_set', { patch: { prebake_motifs: true } });
    if (scenario.motif && !scenario.hidden) {
      await poll(async () => {
        const bake = await invoke(page, 'motif_bake_snapshot');
        row.bake = row.keys.map(key => bake.statuses[key]);
        return row.bake.every(status => status?.phase === 'ready');
      }, 60000);
    }
    await page.waitForFunction(() => !!window.__weftcutTest?.compositorPerfSnapshot?.());
    const settings = await invoke(page, 'app_settings_get');
    row.settings = Object.fromEntries(['playback_resolution', 'prebake_motifs', 'performance', 'resource_policy', 'resource_allocation'].map(k => [k, settings[k]]));
    row.projectSettings = { prefer_proxies: (await invoke(page, 'get_project_settings')).prefer_proxies };
    if (scenario.video) {
      row.videoProbe = await poll(async () => {
        const p = await page.evaluate(id => window.__weftcutTest.activeClipProbe(id), row.videoLayer.layerId);
        return p?.builtFromKey?.startsWith('webcodecs:proxy:') ? { usingProxy: true, sourceKind: p.sourceKind, spriteWidth: p.spriteWidth, spriteHeight: p.spriteHeight, ringSize: p.ringSize } : false;
      }, 60000);
    }
    row.cacheBefore = await cacheSnapshot(page);
    row.resourcesBefore = await page.evaluate(() => window.api.resources.status());
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('motif:read');
      globalThis.__issue62Reads = [];
      ipcMain._invokeHandlers.set('motif:read', async (...args) => {
        const start = performance.now(); const r = await original(...args);
        globalThis.__issue62Reads.push({ ms: performance.now()-start, kind: r?.kind, bytes: r?.rgba?.byteLength ?? 0 });
        return r;
      });
    });
    await page.evaluate(() => {
      const h = window.__weftcutTest;
      h.transportSeekUs(0); h.stageProfilingSet(true);
      window.__issue62LongTasks = [];
      window.__issue62Observer = new PerformanceObserver(list => { for (const e of list.getEntries()) window.__issue62LongTasks.push({ startTime: e.startTime, duration: e.duration }); });
      window.__issue62Observer.observe({ type: 'longtask' });
      window.__issue62Targets.clear();
    });
    let cdp;
    if (scenario.trace) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing', transferMode: 'ReturnAsStream' });
    }
    row.startPerf = await page.evaluate(() => window.__weftcutTest.compositorPerfSnapshot());
    const started = Date.now();
    await page.evaluate(() => window.__weftcutTest.transportPlay());
    // A timed observation window, not a readiness/settle delay.
    await new Promise(r => setTimeout(r, durationMs));
    row.elapsedMs = Date.now()-started;
    row.measurement = await page.evaluate(() => {
      const h = window.__weftcutTest;
      const data = { positionUs: h.getPlayheadUs(), perf: h.compositorPerfSnapshot(), stages: h.stageProfilingSnapshot(), longTasks: window.__issue62LongTasks,
        targets: [...window.__issue62Targets], canvas: { width: window.__issue62App?.canvas.width, height: window.__issue62App?.canvas.height, renderer: window.__issue62App?.renderer.type, resolution: window.__issue62App?.renderer.resolution } };
      h.transportPause(); window.__issue62Observer.disconnect(); return data;
    });
    row.reads = await app.evaluate(() => globalThis.__issue62Reads);
    row.cacheAfter = await cacheSnapshot(page);
    row.resourcesAfter = await page.evaluate(() => window.api.resources.status());
    if (cdp) {
      const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      const { stream } = await complete;
      const fd = fs.openSync(path.join(report, '.private', `${scenario.name}-trace.json`), 'w');
      for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); fs.writeSync(fd, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data); if (chunk.eof) break; }
      fs.closeSync(fd); await cdp.send('IO.close', { handle: stream }); await cdp.detach();
    }
    row.ok = true;
    console.log(JSON.stringify({ name: row.name, elapsedMs: row.elapsedMs, positionUs: row.measurement.positionUs, underrun: row.measurement.perf.underrun, reads: row.reads.length, targets: row.measurement.targets, longTasks: row.measurement.longTasks.length, canvas: row.measurement.canvas }));
  } catch (e) { row.error = String(e.stack ?? e); result.error = row.error; console.error(sanitize(row.error)); record(); process.exitCode = 1; }
  finally {
    const kill = setTimeout(() => app.process().kill('SIGTERM'), 5000);
    try { await app.close(); } catch { /* signal/watchdog may already have closed it */ }
    finally { clearTimeout(kill); clearTimeout(watchdog); activeApp = undefined; }
    const diagnostics = path.join(profile, 'diagnostics-dev');
    row.warnings = 0;
    if (fs.existsSync(diagnostics)) for (const entry of fs.readdirSync(diagnostics)) {
      const file = path.join(diagnostics, entry, 'events.jsonl');
      if (fs.existsSync(file)) row.warnings += fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes("Playback couldn")).length;
    }
    record();
  }
}
