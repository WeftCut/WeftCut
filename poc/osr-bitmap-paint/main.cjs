// Can the bitmap OSR `paint` event replace Page.captureScreenshot as the Motif
// capture output? Runs the production order (render, settle two frames, output)
// on a self-describing page: each frame draws its number as a barcode, so a
// stale or omitted surface is read from the pixels rather than inferred.
//
//   electron poc/osr-bitmap-paint/main.cjs --user-data-dir=<dir> --out=<dir> [--n=40] [--w=1920] [--h=1080]
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const N = Number(arg('n', 40))
const W = Number(arg('w', 1920))
const H = Number(arg('h', 1080))
const OUT = arg('out', path.join(__dirname, 'out'))
const STAGES = arg('stages', 'alpha,correct,timing,nav,resize').split(',')
const KINDS = arg('kinds', 'dom,alpha,canvas,canvasCpu,webgl').split(',')
const PAGE = path.join(__dirname, 'page.html')
const STEP_TIMEOUT_MS = 15000
const PAINT_TIMEOUT_MS = 2000
const BITS = 16
const DIFF_TOLERANCE = 2

setTimeout(() => { console.error('WATCHDOG: run exceeded 15 minutes'); app.exit(3) }, 15 * 60 * 1000).unref()

const withTimeout = (p, label, ms = STEP_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
  p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
})
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2)
}
const stats = xs => ({ n: xs.length, p50: pct(xs, .5), p95: pct(xs, .95) })

class Host {
  constructor(win) {
    this.win = win
    this.wc = win.webContents
    this.waiter = null
    this.paints = 0
    this.nullImages = 0
    this.wc.on('paint', (_e, dirty, image) => {
      this.paints++
      const w = this.waiter
      if (!w) return
      const size = image.getSize()
      if (size.width === 0 || size.height === 0) { this.nullImages++; return }
      if (size.width !== w.width || size.height !== w.height) return
      this.waiter = null
      const t0 = performance.now()
      const bitmap = image.toBitmap()
      w.resolve({ bitmap, dirty, width: size.width, height: size.height, toBitmapMs: performance.now() - t0, paintAt: t0 })
    })
  }
  send(method, params = {}) { return withTimeout(this.wc.debugger.sendCommand(method, params), method) }
  nextPaint(width, height) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new Error('paint timeout')) }, PAINT_TIMEOUT_MS)
      this.waiter = { width, height, resolve: v => { clearTimeout(t); resolve(v) } }
    })
  }
  async size(width, height) {
    this.lastSize = [width, height]
    this.win.setContentSize(width, height)
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }
  async load(kind, nonce = 0) {
    await withTimeout(this.win.loadFile(PAGE, { query: { kind, nonce: String(nonce) } }), 'loadFile', 30000)
    for (let i = 0; i < 100; i++) {
      const r = await this.send('Runtime.evaluate', { expression: `typeof window.__render==='function' && document.readyState==='complete'`, returnByValue: true })
      if (r.result.value === true) {
    // Production re-applies size and overrides after every navigation (capture.ts);
    // on Windows a document loaded without it never emits a paint.
        if (this.lastSize) await this.size(...this.lastSize)
        return
      }
      await new Promise(res => setTimeout(res, 20))
    }
    throw new Error('page never ready')
  }
  async info() { return (await this.send('Runtime.evaluate', { expression: 'window.__info()', returnByValue: true })).result.value }
  async render(frame, settle = 2) {
    const r = await this.send('Runtime.evaluate', { expression: `window.__render(${frame},${settle})`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  }
  async png() {
    const t0 = performance.now()
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    const t1 = performance.now()
    const buf = Buffer.from(shot.data, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    const bitmap = img.toBitmap()
    const t2 = performance.now()
    const s = img.getSize()
    return { bitmap, width: s.width, height: s.height, bytes: buf.length, screenshotMs: t1 - t0, decodeMs: t2 - t1 }
  }
}

async function newHost({ transparent }) {
  const win = new BrowserWindow({
    show: false, transparent,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  // A window built right after another's destroy can fail its first load.
  for (let attempt = 0; ; attempt++) {
    try { await withTimeout(win.loadURL('about:blank'), 'about:blank'); break }
    catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 300)) }
  }
  win.webContents.debugger.attach('1.3')
  const h = new Host(win)
  await h.send('Page.enable')
  await h.send('Runtime.enable')
  return h
}

// Bitmap order is N32: read back by channel name after `detectOrder`.
function readBar(b, width, row) {
  let value = 0
  let minAlpha = 255
  for (let i = 0; i < BITS; i++) {
    const off = ((row * 20 + 8) * width + i * 20 + 8) * 4
    const a = b[off + 3]
    minAlpha = Math.min(minAlpha, a)
    if (b[off] > 127 && b[off + 1] > 127 && b[off + 2] > 127) value |= 1 << i
  }
  return minAlpha < 200 ? 'blank' : value
}

function diff(a, b) {
  if (a.length !== b.length) return { sizeMismatch: true, count: -1, max: -1 }
  let count = 0
  let max = 0
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]))
    if (d > max) max = d
    if (d > DIFF_TOLERANCE) count++
  }
  return { count, max }
}

function dump(name, bitmap, width, height) {
  try {
    fs.writeFileSync(path.join(OUT, `${name}.png`), nativeImage.createFromBitmap(bitmap, { width, height }).toPNG())
  } catch (e) { console.error('dump failed', e.message) }
}

// Sequential with repeats (static seek) and backward jumps (scrub).
function frameSequence(n) {
  const out = []
  let f = 100
  for (let i = 0; i < n; i++) {
    if (i % 16 === 15) f -= 5
    else if (i % 8 !== 7) f += 1
    out.push(f)
  }
  return out
}

const LANES = {
  // OffscreenFrames' order: stop before render, restart and invalidate after.
  async 'paint-restart'(h, frame, w, height) {
    h.wc.stopPainting()
    const t0 = performance.now()
    await h.render(frame)
    const t1 = performance.now()
    const p = h.nextPaint(w, height)
    h.wc.startPainting()
    h.wc.invalidate()
    const got = await p
    return { ...got, renderMs: t1 - t0, outputMs: performance.now() - t1, blockMs: got.toBitmapMs }
  },
  // Painting stays on; takes the first paint after the settle.
  async 'paint-keep'(h, frame, w, height) {
    if (!h.wc.isPainting()) h.wc.startPainting()
    const t0 = performance.now()
    await h.render(frame)
    const t1 = performance.now()
    const p = h.nextPaint(w, height)
    h.wc.invalidate()
    const got = await p
    return { ...got, renderMs: t1 - t0, outputMs: performance.now() - t1, blockMs: got.toBitmapMs }
  },
  async png(h, frame) {
    // The production PNG host never stops painting.
    if (!h.wc.isPainting()) h.wc.startPainting()
    const t0 = performance.now()
    await h.render(frame)
    const t1 = performance.now()
    const got = await h.png()
    return { ...got, renderMs: t1 - t0, outputMs: performance.now() - t1, blockMs: got.decodeMs }
  },
}

async function verify(h, lane, frame, w, height, label, tally) {
  let got
  try { got = await LANES[lane](h, frame, w, height) }
  catch (e) { tally.errors++; tally.firstError ??= e.message; return }
  tally.samples++
  const dom = readBar(got.bitmap, got.width, 0)
  const surface = readBar(got.bitmap, got.width, 1)
  if (dom === 'blank') tally.blankDom++
  else if (dom !== frame) { tally.staleDom++; tally.staleBy.push(frame - dom) }
  if (surface === 'blank') tally.blankSurface++
  else if (surface !== frame) tally.staleSurface++
  if (lane === 'png') return
  const ref = await h.png()
  const refDom = readBar(ref.bitmap, ref.width, 0)
  const refSurface = readBar(ref.bitmap, ref.width, 1)
  if (refDom !== frame || refSurface !== frame) tally.refWrong++
  const d = diff(got.bitmap, ref.bitmap)
  if (d.count !== 0) {
    tally.diffFrames++
    tally.maxDiffCount = Math.max(tally.maxDiffCount, d.count)
    tally.maxDelta = Math.max(tally.maxDelta, d.max)
    if (!tally.dumped) {
      tally.dumped = true
      dump(`${label}-paint`, got.bitmap, got.width, got.height)
      dump(`${label}-ref`, ref.bitmap, ref.width, ref.height)
    }
  }
}
const newTally = () => ({ samples: 0, errors: 0, blankDom: 0, staleDom: 0, staleBy: [], blankSurface: 0, staleSurface: 0, refWrong: 0, diffFrames: 0, maxDiffCount: 0, maxDelta: 0 })

async function stageAlpha(results) {
  results.alpha = {}
  for (const transparent of [true, false]) {
    const h = await newHost({ transparent })
    await h.size(W, H)
    await h.load('alpha')
    const read = (b, width, x, y) => [...b.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
    const sample = (g) => ({
      half: read(g.bitmap, g.width, 500, 400),
      solid: read(g.bitmap, g.width, 800, 400),
      background: read(g.bitmap, g.width, 1000, 900),
    })
    const paint = await LANES['paint-keep'](h, 200, W, H)
    const png = await h.png()
    results.alpha[`transparent=${transparent}`] = { paint: sample(paint), png: sample(png), diff: diff(paint.bitmap, png.bitmap) }
    h.win.destroy()
  }
}

async function stageCorrect(results) {
  results.correct = {}
  const h = await newHost({ transparent: true })
  await h.size(W, H)
  for (const kind of KINDS) {
    await h.load(kind)
    const info = await h.info()
    if (info.unsupported) { results.correct[kind] = info; continue }
    if (info.renderer) results.webglRenderer = info.renderer
    for (const lane of ['paint-restart', 'paint-keep']) {
      const t = newTally()
      for (const f of frameSequence(N)) await verify(h, lane, f, W, H, `correct-${kind}-${lane}`, t)
      results.correct[`${kind}/${lane}`] = t
    }
  }
  h.win.destroy()
}

async function stageTiming(results) {
  results.timing = {}
  for (const fps of [60, 240]) {
    const h = await newHost({ transparent: true })
    h.wc.setFrameRate(fps)
    await h.size(W, H)
    for (const kind of KINDS) {
      await h.load(kind)
      if ((await h.info()).unsupported) continue
      const rows = { png: [], 'paint-restart': [], 'paint-keep': [] }
      const wrong = { png: 0, 'paint-restart': 0, 'paint-keep': 0 }
      const errors = { png: 0, 'paint-restart': 0, 'paint-keep': 0 }
      const lanes = Object.keys(rows)
      const seq = frameSequence(N * lanes.length)
      for (let i = 0; i < seq.length; i++) {
        // Lanes rotate frame by frame so drift and thermal state hit all three.
        const lane = lanes[i % lanes.length]
        try {
          const g = await LANES[lane](h, seq[i], W, H)
          rows[lane].push(g)
          if (readBar(g.bitmap, g.width, 0) !== seq[i]) wrong[lane]++
        } catch { errors[lane]++ }
      }
      for (const lane of lanes) {
        results.timing[`${fps}fps/${kind}/${lane}`] = {
          render: stats(rows[lane].map(r => r.renderMs)),
          output: stats(rows[lane].map(r => r.outputMs)),
          mainThreadBlock: stats(rows[lane].map(r => r.blockMs)),
          wrong: wrong[lane], errors: errors[lane],
          ...(lane === 'png' ? { pngBytesP50: pct(rows[lane].map(r => r.bytes), .5) } : {}),
        }
      }
    }
    h.win.destroy()
  }
}

async function stageNav(results) {
  results.nav = {}
  const h = await newHost({ transparent: true })
  await h.size(W, H)
  const cycles = Math.max(10, Math.floor(N / 2))
  for (const kind of KINDS) {
    await h.load(kind)
    if ((await h.info()).unsupported) continue
    for (const lane of ['paint-restart', 'paint-keep', 'png']) {
      const t = newTally()
      for (let i = 0; i < cycles; i++) {
        await h.load(kind, i + 1)
        await verify(h, lane, 500 + i, W, H, `nav-${kind}-${lane}`, t)
      }
      results.nav[`${kind}/${lane}`] = t
    }
  }
  h.win.destroy()
}

async function stageResize(results) {
  results.resize = {}
  const h = await newHost({ transparent: true })
  const sizes = [[1280, 720], [W, H], [960, 540]]
  for (const kind of KINDS) {
    await h.size(W, H)
    await h.load(kind)
    if ((await h.info()).unsupported) continue
    for (const lane of ['paint-restart', 'paint-keep']) {
      const t = newTally()
      for (let i = 0; i < 12; i++) {
        const [w, height] = sizes[i % sizes.length]
        await h.size(w, height)
        await verify(h, lane, 700 + i, w, height, `resize-${kind}-${lane}`, t)
      }
      results.resize[`${kind}/${lane}`] = t
    }
  }
  h.win.destroy()
}

app.on('window-all-closed', () => { /* the run owns exit */ })
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const results = {
    electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform,
    arch: process.arch, size: [W, H], n: N, gpuFeatures: app.getGPUFeatureStatus(),
  }
  const stages = { alpha: stageAlpha, correct: stageCorrect, timing: stageTiming, nav: stageNav, resize: stageResize }
  let code = 0
  for (const name of STAGES) {
    const started = Date.now()
    try { await stages[name](results) }
    catch (e) { results[`${name}Failed`] = String(e?.stack ?? e); code = 1 }
    results.gpuAtEnd = app.getGPUFeatureStatus().gpu_compositing
    console.log(`[stage] ${name} ${Date.now() - started} ms`)
    fs.writeFileSync(path.join(OUT, `results-${W}x${H}.json`), JSON.stringify(results, null, 1))
  }
  console.log('[done]', path.join(OUT, `results-${W}x${H}.json`))
  app.exit(code)
})
