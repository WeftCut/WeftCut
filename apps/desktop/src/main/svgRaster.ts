// apps/desktop/src/main/svgRaster.ts
//
// SVG on import (ticket 30): `import_media` takes a drawing as an `.svg` and
// imports a PNG of it, drawn once by Chromium at a fixed size with its alpha
// kept. The pool holds raster stills only (the native probe and decoders), so
// an agent's drawing becomes an Image like any other: a sticker's `media` prop,
// an image layer, export.
//
// Safety: the SVG is drawn as an `<img>` from a data URL, which runs no script
// and loads nothing outside itself; the page around it allows nothing but
// that data URL, and its session cancels every other request.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The longest edge of the PNG an SVG becomes. */
export const SVG_RASTER_LONG_EDGE = 2048
const MAX_SVG_BYTES = 8 * 1024 * 1024

const LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/

/** An SVG's own size, from its root's width and height (unitless or px),
 *  else its viewBox; null when it states neither. */
export function svgIntrinsicSize(text: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!root) return null
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const w = LENGTH.exec(attr('width') ?? ''), h = LENGTH.exec(attr('height') ?? '')
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return { width: Number(w[1]), height: Number(h[1]) }
  const vb = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) return { width: vb[2]!, height: vb[3]! }
  return null
}

/** The PNG size for an SVG of `size`: its long edge at `longEdge`. */
export function rasterSize(size: { width: number; height: number }, longEdge = SVG_RASTER_LONG_EDGE): { width: number; height: number } {
  const k = longEdge / Math.max(size.width, size.height)
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) }
}

/** Draw the SVG at `svgPath` to `<outDir>/<content hash>/<name>.png` and return
 *  that path. The same SVG returns the PNG already drawn. Throws when the file
 *  is not an SVG Chromium can draw. */
export async function rasterizeSvg(svgPath: string, outDir: string): Promise<string> {
  const bytes = fs.readFileSync(svgPath)
  if (bytes.length > MAX_SVG_BYTES) throw new Error(`${path.basename(svgPath)} is ${(bytes.length / 1e6).toFixed(1)} MB; an SVG to import is at most 8 MB`)
  const text = bytes.toString('utf8')
  const own = svgIntrinsicSize(text)
  if (!/<svg\b/i.test(text)) throw new Error(`${path.basename(svgPath)} has no <svg> root`)
  const { width, height } = rasterSize(own ?? { width: 1024, height: 1024 })
  const key = createHash('sha256').update(bytes).update(`@${width}x${height}`).digest('hex').slice(0, 32)
  const out = path.join(outDir, key, `${path.basename(svgPath, path.extname(svgPath))}.png`)
  if (fs.existsSync(out)) return out

  const { BrowserWindow, session } = await import('electron')
  const ses = session.fromPartition('svg-raster')
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }))
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses },
  })
  try {
    win.webContents.setZoomFactor(1)
    const page = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`
      + `<style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${width}px;height:${height}px}</style></head>`
      + `<body><img src="data:image/svg+xml;base64,${bytes.toString('base64')}"></body></html>`
    await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`)
    const drawn = await win.webContents.executeJavaScript('document.images[0].decode().then(() => document.images[0].naturalWidth > 0, () => false)') as boolean
    if (!drawn) throw new Error(`${path.basename(svgPath)} is not an SVG this app can draw`)
    let image = await win.webContents.capturePage({ x: 0, y: 0, width, height })
    const got = image.getSize()
    if (got.width !== width || got.height !== height) image = image.resize({ width, height, quality: 'best' })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const tmp = `${out}.${process.pid}.tmp`
    fs.writeFileSync(tmp, image.toPNG())
    fs.renameSync(tmp, out)
    return out
  } finally {
    win.destroy()
  }
}
