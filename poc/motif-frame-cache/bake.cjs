// Full-bake benchmark. All projects, profiles, frames and bundles are disposable.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const native = require('../../apps/desktop/native');
const root = path.resolve(__dirname, '../..');
const work = path.join(root, '.scratch', `motif-bake-${Date.now()}`);
const experiment = require(path.join(root, '.scratch/motif-bake-addon.node'));
app.setPath('userData', path.join(work, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'motif', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// A title card with antialiased text, CSS animation, partial alpha and Canvas.
// "dense" adds deterministic high-entropy Canvas pixels with all 256 alphas.
const html = `<!doctype html><style>
html,body{margin:0;background:transparent;overflow:hidden}
#box{position:absolute;left:4%;top:8%;width:42%;height:26%;background:rgba(31,150,225,.47);border-radius:23px;box-shadow:8px 10px 20px #21224466}
#text{position:absolute;left:7%;top:16%;color:#fca96db5;font:700 48px Arial;letter-spacing:1px}
#waapi{position:absolute;left:12%;top:55%;width:25%;height:10%;background:#8090ff79;animation:move 2s linear infinite alternate}
@keyframes move{from{transform:translateX(0)}to{transform:translateX(90px)}}
canvas{position:absolute;inset:0;z-index:-1}
</style><canvas></canvas><div id="box"></div><div id="text"></div><div id="waapi"></div><script>
let fixture='overlay';motif.define({setup(props){fixture=props.fixture},frame(t,ctx){
 const i=Math.round(t*30),c=document.querySelector('canvas');
 document.querySelector('#box').style.transform='translateX('+(i*3%90)+'px)';
 document.querySelector('#text').textContent='Frame '+i+' — Motif';
 if(c.width!==ctx.width||c.height!==ctx.height){c.width=ctx.width;c.height=ctx.height}
 const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);
 if(fixture==='dense'){
   const data=g.createImageData(c.width,c.height);let s=12345+i;
   for(let p=0;p<data.data.length;p+=4){s=(Math.imul(s,1664525)+1013904223)|0;data.data[p]=s>>>24;data.data[p+1]=s>>>16;data.data[p+2]=s>>>8;data.data[p+3]=(p/4+i)%256}
   g.putImageData(data,0,0);
 }else{g.fillStyle='rgba(210,70,130,.31)';g.fillRect(i%100,c.height*.7,c.width*.4,30)}
}});
</script>`;

const hashOf = s => createHash('md5').update(s).digest('hex'); // cache address only
const stats = values => {
  const a = [...values].sort((x, y) => x - y);
  return { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length,
    p50: a[Math.floor((a.length - 1) * .5)], p95: a[Math.ceil((a.length - 1) * .95)] };
};
let capture, gpu, encoder, win;
app.whenReady().then(async () => {
  await fs.mkdir(work, { recursive: true });
  const bundles = {
    capture: 'apps/desktop/src/main/motif/capture.ts',
    runtime: 'apps/desktop/src/renderer/render/motifs/runtime.ts',
    gpu: 'apps/desktop/src/main/motif/gpuTransport.ts',
    store: 'apps/desktop/src/main/motif/frameStore.ts',
    preload: 'poc/motif-frame-cache/bake-preload.ts',
    renderer: 'poc/motif-frame-cache/bake-renderer.ts',
  };
  for (const [name, entry] of Object.entries(bundles)) {
    await esbuild.build({ entryPoints: [path.join(root, entry)], outfile: path.join(work, name + '.cjs'),
      bundle: true, platform: name === 'renderer' ? 'browser' : 'node',
      format: name === 'renderer' ? 'iife' : 'cjs', globalName: name === 'renderer' ? 'bakeBench' : undefined,
      external: ['electron'], alias: { '@': path.join(root, 'apps/desktop/src/renderer') },
      define: { 'import.meta.dirname': JSON.stringify(path.join(root, 'apps/desktop/src/main')), 'import.meta.env.VITE_WEFTCUT_E2E': '"0"' } });
  }
  capture = require(path.join(work, 'capture.cjs'));
  capture.setRuntimeSource(require(path.join(work, 'runtime.cjs')).MOTIF_RUNTIME_SOURCE);
  capture.setTextureCaptureEnabled(true);
  protocol.handle('motif', () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
  const { MotifGpuTransport } = require(path.join(work, 'gpu.cjs'));
  const { MotifFrameStore } = require(path.join(work, 'store.cjs'));
  gpu = new MotifGpuTransport((w, h, bgra) => new native.MotifGpuPool(w, h, 1, bgra));
  encoder = new experiment.TextureEncoder();
  let config, hash, metrics, captures, captureByFrame, counter = 0;
  const getMetric = frame => metrics[frame] ??= {};
  const store = new MotifFrameStore(async () => work, native);
  let readGpu = true;
  ipcMain.handle('bench:readMode', (_event, enabled) => { readGpu = enabled; });
  ipcMain.handle('motif:read', (event, a) => store.read(a.hash, a.frame,
    readGpu ? (file, width, height) => gpu.read(event.sender, file, width, height) : undefined));
  // Candidate still uses production atomic file replacement and directory layout.
  const writeEncoded = async (frame, bytes) => {
    const encodedStore = new MotifFrameStore(async () => work, { motifEncodePng: async () => bytes });
    const t = performance.now(); await encodedStore.write(hash, frame, new Uint8Array());
    return performance.now() - t;
  };
  ipcMain.handle('bench:begin', (_event, c) => {
    config = c; hash = hashOf(JSON.stringify(c) + ':' + counter++);
    metrics = {}; captures = 0; captureByFrame = {}; return hash;
  });
  ipcMain.handle('bench:has', (_event, frame) => store.has(hash, frame));
  ipcMain.handle('bench:persist', async (_event, a) => {
    const t = performance.now(); let bytes, encodeMs;
    // Match FrameStore's zero-copy Buffer view; Buffer.from(Uint8Array) would
    // add a benchmark-only full-payload copy, especially unfair to RGBA IPC.
    const input = Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength);
    if (a.mode === 'png') {
      bytes = await native.motifEncodePng(input, true);
      encodeMs = performance.now() - t;
    } else {
      const encoded = await experiment.encodeRgba(a.width, a.height, input);
      bytes = encoded.bytes; encodeMs = performance.now() - t;
    }
    const writeMs = await writeEncoded(a.frame, bytes);
    Object.assign(getMetric(a.frame), { encodeMs, writeMs, fileBytes: bytes.length });
    return { encodeMs, writeMs, fileBytes: bytes.length };
  });
  ipcMain.on('motif:ack', (event, { token, failed }) => gpu.release(event.sender, token, failed));
  ipcMain.handle('motif:capture', async (event, request) => {
    const { benchFrame: frame, ...a } = request;
    captures++; captureByFrame[frame] = (captureByFrame[frame] ?? 0) + 1;
    const start = performance.now();
    return capture.captureMotifTexture(a, async texture => {
      getMetric(frame).renderMs = performance.now() - start;
      if (config.mode === 'native') {
        const encoded = await encoder.encode(texture.textureInfo.handle.ntHandle);
        Object.assign(getMetric(frame), { readbackMs: encoded.readbackMs, alphaMs: encoded.alphaMs,
          encodeMs: encoded.encodeMs, fileBytes: encoded.bytes.length,
          writeMs: await writeEncoded(frame, encoded.bytes) });
      }
      const t = performance.now();
      const result = await gpu.copy(event.sender, texture);
      getMetric(frame).gpuCopyMs = performance.now() - t;
      return result;
    });
  });
  ipcMain.handle('bench:end', () => ({ hash, captures, captureByFrame, metrics }));
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(work, 'preload.cjs'), backgroundThrottling: false, sandbox: true,
  } });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(await fs.readFile(path.join(work, 'renderer.cjs'), 'utf8'));
  const run = (fn, ...args) => win.webContents.executeJavaScript(`bakeBench.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`);
  const quick = process.env.MOTIF_BAKE_QUICK === '1';
  const frames = quick ? 4 : 20, rounds = quick ? 1 : 3;
  const result = { environment: { electron: process.versions.electron, node: process.versions.node,
    platform: process.platform, cpu: os.cpus()[0]?.model, gpu: await app.getGPUInfo('basic'), frames, rounds },
    warmups: [], runs: [], reuse: [], parity: [], renderedParity: [], summary: [] };
  const flush = () => fs.writeFile(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
  const validations = [];
  for (const [width, height] of [[480, 270], [1920, 1080]]) for (const fixture of ['overlay', 'dense']) {
    // Warm every path before timing; separate directories ensure all timed bakes are cold L2.
    for (const mode of ['png', 'rgba', 'native']) {
      result.warmups.push(await run('runBake', { mode, width, height, fixture, frames: 3, round: -1 }));
    }
    for (let round = 0; round < rounds; round++) {
      // Rotate execution order to reduce warmup/thermal/order bias.
      const modes = ['png', 'rgba', 'native'];
      const ordered = modes.slice(round).concat(modes.slice(0, round));
      const runs = {};
      for (const mode of ordered) {
        const r = await run('runBake', { mode, width, height, fixture, frames, round });
        if (r.main.captures !== frames || r.cachedFrames !== frames) throw new Error('Bake skipped frames or duplicated captures');
        result.runs.push(r); runs[mode] = r;
        console.log(`${width}x${height} ${fixture} round=${round} ${mode}: ${r.elapsedMs.toFixed(1)}ms (${r.fps.toFixed(2)}fps), captures=${r.main.captures}`);
        await flush();
      }
      validations.push({ width, height, fixture, round, runs });
    }
  }
  for (let round = 0; round < rounds; round++) for (const warmFirst of [false, true]) for (const reuse of round % 2 ? [true, false] : [false, true]) {
    const c = { mode: 'rgba', width: 1920, height: 1080, fixture: 'overlay', frames: quick ? 3 : 12, round };
    const r = await run('runReuse', c, reuse, warmFirst);
    r.round = round;
    const expectedCaptures = c.frames * (warmFirst ? (reuse ? 1 : 2) : (reuse ? 1 : 3));
    if (r.main.captures !== expectedCaptures) throw new Error(`Capture reuse: expected ${expectedCaptures}, got ${r.main.captures}`);
    result.reuse.push(r);
    console.log(`reuse=${reuse} warmFirst=${warmFirst}: captures=${r.main.captures}, mean=${stats(r.perFrame).mean.toFixed(1)}ms`);
    await flush();
  }
  // All validation follows ALL timing, so its large Canvas readbacks and disk
  // decodes cannot contaminate a later timed round with garbage collection.
  const sequences = new Map();
  result.determinism = [];
  for (const { width, height, fixture, round, runs } of validations) {
    for (const mode of ['rgba', 'native']) {
      let channels = 0, alpha = 0, max = 0, premultipliedChannels = 0, first;
      const digests = [];
      for (let f = 0; f < frames; f++) {
        const read = r => native.motifReadFrame(path.join(work, 'Cache/raster', r.main.hash, `${f}.wfrm`));
        const reference = await read(runs.png), actual = await read(runs[mode]);
        if (reference.width !== actual.width || reference.height !== actual.height) throw new Error('Frame dimensions differ');
        digests.push(createHash('sha256').update(actual.rgba).digest('hex'));
        for (let i = 0; i < reference.rgba.length; i++) {
          const diff = Math.abs(reference.rgba[i] - actual.rgba[i]);
          if (diff) {
            channels++; if (i % 4 === 3) alpha++; max = Math.max(max, diff);
            first ??= { frame: f, channel: i, expected: reference.rgba[i], actual: actual.rgba[i] };
          }
          const a = reference.rgba[i - i % 4 + 3], b = actual.rgba[i - i % 4 + 3];
          const expected = i % 4 === 3 ? a : Math.floor((reference.rgba[i] * a + 127) / 255);
          const got = i % 4 === 3 ? b : Math.floor((actual.rgba[i] * b + 127) / 255);
          if (expected !== got) premultipliedChannels++;
        }
      }
      result.parity.push({ width, height, fixture, round, mode, channels, alpha, max, premultipliedChannels, first });
      const key = `${width}:${fixture}:${mode}`, sequence = JSON.stringify(digests);
      if (new Set(digests).size !== frames) throw new Error('Fixture did not produce distinct frames');
      if (sequences.has(key) && sequences.get(key) !== sequence) throw new Error('Repeated runs produced different pixels');
      sequences.set(key, sequence);
      result.determinism.push({ width, height, fixture, round, mode, uniqueFrames: new Set(digests).size });
      if (round === 0) result.renderedParity.push({ width, height, fixture, mode,
        checks: await run('verifyRendered', runs.png.main.hash, runs[mode].main.hash, Math.min(frames, 3)) });
    }
    await flush();
  }
  for (const [width, height] of [[480, 270], [1920, 1080]]) for (const fixture of ['overlay', 'dense']) for (const mode of ['png', 'rgba', 'native']) {
    const runs = result.runs.filter(r => r.config.width === width && r.config.fixture === fixture && r.config.mode === mode);
    const frameTimes = runs.flatMap(r => r.timings);
    const stages = {};
    for (const field of ['frameMs', 'hasMs', 'captureIpcMs', 'prepareMs', 'persistIpcMs']) {
      const values = frameTimes.map(t => t[field]).filter(v => v !== undefined);
      if (values.length) stages[field] = stats(values);
    }
    for (const field of ['renderMs', 'gpuCopyMs', 'readbackMs', 'alphaMs', 'encodeMs', 'writeMs', 'fileBytes']) {
      const values = runs.flatMap(r => Object.values(r.main.metrics)).map(t => t[field]).filter(v => v !== undefined);
      if (values.length) stages[field] = stats(values);
    }
    result.summary.push({ width, height, fixture, mode, bakeMs: stats(runs.map(r => r.elapsedMs)), stages });
  }
  result.environment.gpuAfterRun = await app.getGPUInfo('complete');
  await flush();
  console.log(`RESULT ${path.join(work, 'result.json')}`);
  console.log('PARITY', JSON.stringify(result.parity));
  capture.shutdownCaptureHost(); gpu.close(win.webContents); win.destroy(); encoder.close();
  // Straight-alpha bytes can differ by one because more than one integer maps
  // to the SAME premultiplied channel. Do not hide that raw-byte finding: the
  // rendered comparison is a separate, stricter-than-perceptual exact-byte gate.
  const rawInvalid = result.parity.some(p => p.alpha || p.max > 1 || p.premultipliedChannels);
  const visibleInvalid = result.renderedParity.some(p => p.checks.some(c => c.channels));
  app.exit(rawInvalid || visibleInvalid ? 1 : 0);
}).catch(async error => {
  console.error(error);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'error.txt'), String(error.stack ?? error));
  capture?.shutdownCaptureHost(); if (win) { gpu?.close(win.webContents); win.destroy(); }
  encoder?.close(); app.exit(1);
});
