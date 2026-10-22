// apps/desktop/src/main/motif/mediaProps.ts
//
// `media` props at capture time (ADR 0132). Before `setup`, each media prop's
// value ("<media_id>" or "<media_id>@<t_us>") becomes a URL on the Motif's own
// origin, `motif://<id>/.media/<picture key>`, which the motif protocol serves
// from here. The page loads it like one of its own files, so the render CSP
// stays as it is and no bytes cross the capture channel per frame. A video
// frame is taken once with the bundled ffmpeg, at full size, and kept on disk
// by picture key. A ref the pool cannot resolve becomes "": the Motif draws its
// fallback, and the audit or the tool call has said why.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Manifest } from '../../shared/motifs/catalog.js'
import { MOTIF_MEDIA_DIR, mediaPictureKey, parseMediaRef } from '../../shared/motifs/mediaProp.js'
import type { MediaItem } from '../state/model.js'

type Pool = Readonly<Record<string, Pick<MediaItem, 'kind' | 'path_abs' | 'file_hash_blake3'>>>

let pool: (() => Pool | null) | null = null
let framesDir: string | null = null

/** Wire the open project's media pool and the directory video frames are kept
 *  in. Until then every media prop resolves to "". */
export function setMotifMediaSource(getPool: () => Pool | null, dir: string): void {
  pool = getPool
  framesDir = dir
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' }

/** Picture key → file. Only what a resolve put here is served. */
const served = new Map<string, { file: string; mime: string }>()
const MAX_SERVED = 512
const pending = new Map<string, Promise<string>>()

function remember(key: string, file: string, mime: string): void {
  if (served.has(key)) served.delete(key)
  else if (served.size >= MAX_SERVED) served.delete(served.keys().next().value!)
  served.set(key, { file, mime })
}

function grabFrame(src: string, tUs: number, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const tmp = `${out}.${process.pid}.tmp.png`
    execFile('ffmpeg', ['-v', 'error', '-y', '-ss', (tUs / 1e6).toFixed(6), '-i', src, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', tmp],
      { windowsHide: true, timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err || !fs.existsSync(tmp)) {
          fs.rmSync(tmp, { force: true })
          reject(new Error(`frame grab failed at ${tUs} µs: ${String(stderr || err).slice(0, 300)}`))
          return
        }
        fs.renameSync(tmp, out)
        resolve(out)
      })
  })
}

async function videoFrame(src: string, key: string, tUs: number): Promise<string> {
  const out = path.join(framesDir!, `${key.replace('@', '_')}.png`)
  if (fs.existsSync(out)) return out
  let p = pending.get(key)
  if (!p) {
    p = grabFrame(src, tUs, out).finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

/** `props` with each media prop replaced by its served URL, or "" when it
 *  names nothing the pool holds. Other props pass through untouched. */
export async function resolveMotifMediaProps(motifId: string, manifest: Pick<Manifest, 'props_schema'> | null | undefined, props: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!manifest) return props
  let out: Record<string, unknown> | null = null
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    if (spec.type !== 'media') continue
    out ??= { ...props }
    out[key] = await resolveOne(motifId, props[key])
  }
  return out ?? props
}

async function resolveOne(motifId: string, value: unknown): Promise<string> {
  const ref = parseMediaRef(value)
  const item = ref ? pool?.()?.[ref.media_id] : undefined
  if (!ref || !item) return ''
  const key = mediaPictureKey(item.file_hash_blake3, item.kind === 'Video' ? { ...ref, t_us: ref.t_us ?? 0 } : { ...ref, t_us: null })
  if (item.kind === 'Image') {
    // Refreshed every time: a workspace move changes the path, not the key.
    const mime = MIME[path.extname(item.path_abs).toLowerCase()]
    if (!mime) return ''
    remember(key, item.path_abs, mime)
  } else if (item.kind === 'Video' && framesDir) {
    if (!served.has(key)) remember(key, await videoFrame(item.path_abs, key, ref.t_us ?? 0), 'image/png')
  } else return ''
  return `motif://${motifId}/${MOTIF_MEDIA_DIR}/${encodeURIComponent(key)}`
}

/** The picture at `motif://<id>/.media/<key>`, or null. `rest` is the path
 *  after the host, already decoded. */
export function servedMotifMedia(rest: string): { file: string; mime: string } | null {
  if (!rest.startsWith(`${MOTIF_MEDIA_DIR}/`)) return null
  return served.get(rest.slice(MOTIF_MEDIA_DIR.length + 1)) ?? null
}
