// apps/desktop/src/main/imageSearch.ts
//
// Open-licence pictures for an agent to show what the user's media does not
// (ticket 32, ADR 0133): search Wikimedia Commons for images whose licence
// allows reuse with changes and commercial use (CC0, public domain, CC BY,
// CC BY-SA), and fetch one into the project with its credit. (Openverse,
// which aggregates more libraries, answered every anonymous request from the
// test hosts with a Cloudflare challenge, so it is not used.)
//
// A candidate's licence is read from the library each time, never taken from
// the agent: `lookupImage` asks the library again by id before a download, and
// the credit written beside the project comes from that answer.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type ImageSource = 'commons'

export interface ImageCandidate {
  /** `commons:<page id>`. */
  candidate_id: string
  source: ImageSource
  title: string
  /** The library's page for the image, where its licence is stated. */
  page_url: string
  thumb_url: string
  /** What `import_image` downloads: the original, or for a file wider than
   *  1920 px, an SVG or a TIFF, Commons' 1920 px rendering (known only after
   *  `lookupImage`; a search answer carries the original). */
  image_url: string
  width: number
  height: number
  license: string
  license_url: string | null
  author: string
  /** One line to credit it by: title, author, licence, where from. */
  credit: string
}

export interface ImageCredit {
  title: string; author: string; license: string; license_url: string | null
  page_url: string; source: ImageSource; credit: string; imported_at: string
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; url: string; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>

const USER_AGENT = 'WeftCut/0.5 (open-licence picture search for video editing; https://github.com/WeftCut/WeftCut)'
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
// Commons renders thumbnails at standard widths only (others answer HTTP 400),
// so both come from the API's own `thumburl`, never a URL built here.
const IMPORT_WIDTH = 1920
const THUMB_WIDTH = 320
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
const IMAGE_MIME = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']])

const strip = (html: unknown) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim()

/** A Commons licence name, as Commons writes it, when it allows reuse with
 *  changes and commercial use; null otherwise (NC, ND, GFDL-only, fair use). */
export function acceptableCommonsLicence(short: string): string | null {
  const s = short.trim()
  if (/\b(NC|ND)\b/i.test(s) || /non-?commercial|no ?deriv/i.test(s)) return null
  if (/^(CC0|PDM|Public domain|PD\b|PD-)/i.test(s)) return /^CC0/i.test(s) ? 'CC0' : 'Public domain'
  if (/^CC BY(-SA)? \d(\.\d)?/i.test(s)) return s.replace(/^cc by/i, 'CC BY')
  return null
}


function creditLine(c: { title: string; author: string; license: string; source: ImageSource }): string {
  const where = 'via Wikimedia Commons'
  return c.license === 'CC0' || c.license === 'Public domain'
    ? `"${c.title}"${c.author ? ` by ${c.author}` : ''}, ${c.license === 'CC0' ? 'CC0' : 'public domain'}, ${where}`
    : `"${c.title}" by ${c.author || 'unknown'}, ${c.license}, ${where}`
}

/** Candidates from a Commons `imageinfo` answer. `rendered`: the answer was
 *  asked for at the import width, so its `thumburl` is what to download. */
export function parseCommons(json: unknown, rendered = false): ImageCandidate[] {
  const pages = Object.values(((json as { query?: { pages?: Record<string, unknown> } })?.query?.pages) ?? {}) as Array<{ pageid: number; title: string; index?: number; imageinfo?: Array<Record<string, unknown>> }>
  const out: Array<ImageCandidate & { index: number }> = []
  for (const p of pages) {
    const ii = p.imageinfo?.[0] as { url?: string; descriptionurl?: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; width?: number; height?: number; mime?: string; extmetadata?: Record<string, { value?: unknown }> } | undefined
    if (!ii?.url || !IMAGE_MIME.has(String(ii.mime)) && ii.mime !== 'image/svg+xml' && ii.mime !== 'image/tiff') continue
    const meta = ii.extmetadata ?? {}
    const license = acceptableCommonsLicence(strip(meta.LicenseShortName?.value))
    if (!license) continue
    const title = strip(meta.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
    const author = strip(meta.Artist?.value).slice(0, 200)
    const width = Number(ii.width) || 0, height = Number(ii.height) || 0
    // A raster original at most 1920 wide is fetched as is; anything larger,
    // or an SVG or TIFF, as Commons' rendering.
    const scaled = rendered && Boolean(ii.thumburl) && (width > IMPORT_WIDTH || !IMAGE_MIME.has(String(ii.mime)))
    const thumb = String(ii.thumburl ?? ii.url)
    const c: ImageCandidate = {
      candidate_id: `commons:${p.pageid}`, source: 'commons', title,
      page_url: String(ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`),
      thumb_url: thumb,
      image_url: scaled ? thumb : String(ii.url).split('?')[0]!,
      width: scaled ? Number(ii.thumbwidth) || width : width, height: scaled ? Number(ii.thumbheight) || height : height,
      license, license_url: strip(meta.LicenseUrl?.value) || null, author,
      credit: '',
    }
    c.credit = creditLine(c)
    out.push({ ...c, index: p.index ?? 0 })
  }
  return out.sort((a, b) => a.index - b.index).map(({ index: _, ...c }) => c)
}

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return res.json()
}

const commonsQuery = (params: Record<string, string>) => `${COMMONS_API}?${new URLSearchParams({
  action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(THUMB_WIDTH),
  iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName', ...params,
})}`

/** Up to `limit` candidates for `query`, in Commons' search order. */
export async function searchImages(query: string, opts: { limit?: number; fetch?: Fetch } = {}): Promise<ImageCandidate[]> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  const limit = Math.max(1, Math.min(12, opts.limit ?? 6))
  // Asks for three times as many: files with a licence that does not allow
  // reuse with changes, and non-images, are dropped.
  const found = parseCommons(await getJson(fetchFn, commonsQuery({ generator: 'search', gsrnamespace: '6', gsrlimit: String(limit * 3), gsrsearch: query })))
  return found.slice(0, limit)
}

/** The candidate `id` names, read again from its library. */
export async function lookupImage(id: string, opts: { fetch?: Fetch } = {}): Promise<ImageCandidate> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  const m = /^commons:(\d{1,12})$/.exec(id)
  if (!m) throw new Error(`candidate_id ${id} is not one search_images returned (commons:<page id>)`)
  const found = parseCommons(await getJson(fetchFn, commonsQuery({ pageids: m[1]!, iiurlwidth: String(IMPORT_WIDTH) })), true)
  if (!found[0]) throw new Error(`${id} is gone from its library, or its licence no longer allows reuse with changes`)
  return found[0]
}

/** Download the candidate's image to `<dir>/<slug>.<ext>`: https only, an
 *  image type, at most 40 MB. Returns the file's path. */
export async function downloadImage(c: ImageCandidate, dir: string, opts: { fetch?: Fetch } = {}): Promise<string> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  if (!c.image_url.startsWith('https://')) throw new Error(`${c.candidate_id}: the image is not served over https`)
  const res = await fetchFn(c.image_url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`downloading ${c.candidate_id} failed: HTTP ${res.status}`)
  if (!res.url.startsWith('https://')) throw new Error(`downloading ${c.candidate_id} was redirected off https`)
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const ext = IMAGE_MIME.get(mime)
  if (!ext) throw new Error(`downloading ${c.candidate_id} gave ${mime || 'no content type'}, not a JPEG, PNG, WebP or GIF`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`${c.candidate_id} is ${(declared / 1e6).toFixed(0)} MB, over the 40 MB limit`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`${c.candidate_id} is ${(bytes.length / 1e6).toFixed(0)} MB, over the 40 MB limit`)
  const slug = c.title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'image'
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${slug}-${hash}.${ext}`)
  fs.writeFileSync(file, bytes)
  return file
}

// ── Credits beside the project ──────────────────────────────────────────────
// `<project>/credits.json`, keyed by the pool item's content hash, so a credit
// follows its file through a relink or a move. Items the user imported have
// none and need none.

export const CREDITS_FILE = 'credits.json'

export function readCredits(projectDir: string): Record<string, ImageCredit> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectDir, CREDITS_FILE), 'utf8')) as { items?: Record<string, ImageCredit> }
    return j.items && typeof j.items === 'object' ? j.items : {}
  } catch { return {} }
}

export function writeCredit(projectDir: string, fileHash: string, credit: ImageCredit): void {
  const items = { ...readCredits(projectDir), [fileHash]: credit }
  const file = path.join(projectDir, CREDITS_FILE), tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
