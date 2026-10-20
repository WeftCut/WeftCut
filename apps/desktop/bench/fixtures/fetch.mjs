#!/usr/bin/env node
// apps/desktop/bench/fixtures/fetch.mjs
//
//   node bench/fixtures/fetch.mjs --all        fetch + verify every fixture
//   node bench/fixtures/fetch.mjs <id> [<id>]  just these
//   node bench/fixtures/fetch.mjs --list       ids, licenses, sizes
//
// Downloads into bench/.cache/fixtures/ (git-ignored; WEFTCUT_BENCH_CACHE
// overrides), verifies sha256, trims where the fixture says so, and prints
// each verified path. Exits non-zero on any failure, hash mismatches included.
// Needs ffmpeg + ffprobe on PATH for trimmed fixtures (WEFTCUT_BENCH_FFMPEG /
// WEFTCUT_BENCH_FFPROBE override).

import { fixtureIds, loadManifest, probe, resolveFixture } from './fixtures.mjs'

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('usage: node bench/fixtures/fetch.mjs --all | --list | <fixture-id>...')
  console.log(`fixtures: ${fixtureIds().join(', ')}`)
  process.exit(args.length ? 0 : 2)
}
if (args.includes('--list')) {
  for (const f of loadManifest().fixtures)
    console.log(`${f.id}\t${f.license}\t${(f.size_bytes / 1e6).toFixed(1)} MB download\t${f.title}`)
  process.exit(0)
}

const ids = args.includes('--all') ? fixtureIds() : args
let failed = 0
for (const id of ids) {
  try {
    const file = await resolveFixture(id)
    const p = await probe(file)
    const kinds = p.streams.map((s) => `${s.codec_type}:${s.codec_name}`).join(' ')
    console.log(`ok  ${id}  ${p.duration_s.toFixed(3)} s  ${kinds}  ${file}`)
  } catch (e) {
    failed++
    console.error(`FAIL ${id}: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
