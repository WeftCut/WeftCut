import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, tmpDir } from './helpers/driver'
import { supportsMotifSharedTextures } from './helpers/motif-gpu'

// Real preload/worker/native texture ownership, with synthetic colored frames.
test('@serial cached Motif frames survive concurrent reads and slot reuse', async () => {
  const { app, page } = await launchApp({ env: { ELECTRON_RENDERER_URL: '' } })
  try {
    const sharedTextures = await supportsMotifSharedTextures(app)
    const parent = tmpDir('weftcut-motif-transport-')
    await newProject(page, { parentFolder: parent, name: 'Transport', canvas: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } })
    const hash = '0123456789abcdef0123456789abcdef'
    const pngs = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920; canvas.height = 1080
      const ctx = canvas.getContext('2d')!
      return Array.from({ length: 6 }, (_, i) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = `rgba(${i * 40}, ${200 - i * 30}, 80, 0.5)`
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/png').split(',')[1]!
      })
    })
    const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
    await app.evaluate(async ({ ipcMain }, { addon, directory, pngs }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const fs = process.getBuiltinModule('fs/promises')
      await fs.mkdir(directory, { recursive: true })
      for (let i = 0; i < pngs.length; i++) {
        await fs.writeFile(`${directory}/${i}.wfrm`, await native.motifEncodePng(Buffer.from(pngs[i]!, 'base64'), true))
      }
      const handler = ipcMain._invokeHandlers.get('motif:read')!
      ;(globalThis as any).__motifReadKinds = []
      ipcMain._invokeHandlers.set('motif:read', async (...args: any[]) => {
        const result = await handler(...args)
        ;(globalThis as any).__motifReadKinds.push(result?.kind)
        return result
      })
    }, { addon, directory: path.join(parent, 'Transport', 'Cache', 'raster', hash), pngs })
    const pixels = await page.evaluate(async hash => {
      const channel = new MessageChannel()
      const pending = new Map<number, { resolve(bitmap: ImageBitmap): void; reject(error: Error): void }>()
      channel.port1.onmessage = ({ data }) => {
        const request = pending.get(data.id)!
        pending.delete(data.id)
        if (data.error || !data.bitmap) request.reject(new Error(data.error ?? 'Missing frame'))
        else request.resolve(data.bitmap)
      }
      window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2])
      let id = 0
      const read = (frame: number) => new Promise<ImageBitmap>((resolve, reject) => {
        const requestId = ++id
        pending.set(requestId, { resolve, reject })
        channel.port1.postMessage({ id: requestId, hash, frame })
      })
      const held = await Promise.all(Array.from({ length: 12 }, (_, i) => read(i % 6)))
      // Keep old bitmaps alive while every GPU lane is overwritten repeatedly.
      for (let batch = 0; batch < 4; batch++) {
        const frames = await Promise.all(Array.from({ length: 6 }, (_, i) => read(5 - i)))
        frames.forEach(frame => frame.close())
      }
      const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
      const samples = held.map(frame => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.drawImage(frame, 100, 100, 1, 1, 0, 0, 1, 1)
        frame.close()
        return [...ctx.getImageData(0, 0, 1, 1).data]
      })
      channel.port1.close()
      return samples
    }, hash)
    for (let i = 0; i < pixels.length; i++) {
      const expected = [(i % 6) * 40, 200 - (i % 6) * 30, 80, 128]
      expected.forEach((value, channel) => expect(Math.abs(pixels[i]![channel]! - value)).toBeLessThanOrEqual(2))
    }
    const kinds = await app.evaluate(() => (globalThis as any).__motifReadKinds as string[])
    expect(kinds).toHaveLength(36)
    expect(new Set(kinds)).toEqual(new Set([sharedTextures ? 'texture' : 'rgba']))
  } finally { await app.close() }
})

test('@serial cached Motif transport stays responsive across renderer reloads', async () => {
  const { app, page } = await launchApp({ env: { ELECTRON_RENDERER_URL: '' } })
  try {
    test.skip(!await supportsMotifSharedTextures(app), 'Requires real shared GPU textures')
    const parent = tmpDir('weftcut-motif-reload-')
    await newProject(page, { parentFolder: parent, name: 'Reload', canvas: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } })
    const hash = '123456789abcdef0123456789abcdef0'
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920; canvas.height = 1080
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#d04080'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
    await app.evaluate(async ({ ipcMain }, { addon, directory, png }) => {
      const native = process.getBuiltinModule('module').createRequire(addon)(addon)
      const fs = process.getBuiltinModule('fs/promises')
      await fs.mkdir(directory, { recursive: true })
      const encoded = await native.motifEncodePng(Buffer.from(png, 'base64'), true)
      await fs.writeFile(`${directory}/0.wfrm`, encoded)
      await fs.writeFile(`${directory}/1.wfrm`, encoded)
      const handler = ipcMain._invokeHandlers.get('motif:read')!
      ;(globalThis as any).__motifReloadKinds = []
      ipcMain._invokeHandlers.set('motif:read', async (event: any, args: any) => {
        const result = await handler(event, args)
        if (args.frame === 0) (globalThis as any).__motifReloadKinds.push(result?.kind)
        return result
      })
    }, { addon, directory: path.join(parent, 'Reload', 'Cache', 'raster', hash), png })
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
          channel.port1.postMessage({ id: requestId, hash, frame: 0 })
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
        for (let id = 1; id <= 24; id++) channel.port1.postMessage({ id, hash, frame: 1 })
      }, hash)
    }
    // A silent permanent switch to CPU must not hide a remaining import leak.
    const kinds = await app.evaluate(() => (globalThis as any).__motifReloadKinds as string[])
    expect(kinds).toHaveLength(54)
    expect(new Set(kinds)).toEqual(new Set(['texture']))
  } finally { await app.close() }
})
