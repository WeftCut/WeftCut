// Timing experiment, NOT a machine-rating algorithm. Uses real preview pipelines
// in disposable profiles. Never reads or changes the user's normal app settings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from '@playwright/test';
import { BENCH_MATRIX, benchFixturePath } from './gen-decode-bench-fixtures.mjs';
import { electronBinPath } from '../lib/electron-bin.mjs';
import { CALIBRATION_DIR, CALIBRATION_SECONDS, calibrationFixturePath } from './gen-calibration-fixtures.mjs';
import { createCalibrationPlan, executionOf } from '../lib/calibration-plan.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, fallback) => {
  const i = argv.indexOf(`--${key}`);
  return i < 0 ? fallback : argv[i + 1];
};
if (argv.includes('--help')) {
  console.log(`Local calibration timing prototype (requires build:e2e and decode fixtures)
  --only h264-1080,h264-2160,hevc-1080,hevc-2160
  --fixture-set short|full  20s calibration clips (default) or original 60s clips
  --tracks 1,2,3       ascending loads; last load is repeated
  --window-s 4        measured playback per load
  --warmup-s 1.5      playback before measurement
  --quiet-s 15        maximum background settling wait (timeout is reported)
  --no-seek           omit four seek-response probes per fixture
  --no-motif          omit mixed video + countdown cold/replay comparison
  --plan-only         print the fixed plan without starting the app
Outputs report.json and report.html under .scratch/performance-calibration/.
No settings in the regular user profile are changed. No preset is generated.`);
  process.exit(0);
}
const number = (key, fallback, min, max) => {
  const value = Number(arg(key, fallback));
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid --${key}`);
  return value;
};
const options = {
  fixtureSet: arg('fixture-set', 'short'),
  fixtures: arg('only', 'h264-1080,h264-2160,hevc-1080,hevc-2160').split(','),
  tracks: arg('tracks', '1,2,3').split(',').map(Number),
  windowS: number('window-s', 4, 1, 20),
  warmupS: number('warmup-s', 1.5, 0, 10),
  quietS: number('quiet-s', 15, 0, 120),
  seek: !argv.includes('--no-seek'), motif: !argv.includes('--no-motif'),
};
if (!['short', 'full'].includes(options.fixtureSet)) throw new Error('--fixture-set must be short or full');
// Reserve two seconds for play-start polling, IPC scheduling, and the decoder
// lookahead. Reject long custom windows before launching, rather than measuring
// a clock stopped at EOF. Select --fixture-set full for longer experiments.
const durationS = options.fixtureSet === 'short' ? CALIBRATION_SECONDS : 60;
if (2 + options.warmupS + options.windowS + 2 > durationS) {
  throw new Error('Playback window exceeds fixture duration; reduce --window-s/--warmup-s or use --fixture-set full');
}
if (options.tracks.some((n, i) => !Number.isInteger(n) || n < 1 || n > 8 || (i && n <= options.tracks[i - 1]))) {
  throw new Error('--tracks must contain ascending integers from 1 to 8');
}
const plan = createCalibrationPlan(options);
if (argv.includes('--plan-only')) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
function fixtureFor(name) {
  const row = BENCH_MATRIX.find(r => r.name === name);
  if (!row || !/^(h264|hevc)-(1080|2160)$/.test(name)) throw new Error(`Unsupported fixture ${name}`);
  const file = options.fixtureSet === 'short' ? calibrationFixturePath(name) : benchFixturePath(name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}; ${options.fixtureSet === 'short' ? 'run npm run bench:calibration:fixtures' : `generate with gen-decode-bench-fixtures.mjs --only ${name}`}`);
  return { ...row, file, durationUs: durationS * 1e6, bytes: fs.statSync(file).size };
}
const fixtures = options.fixtures.map(fixtureFor);
const motifFixture = options.motif ? fixtureFor('h264-1080') : null;
const main = path.join(desktop, 'out/main/index.js');
if (!fs.existsSync(main)) throw new Error('Run npm run build:e2e in apps/desktop first');
const runDir = path.resolve(desktop, '../../.scratch/performance-calibration', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
const start = performance.now();
const report = {
  version: 3, startedAt: new Date().toISOString(), plan, options, fixtures,
  fixtureValidation: options.fixtureSet === 'short' ? JSON.parse(fs.readFileSync(path.join(CALIBRATION_DIR, 'manifest.json'), 'utf8')) : null,
  host: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
  notes: [
    '这是耗时原型，不生成机器上限或预设；短窗口通过不能证明长期稳定。',
    `素材为 ${durationS} 秒、30fps、8 秒 GOP 的合成视频；20 秒版直接复制原视频前段压缩数据，不重编码。素材生成和应用构建不计入运行时间，尚未随应用分发。`,
    '每种素材使用独立应用和项目；同素材逐步增加图层并复测最后一档。多层使用同一素材的独立解码实例。',
    '预览固定原片和完整分辨率；只在隔离配置中放宽硬件解码准入，其他缓存预算保持默认。软件回退和后台未静止均单独标记。',
    'CPU 是 Electron 各进程的统计之和；不含独立 FFmpeg 子进程。未测 GPU 利用率或整机可用显存，不据此推算缓存容量。',
    '动画测试为视频加 countdown 的首次播放与重播，包含正常预烘焙；不等于纯冷缓存对比，也不覆盖所有动画。',
  ], phases: [], samples: [], seeks: [], errors: [], wallMs: 0,
};
const labels = { launch: '启动应用', settings: '设置隔离配置', project: '创建测试项目', import: '导入及放置素材', ready: '等待解码首帧', background: '等待后台任务', warmup: '播放预热', measure: '播放采样', seek: '跳转响应', motif: '加入动画', close: '关闭应用' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const seconds = ms => (ms / 1000).toFixed(2);
function save() {
  report.wallMs = performance.now() - start;
  report.execution = executionOf(plan, report);
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const totals = {};
  for (const p of report.phases) totals[p.kind] = (totals[p.kind] ?? 0) + p.ms;
  const table = (headers, rows) => `<table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const stateLabels = { recorded: '已记录', pending: '待执行', 'not-run': '未完成' };
  const planSection = `<h2>固定测试计划</h2><p>计划标识：<code>${plan.id.slice(0, 16)}</code> · <a href="plan.json">完整计划</a></p><p>不读取历史成绩，不根据本轮成绩加减档位或复测。已记录表示有测量数据，不代表性能通过。</p>${table(['场景', '测试项', '状态', '未完成原因'], report.execution.map(item => [item.scenario, item.kind === 'playback' ? `${item.cell} · ${item.windowS}s` : `跳转到 ${item.targetUs / 1e6}s`, stateLabels[item.status], item.reason]))}`;
  fs.writeFileSync(path.join(runDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>校准测试耗时原型</title><style>body{font:15px/1.6 system-ui;background:#101419;color:#e7edf4;max-width:1150px;margin:40px auto;padding:0 24px}h1{font-size:28px}h2{margin-top:32px;font-size:20px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #33404d}th{color:#95b7d8}small,li{color:#aab7c5}code{color:#98d8bf}meter{width:220px;height:18px}td:first-child{overflow-wrap:anywhere}a{color:#98c7ff}</style><h1>校准测试耗时原型</h1><p>${escape(report.startedAt)} · 总耗时 <b>${seconds(report.wallMs)} 秒</b> · ${report.finishedAt ? '已结束' : '进行中'}</p><p>${escape(report.host.cpu)} · ${Math.round(report.host.totalMemoryBytes / 2 ** 30)} GiB · ${escape(report.host.platform)}</p><p>每段预热 ${options.warmupS}s，采样 ${options.windowS}s，路数 ${options.tracks.join(' / ')}。<a href="report.json">原始记录</a></p>${planSection}<h2>时间花在哪里</h2>${table(['阶段', '累计秒数', '占总耗时'], Object.entries(totals).sort((a,b) => b[1]-a[1]).map(([k,v]) => [labels[k], seconds(v), `${(100*v/report.wallMs).toFixed(1)}%`]))}<h2>播放记录</h2>${table(['场景', '路数', '结果', '画面提交/秒¹', '掉帧计数', 'tick p99 / ms', '实际采样秒'], report.samples.map(s => [s.cell,s.tracks,s.observation,s.presentHz?.toFixed(1),s.dropped,s.tickP99Ms?.toFixed(1),seconds(s.wallMs)]))}<small>¹ 画面提交可能重复同一帧，不能单独作为流畅度结论；需结合内容时钟、掉帧和每层解码计数。</small><h2>跳转记录</h2>${table(['场景', '目标秒', '等待毫秒', '结果'], report.seeks.map(s => [s.cell,s.targetUs/1e6,s.ms.toFixed(1),s.ok?'目标帧已绑定':'超时']))}<h2>逐项计时</h2>${table(['场景', '阶段', '开始秒', '耗时秒', '状态'], report.phases.map(p => [p.cell,labels[p.kind],seconds(p.offsetMs),seconds(p.ms),p.error || '完成']))}<h2>解释边界</h2><ul>${report.notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul>${report.errors.length ? `<h2>错误</h2><pre>${escape(JSON.stringify(report.errors,null,2))}</pre>` : ''}`);
}
async function phase(cell, kind, fn) {
  const begin = performance.now();
  const p = { cell, kind, offsetMs: begin - start, ms: 0 };
  console.log(`START ${cell} / ${labels[kind]}`);
  try { return await fn(); }
  catch (e) { p.error = String(e); throw e; }
  finally { p.ms = performance.now() - begin; report.phases.push(p); save(); console.log(`DONE  ${cell} / ${labels[kind]} ${seconds(p.ms)}s${p.error ? ' ERROR' : ''}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(read, accept, timeoutMs, interval = 100) {
  const begin = performance.now();
  let value;
  do {
    value = await read();
    if (accept(value)) return { ok: true, ms: performance.now() - begin, value };
    await sleep(interval);
  } while (performance.now() - begin < timeoutMs);
  return { ok: false, ms: performance.now() - begin, value };
}
let activeApp;
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  report.errors.push({ error: 'Interrupted by user' }); save();
  activeApp?.process().kill(); process.exitCode = 130;
});
async function runFixture(fixture, scenario) {
  const { name, mixed } = scenario;
  let app, page;
  const hook = (method, args) => page.evaluate(({ method, args }) => window.__weftcutTest[method](args), { method, args });
  const invoke = (cmd, args) => page.evaluate(({ cmd, args }) => window.api.backend.invoke(cmd, args), { cmd, args });
  const ids = [];
  const probes = () => page.evaluate(ids => ids.map(id => window.__weftcutTest.activeClipProbe(id)), ids);
  const snapshot = () => page.evaluate(() => ({ resource: window.__weftcutTest.previewResourceProbe(), perf: window.__weftcutTest.compositorPerfSnapshot(), stage: window.__weftcutTest.stageProfilingSnapshot(), derivativeJobsPending: !!document.querySelector('.derivatives-pill') }));
  const metrics = () => app.evaluate(({ app }) => app.getAppMetrics());
  const root = path.join(runDir, name);
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  // page.evaluate has no timeout of its own. A renderer/native hang must still
  // leave a partial report and terminate only this harness's child process.
  const watchdog = setTimeout(() => {
    report.errors.push({ cell: name, error: 'Fixture watchdog expired' });
    save(); app?.process().kill();
  }, (100 + options.quietS + (options.tracks.length + 1) * (options.windowS + options.warmupS + 30)) * 1000);
  try {
    await phase(name, 'launch', async () => {
      app = activeApp = await electron.launch({ executablePath: electronBinPath(), args: [`--user-data-dir=${path.join(root, 'profile')}`, main], env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1', ...(process.platform === 'win32' ? { WEFTCUT_FORCE_HW_LANE: 'd3d11va' } : {}) }, timeout: 45_000 });
      page = await app.firstWindow({ timeout: 30_000 });
      page.setDefaultTimeout(20_000);
      await page.waitForFunction(() => typeof window.__weftcutTest?.stageProfilingSnapshot === 'function', undefined, { timeout: 30_000 });
      report.gpu ??= await app.evaluate(({ app }) => app.getGPUInfo('basic'));
    });
    await phase(name, 'settings', async () => {
      report.settings = await invoke('app_settings_set', { patch: plan.initialSettings });
    });
    await phase(name, 'project', async () => {
      await hook('newProjectAndEnter', { parentFolder: path.join(root, 'projects'), name: 'calibration', canvas: { width: fixture.width, height: fixture.height, fpsNum: 30, fpsDen: 1 } });
      await page.waitForSelector('[data-testid="timeline-ruler"]');
      await page.waitForSelector('.splash-screen', { state: 'detached' });
      await hook('setPreferProxies', false);
    });
    let mediaId;
    await phase(name, 'import', async () => {
      const first = await hook('importAndPlaceMedia', { mediaAbsPath: fixture.file, tStartUs: 0 });
      mediaId = first.mediaId; ids.push(first.layerId);
      await page.evaluate(mediaId => window.__weftcutTest.setProxyOverride(mediaId, false), mediaId);
    });
    const background = await phase(name, 'background', async () => {
      let quiet = 0;
      return poll(async () => {
        const m = await metrics();
        const cpu = m.reduce((sum,p) => sum + (p.cpu?.percentCPUUsage ?? 0), 0);
        const jobs = await page.evaluate(() => !!document.querySelector('.derivatives-pill'));
        quiet = cpu < 20 && !jobs ? quiet + 1 : 0;
        return { cpu, jobs, quiet };
      }, x => x.quiet >= 3, plan.quietS * 1000, 500);
    });
    if (mixed) await phase(name, 'motif', async () => {
      // Countdown's seconds prop caps its layer duration. Setting only
      // durationUs silently truncates it to 5s and stops testing the overlay
      // halfway through a longer measurement window.
      const seconds = Math.ceil(2 + options.warmupS + options.windowS + 2);
      const layerId = await hook('addMotifLayer', { motifId: 'countdown', durationUs: seconds * 1e6, props: { seconds } });
      const summary = await invoke('project_summary', {});
      const layer = Object.values(summary.compositions).flatMap(c => c.tracks.flatMap(t => t.layers)).find(l => l.id === layerId);
      if (!layer || layer.t_end_us < seconds * 1e6) throw new Error('Motif layer does not cover the measurement window');
    });
    for (const sampleWindow of scenario.windows) {
      const { tracks: n, cell, startUs, warmupS, windowS } = sampleWindow;
      if (ids.length < n) await phase(cell, 'import', async () => {
        while (ids.length < n) ids.push((await hook('placeMediaLayer', { mediaId, tStartUs: 0 })).layerId);
      });
      await phase(cell, 'ready', async () => {
        const result = await poll(probes, ps => ps.every(p => p?.builtFromKey && p.ringSize > 0), 15_000);
        if (!result.ok) throw new Error(`Decoder not ready: ${JSON.stringify(result.value)}`);
      });
      const pre = await probes();
      await phase(cell, 'warmup', async () => {
        await hook('transportSeekUs', startUs);
        await hook('stageProfilingSet', true);
        await hook('transportPlay');
        const advancing = await poll(() => hook('previewResourceProbe'), r => r?.positionUs > startUs + 150_000, 10_000);
        if (!advancing.ok) throw new Error('Playback clock did not advance');
        await sleep(warmupS * 1000);
        const position = (await hook('previewResourceProbe'))?.positionUs;
        if (!Number.isFinite(position) || position + (windowS + .5) * 1e6 >= fixture.durationUs) {
          throw new Error('Insufficient media remains after warmup; use --fixture-set full or a shorter window');
        }
      });
      await phase(cell, 'measure', async () => {
        await hook('stageProfilingReset');
        const before = await snapshot();
        const begin = performance.now();
        const timeline = [];
        while (performance.now() - begin < windowS * 1000) {
          await sleep(Math.min(500, Math.max(1, windowS * 1000 - (performance.now() - begin))));
          const state = await snapshot();
          timeline.push({ atMs: performance.now() - begin, state, processes: await metrics() });
        }
        const end = timeline.at(-1).state;
        const wallMs = timeline.at(-1).atMs;
        const after = await probes();
        const contentS = (end.resource.positionUs - before.resource.positionUs) / 1e6;
        const presented = end.resource.presentedCompositeCount - before.resource.presentedCompositeCount;
        const dropped = (end.perf.underrun?.droppedFrames ?? 0) - (before.perf.underrun?.droppedFrames ?? 0);
        const pure = [...pre, ...after].every(p => p?.sourceKind === 'native-gpu' && p.builtFromKey?.startsWith('ffmpeg:original:'));
        const tickP99Ms = end.stage.byStage?.tickInterval?.p99Ms ?? null;
        const flags = [];
        if (!pure) flags.push('含回退或路由异常');
        if (!background.ok) flags.push('采样前后台等待超时');
        if (timeline.some(t => t.state.derivativeJobsPending)) flags.push('采样期间存在后台任务');
        if (contentS < wallMs / 1000 * .9) flags.push('内容时钟偏慢');
        if (presented <= 0) flags.push('未提交画面');
        if (dropped > contentS * 30 * .01) flags.push('掉帧超过 1%');
        if (tickP99Ms === null) flags.push('缺少帧间隔数据');
        else if (tickP99Ms > 1000 / 30) flags.push('长帧间隔');
        if (mixed) {
          const motifs = timeline.flatMap(t => t.state.perf.motifs ?? []);
          if (timeline.some(t => !t.state.perf.motifs?.length)) flags.push('动画未覆盖完整采样');
          if (!motifs.length || motifs.every(m => m.boundFrame == null)) flags.push('动画未出帧');
          else if (motifs.some(m => m.boundFrame == null || m.lagFrames > 2 || m.heldMs > 100)) flags.push('动画跟帧延迟');
        }
        report.samples.push({ cell, tracks: n, mixed, observation: flags.join('；') || '短窗口未见异常', wallMs, contentS, presentHz: presented / (wallMs / 1000), dropped, tickP99Ms, routePure: pure, background, before, timeline, pre, after, budget: await hook('previewGpuBudget') });
        await hook('transportPause');
        await hook('stageProfilingSet', false);
      });
    }
    {
      for (const targetUs of scenario.seekTargetsUs) {
        await phase(name, 'seek', async () => {
          const begin = performance.now();
          await hook('transportSeekUs', targetUs);
          const result = await poll(probes, ps => ps.every(p => p?.boundFramePtsUs != null && Math.abs(p.boundFramePtsUs - targetUs) <= 70_000), 5000, 25);
          report.seeks.push({ cell: name, targetUs, ...result, ms: performance.now() - begin });
        });
      }
    }
  } catch (e) {
    report.errors.push({ cell: name, error: String(e) });
    console.error(`${name}: ${e}`);
  } finally {
    clearTimeout(watchdog);
    if (app) await phase(name, 'close', async () => {
      const timer = setTimeout(() => app.process().kill(), 8000);
      try { await app.close(); } catch (e) { report.errors.push({ cell: name, error: `close: ${e}` }); }
      finally { clearTimeout(timer); activeApp = undefined; }
    });
  }
}
console.log(`Report: ${runDir}`);
console.log(`Fixed plan: ${plan.id}`);
save();
for (const scenario of plan.scenarios) {
  if (interrupted) break;
  const fixture = scenario.mixed ? motifFixture : fixtures.find(f => f.name === scenario.fixture);
  await runFixture(fixture, scenario);
}
report.finishedAt = new Date().toISOString(); save();
console.log(`Finished in ${seconds(report.wallMs)}s: ${path.join(runDir, 'report.html')}`);
process.exitCode = interrupted ? 130 : report.errors.length ? 2 : 0;
