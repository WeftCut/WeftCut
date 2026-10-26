// Module Worker. mode 'decode': demux+decode+createImageBitmap here, transfer
// bitmaps to the main thread. mode 'all': additionally run Pixi here on the
// transferred OffscreenCanvas.
import { StreamDecoder, Window, fetchBuffer } from './pipeline.mjs'
import { createPresenter } from './presenter.mjs'

let decoders = [], presenter = null, win = null

self.onmessage = async ({ data }) => {
  if (data.type === 'start') {
    try {
      win = new Window(data.warmup, data.sample)
      if (data.mode === 'all') presenter = await createPresenter({ canvas: data.canvas, width: data.width, height: data.height, streams: data.streams, inWorker: true, preference: data.preference, window: win })
      const buffers = []
      for (let i = 0; i < data.streams; i++) buffers.push(await fetchBuffer(data.fixture))
      win = new Window(data.warmup, data.sample)
      if (presenter) presenter.setWindow(win)
      const onFrame = data.mode === 'all'
        ? (i, bmp, ts) => presenter.submit(i, bmp, ts)
        : (i, bmp, ts) => self.postMessage({ type: 'frame', i, bmp, ts, at: performance.timeOrigin + performance.now() }, [bmp])
      decoders = buffers.map((b, i) => new StreamDecoder(i, b, { window: win, hw: data.hw, onFrame }))
      if (presenter && presenter.renderer === 'canvas') throw new Error('Pixi fell back to the canvas renderer inside the Worker: no GPU renderer available')
      self.postMessage({ type: 'started', renderer: presenter?.renderer ?? null })
      await Promise.all(decoders.map(d => d.start().catch(e => d.stats.errors.push('start: ' + e))))
    } catch (e) { self.postMessage({ type: 'error', message: String(e && e.stack || e) }) }
  } else if (data.type === 'stop') {
    for (const d of decoders) d.stop()
    presenter?.stop()
    self.postMessage({ type: 'result', streams: decoders.map(d => d.summary()), presenter: presenter?.summary() ?? null })
  }
}
