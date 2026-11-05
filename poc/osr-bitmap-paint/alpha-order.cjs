// Whether paint keeps alpha depends on when the background override is applied
// relative to navigation, across documents and across windows.
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('node:path')
const PAGE = path.join(__dirname, 'page.html')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const W = 1920, H = 1080
const at = (b, x, y) => [...b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)].join(',')

async function makeWin(transparent) {
  const win = new BrowserWindow({ show: false, transparent, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } })
  for (let i = 0; ; i++) { try { await win.loadURL('about:blank'); break } catch (e) { if (i > 3) throw e; await sleep(300) } }
  const wc = win.webContents
  wc.debugger.attach('1.3')
  const send = (m, p = {}) => wc.debugger.sendCommand(m, p)
  await send('Page.enable'); await send('Runtime.enable')
  const h = { win, wc, send, sink: null }
  wc.on('paint', (_e, _d, image) => { if (h.sink) h.sink(image) })
  h.apply = async () => {
    win.setContentSize(W, H)
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  }
  h.load = async n => {
    await win.loadFile(PAGE, { query: { kind: 'alpha', nonce: String(n) } })
    for (let i = 0; i < 200; i++) {
      const r = await send('Runtime.evaluate', { expression: `typeof window.__render==='function' && document.readyState==='complete'`, returnByValue: true })
      if (r.result.value === true) return
      await sleep(20)
    }
    throw new Error('never ready')
  }
  h.shot = async f => {
    await send('Runtime.evaluate', { expression: `window.__render(${f},3)`, awaitPromise: true })
    let last = null
    h.sink = image => { const s = image.getSize(); if (s.width === W && s.height === H) last = image.toBitmap() }
    wc.invalidate()
    await sleep(150)
    h.sink = null
    const png = nativeImage.createFromBuffer(Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')).toBitmap()
    return `paint bg=${last ? at(last, 1000, 900) : 'none'} half=${last ? at(last, 500, 400) : 'none'} | png bg=${at(png, 1000, 900)} half=${at(png, 500, 400)}`
  }
  return h
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  for (const [label, applyAfterLoad, transparent] of [
    ['override BEFORE load, transparent', false, true],
    ['override AFTER load,  transparent', true, true],
    ['override AFTER load,  opaque     ', true, false],
    ['override BEFORE load, opaque     ', false, false],
  ]) {
    for (let w = 1; w <= 2; w++) {
      const h = await makeWin(transparent)
      if (!applyAfterLoad) await h.apply()
      for (let n = 1; n <= 3; n++) {
        await h.load(n)
        if (applyAfterLoad) await h.apply()
        console.log(`${label} win${w} doc${n}: ${await h.shot(100 + n)}`)
      }
      h.wc.stopPainting()
    }
  }
  console.log('gpu_compositing at end', app.getGPUFeatureStatus().gpu_compositing, JSON.stringify((await app.getGPUInfo('basic')).gpuDevice?.map(d => [d.active, d.vendorId, d.deviceId])))
  app.exit(0)
})
