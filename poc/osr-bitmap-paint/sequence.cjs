// Records every paint after a render instead of taking the first, to find a
// rule that selects the right frame without reading its content: a real Motif
// has no barcode to check, so a production fence must not depend on one.
//
//   electron poc/osr-bitmap-paint/sequence.cjs --user-data-dir=<dir> --out=<dir> [--n=30]
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const N = Number(arg('n', 30))
const W = 1920
const H = 1080
const OUT = arg('out', path.join(__dirname, 'out'))
const PAGE = path.join(__dirname, 'page.html')
const COLLECT_MS = 200
const BITS = 16
const DIFF_TOLERANCE = 2

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

function diff(a, b) {
  if (a.length !== b.length) return { count: -1, max: -1, alphaOnly: -1 }
  let count = 0
  let max = 0
  let colorCount = 0
  for (let i = 0; i < a.length; i += 4) {
    const c = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
    const d = Math.max(c, Math.abs(a[i + 3] - b[i + 3]))
    if (d > max) max = d
    if (d > DIFF_TOLERANCE) count++
    if (c > DIFF_TOLERANCE) colorCount++
  }
  return { count, max, colorCount }
}

async function host({ transparent, background }) {
  const win = new BrowserWindow({
    show: false, transparent, ...(background ? { backgroundColor: background } : {}),
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
  const applySize = async () => {
    win.setContentSize(W, H)
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }
  await applySize()
  const h = { win, wc, send, sink: null }
  wc.on('paint', (_e, dirty, image) => { if (h.sink) h.sink(dirty, image) })
  h.load = async kind => {
    await win.loadFile(PAGE, { query: { kind } })
    for (let i = 0; i < 100; i++) {
      const r = await send('Runtime.evaluate', { expression: `typeof window.__render==='function' && document.readyState==='complete'`, returnByValue: true })
      if (r.result.value === true) {
    // Production re-applies size and overrides after every navigation (capture.ts);
    // on Windows a document loaded without it never emits a paint.
        await applySize()
        return
      }
      await sleep(20)
    }
    throw new Error('never ready')
  }
  h.render = (f, settle) => send('Runtime.evaluate', { expression: `window.__render(${f},${settle})`, awaitPromise: true, returnByValue: true })
  h.png = async (params = {}) => {
    const t0 = performance.now()
    const shot = await send('Page.captureScreenshot', { format: 'png', ...params })
    const t1 = performance.now()
    const buf = Buffer.from(shot.data, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    const bitmap = img.toBitmap()
    return { bitmap, screenshotMs: t1 - t0, decodeMs: performance.now() - t1, bytes: buf.length }
  }
  return h
}

// One capture: render, invalidate, then log each paint for COLLECT_MS.
async function collect(h, frame, settle, invalidate) {
  await h.render(frame, settle)
  const start = performance.now()
  const paints = []
  h.sink = (dirty, image) => {
    const s = image.getSize()
    if (s.width !== W || s.height !== H) return
    const bitmap = image.toBitmap()
    paints.push({
      at: performance.now() - start, bitmap,
      full: dirty.x === 0 && dirty.y === 0 && dirty.width === W && dirty.height === H,
      dom: readBar(bitmap, W, 0), surface: readBar(bitmap, W, 1),
    })
  }
  if (invalidate) h.wc.invalidate()
  await sleep(COLLECT_MS)
  h.sink = null
  return paints
}

function score(rows, frame) {
  const rules = {
    first: p => p[0],
    second: p => p[1],
    third: p => p[2],
    firstFullDirty: p => p.find(x => x.full),
    secondFullDirty: p => p.filter(x => x.full)[1],
    last: p => p[p.length - 1],
  }
  const out = {}
  for (const [name, pick] of Object.entries(rules)) {
    let right = 0
    let wrong = 0
    let missing = 0
    const at = []
    for (const r of rows) {
      const p = pick(r.paints)
      if (!p) { missing++; continue }
      at.push(p.at)
      if (p.dom === r.frame && p.surface === r.frame) right++
      else wrong++
    }
    out[name] = { right, wrong, missing, msP50: pct(at, .5), msP95: pct(at, .95) }
  }
  const firstRight = rows.map(r => r.paints.find(x => x.dom === r.frame && x.surface === r.frame)).filter(Boolean)
  // A paint older than one already seen would break "last is newest".
  let regressions = 0
  for (const r of rows) {
    let seen = false
    for (const p of r.paints) {
      if (p.dom === r.frame) seen = true
      else if (seen) regressions++
    }
  }
  return {
    samples: rows.length,
    paintsP50: pct(rows.map(r => r.paints.length), .5),
    fullDirtyP50: pct(rows.map(r => r.paints.filter(x => x.full).length), .5),
    neverRight: rows.length - firstRight.length,
    firstRightMs: { p50: pct(firstRight.map(p => p.at), .5), p95: pct(firstRight.map(p => p.at), .95) },
    regressions, rules: out,
  }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const results = { platform: process.platform, sequence: {}, alpha: {}, pngSpeed: {} }
  const save = () => fs.writeFileSync(path.join(OUT, 'sequence.json'), JSON.stringify(results, null, 1))

  const h = await host({ transparent: true })
  for (const fps of [60, 240]) {
    h.wc.setFrameRate(fps)
    for (const kind of ['dom', 'alpha', 'canvas']) {
      await h.load(kind)
      for (const settle of [2, 3]) {
        for (const invalidate of [true, false]) {
          const rows = []
          for (let i = 0; i < N; i++) {
            const frame = 1000 + rows.length + (i % 8 === 7 ? -1 : 0)
            const paints = await collect(h, frame, settle, invalidate)
            rows.push({ frame, paints: paints.map(p => ({ at: p.at, full: p.full, dom: p.dom, surface: p.surface })) })
          }
          results.sequence[`${fps}fps/${kind}/settle${settle}/${invalidate ? 'invalidate' : 'no-invalidate'}`] = score(rows)
          save()
        }
      }
      console.log('[sequence]', fps, kind)
    }
  }
  h.wc.setFrameRate(60)

  // Compares the last right paint with a screenshot of the same committed state.
  await h.load('alpha')
  const variants = [
    ['transparent', { transparent: true }],
    ['transparent+bg00', { transparent: true, background: '#00000000' }],
    ['opaque', { transparent: false }],
  ]
  for (const kind of ['alpha', 'dom', 'canvas']) {
    for (const [label, opts] of kind === 'alpha' ? variants : variants.slice(0, 1)) {
      const v = label === 'transparent' && kind !== 'alpha' ? h : label === 'transparent' ? h : await host(opts)
      await v.load(kind)
      const frame = 2000
      const paints = await collect(v, frame, 3, true)
      const right = paints.filter(p => p.dom === frame && p.surface === frame).pop()
      const ref = await v.png()
      const key = `${kind}/${label}`
      if (!right) { results.alpha[key] = { noRightPaint: true, paints: paints.length }; save(); continue }
      const at = (b, x, y) => [...b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]
      results.alpha[key] = {
        diff: diff(right.bitmap, ref.bitmap),
        ...(kind === 'alpha' ? {
          paint: { half: at(right.bitmap, 500, 400), solid: at(right.bitmap, 800, 400), bg: at(right.bitmap, 1000, 900) },
          png: { half: at(ref.bitmap, 500, 400), solid: at(ref.bitmap, 800, 400), bg: at(ref.bitmap, 1000, 900) },
        } : {}),
      }
      fs.writeFileSync(path.join(OUT, `raw-${kind}-${label}-paint.bgra`), right.bitmap)
      fs.writeFileSync(path.join(OUT, `raw-${kind}-${label}-png.bgra`), ref.bitmap)
      save()
    }
  }
  console.log('[alpha] done')

  for (const kind of ['dom', 'canvas']) {
    await h.load(kind)
    for (const [label, params] of [['default', {}], ['optimizeForSpeed', { optimizeForSpeed: true }]]) {
      const rows = []
      for (let i = 0; i < 15; i++) {
        await h.render(3000 + i, 2)
        rows.push(await h.png(params))
      }
      results.pngSpeed[`${kind}/${label}`] = {
        screenshotMs: { p50: pct(rows.map(r => r.screenshotMs), .5), p95: pct(rows.map(r => r.screenshotMs), .95) },
        decodeMs: pct(rows.map(r => r.decodeMs), .5), bytes: pct(rows.map(r => r.bytes), .5),
      }
      save()
    }
  }
  results.gpuAtEnd = app.getGPUFeatureStatus().gpu_compositing
  save()
  console.log('[done]')
  app.exit(0)
})
