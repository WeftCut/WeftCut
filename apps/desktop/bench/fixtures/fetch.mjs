#!/usr/bin/env node
// apps/desktop/bench/fixtures/fetch.mjs
//
//   node bench/fixtures/fetch.mjs --all        fetch + verify + transcode every fixture
//   node bench/fixtures/fetch.mjs <id> [<id>]  just these
//   node bench/fixtures/fetch.mjs --list       ids, licenses, sizes
//   ... --json                                 also print one `@@META@@{id: fixture.json}` line
//
// Downloads into bench/.cache/fixtures/ (git-ignored; WEFTCUT_BENCH_CACHE
// overrides), verifies sha256, trims where the fixture says so, transcodes to
// the H.264/AAC MP4 the bench imports, and prints each MP4's path. Exits
// non-zero on any failure, hash mismatches included. Needs ffmpeg (with
// libx264) and ffprobe on PATH (WEFTCUT_BENCH_FFMPEG / WEFTCUT_BENCH_FFPROBE
// override).

import { fixtureIds, loadManifest, resolveFixtureWithMeta } from './fixtures.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const rest = args.filter((a) => a !== '--json')
if (!rest.length || rest.includes('--help') || rest.includes('-h')) {
  console.log('usage: node bench/fixtures/fetch.mjs [--json] --all | --list | <fixture-id>...')
  console.log(`fixtures: ${fixtureIds().join(', ')}`)
  process.exit(rest.length ? 0 : 2)
}
if (rest.includes('--list')) {
  for (const f of loadManifest().fixtures)
    console.log(`${f.id}\t${f.license}\t${(f.size_bytes / 1e6).toFixed(1)} MB download\t${f.title}`)
  process.exit(0)
}

const ids = rest.includes('--all') ? fixtureIds() : rest
let failed = 0
const metas = {}
for (const id of ids) {
  try {
    const { path, meta } = await resolveFixtureWithMeta(id)
    metas[id] = meta
    const kinds = meta.output.streams.map((s) => `${s.codec_type}:${s.codec_name}`).join(' ')
    const extent = meta.output.duration_s !== undefined ? `${meta.output.duration_s.toFixed(3)} s` : `${meta.output.width}x${meta.output.height}`
    console.log(`ok  ${id}  ${extent}  ${kinds}  ${(meta.output.bytes / 1e6).toFixed(1)} MB  ${path}`)
  } catch (e) {
    failed++
    console.error(`FAIL ${id}: ${e.message}`)
  }
}
if (json) console.log(`@@META@@${JSON.stringify(metas)}`)
process.exit(failed ? 1 : 0)
