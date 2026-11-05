// Answers three questions the Electron and Chromium sources raise:
//   1. Does `invalidate()` emit the cached bitmap, synchronously, without capturing?
//   2. How long does a change take to reach a paint, counted from the render itself?
//   3. Is `capturePage()` a PNG screenshot without the encode?
//
//   electron poc/osr-bitmap-paint/capture-sources.cjs --user-data-dir=<dir> --out=<file> [--n=25]
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const N = Number(arg('n', 25))
const W = Number(arg('w', 1920))
const H = Number(arg('h', 1080))
const OUT = arg('out', path.join(__dirname, 'capture-sources.json'))
const KINDS = arg('kinds', 'dom,alpha,canvas,webgl').split(',')
const PAGE = path.join(__dirname, 'page.html')
const BITS = 16
const DIFF_TOLERANCE = 2
const PAINT_WAIT_MS = 400

setTimeout(() => { console.error('WATCHDOG'); app.exit(3) }, 12 * 60 * 1000).unref()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1)
}
const stats = xs => ({ n: xs.length, p50: pct(xs, .5), p95: pct(xs, .95) })

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

function pixelsOff(a, b) {
  if (a.length !== b.length) return -1
  let off = 0
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > DIFF_TOLERANCE || Math.abs(a[i + 1] - b[i + 1]) > DIFF_TOLERANCE
      || Math.abs(a[i + 2] - b[i + 2]) > DIFF_TOLERANCE || Math.abs(a[i + 3] - b[i + 3]) > DIFF_TOLERANCE) off++
  }
  return off
}

async function makeHost() {
  const win = new BrowserWindow({
    show: false, transparent: true,
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
  wc.on('paint', (_e, dirty, image) => { if (h.sink) h.sink(image, dirty) })
  h.size = async (w, height) => {
    win.setContentSize(w, height)
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }
  h.load = async (kind, nonce = 0, size = [W, H]) => {
    await win.loadFile(PAGE, { query: { kind, nonce: String(nonce) } })
    for (let i = 0; i < 200; i++) {
      const r = await send('Runtime.evaluate', { expression: `typeof window.__render==='function' && document.readyState==='complete'`, returnByValue: true })
      if (r.result.value === true) { await h.size(size[0], size[1]); return }
      await sleep(20)
    }
    throw new Error('never ready')
  }
  h.unsupported = async () => (await send('Runtime.evaluate', { expression: 'window.__info().unsupported ?? null', returnByValue: true })).result.value
  h.render = (f, settle) => send('Runtime.evaluate', { expression: `window.__render(${f},${settle})`, awaitPromise: true, returnByValue: true })
  h.png = async (params = {}) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', ...params })
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).toBitmap()
  }
  return h
}

// A paint that arrives before `invalidate()` returns came from no capture at all.
async function stageInvalidate(h, results) {
  await h.load('dom')
  await h.render(100, 3)
  await sleep(300)
  let last = null
  h.sink = image => { last = image.toBitmap() }
  h.wc.invalidate()
  await sleep(200)
  const rows = []
  for (let i = 0; i < N; i++) {
    const seen = []
    h.sink = image => { seen.push(image.toBitmap()) }
    const t0 = performance.now()
    h.wc.invalidate()
    const syncMs = performance.now() - t0
    const syncCount = seen.length
    await sleep(150)
    rows.push({ syncCount, total: seen.length, syncMs, same: seen[0] && last ? pixelsOff(seen[0], last) === 0 : null })
  }
  h.sink = null
  results.invalidate = {
    n: rows.length,
    emittedBeforeReturn: rows.filter(r => r.syncCount > 0).length,
    identicalToLastPaint: rows.filter(r => r.same).length,
    laterPaints: rows.reduce((a, r) => a + r.total - r.syncCount, 0),
    callMs: stats(rows.map(r => r.syncMs)),
  }
}

// Sink armed before the render starts and no invalidate: the first paint holding
// the new frame shows the whole path from change to bitmap.
async function stageLatency(h, results) {
  results.latency = {}
  for (const fps of [60, 240]) {
    h.wc.setFrameRate(fps)
    for (const kind of KINDS) {
      await h.load(kind)
      if (await h.unsupported()) continue
      const paintMs = []
      const copyMs = []
      let missed = 0
      for (let i = 0; i < N; i++) {
        const frame = 5000 + i
        const t0 = performance.now()
        const got = await new Promise(resolve => {
          const giveUp = setTimeout(() => { h.sink = null; resolve(null) }, PAINT_WAIT_MS)
          h.sink = image => {
            const at = performance.now() - t0
            const c0 = performance.now()
            const bitmap = image.toBitmap()
            const copy = performance.now() - c0
            if (readBar(bitmap, W, 0) !== frame) return
            clearTimeout(giveUp)
            h.sink = null
            resolve({ at, copy })
          }
          h.render(frame, 0)
        })
        if (got) { paintMs.push(got.at); copyMs.push(got.copy) } else missed++
        await sleep(60)
      }
      results.latency[`${fps}fps/${kind}`] = { paintMs: stats(paintMs), toBitmapMs: stats(copyMs), missed }
      fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
    }
  }
  h.wc.setFrameRate(60)
}

// Whether capturePage returns the rendered frame after each settle count, how it
// compares with a PNG of the same state, and how it costs.
async function stageCapturePage(h, results) {
  results.capturePage = {}
  for (const kind of KINDS) {
    await h.load(kind)
    if (await h.unsupported()) continue
    for (const settle of [0, 1, 2, 3]) {
      const rows = { wrongDom: 0, wrongSurface: 0, pngWrongDom: 0, differs: 0, maxOff: 0, failed: 0 }
      const ms = []
      const block = []
      const toBitmap = []
      for (let i = 0; i < N; i++) {
        const frame = 6000 + i
        await h.render(frame, settle)
        const t0 = performance.now()
        let image
        try { image = await h.wc.capturePage(undefined, { stayHidden: true, stayAwake: true }) }
        catch (e) { rows.failed++; rows.lastError = String(e?.message ?? e); continue }
        const t1 = performance.now()
        const bitmap = image.toBitmap()
        const t2 = performance.now()
        ms.push(t1 - t0)
        toBitmap.push(t2 - t1)
        block.push(t2 - t1)
        if (readBar(bitmap, W, 0) !== frame) rows.wrongDom++
        if (readBar(bitmap, W, 1) !== frame) rows.wrongSurface++
        const ref = await h.png()
        if (readBar(ref, W, 0) !== frame) rows.pngWrongDom++
        const off = pixelsOff(bitmap, ref)
        if (off !== 0) rows.differs++
        rows.maxOff = Math.max(rows.maxOff, off)
      }
      results.capturePage[`${kind}/settle${settle}`] = { ...rows, captureMs: stats(ms), toBitmapMs: stats(toBitmap) }
      fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
    }
  }
}

// A surface is new after these; ADR 0078 fences them with a full readback.
async function stageNewSurface(h, results) {
  results.newSurface = {}
  const sizes = [[1280, 720], [W, H], [960, 540]]
  for (const kind of KINDS) {
    await h.load(kind)
    if (await h.unsupported()) continue
    for (const label of ['navigation', 'resize']) {
      for (const settle of [2, 3]) {
        const rows = { samples: 0, wrongDom: 0, differs: 0, maxOff: 0, failed: 0 }
        for (let i = 0; i < 12; i++) {
          let size = [W, H]
          if (label === 'navigation') await h.load(kind, i + 1)
          else { size = sizes[i % sizes.length]; await h.size(size[0], size[1]) }
          const frame = 7000 + i
          await h.render(frame, settle)
          let image
          try { image = await h.wc.capturePage(undefined, { stayHidden: true, stayAwake: true }) }
          catch (e) { rows.failed++; rows.lastError = String(e?.message ?? e); continue }
          const bitmap = image.toBitmap()
          rows.samples++
          if (readBar(bitmap, size[0], 0) !== frame) rows.wrongDom++
          const off = pixelsOff(bitmap, await h.png())
          if (off !== 0) rows.differs++
          rows.maxOff = Math.max(rows.maxOff, off)
        }
        results.newSurface[`${kind}/${label}/settle${settle}`] = rows
        await h.size(W, H)
        fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
      }
    }
  }
}

// 50% red over a transparent page; a PNG reads 0,0,128,128 on every host so far.
async function stageAlpha(h, results) {
  results.alpha = []
  for (let i = 0; i < 6; i++) {
    await h.load('alpha', i + 100)
    await h.render(8000 + i, 3)
    const image = await h.wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
    const a = image.toBitmap()
    const b = await h.png()
    const at = (x, px, py) => [...x.subarray((py * W + px) * 4, (py * W + px) * 4 + 4)]
    results.alpha.push({
      capturePage: { half: at(a, 500, 400), bg: at(a, 1000, 900) },
      png: { half: at(b, 500, 400), bg: at(b, 1000, 900) },
      pixelsOff: pixelsOff(a, b),
    })
  }
}

// Full-frame cost of each way to ask for a screenshot, used as a fence or an output.
async function stageFence(h, results) {
  results.fence = {}
  const modes = {
    png: { format: 'png' },
    pngFast: { format: 'png', optimizeForSpeed: true },
    jpegQ1: { format: 'jpeg', quality: 1 },
  }
  for (const kind of ['dom', 'canvas']) {
    await h.load(kind)
    for (const [label, params] of Object.entries(modes)) {
      const ms = []
      for (let i = 0; i < 15; i++) {
        await h.render(9000 + i, 2)
        const t0 = performance.now()
        await h.send('Page.captureScreenshot', params)
        ms.push(performance.now() - t0)
      }
      results.fence[`${kind}/${label}`] = stats(ms)
    }
    const ms = []
    const copy = []
    for (let i = 0; i < 15; i++) {
      await h.render(9100 + i, 2)
      const t0 = performance.now()
      const image = await h.wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
      const t1 = performance.now()
      image.toBitmap()
      ms.push(t1 - t0)
      copy.push(performance.now() - t1)
    }
    results.fence[`${kind}/capturePage`] = stats(ms)
    results.fence[`${kind}/capturePage.toBitmap`] = stats(copy)
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
  }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const results = { platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome, size: [W, H] }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  let code = 0
  const h = await makeHost()
  await h.size(W, H)
  const stages = { stageInvalidate, stageLatency, stageCapturePage, stageNewSurface, stageAlpha, stageFence }
  const only = arg('stages', Object.keys(stages).join(',')).split(',')
  for (const name of only) {
    try { await stages[name](h, results) }
    catch (e) { results[`${name}Failed`] = String(e?.stack ?? e); code = 1 }
    results.gpuAtEnd = app.getGPUFeatureStatus().gpu_compositing
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
    console.log('[stage]', name)
  }
  app.exit(code)
})
