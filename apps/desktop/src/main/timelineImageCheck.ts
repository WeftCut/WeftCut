import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { session, WebContentsView } from 'electron'

const origin = 'weftcut-media://timeline-image-check'
const page = origin + '/'
const timeoutMs = 10_000
const maxImageBytes = 256 * 1024 * 1024
const sources = new Map<string, { file: FileHandle; size: number }>()

export interface TimelineImageCheck {
  inspect(path: string): Promise<{ width: number; height: number } | 'too-large' | null>
  close(): void
}

export function createTimelineImageCheck(): TimelineImageCheck {
  const isolated = session.fromPartition('timeline-image-check')
  if (!isolated.protocol.isProtocolHandled('weftcut-media')) {
    // The image decoder can read only registered handles in this partition.
    // No path or resource URL from the XML reaches the image page.
    isolated.webRequest.onBeforeRequest((request, callback) => {
      callback({ cancel: request.url !== page && !sources.has(request.url) })
    })
    isolated.protocol.handle('weftcut-media', request => {
      if (request.method === 'GET' && request.url === page) {
        return new Response('<!doctype html><title>Timeline image check</title>', { headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        } })
      }
      const source = request.method === 'GET' ? sources.get(request.url) : undefined
      if (!source) return new Response(null, { status: 404 })
      const stream = source.file.createReadStream({ autoClose: false, start: 0, end: source.size - 1 })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      })
    })
  }
  function decoder() {
    const view = new WebContentsView({ webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } })
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    return { view, loaded: contents.loadURL(page) }
  }
  let active: ReturnType<typeof decoder> | undefined
  function close() {
    const contents = active?.view.webContents
    active = undefined
    if (contents && !contents.isDestroyed()) contents.close()
  }
  return {
    close,
    async inspect(path) {
      const info = await lstat(path)
      if (!info.isFile()) throw new Error('The image must be a regular file')
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      const file = await open(path, flags)
      const url = origin + '/' + randomUUID()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || !opened.size) {
          throw new Error('The image changed during review or is empty')
        }
        if (opened.size > maxImageBytes) return 'too-large'
        sources.set(url, { file, size: opened.size })
        const { view, loaded } = active ??= decoder()
        const decoded = loaded.then(() => view.webContents.executeJavaScript(`(async () => {
          const response = await fetch(${JSON.stringify(url)});
          if (!response.ok) throw new Error('Could not read the image');
          const blob = await response.blob();
          try {
            const bitmap = await createImageBitmap(blob);
            const size = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            return size;
          } catch { return null; }
        })()`) as Promise<{ width: number; height: number } | null>)
        return await Promise.race([decoded, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('The image could not be checked in time')), timeoutMs)
        })])
      } catch (error) {
        close()
        throw error
      } finally {
        clearTimeout(timeout)
        sources.delete(url)
        await file.close()
      }
    },
  }
}
