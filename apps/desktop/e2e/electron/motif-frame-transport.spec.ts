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
