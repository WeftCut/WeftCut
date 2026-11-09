import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { supportsMotifSharedTextures } from './helpers/motif-gpu'
import { compareReadback } from '../lib/motif-downscale.mjs'
import { MOTIF_TUNING_DEFAULTS } from '../../src/shared/motifs/tuning'

interface ReaderStats {
  reads: { texture: number; utility: number };
  misses: number;
  fallbacks: number;
  transportFailures: number;
}

// The real MotifFrameReader (ADR 0154) with synthetic colored frames: the
// texture lane's native ownership and slot reuse on Windows with shared
// textures, the utility process and reader worker everywhere else.
test('@serial cached Motif frames survive concurrent reads and slot reuse', async () => {
  const { app, page } = await launchApp({ env: { ELECTRON_RENDERER_URL: '' } })
  try {
    const sharedTextures = await supportsMotifSharedTextures(app)
    const parent = tmpDir('weftcut-motif-transport-')
    await newProject(page, { parentFolder: parent, name: 'Transport', canvas: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } })
    const hash = '0123456789abcdef0123456789abcdef'
    // Six solid, half-transparent frames, as straight RGBA.
    const colors = Array.from({ length: 6 }, (_, i) => [i * 40, 200 - i * 30, 80, 128])
    const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
    await app.evaluate(async (_electron, { addon, directory, colors }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const fs = process.getBuiltinModule('fs/promises')
      await fs.mkdir(directory, { recursive: true })
      for (const [i, color] of colors.entries()) {
        const rgba = Buffer.alloc(1920 * 1080 * 4, Buffer.from(color))
        await fs.writeFile(`${directory}/${i}.wfrm`, await native.motifConvert(rgba, 1920, 1080, 'rgba', 'frame'))
      }
    }, { addon, directory: path.join(parent, 'Transport', 'Cache', 'raster', hash), colors })
    await waitForHook(page, 'readMotifFrame')
    await waitForHook(page, 'motifReaderStats')
    const { pixels, before, after, readsInFlight } = await page.evaluate(async ({ hash, defaultReadsInFlight }) => {
      const hook = (window as any).__weftcutTest
      // The reader's own resolution (renderer/render/motifs/tuning.ts).
      const readsInFlight: number = (window as any).api?.app?.motifTuning?.readsInFlight ?? defaultReadsInFlight
      const stats = () => hook.motifReaderStats()
      const before = stats()
      const read = async (frame: number): Promise<ImageBitmap> => {
        const bitmap = await hook.readMotifFrame({ hash, frame, div: 1 }) as ImageBitmap | null
        if (!bitmap) throw new Error(`Missing frame ${frame}`)
        return bitmap
      }
      const held = await Promise.all(Array.from({ length: 12 }, (_, i) => read(i % 6)))
      // Keep old bitmaps alive while every GPU lane is overwritten repeatedly.
      for (let batch = 0; batch < 4; batch++) {
        const frames = await Promise.all(Array.from({ length: 6 }, (_, i) => read(5 - i)))
        frames.forEach(frame => frame.close())
      }
      const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
      const pixels = held.map(frame => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.drawImage(frame, 100, 100, 1, 1, 0, 0, 1, 1)
        frame.close()
        return [...ctx.getImageData(0, 0, 1, 1).data]
      })
      return { pixels, before, after: stats(), readsInFlight }
    }, { hash, defaultReadsInFlight: MOTIF_TUNING_DEFAULTS.readsInFlight }) as { pixels: number[][]; before: ReaderStats; after: ReaderStats; readsInFlight: number }
    // The reader conformance rule for the lane that answered
    // (e2e/lib/motif-downscale.mjs): a canvas read-back premultiplies once.
    const rule = sharedTextures ? 'premultiplied' : 'straight'
    for (let i = 0; i < pixels.length; i++) {
      const result = compareReadback({ expected: Uint8Array.from(colors[i % 6]!), actual: Uint8Array.from(pixels[i]!), width: 1, height: 1, rule })
      expect(result.mismatches, `frame ${i % 6} read back ${pixels[i]}, expected ${colors[i % 6]} (${rule})`).toBe(0)
    }
    // Shared textures take the texture lane; everything else the utility lane.
    // Windows without shared textures asks the texture lane, which main
    // answers `unavailable` with reason `lane`: only the reads admitted before
    // that first answer asked it and fall back, the rest skip it
    // (docs/motifs.md, Windows texture lane). Other platforms never ask it.
    const delta = (pick: (stats: ReaderStats) => number) => pick(after) - pick(before)
    expect({ texture: delta(s => s.reads.texture), utility: delta(s => s.reads.utility) })
      .toEqual(sharedTextures ? { texture: 36, utility: 0 } : { texture: 0, utility: 36 })
    expect(delta(s => s.fallbacks)).toBe(!sharedTextures && process.platform === 'win32' ? readsInFlight : 0)
    expect(delta(s => s.misses)).toBe(0)
    expect(delta(s => s.transportFailures)).toBe(0)
  } finally { await app.close() }
})

test('@serial cached Motif transport stays responsive across renderer reloads', async () => {
  const { app, page } = await launchApp({ env: { ELECTRON_RENDERER_URL: '' } })
  try {
    test.skip(!await supportsMotifSharedTextures(app), 'Requires real shared GPU textures')
    const parent = tmpDir('weftcut-motif-reload-')
    await newProject(page, { parentFolder: parent, name: 'Reload', canvas: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } })
    const hash = '123456789abcdef0123456789abcdef0'
    const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
    await app.evaluate(async ({ ipcMain }, { addon, directory }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const fs = process.getBuiltinModule('fs/promises')
      await fs.mkdir(directory, { recursive: true })
      // Solid #d04080, opaque.
      const encoded = await native.motifConvert(Buffer.alloc(1920 * 1080 * 4, Buffer.from([208, 64, 128, 255])), 1920, 1080, 'rgba', 'frame')
      await fs.writeFile(`${directory}/0.wfrm`, encoded)
      await fs.writeFile(`${directory}/1.wfrm`, encoded)
      const handler = ipcMain._invokeHandlers.get('motif:read')!
      ;(globalThis as any).__motifReloadKinds = []
      ipcMain._invokeHandlers.set('motif:read', async (event: any, args: any) => {
        const result = await handler(event, args)
        if (args.frame === 0) (globalThis as any).__motifReloadKinds.push(result?.kind)
        return result
      })
    }, { addon, directory: path.join(parent, 'Reload', 'Cache', 'raster', hash) })
    for (let round = 0; round < 9; round++) {
      if (round) await page.reload()
      const results = await page.evaluate(async hash => {
        const channel = new MessageChannel()
        const held: ImageBitmap[] = []
        ;(window as any).__motifReloadFrames = held
        const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
        let id = 0
        const pending = new Map<number, (value: string) => void>()
        channel.port1.onmessage = ({ data }) => {
          let result = data.error ?? (data.bitmap ? 'ok' : 'missing')
          if (data.bitmap) {
            // Match the preview's L0 cache: hold delivered bitmaps until the
            // document goes away, including across native slot reuse.
            held.push(data.bitmap)
            ctx.drawImage(data.bitmap, 0, 0, 1, 1)
            const rgba = [...ctx.getImageData(0, 0, 1, 1).data]
            if (rgba.some((v, i) => Math.abs(v - [208, 64, 128, 255][i]!) > 2)) result = `Wrong pixels: ${rgba}`
          }
          pending.get(data.id)?.(result)
          pending.delete(data.id)
        }
        window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2])
        const read = () => new Promise<string>(resolve => {
          const requestId = ++id
          const timeout = setTimeout(() => { pending.delete(requestId); resolve('timeout') }, 3000)
          pending.set(requestId, result => { clearTimeout(timeout); resolve(result) })
          channel.port1.postMessage({ id: requestId, hash, frame: 0, div: 1 })
        })
        const first = await Promise.all([read(), read(), read()])
        const second = await Promise.all([read(), read(), read()])
        channel.port1.close()
        return { first, second }
      }, hash)
      expect(results.first, `reload ${round} reused stale imports`).toEqual(['ok', 'ok', 'ok'])
      expect(results.second, `reload ${round} exhausted the transport`).toEqual(['ok', 'ok', 'ok'])
      // Also tear down a document with outstanding reads and cached bitmaps.
      // Reload must cancel that generation without consuming the next one's
      // lanes or retaining its imported pools.
      if (round < 8) await page.evaluate(hash => {
        const channel = new MessageChannel()
        channel.port1.onmessage = ({ data }) => {
          if (data.bitmap) (window as any).__motifReloadFrames.push(data.bitmap)
        }
        window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2])
        for (let id = 1; id <= 24; id++) channel.port1.postMessage({ id, hash, frame: 1, div: 1 })
      }, hash)
    }
    // A silent switch to the utility lane (`unavailable`) must not hide a
    // remaining import leak.
    const kinds = await app.evaluate(() => (globalThis as any).__motifReloadKinds as string[])
    expect(kinds).toHaveLength(54)
    expect(new Set(kinds)).toEqual(new Set(['texture']))
  } finally { await app.close() }
})
