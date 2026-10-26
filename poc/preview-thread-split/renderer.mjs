// Renderer main thread: runs the arm selected by the query string and reports.
//   idle           monitor only (noise floor)
//   main           decode + createImageBitmap + Pixi all on the main thread (today's shape)
//   decode-worker  decode + createImageBitmap in a Worker, bitmaps transferred, Pixi on main
//   all-worker     decode + Pixi in a Worker on an OffscreenCanvas; main thread idle
//   decode-raw     decode on main, VideoFrames closed unused (no ImageBitmap, no upload, no composite)
//   decode-only    decode + createImageBitmap on main, bitmaps closed unused (no upload, no composite)
//   upload-only    no decode; a static 4K bitmap per stream re-uploaded through Pixi at 30 fps
import { StreamDecoder, Window, fetchBuffer, sleep } from './pipeline.mjs'
import { createPresenter } from './presenter.mjs'
import { startMonitor } from './monitor.mjs'

const { ipcRenderer } = require('electron')
const q = new URLSearchParams(location.search)
const arm = q.get('arm'), streams = Number(q.get('streams')), warmup = Number(q.get('warmup')), sample = Number(q.get('sample'))
const hw = q.get('hw'), preference = q.get('preference'), fixture = q.get('fixture')
const canvas = document.getElementById('canvas'), status = document.getElementById('status'), playhead = document.getElementById('playhead')
const W = 1280, H = 720
window.onerror = (m, s, l, c, e) => ipcRenderer.send('poc-error', `${m} @${s}:${l} ${e && e.stack || ''}`)
window.onunhandledrejection = e => ipcRenderer.send('poc-error', `unhandled: ${e.reason && e.reason.stack || e.reason}`)

async function main() {
  const report = { streamsReport: null, presenter: null, monitor: null, mainThread: {} }
  let win, monitor, presenter = null, decoders = [], worker = null
  const t0 = performance.now()

  if (arm === 'idle') {
    win = new Window(warmup, sample); monitor = startMonitor(win, playhead)
  } else if (arm === 'main') {
    win = new Window(warmup, sample)
    presenter = await createPresenter({ canvas, width: W, height: H, streams, inWorker: false, preference, window: win })
    const buffers = []
    for (let i = 0; i < streams; i++) buffers.push(await fetchBuffer(fixture))
    win = new Window(warmup, sample); presenter.setWindow(win)
    monitor = startMonitor(win, playhead)
    decoders = buffers.map((b, i) => new StreamDecoder(i, b, { window: win, hw, onFrame: (i, bmp, ts) => presenter.submit(i, bmp, ts) }))
    for (const d of decoders) d.start().catch(e => d.stats.errors.push('start: ' + e))
  } else if (arm === 'decode-raw') {
    // Hardware decode on main, VideoFrames closed at once: no ImageBitmap, no upload, no composite.
    win = new Window(warmup, sample)
    const buffers = []
    for (let i = 0; i < streams; i++) buffers.push(await fetchBuffer(fixture))
    win = new Window(warmup, sample)
    monitor = startMonitor(win, playhead)
    decoders = buffers.map((b, i) => new StreamDecoder(i, b, { window: win, hw, raw: true, onFrame: () => {} }))
    for (const d of decoders) d.start().catch(e => d.stats.errors.push('start: ' + e))
  } else if (arm === 'decode-only') {
    // Hardware decode + createImageBitmap on main, bitmaps closed at once: no texture upload, no composite.
    win = new Window(warmup, sample)
    const buffers = []
    for (let i = 0; i < streams; i++) buffers.push(await fetchBuffer(fixture))
    win = new Window(warmup, sample)
    monitor = startMonitor(win, playhead)
    decoders = buffers.map((b, i) => new StreamDecoder(i, b, { window: win, hw, onFrame: (_i, bmp) => bmp.close() }))
    for (const d of decoders) d.start().catch(e => d.stats.errors.push('start: ' + e))
  } else if (arm === 'upload-only') {
    // No decoding: one static 4K ImageBitmap per stream re-submitted at 30 fps, so Pixi re-uploads
    // a 4K texture per stream per frame. Isolates the upload + composite cost.
    win = new Window(warmup, sample)
    presenter = await createPresenter({ canvas, width: W, height: H, streams, inWorker: false, preference, window: win, ownsBitmaps: false })
    const src = new OffscreenCanvas(3840, 2160); const g = src.getContext('2d'); g.fillStyle = '#48a'; g.fillRect(0, 0, 3840, 2160); g.fillStyle = '#fc3'; g.fillRect(400, 300, 3000, 1500)
    const statics = []
    for (let i = 0; i < streams; i++) statics.push(await createImageBitmap(src))
    win = new Window(warmup, sample); presenter.setWindow(win)
    monitor = startMonitor(win, playhead)
    let n = 0
    const feeder = setInterval(() => { const ts = Math.round(n * 1e6 / 30); n++; for (let i = 0; i < streams; i++) presenter.submit(i, statics[i], ts) }, 1000 / 30)
    report.feeder = feeder
  } else if (arm === 'decode-worker' || arm === 'all-worker') {
    win = new Window(warmup, sample)
    worker = new Worker('./worker.mjs', { type: 'module' })
    const started = new Promise((res, rej) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'started') res()
        else if (data.type === 'error') { ipcRenderer.send('poc-error', data.message); rej(new Error(data.message)) }
        else if (data.type === 'frame') { if (win.sampling()) report.mainThread.transferLagSum = (report.mainThread.transferLagSum || 0) + (performance.timeOrigin + performance.now() - data.at), report.mainThread.transferred = (report.mainThread.transferred || 0) + 1; presenter.submit(data.i, data.bmp, data.ts) }
      }
      worker.onerror = e => { ipcRenderer.send('poc-error', 'worker: ' + e.message); rej(e) }
    })
    if (arm === 'decode-worker') {
      presenter = await createPresenter({ canvas, width: W, height: H, streams, inWorker: false, preference, window: win })
      worker.postMessage({ type: 'start', mode: 'decode', fixture, streams, hw, warmup, sample, preference })
    } else {
      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage({ type: 'start', mode: 'all', fixture, streams, hw, warmup, sample, preference, canvas: offscreen, width: W, height: H }, [offscreen])
    }
    await started
    win = new Window(warmup, sample); if (presenter) presenter.setWindow(win)
    monitor = startMonitor(win, playhead)
  } else throw new Error('unknown arm ' + arm)

  report.setupMs = Math.round(performance.now() - t0)
  while (!win.done()) {
    status.textContent = `${arm} ×${streams}  t=${win.sec().toFixed(1)}s  ${win.sampling() ? 'SAMPLING' : 'warmup'}`
    await sleep(250)
  }
  monitor.stop()
  if (report.feeder) { clearInterval(report.feeder); delete report.feeder }
  for (const d of decoders) d.stop()
  presenter?.stop()
  report.monitor = monitor.summary()
  if (decoders.length) report.streamsReport = decoders.map(d => d.summary())
  if (presenter) report.presenter = presenter.summary()
  if (worker) {
    const r = await new Promise(res => { worker.onmessage = ({ data }) => { if (data.type === 'result') res(data) }; worker.postMessage({ type: 'stop' }) })
    report.streamsReport = r.streams
    if (r.presenter) report.presenter = r.presenter
    if (report.mainThread.transferred) report.mainThread.transferLagMeanMs = +(report.mainThread.transferLagSum / report.mainThread.transferred).toFixed(2)
    delete report.mainThread.transferLagSum
  }
  status.textContent = 'done'
  ipcRenderer.send('poc-result', report)
}

main().catch(e => { ipcRenderer.send('poc-error', String(e && e.stack || e)); ipcRenderer.send('poc-result', { failed: true }) })
