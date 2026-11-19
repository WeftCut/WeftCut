import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Main's end of `motif:capture`: each capture resolves or rejects as queued.
const main = vi.hoisted(() => ({ answers: [] as Array<{ reply: unknown } | { error: Error }> }))
vi.mock('electron', () => ({
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(async () => {
      const answer = main.answers.shift()!
      if ('error' in answer) throw answer.error
      return answer.reply
    }),
  },
}))

const { installMotifFrames } = await import('./motifFrames')
const { ipcRenderer } = await import('electron')

// The preload's texture read and read barrier, as each test sets them.
const reading = {
  readTexture: (_key: string): Promise<ImageBitmap> => Promise.reject(new Error('no texture')),
  finishRead: async (bitmap: ImageBitmap): Promise<ImageBitmap> => bitmap,
}

// The page's end of the frame port. The page decodes `{ error, code }` into a
// MotifError (frameTransport.test.ts); this pins what the preload posts.
let page: MessagePort
beforeAll(() => {
  let listener: ((event: { source: unknown; data: unknown; ports: MessagePort[] }) => void) | null = null
  const stub = { addEventListener: (_type: string, handler: typeof listener) => { listener = handler } }
  vi.stubGlobal('window', stub)
  installMotifFrames(key => reading.readTexture(key), bitmap => reading.finishRead(bitmap))
  const channel = new MessageChannel()
  page = channel.port1
  listener!({ source: stub, data: { type: 'weftcut:motif-frame-port' }, ports: [channel.port2] })
})
afterAll(() => { page.close(); vi.unstubAllGlobals() })

let nextId = 0
function capture(): Promise<unknown> {
  const id = ++nextId
  return new Promise(resolve => {
    const onReply = ({ data }: MessageEvent<{ id: number }>) => {
      if (data.id !== id) return
      page.removeEventListener('message', onReply)
      resolve(data)
    }
    page.addEventListener('message', onReply)
    page.start()
    page.postMessage({ id, capture: { requestId: id, motifId: 'm', tSec: 0, propsJson: '{}', width: 2, height: 2, contentHash: '', priority: 'ahead' } })
  })
}

describe('Motif frame port, main to page', () => {
  it('a `capacity` reply reaches the page as the `capacity` failure main refused with', async () => {
    main.answers.push({ reply: { kind: 'capacity', detail: 'resource-capacity-exceeded: synthetic' } })
    expect(await capture()).toEqual({ id: nextId, error: 'resource-capacity-exceeded: synthetic', code: 'capacity' })
  })

  it('a `superseded` reply is not a failure; a thrown failure keeps its code', async () => {
    main.answers.push({ reply: { kind: 'superseded' } })
    expect(await capture()).toEqual({ id: nextId, superseded: true })
    main.answers.push({ error: new Error("Error invoking remote method 'motif:capture': Error: [motif:content] synthetic") })
    expect(await capture()).toEqual({ id: nextId, error: 'synthetic', code: 'content' })
  })

  it('a texture whose read barrier fails is closed here, and main hears the read failed', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    reading.readTexture = async () => bitmap
    reading.finishRead = () => Promise.reject(new Error('Motif texture read barrier unavailable'))
    main.answers.push({ reply: { kind: 'texture', key: 'k', token: 'read-1' } })
    expect(await capture()).toMatchObject({ id: nextId, error: expect.stringContaining('read barrier unavailable') })
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(ipcRenderer.send).toHaveBeenCalledWith('motif:ack', { token: 'read-1', failed: true })
  })
})
