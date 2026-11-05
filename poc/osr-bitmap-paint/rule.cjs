// Tests the one selection rule the sequence run left standing (invalidate, wait
// for paints to go quiet, keep the last) where a surface is new: after a
// navigation and after a resize. Also reports whether the host preserves alpha.
//
//   electron poc/osr-bitmap-paint/rule.cjs --user-data-dir=<dir> --out=<file> [--n=20] [--stages=alpha,rule] [--w=1920] [--h=1080]
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const N = Number(arg('n', 20))
const W = Number(arg('w', 1920))
const H = Number(arg('h', 1080))
const OUT = arg('out', path.join(__dirname, 'rule.json'))
const STAGES = arg('stages', 'alpha,rule').split(',')
const KINDS = arg('kinds', 'dom,alpha,canvas,canvasCpu,webgl').split(',')
const VARIANT = arg('variant', null)
const PAGE = path.join(__dirname, 'page.html')
const BITS = 16
const DIFF_TOLERANCE = 2
const FIRST_PAINT_TIMEOUT_MS = 1500

setTimeout(() => { console.error('WATCHDOG'); app.exit(3) }, 13 * 60 * 1000).unref()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1)
}

function readBar(b, width, row) {
  let value = 0
  let minAlpha = 255
  for (let i = 0; i < BITS; i++) {
    const off = ((row * 20 + 8) * width + i * 20 + 8) * 4
    minAlpha = Math.min(minAlpha, b[off + 3])
    if (b[off] > 127 && b[off + 1] > 127 && b[off + 2] > 127) value |= 1 << i
  }
  return minAlpha < 200 ? 'blank' : value
}

// Pixels off after flattening the reference on white: a host without alpha
// still counts as matching when alpha is the only thing it lost.
function compare(paint, ref) {
  if (paint.length !== ref.length) return { sizeMismatch: true }
  let exact = 0
  let flattened = 0
  let opaque = 0
  for (let i = 0; i < paint.length; i += 4) {
    const inv = 255 - ref[i + 3]
    let e = Math.abs(paint[i + 3] - ref[i + 3])
    let f = 0
    for (let c = 0; c < 3; c++) {
      e = Math.max(e, Math.abs(paint[i + c] - ref[i + c]))
      f = Math.max(f, Math.abs(paint[i + c] - (ref[i + c] + inv)))
    }
    if (e > DIFF_TOLERANCE) exact++
    if (f > DIFF_TOLERANCE) flattened++
    if (paint[i + 3] === 255) opaque++
  }
  return { exact, flattened, opaque, total: paint.length / 4 }
}

async function makeHost(extra = {}) {
  const win = new BrowserWindow({
    show: false, transparent: true, ...extra,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  })
  for (let attempt = 0; ; attempt++) {
    try { await win.loadURL('about:blank'); break }
    catch (e) { if (attempt >= 3) throw e; await sleep(300) }
  }
  const wc = win.webContents
  wc.debugger.attach('1.3')
  const send = (m, p = {}) => wc.debugger.sendCommand(m, p)
  await send('Page.enable')
  await send('Runtime.enable')
  const h = { win, wc, send, sink: null }
  wc.on('paint', (_e, _dirty, image) => { if (h.sink) h.sink(image) })
  h.size = async (w, height) => {
    h.lastSize = [w, height]
    win.setContentSize(w, height)
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }
  h.load = async (kind, nonce = 0) => {
    await win.loadFile(PAGE, { query: { kind, nonce: String(nonce) } })
    for (let i = 0; i < 200; i++) {
      const r = await send('Runtime.evaluate', { expression: `typeof window.__render==='function' && document.readyState==='complete'`, returnByValue: true })
      if (r.result.value === true) {
    // Production re-applies size and overrides after every navigation (capture.ts);
    // on Windows a document loaded without it never emits a paint.
        if (h.lastSize) await h.size(...h.lastSize)
        return
      }
      await sleep(20)
    }
    throw new Error('never ready')
  }
  h.unsupported = async () => (await send('Runtime.evaluate', { expression: 'window.__info().unsupported ?? null', returnByValue: true })).result.value
  h.render = (f, settle) => send('Runtime.evaluate', { expression: `window.__render(${f},${settle})`, awaitPromise: true, returnByValue: true })
  h.png = async () => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).toBitmap()
  }
  // Every wait here is what production would really pay; it is all in `outputMs`.
  h.lastPaint = (w, height, quietMs) => new Promise((resolve, reject) => {
    const start = performance.now()
    let last = null
    let quiet = null
    const giveUp = setTimeout(() => { h.sink = null; reject(new Error('no paint')) }, FIRST_PAINT_TIMEOUT_MS)
    h.sink = image => {
      const s = image.getSize()
      if (s.width !== w || s.height !== height) return
      clearTimeout(giveUp)
      clearTimeout(quiet)
      last = image.toBitmap()
      quiet = setTimeout(() => { h.sink = null; resolve({ bitmap: last, outputMs: performance.now() - start }) }, quietMs)
    }
    wc.invalidate()
  })
  return h
}

async function stageAlpha(results) {
  results.alpha = {}
  const variants = {
    'transparent:true': {},
    'transparent:false': { transparent: false },
    'ctor backgroundColor #00000000': { backgroundColor: '#00000000' },
    'frame:false': { frame: false },
    'setBackgroundColor after load': { after: h => h.win.setBackgroundColor('#00000000') },
  }
  for (const [label, { after, ...opts }] of Object.entries(variants)) {
    if (VARIANT && label !== VARIANT) continue
    const h = await makeHost(opts)
    await h.size(W, H)
    await h.load('alpha')
    if (after) after(h)
    await h.render(2000, 3)
    const got = await h.lastPaint(W, H, 120).catch(e => ({ error: e.message }))
    if (got.error) { results.alpha[label] = got; continue }
    const ref = await h.png()
    const at = (b, x, y) => [...b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]
    results.alpha[label] = {
      paintBg: at(got.bitmap, 1000, 900), pngBg: at(ref, 1000, 900),
      paintHalf: at(got.bitmap, 500, 400), pngHalf: at(ref, 500, 400),
      compare: compare(got.bitmap, ref),
    }
    h.win.hide()
    h.wc.stopPainting()
  }
}

async function stageRule(results) {
  results.rule = {}
  const h = await makeHost()
  const sizes = [[1280, 720], [W, H], [960, 540]]
  const run = async (kind, label, quiet, prepare, count) => {
    const t = { samples: 0, noPaint: 0, wrongDom: 0, wrongSurface: 0, refWrong: 0, colorOff: 0, maxColorOff: 0, outputMs: [] }
    for (let i = 0; i < count; i++) {
      const size = await prepare(i)
      const frame = 3000 + i
      await h.render(frame, 3)
      let got
      try { got = await h.lastPaint(size[0], size[1], quiet) }
      catch { t.noPaint++; continue }
      t.samples++
      t.outputMs.push(got.outputMs)
      if (readBar(got.bitmap, size[0], 0) !== frame) t.wrongDom++
      if (readBar(got.bitmap, size[0], 1) !== frame) t.wrongSurface++
      const ref = await h.png()
      if (readBar(ref, size[0], 0) !== frame) t.refWrong++
      const c = compare(got.bitmap, ref)
      const off = Math.min(c.exact, c.flattened)
      if (off > 0) t.colorOff++
      t.maxColorOff = Math.max(t.maxColorOff, off)
    }
    const { outputMs, ...rest } = t
    results.rule[`${kind}/${label}/quiet${quiet}`] = { ...rest, outputP50: pct(outputMs, .5), outputP95: pct(outputMs, .95) }
  }
  for (const kind of KINDS) {
    await h.size(W, H)
    await h.load(kind)
    if (await h.unsupported()) { results.rule[kind] = { unsupported: true }; continue }
    for (const quiet of [34, 67]) {
      await run(kind, 'sequential', quiet, async () => [W, H], N)
      await run(kind, 'navigation', quiet, async i => { await h.load(kind, i + 1); return [W, H] }, N)
      await run(kind, 'resize', quiet, async i => { const s = sizes[i % sizes.length]; await h.size(s[0], s[1]); return s }, 12)
      await h.size(W, H)
      fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
      console.log('[rule]', kind, quiet)
    }
  }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const results = { platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome, gpu: app.getGPUFeatureStatus().gpu_compositing, size: [W, H] }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  let code = 0
  for (const name of STAGES) {
    try { await ({ alpha: stageAlpha, rule: stageRule })[name](results) }
    catch (e) { results[`${name}Failed`] = String(e?.stack ?? e); code = 1 }
    results.gpuAtEnd = app.getGPUFeatureStatus().gpu_compositing
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
    console.log('[stage]', name)
  }
  app.exit(code)
})
