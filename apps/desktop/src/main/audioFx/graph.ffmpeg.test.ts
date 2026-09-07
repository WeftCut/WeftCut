// Real-ffmpeg smoke for the audio-effect filter graphs. Repo rule: anything
// that emits an ffmpeg graph is smoke-run through ffmpeg — a regex proves the
// string, only ffmpeg proves the graph PARSES, that `asendcmd`'s target
// resolves to the named `afftdn` instance, and that two stages' labels do not
// collide.
//
// Main-side, not beside the module it tests: src/shared/audioEffects/ is
// compiled without @types/node so the renderer cannot pick up a Node
// dependency, and this needs fs / child_process. The graph TEXT is pinned in
// src/shared/audioEffects/graph.test.ts.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIO_FX_OUT_LABEL, buildFilterComplex, chainMeasurements, measurementKey, type BakeCtx } from '../../shared/audioEffects/graph'
import { CONFORM_SAMPLE_RATE } from '../../shared/audioEffects/conform'
import { staticParams, type AudioEffectEntry, type ChainEntry } from '../../shared/audioEffects/catalog'
import { DENOISE } from '../../shared/audioEffects/denoise'

const sp = (value: number) => ({ mode: 'Static' as const, value })

/** A chain entry built DIRECTLY, without `effectiveChain`: the fixture is
 *  0.1 s long, far shorter than the 0.25 s a real sample region needs, so the
 *  completeness gate would (correctly) drop it. */
function entry(params: Record<string, number>): ChainEntry {
  const effect: AudioEffectEntry = {
    id: 'e1', kind: 'audio.denoise', enabled: true,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, sp(v)])),
  }
  return { effect, descriptor: DENOISE, params: staticParams(effect, DENOISE) }
}

function ctxFor(chain: ChainEntry[], rmsDbfs: number | null): BakeCtx {
  const measurements: Record<string, number | null> = {}
  for (const req of chainMeasurements(chain)) measurements[measurementKey(req)] = rmsDbfs
  return { measurements }
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FFMPEG_DIR: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' }

function shippedFfmpeg(): string | null {
  const dir = FFMPEG_DIR[platform()]
  if (!dir) return null
  const bin = join(APP_ROOT, 'resources', 'ffmpeg', dir, platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return existsSync(bin) ? bin : null
}

const FFMPEG = shippedFfmpeg()
const FIXTURE_FRAMES = CONFORM_SAMPLE_RATE / 10 // 0.1 s mono

/** 440 Hz tone under deterministic broadband noise — enough spectral content
 *  for afftdn to have something to subtract. Seeded LCG, no Math.random: a
 *  smoke test that fails only on some runs is worse than none. */
function fixtureBytes(): Uint8Array {
  const pcm = new Float32Array(FIXTURE_FRAMES)
  let seed = 0x2545f491
  for (let i = 0; i < FIXTURE_FRAMES; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const noise = (seed / 0xffffffff) * 2 - 1
    pcm[i] = 0.02 * Math.sin((2 * Math.PI * 440 * i) / CONFORM_SAMPLE_RATE) + 0.002 * noise
  }
  return new Uint8Array(pcm.buffer)
}

function runGraph(ffmpeg: string, graph: string | null, label: string): void {
  expect(graph, label).not.toBeNull()
  const dir = mkdtempSync(join(tmpdir(), 'weftcut-audiofx-'))
  try {
    const src = join(dir, 'in.f32')
    const dst = join(dir, 'out.f32')
    const input = fixtureBytes()
    writeFileSync(src, input)
    const r = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
      '-f', 'f32le', '-ar', String(CONFORM_SAMPLE_RATE), '-ac', '1', '-i', src,
      '-filter_complex', graph as string,
      '-map', `[${AUDIO_FX_OUT_LABEL}]`,
      '-f', 'f32le', '-ar', String(CONFORM_SAMPLE_RATE), '-ac', '1', dst,
    ], { encoding: 'utf8' })
    const where = `${label}\ngraph: ${graph}\nstderr: ${r.stderr ?? ''}`
    expect(r.status, where).toBe(0)
    // Byte equality is the invariant the bake primitive asserts: the concat
    // pre-roll must come back off exactly, or the artifact no longer aligns 1:1
    // with the conform it replaces.
    expect(readFileSync(dst).byteLength, where).toBe(input.byteLength)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/// Carries the skip REASON, so a run with no bundled binary says why instead of
/// silently reporting three fewer tests.
const TITLE = FFMPEG
  ? 'denoise graph through the shipped ffmpeg'
  : `denoise graph through the shipped ffmpeg — SKIPPED: none at resources/ffmpeg/${FFMPEG_DIR[platform()] ?? platform()}/ (fetch it with scripts/fetch-ffmpeg.mjs)`

describe.skipIf(FFMPEG === null)(TITLE, () => {
  it('one stage, region on the sample lattice', () => {
    // 0.02–0.06 s: both bounds are whole samples at 48 kHz.
    const chain = [entry({ profile_in_us: 20_000, profile_out_us: 60_000, strength: 12, margin: 8 })]
    runGraph(FFMPEG as string, buildFilterComplex(chain, ctxFor(chain, -34)), 'single denoise stage, aligned region')
  })

  // The regression case. One sample is 20.8333 µs and the region gesture stores
  // raw µs, so bounds off the lattice are the NORMAL case, not the edge one:
  // with second-valued trims ffmpeg rounded each bound on its own and the
  // output came back one sample (4 bytes) short of the input.
  it('one stage, region NOT on the sample lattice', () => {
    const chain = [entry({ profile_in_us: 20_007, profile_out_us: 60_011, strength: 12, margin: 8 })]
    runGraph(FFMPEG as string, buildFilterComplex(chain, ctxFor(chain, -34)), 'single denoise stage, unaligned region')
  })

  it('two stages: label and filter-instance uniqueness proven by ffmpeg', () => {
    const chain = [
      entry({ profile_in_us: 20_007, profile_out_us: 60_011, strength: 12, margin: 8 }),
      entry({ profile_in_us: 0, profile_out_us: 20_003, strength: 24, margin: 4 }),
    ]
    runGraph(FFMPEG as string, buildFilterComplex(chain, ctxFor(chain, -34)), 'two denoise stages')
  })
})
