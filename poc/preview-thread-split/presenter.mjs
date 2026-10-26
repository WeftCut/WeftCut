// The Pixi side: one sprite per stream in a grid, manual render on rAF when a
// stream has a new bitmap. Runs on the main thread or inside a Worker.
import { Application, Sprite, Texture, ImageSource, DOMAdapter, extensions, DOMPipe, HTMLTextPipe, HTMLTextSystem, EventSystem, AccessibilitySystem } from '../../node_modules/pixi.js/dist/pixi.mjs'

// The dist bundle ships only the browser adapter; this mirrors
// lib/environment-webworker/WebWorkerAdapter.mjs minus the XML parser.
const WebWorkerAdapter = {
  createCanvas: (width, height) => new OffscreenCanvas(width ?? 0, height ?? 0),
  createImage: () => { throw new Error('no Image in a Worker') },
  getCanvasRenderingContext2D: () => OffscreenCanvasRenderingContext2D,
  getWebGLRenderingContext: () => WebGLRenderingContext,
  getNavigator: () => navigator,
  getBaseUrl: () => globalThis.location.href,
  getFontFaceSet: () => globalThis.fonts,
  fetch: (url, options) => fetch(url, options),
  parseXML: () => { throw new Error('no XML parser in the Worker adapter') },
}
import { percentiles } from './pipeline.mjs'

export async function createPresenter({ canvas, width, height, streams, inWorker, preference, window: initialWindow, lookaheadSec = 0.15, ownsBitmaps = true }) {
  let win = initialWindow
  // The dist bundle registers the browser-only pipes (lib's webworkerAll leaves them out).
  if (inWorker) { DOMAdapter.set(WebWorkerAdapter); extensions.remove(DOMPipe, HTMLTextPipe, HTMLTextSystem, EventSystem, AccessibilitySystem) }
  const app = new Application()
  await app.init({ canvas, width, height, preference, autoStart: false, sharedTicker: false, background: 0x202020, antialias: false, resolution: 1 })
  const cols = streams === 1 ? 1 : 2, rows = Math.ceil(streams / cols)
  const cellW = Math.floor(width / cols), cellH = Math.floor(height / rows)
  const sprites = [], sources = new Array(streams).fill(null)
  for (let i = 0; i < streams; i++) {
    const s = new Sprite(Texture.WHITE)
    s.x = (i % cols) * cellW; s.y = Math.floor(i / cols) * cellH
    s.width = cellW; s.height = cellH; s.tint = 0x404040
    app.stage.addChild(s); sprites.push(s)
  }
  // Presentation is clock-driven like a player, not latest-wins: each stream
  // queues decoded frames and the tick shows the newest frame that is due,
  // dropping only frames whose time has already passed. Media time runs
  // `lookaheadSec` behind the pacing clock (the decoder is fed that far ahead).
  const queues = Array.from({ length: streams }, () => []), shown = new Array(streams).fill(null)
  const stats = { dropped: 0, presented: 0, rendered: 0, renderMs: [], renderIntervalMs: [], presentSkewMs: [], queueMax: 0 }
  let lastRender = 0, stopped = false
  const mediaNowUs = () => (win.sec() - lookaheadSec) * 1e6

  function submit(i, bmp, ts) {
    const q = queues[i]
    q.push({ bmp, ts })
    if (q.length > stats.queueMax) stats.queueMax = q.length
    if (q.length > 12) { const old = q.shift(); if (ownsBitmaps) old.bmp.close(); if (win.sampling()) stats.dropped++ }
  }

  function tick() {
    if (stopped) return
    const toClose = []
    let dirty = false
    const nowUs = mediaNowUs()
    for (let i = 0; i < streams; i++) {
      const q = queues[i]
      let pick = -1
      for (let k = 0; k < q.length; k++) { if (q[k].ts <= nowUs) pick = k; else break }
      if (pick < 0) continue
      for (let k = 0; k < pick; k++) { if (ownsBitmaps) toClose.push(q[k].bmp); if (win.sampling()) stats.dropped++ }
      const p = q[pick]
      q.splice(0, pick + 1)
      if (!sources[i]) {
        sources[i] = new ImageSource({ resource: p.bmp })
        sprites[i].texture = new Texture({ source: sources[i] })
        sprites[i].tint = 0xffffff
        sprites[i].width = cellW; sprites[i].height = cellH
      } else { sources[i].resource = p.bmp; sources[i].update() }
      if (shown[i] && ownsBitmaps) toClose.push(shown[i].bmp)
      shown[i] = p
      if (win.sampling()) { stats.presented++; stats.presentSkewMs.push((nowUs - p.ts) / 1000) }
      dirty = true
    }
    if (dirty) {
      const t0 = performance.now()
      app.render()
      const t1 = performance.now()
      if (win.sampling()) { stats.renderMs.push(t1 - t0); if (lastRender) stats.renderIntervalMs.push(t0 - lastRender); stats.rendered++ }
      lastRender = t0
    }
    for (const b of toClose) b.close()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  return {
    app, submit,
    stop() { stopped = true },
    setWindow(w) { win = w },
    renderer: app.renderer.name,
    summary() { return { renderer: app.renderer.name, dropped: stats.dropped, presented: stats.presented, rendered: stats.rendered, queueMax: stats.queueMax, renderMs: percentiles(stats.renderMs), renderIntervalMs: percentiles(stats.renderIntervalMs), presentSkewMs: percentiles(stats.presentSkewMs) } },
  }
}
