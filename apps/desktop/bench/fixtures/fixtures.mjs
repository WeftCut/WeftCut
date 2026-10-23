// apps/desktop/bench/fixtures/fixtures.mjs
//
// Bench footage: public / CC files listed in fixtures.json, downloaded on first
// use into a git-ignored cache, verified by sha256, trimmed when the fixture
// names a window, then transcoded to an H.264/AAC MP4 — the file the bench
// imports. A still image (`media.type: "image"`) is imported as downloaded,
// once its sha256 matches. Nothing here is committed media.
//
// Why the transcode: Commons serves VP9/AV1 WebM, which the app routes through
// a full proxy. Users bring H.264, and a proxied source makes every preview,
// Motif preview and export of a run slower than real footage would.
//
// Trust: a download is untrusted data. It lands in its own empty directory,
// is hashed before anything reads it, and is only ever handed to ffmpeg /
// ffprobe as a file argument (no shell). A hash mismatch throws.
//
// What is pinned and what is recorded:
//   - the SOURCE download: sha256, pinned in fixtures.json, checked every time;
//   - the TRIM (a stream copy, deterministic for one ffmpeg build): its file
//     sha256, or else its per-stream packet hashes (`trim.stream_sha256`, the
//     ffmpeg `streamhash` muxer) — another ffmpeg may lay the container out
//     differently but must copy identical packets;
//   - the MP4: NOT pinnable, since x264/aac output differs across ffmpeg
//     builds. Fetch records the parameters, the ffmpeg version and the
//     output's sha256 in <cache>/<id>/fixture.json; run.json and the template
//     key take them from there.

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
  const t = m.transcode
  if (!t || t.container !== 'mp4' || t.video?.encoder !== 'libx264' || t.audio?.encoder !== 'aac'
    || !Number.isInteger(t.video.crf) || typeof t.video.preset !== 'string' || !(t.video.keyframe_interval_s > 0)
    || !Number.isInteger(t.audio.bitrate) || !Number.isInteger(t.audio.sample_rate) || !Number.isInteger(t.audio.channels))
    throw new Error(`${MANIFEST_PATH}: transcode must name mp4, libx264 { preset, crf, pix_fmt, keyframe_interval_s } and aac { bitrate, sample_rate, channels }`)
  for (const f of m.fixtures) {
    const where = `${MANIFEST_PATH}: fixture ${JSON.stringify(f.id)}`
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) throw new Error(`${where}: id must be kebab-case`)
    if (typeof f.file_url !== 'string' || !f.file_url.startsWith('https://')) throw new Error(`${where}: file_url must be https`)
    if (!HEX64.test(f.sha256 ?? '')) throw new Error(`${where}: sha256 must be 64 lowercase hex chars`)
    if (!/^[a-z0-9]+$/.test(f.ext ?? '')) throw new Error(`${where}: ext must be a bare extension`)
    for (const k of ['source_url', 'author', 'license', 'attribution'])
      if (typeof f[k] !== 'string' || !f[k].trim()) throw new Error(`${where}: ${k} is required`)
    if (isImage(f)) {
      if (!Number.isInteger(f.media.width) || !Number.isInteger(f.media.height) || f.trim)
        throw new Error(`${where}: an image needs media { width, height } and no trim`)
      continue
    }
    const fps = f.media?.fps
    if (!Number.isInteger(fps?.num) || !Number.isInteger(fps?.den) || !(Number(f.media?.duration_s) > 0))
      throw new Error(`${where}: media needs duration_s and fps { num, den } (the transcode keeps the source's rate)`)
    if (f.trim) {
      const { start_s, duration_s } = f.trim
      if (!(Number.isFinite(start_s) && start_s >= 0 && Number.isFinite(duration_s) && duration_s > 0))
        throw new Error(`${where}: trim needs start_s >= 0 and duration_s > 0`)
      if (!HEX64.test(f.trim.sha256 ?? '')) throw new Error(`${where}: a trim pins its output sha256`)
      if (!HEX64.test(f.trim.stream_sha256?.v ?? '') || !HEX64.test(f.trim.stream_sha256?.a ?? ''))
        throw new Error(`${where}: a trim pins stream_sha256 { v, a }`)
    }
  }
  return m
}

/** A still image: imported as downloaded, no trim or transcode. */
export const isImage = (f) => f.media?.type === 'image'

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

/** Duration and stream kinds, as a playability check. */
export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels', '-of', 'json', file], { maxBuffer: 1 << 20 })
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

/** The MP4 transcode for fixture `f` under the manifest's `transcode` recipe:
 *  constant frame rate at the source's own rate, a closed GOP every
 *  `keyframe_interval_s` (no scene-cut keyframes, so the cadence is fixed),
 *  AAC at a fixed rate and layout, faststart, no metadata. */
export function transcodeArgs(src, out, f, t) {
  const { num, den } = f.media.fps
  const gop = Math.max(1, Math.round((t.video.keyframe_interval_s * num) / den))
  return ['-nostdin', '-v', 'error', '-y', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', t.video.encoder, '-preset', t.video.preset, '-crf', String(t.video.crf), '-pix_fmt', t.video.pix_fmt,
    '-r', `${num}/${den}`, '-g', String(gop), '-keyint_min', String(gop),
    ...(t.video.scene_cut_keyframes ? [] : ['-sc_threshold', '0']),
    '-c:a', t.audio.encoder, '-b:a', String(t.audio.bitrate), '-ar', String(t.audio.sample_rate), '-ac', String(t.audio.channels),
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', t.movflags, '-f', 'mp4', out]
}

export async function ffmpegVersion() {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-version'], { maxBuffer: 1 << 20 })
  // `ffmpeg version 8.1.1-full_build-www.gyan.dev`, without the copyright tail.
  return stdout.split(/\r?\n/)[0].replace(/\s+Copyright.*$/, '').trim()
}

function paths(f) {
  const dir = path.join(CACHE_DIR, f.id)
  return {
    dir,
    trimDir: path.join(dir, 'trim'),
    out: path.join(dir, `${f.id}.mp4`),
    meta: path.join(dir, 'fixture.json'),
  }
}

/** What the MP4 depends on: a change to any of it means a new transcode. */
function cacheKey(f, transcode, version) {
  return JSON.stringify({ source_sha256: f.sha256, trim: f.trim ?? null, fps: f.media.fps, transcode, ffmpeg: version })
}

/** Files of the earlier WebM layout (a trimmed .webm beside verified.json):
 *  superseded by the MP4, removed so nothing imports them by accident. The
 *  downloaded source stays. */
function dropOldLayout(f) {
  const { dir } = paths(f)
  for (const name of [`${f.id}.webm`, 'verified.json']) fs.rmSync(path.join(dir, name), { force: true })
}

/** The trimmed WebM, verified against the trim's pins, in its own folder. */
async function trimmed(f, src, log) {
  const { trimDir } = paths(f)
  fs.rmSync(trimDir, { recursive: true, force: true })
  fs.mkdirSync(trimDir, { recursive: true })
  const out = path.join(trimDir, `${f.id}.webm`)
  log(`  trimming ${f.id}: ${f.trim.start_s} s + ${f.trim.duration_s} s (stream copy)`)
  try {
    await run(FFMPEG, trimArgs(src, out, f.trim))
  } catch (e) {
    throw new Error(`ffmpeg trim of ${f.id} failed: ${e.stderr?.trim() || e.message}`)
  }
  const got = await sha256File(out)
  if (got !== f.trim.sha256) {
    const hashes = await streamHashes(out)
    if (hashes.v !== f.trim.stream_sha256.v || hashes.a !== f.trim.stream_sha256.a)
      throw new Error(`HASH MISMATCH for trimmed fixture ${f.id}: file sha256 ${got} (pinned ${f.trim.sha256}) and stream hashes ${JSON.stringify(hashes)} (pinned ${JSON.stringify(f.trim.stream_sha256)}). The source verified, so the local ffmpeg cut a different window; check its version or the trim parameters.`)
    log(`  note: ${f.id} trim container bytes differ from the pinned file (another ffmpeg build), but every video and audio packet matches`)
  }
  return out
}

/** The recorded metadata of fixture `id` (fixture.json), or null before its
 *  first fetch. */
export function fixtureMeta(id) {
  const { meta } = paths(fixtureEntry(id))
  return fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : null
}

/** The fixture's MP4 and its recorded metadata; downloads, verifies, trims and
 *  transcodes on first use (or when the source, trim, recipe or ffmpeg build
 *  changed). Throws on any hash mismatch. */
export async function resolveFixtureWithMeta(id, { log = (m) => console.error(m) } = {}) {
  const f = fixtureEntry(id)
  if (isImage(f)) return resolveImage(f, log)
  const { transcode } = loadManifest()
  const p = paths(f)
  fs.mkdirSync(p.dir, { recursive: true })
  dropOldLayout(f)
  const version = await ffmpegVersion()
  const key = cacheKey(f, transcode, version)
  const prior = fixtureMeta(id)
  if (prior && prior.key === key && fs.existsSync(p.out) && (await sha256File(p.out)) === prior.output.sha256)
    return { path: p.out, meta: prior }

  // The source is verified even when only the recipe changed: the MP4 is
  // made from bytes checked now, not from whatever was cached.
  const src = await ensureSource(f, log)
  const input = f.trim ? await trimmed(f, src, log) : src
  const part = path.join(p.dir, `${f.id}.part.mp4`)
  const args = transcodeArgs(input, part, f, transcode)
  log(`  transcoding ${f.id} to H.264/AAC MP4 (${transcode.video.preset}, crf ${transcode.video.crf})`)
  const started = Date.now()
  try {
    await run(FFMPEG, args, { maxBuffer: 16 << 20 })
  } catch (e) {
    fs.rmSync(part, { force: true })
    throw new Error(`ffmpeg transcode of ${f.id} failed: ${e.stderr?.trim() || e.message}`)
  }
  const transcodeMs = Date.now() - started
  const pr = await probe(part)
  const v = pr.streams.find((s) => s.codec_type === 'video')
  const a = pr.streams.find((s) => s.codec_type === 'audio')
  if (v?.codec_name !== 'h264' || a?.codec_name !== 'aac') {
    fs.rmSync(part, { force: true })
    throw new Error(`transcoded fixture ${f.id} is not H.264 + AAC: ${JSON.stringify(pr.streams)}`)
  }
  if (Math.abs(pr.duration_s - f.media.duration_s) > 0.5) {
    fs.rmSync(part, { force: true })
    throw new Error(`transcoded fixture ${f.id} is ${pr.duration_s} s long, expected ~${f.media.duration_s} s`)
  }
  const sha256 = await sha256File(part)
  fs.renameSync(part, p.out)
  if (f.trim) fs.rmSync(p.trimDir, { recursive: true, force: true })
  const meta = {
    id: f.id, key,
    source: { url: f.file_url, sha256: f.sha256 },
    trim: f.trim ?? null,
    transcode: { ...transcode, ffmpeg_version: version, args: [...args.slice(0, 5), '<input>', ...args.slice(6, -1), '<output>'] },
    output: { file: path.basename(p.out), sha256, bytes: fs.statSync(p.out).size, duration_s: pr.duration_s, streams: pr.streams },
    transcode_ms: transcodeMs,
    created_at: new Date().toISOString(),
  }
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + '\n')
  return { path: p.out, meta }
}

/** An image fixture: the verified download, copied under the fixture's name
 *  (`<id>.<ext>`, as a user's file would be named) and probed once for its
 *  size. */
async function resolveImage(f, log) {
  const p = paths(f)
  const prior = fixtureMeta(f.id)
  const verified = await ensureSource(f, log)
  const src = path.join(p.dir, `${f.id}.${f.ext}`)
  fs.copyFileSync(verified, src)
  if (prior?.key === f.sha256 && prior.output?.file === path.basename(src)) return { path: src, meta: prior }
  const pr = await probe(src)
  const v = pr.streams.find((x) => x.codec_type === 'video')
  if (v?.width !== f.media.width || v?.height !== f.media.height)
    throw new Error(`image fixture ${f.id} is ${v?.width}x${v?.height}, fixtures.json says ${f.media.width}x${f.media.height}`)
  const meta = {
    id: f.id, key: f.sha256,
    source: { url: f.file_url, sha256: f.sha256 },
    output: { file: path.basename(src), sha256: f.sha256, bytes: fs.statSync(src).size, width: v.width, height: v.height, streams: pr.streams },
    created_at: new Date().toISOString(),
  }
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + '\n')
  return { path: src, meta }
}

/** Absolute path of fixture `id`'s MP4 (resolveFixtureWithMeta's path). */
export async function resolveFixture(id, opts) {
  return (await resolveFixtureWithMeta(id, opts)).path
}
