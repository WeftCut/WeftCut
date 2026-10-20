// apps/desktop/bench/fixtures/fixtures.mjs
//
// Bench footage: public / CC files listed in fixtures.json, downloaded on first
// use into a git-ignored cache, verified by sha256, and trimmed when the
// fixture names a window. Nothing here is committed media.
//
// Trust: a download is untrusted data. It lands in its own empty directory,
// is hashed before anything reads it, and is only ever handed to ffmpeg /
// ffprobe as a file argument (no shell). A hash mismatch throws.
//
// Trims are stream copies (no re-encode), so they are byte-for-byte
// deterministic for one ffmpeg build. Another ffmpeg may lay the container out
// differently; then the per-stream packet hashes (`output_stream_sha256`, the
// ffmpeg `streamhash` muxer) decide: identical packets are accepted with a
// warning, anything else throws.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const MANIFEST_PATH = path.join(HERE, 'fixtures.json')
export const CACHE_DIR = process.env.WEFTCUT_BENCH_CACHE
  ? path.resolve(process.env.WEFTCUT_BENCH_CACHE)
  : path.join(HERE, '..', '.cache', 'fixtures')

const FFMPEG = process.env.WEFTCUT_BENCH_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.WEFTCUT_BENCH_FFPROBE || 'ffprobe'
// Wikimedia asks for an identifying User-Agent on automated downloads.
const USER_AGENT = 'WeftCutBench/0.1 (fixture fetch; https://github.com/UncleChair/WeftCut)'

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const HEX64 = /^[0-9a-f]{64}$/

/** The manifest, shape-checked so a typo fails before a download starts. */
export function loadManifest() {
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  if (!Array.isArray(m.fixtures)) throw new Error(`${MANIFEST_PATH}: expected { fixtures: [...] }`)
  for (const f of m.fixtures) {
    const where = `${MANIFEST_PATH}: fixture ${JSON.stringify(f.id)}`
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) throw new Error(`${where}: id must be kebab-case`)
    if (typeof f.file_url !== 'string' || !f.file_url.startsWith('https://')) throw new Error(`${where}: file_url must be https`)
    if (!HEX64.test(f.sha256 ?? '')) throw new Error(`${where}: sha256 must be 64 lowercase hex chars`)
    if (!/^[a-z0-9]+$/.test(f.ext ?? '')) throw new Error(`${where}: ext must be a bare extension`)
    for (const k of ['source_url', 'author', 'license', 'attribution'])
      if (typeof f[k] !== 'string' || !f[k].trim()) throw new Error(`${where}: ${k} is required`)
    if (f.trim) {
      const { start_s, duration_s } = f.trim
      if (!(Number.isFinite(start_s) && start_s >= 0 && Number.isFinite(duration_s) && duration_s > 0))
        throw new Error(`${where}: trim needs start_s >= 0 and duration_s > 0`)
      if (!HEX64.test(f.output_sha256 ?? '')) throw new Error(`${where}: a trimmed fixture pins output_sha256`)
      if (!HEX64.test(f.output_stream_sha256?.v ?? '') || !HEX64.test(f.output_stream_sha256?.a ?? ''))
        throw new Error(`${where}: a trimmed fixture pins output_stream_sha256 { v, a }`)
    }
  }
  return m
}

export function fixtureIds() {
  return loadManifest().fixtures.map((f) => f.id)
}

function fixtureEntry(id) {
  const f = loadManifest().fixtures.find((x) => x.id === id)
  if (!f) throw new Error(`unknown fixture '${id}' (have: ${fixtureIds().join(', ')})`)
  return f
}

export async function sha256File(file) {
  const h = createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  return h.digest('hex')
}

/** Stream the URL to `dest`, hashing on the way. Retries transient failures. */
async function download(url, dest, log) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      if (!new URL(res.url).protocol.startsWith('https')) throw new Error(`redirected off https to ${res.url}`)
      const hash = createHash('sha256')
      let bytes = 0
      const body = Readable.fromWeb(res.body)
      body.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length })
      await pipeline(body, fs.createWriteStream(dest, { mode: 0o644 }))
      return { sha256: hash.digest('hex'), bytes }
    } catch (e) {
      lastErr = e
      fs.rmSync(dest, { force: true })
      log(`  download attempt ${attempt} failed: ${e.message}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw new Error(`download of ${url} failed: ${lastErr?.message}`)
}

/** The verified source file, downloading it into its own empty directory when
 *  absent. A cached copy is re-hashed rather than trusted. */
async function ensureSource(f, log) {
  const dir = path.join(CACHE_DIR, f.id, 'source')
  const file = path.join(dir, `source.${f.ext}`)
  if (fs.existsSync(file)) {
    const got = await sha256File(file)
    if (got === f.sha256) return file
    log(`  cached source for ${f.id} has sha256 ${got}, expected ${f.sha256}; fetching again`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // Only this fixture's download ever lives in `dir`; it starts empty.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const part = path.join(dir, `source.${f.ext}.part`)
  log(`  downloading ${f.id} (${f.size_bytes ? `${(f.size_bytes / 1e6).toFixed(1)} MB` : 'unknown size'}) from ${f.file_url}`)
  const { sha256, bytes } = await download(f.file_url, part, log)
  if (sha256 !== f.sha256) {
    fs.rmSync(part, { force: true })
    throw new Error(`HASH MISMATCH for fixture ${f.id}: downloaded ${bytes} bytes with sha256 ${sha256}, fixtures.json pins ${f.sha256}. The file at ${f.file_url} changed or the download was tampered with; nothing was kept.`)
  }
  fs.renameSync(part, file)
  return file
}

/** Per-stream sha256 of the packet data, independent of container layout. */
async function streamHashes(file) {
  const { stdout } = await run(FFMPEG, ['-nostdin', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-'], { maxBuffer: 1 << 20 })
  const out = {}
  for (const line of stdout.split('\n')) {
    const m = /^\d+,([av]),SHA256=([0-9a-f]{64})$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Duration and stream kinds, as a playability check on the trimmed output. */
export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { maxBuffer: 1 << 20 })
  const j = JSON.parse(stdout)
  return { duration_s: Number(j.format?.duration), streams: j.streams ?? [] }
}

/** The stream-copy trim, every argument fixed so the output is reproducible:
 *  output-side seek (the start must be a keyframe; it is, see notes), first
 *  video + first audio stream, no metadata or chapters, bitexact muxing. */
function trimArgs(src, out, trim) {
  return ['-nostdin', '-v', 'error', '-y', '-i', src,
    '-ss', String(trim.start_s), '-t', String(trim.duration_s),
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-avoid_negative_ts', 'make_zero', '-f', 'webm', out]
}

function trimmedPaths(f) {
  const dir = path.join(CACHE_DIR, f.id)
  return {
    dir,
    out: path.join(dir, `${f.id}.${f.ext}`),
    stamp: path.join(dir, 'verified.json'),
    key: JSON.stringify({ sha256: f.sha256, trim: f.trim, output_sha256: f.output_sha256, output_stream_sha256: f.output_stream_sha256 }),
  }
}

/** The trimmed file when a previous run verified it and it is unchanged since. */
async function verifiedTrim(f) {
  const { out, stamp, key } = trimmedPaths(f)
  if (!fs.existsSync(out) || !fs.existsSync(stamp)) return null
  const s = JSON.parse(fs.readFileSync(stamp, 'utf8'))
  return s.key === key && (await sha256File(out)) === s.sha256 ? out : null
}

async function ensureTrimmed(f, src, log) {
  const { dir, out, stamp, key } = trimmedPaths(f)
  fs.rmSync(stamp, { force: true })
  const part = path.join(dir, `${f.id}.part.${f.ext}`)
  log(`  trimming ${f.id}: ${f.trim.start_s} s + ${f.trim.duration_s} s (stream copy)`)
  try {
    await run(FFMPEG, trimArgs(src, part, f.trim))
  } catch (e) {
    fs.rmSync(part, { force: true })
    throw new Error(`ffmpeg trim of ${f.id} failed: ${e.stderr?.trim() || e.message}`)
  }
  const got = await sha256File(part)
  if (got !== f.output_sha256) {
    const hashes = await streamHashes(part)
    if (hashes.v !== f.output_stream_sha256.v || hashes.a !== f.output_stream_sha256.a) {
      fs.rmSync(part, { force: true })
      throw new Error(`HASH MISMATCH for trimmed fixture ${f.id}: file sha256 ${got} (pinned ${f.output_sha256}) and stream hashes ${JSON.stringify(hashes)} (pinned ${JSON.stringify(f.output_stream_sha256)}). The source verified, so the local ffmpeg cut a different window; check its version or the trim parameters.`)
    }
    log(`  note: ${f.id} container bytes differ from the pinned file (another ffmpeg build), but every video and audio packet matches`)
  }
  const p = await probe(part)
  const want = f.media?.duration_s
  if (!p.streams.some((s) => s.codec_type === 'video') || !p.streams.some((s) => s.codec_type === 'audio'))
    throw new Error(`trimmed fixture ${f.id} lacks a video or audio stream: ${JSON.stringify(p.streams)}`)
  if (Number.isFinite(want) && Math.abs(p.duration_s - want) > 0.5)
    throw new Error(`trimmed fixture ${f.id} is ${p.duration_s} s long, expected ~${want} s`)
  fs.renameSync(part, out)
  fs.writeFileSync(stamp, JSON.stringify({ key, sha256: got, verified_at: new Date().toISOString() }, null, 2) + '\n')
  return out
}

/** Absolute path of the verified local file for fixture `id`; downloads,
 *  verifies and trims on first use. Throws on any hash mismatch. */
export async function resolveFixture(id, { log = (m) => console.error(m) } = {}) {
  const f = fixtureEntry(id)
  fs.mkdirSync(path.join(CACHE_DIR, f.id), { recursive: true })
  if (f.trim) {
    const ready = await verifiedTrim(f)
    if (ready) return ready
  }
  const src = await ensureSource(f, log)
  return f.trim ? ensureTrimmed(f, src, log) : src
}
