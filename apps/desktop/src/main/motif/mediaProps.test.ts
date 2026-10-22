import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveMotifMediaProps, servedMotifMedia, setMotifMediaSource } from './mediaProps'

const manifest = { props_schema: { photo: { type: 'media' as const, default: '' as const }, label: { type: 'string' as const, default: 'x' } } }
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-media-'))
  const png = path.join(dir, 'brain.png')
  // A 1×1 PNG.
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))
  const pool: Record<string, { kind: 'Image' | 'Video' | 'Audio'; path_abs: string; file_hash_blake3: string }> = {
    img: { kind: 'Image', path_abs: png, file_hash_blake3: 'h1' },
    aud: { kind: 'Audio', path_abs: png, file_hash_blake3: 'h2' },
  }
  setMotifMediaSource(() => pool, path.join(dir, 'frames'))
  return { dir, pool }
}

describe('media props at capture', () => {
  it('become a URL on the Motif origin that serves the file, leaving other props alone', async () => {
    setup()
    const out = await resolveMotifMediaProps('clipping-sticker', manifest, { photo: 'img', label: 'img' })
    expect(out).toEqual({ photo: 'motif://clipping-sticker/.media/h1', label: 'img' })
    expect(servedMotifMedia('.media/h1')?.mime).toBe('image/png')
    expect(servedMotifMedia('index.html')).toBeNull()
  })

  it('resolve to "" for nothing, a missing item, or a non-picture', async () => {
    setup()
    for (const photo of ['', 'gone', 'aud']) expect((await resolveMotifMediaProps('m', manifest, { photo, label: '' })).photo).toBe('')
  })

  it.skipIf(!hasFfmpeg)('take a video frame once, at full size, keyed by hash and time', async () => {
    const { dir, pool } = setup()
    const vid = path.join(dir, 'clip.mp4')
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=1', '-pix_fmt', 'yuv420p', vid])
    pool.vid = { kind: 'Video', path_abs: vid, file_hash_blake3: 'hv' }
    const out = await resolveMotifMediaProps('m', manifest, { photo: 'vid@500000', label: '' })
    expect(out.photo).toBe(`motif://m/.media/${encodeURIComponent('hv@500000')}`)
    const served = servedMotifMedia('.media/hv@500000')!
    expect(fs.readFileSync(served.file).subarray(1, 4).toString()).toBe('PNG')
  })
})
