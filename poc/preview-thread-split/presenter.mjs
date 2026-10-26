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

export async function createPresenter({ canvas, width, height, streams, inWorker, preference, window: initialWindow }) {
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
  const pending = new Array(streams).fill(null), shown = new Array(streams).fill(null)
  const stats = { superseded: 0, rendered: 0, renderMs: [], renderIntervalMs: [], presentLagMs: [] }
  let lastRender = 0, stopped = false

  function submit(i, bmp, ts) {
    if (pending[i]) { pending[i].bmp.close(); if (win.sampling()) stats.superseded++ }
    pending[i] = { bmp, ts, at: performance.now() }
  }

  function tick() {
    if (stopped) return
    const toClose = []
    let dirty = false
    for (let i = 0; i < streams; i++) {
      const p = pending[i]; if (!p) continue
      pending[i] = null
      if (!sources[i]) {
        sources[i] = new ImageSource({ resource: p.bmp })
        sprites[i].texture = new Texture({ source: sources[i] })
        sprites[i].tint = 0xffffff
        sprites[i].width = cellW; sprites[i].height = cellH
      } else { sources[i].resource = p.bmp; sources[i].update() }
      if (shown[i]) toClose.push(shown[i].bmp)
      shown[i] = p
      if (win.sampling()) stats.presentLagMs.push(performance.now() - p.at)
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
    summary() { return { renderer: app.renderer.name, superseded: stats.superseded, rendered: stats.rendered, renderMs: percentiles(stats.renderMs), renderIntervalMs: percentiles(stats.renderIntervalMs), presentLagMs: percentiles(stats.presentLagMs) } },
  }
}
