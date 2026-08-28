import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, waitForHook, driveExport, importAndPlaceMedia, invokeCmd, summary, tmpDir, exportSsimFloor } from './helpers/driver'

// Runtime smoke for the export-range + audio-settings feature, end-to-end
// through the real renderer + real ffmpeg mux. Reuses the per-second
// tone-marker audio fixture (F_k = 400 + 120k Hz at output second k) so the
// Goertzel can read which source-second each output-second carries — the key
// to proving the audio trim. Local-only (needs `npm run fixtures` + cargo).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const fixture = (name: string) => path.resolve(MEDIA_DIR, name)

// The 30fps tone-marker fixture (shared with audio.spec.ts). Output fps follows
// the 30fps composition, so source second k -> tone F_k = 400 + 120k.
const SOURCE = fixture('test_1080p_30fps_audio.mp4')
// Burned-in-counter video fixture (no audio) — for the software-encode case
// (video frame-alignment + SSIM; hwAccel only affects the video encoder).
// The 6s short fixture: one sample per 2s GOP still crosses every GOP.
const VIDEO_SOURCE = fixture('test_1080p_30fps_6s.mp4')

const toneHz = (second: number) => 400 + 120 * second

/// Poll `pred` until true or `timeoutMs` elapses; throw `msg` on timeout.
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, msg: string) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${msg}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/// Decode a file's audio to mono s16le PCM as a Float32Array in [-1, 1].
/// `media_conformance --audio` can't read a range export (its candidate tones
/// are `400 + 120*outputSecondIndex`, so In-shifted tones fall outside) — a
/// direct Goertzel against the true shifted tones is the right tool.
function extractPcm(file: string, sr = 48000): Float32Array {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(`ffmpeg PCM extract failed (${r.status}): ${r.stderr ?? ''}`)
  }
  const n = r.stdout.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = r.stdout.readInt16LE(i * 2) / 32768
  return out
}

/// Goertzel power at `freq` over `samples`.
function goertzelPower(samples: Float32Array, freq: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]! + coeff * s1 - s2
    s2 = s1
    s1 = s
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/// Dominant candidate tone over an arbitrary `[startS, endS)` window. Needed when
/// the layer's start is NOT on a whole second — a sub-frame audio slip puts every
/// source-second boundary at a fractional output time, so no integer-second window
/// sits inside one tone.
function dominantToneIn(
  pcm: Float32Array,
  startS: number,
  endS: number,
  candidates: number[],
  sr = 48000,
): number {
  const seg = pcm.subarray(Math.round(startS * sr), Math.round(endS * sr))
  let bestF = candidates[0]!
  let bestP = -Infinity
  for (const f of candidates) {
    const p = goertzelPower(seg, f, sr)
    if (p > bestP) {
      bestP = p
      bestF = f
    }
  }
  return bestF
}

/// Dominant candidate tone in the 1-second window at `second`.
function dominantTone(pcm: Float32Array, second: number, candidates: number[], sr = 48000): number {
  const seg = pcm.subarray(second * sr, (second + 1) * sr)
  let bestF = candidates[0]!
  let bestP = -Infinity
  for (const f of candidates) {
    const p = goertzelPower(seg, f, sr)
    if (p > bestP) {
      bestP = p
      bestF = f
    }
  }
  return bestF
}

/// ffprobe a file's video keyframe timestamps (seconds, sorted). Returns null
/// when ffprobe isn't on PATH (soft-skip).
function keyframeTimestamps(file: string): number[] | null {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (r.error) return null // ffprobe not found
  if (r.status !== 0) throw new Error(`ffprobe keyframes failed: ${r.stderr ?? ''}`)
  return r.stdout
    .trim()
    // ffprobe 8.x terminates each csv row with a trailing comma ("0.000000,");
    // 7.1 does not. Split on commas too so both sidecar generations parse.
    .split(/[\s,]+/)
    .map(Number)
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)
}

/// ffprobe a file for audio streams. Returns true/false, or null when ffprobe
/// isn't on PATH (caller soft-skips).
function hasAudioStream(file: string): boolean | null {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
  if (r.error) return null // ffprobe not found
  return r.stdout.trim().length > 0
}

test.describe('export range + audio settings (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    test.skip(!existsSync(SOURCE), `tone source not found at ${SOURCE} (run \`npm run fixtures\`)`)
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  /// Boot a fresh 30fps project under its own throwaway parent dir
  /// (`<tmpDir>/<namePrefix><now>/`) and wait for the editor hooks to mount.
  /// Returns the project directory.
  async function bootProject(namePrefix: string): Promise<string> {
    const name = namePrefix + Date.now()
    const parent = tmpDir('weftcut-e2e-range-audio-proj-')
    await newProject(page, {
      parentFolder: parent,
      name,
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    await waitForHook(page, 'exportClip')
    return path.join(parent, name)
  }

  /// Boot a fresh project, drive exportClip, and return `{ perf }` — the
  /// worker's `window.__weftcutExportPerf` (E2E-only), carrying `totalFrames`.
  async function bootAndExport(opts: {
    output: string
    settings?: Record<string, unknown>
    range?: { startUs: number; endUs: number }
    source?: string
  }): Promise<{ perf: { totalFrames: number } | null }> {
    await bootProject('e2e-range-audio-')
    const args: Record<string, unknown> = {
      mediaAbsPath: opts.source ?? SOURCE,
      outputAbsPath: opts.output,
    }
    if (opts.settings) args.settings = opts.settings
    if (opts.range) args.range = opts.range
    const r = await driveExport(page, args)
    if (!r.done.ok) {
      throw new Error(`export failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`)
    }
    const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as {
      totalFrames: number
    } | null
    return { perf }
  }

  test('sub-range export trims both video frame count and audio to the window', async () => {
    test.setTimeout(240000)
    // Window [1s, 3s): 2 s at 30fps = 60 output frames. Audio output-second 0
    // should carry the source's 1 s tone (520 Hz), second 1 the 2 s tone
    // (640 Hz) — proving the audio was trimmed to the In point and rebased to 0.
    const output = path.join(tmpDir('weftcut-e2e-range-'), 'range.mp4')

    const { perf } = await bootAndExport({ output, range: { startUs: 1_000_000, endUs: 3_000_000 } })

    expect(perf).not.toBeNull()
    expect(perf!.totalFrames).toBe(60)

    const pcm = extractPcm(output)
    const cands = [toneHz(0), toneHz(1), toneHz(2), toneHz(3)] // 400/520/640/760
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(1)) // source 1 s -> 520 Hz
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(2)) // source 2 s -> 640 Hz
  })

  // ── Sub-frame audio: the slipped-sync case (spec R2-D6 / ADR 0038) ──────────
  // An audio layer authored to a 48 kHz sample boundary that is deliberately HALF A
  // FRAME off the composition frame grid, driven through the real renderer → actor
  // IPC and the real persistence round trip. Both data-loss dependencies live here at
  // integration level: a kind-blind link fan-out would re-sync the slip on the link
  // move, and a kind-blind load repair would erase it on reopen.
  //
  // Deliberately NOT asserted: the exported PCM's sub-frame start offset. AAC encoder
  // delay/priming is 1024–2048 samples (21–43 ms) and is not removed by a
  // decode-to-PCM, so it swamps the ≤16.7 ms sub-frame signal being measured — an
  // assertion on it would be flaky rather than wrong-detecting. What is asserted is
  // that the sub-frame geometry survives every seam AND that the export still produces
  // faithful audio from it (the mixer places at `us_to_frame(t_start_us, 48000)`, so a
  // sub-frame start must not break the mux). Sample-exact placement is proven in
  // `main/state/__tests__/audio-grid.test.ts` against the same leaf math the mixer uses.
  test('a sub-frame audio slip survives the link move, save/reopen, and export', async () => {
    test.setTimeout(300000)
    const projectDir = await bootProject('e2e-audio-slip-')
    const { layerId: videoLayer } = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE })

    // `add_media_layer` auto-pairs an AV source: video + Audio layer on the same
    // track, linked. Find the audio half.
    const s0 = await summary(page)
    const audioLayer = s0.tracks
      .flatMap((t) => t.layers)
      .find((l) => l.params.kind === 'Audio')?.id
    expect(audioLayer, 'the AV source should have auto-paired an Audio layer').toBeTruthy()

    // 350_000 µs is exactly sample 16800 and exactly frame 10.5 — on the audio
    // lattice, half a frame off the composition grid, so it is only expressible
    // because audio no longer shares the video grid.
    // NOTE: this is the production `command` channel, whose wire args are camelCase
    // (`commands.ts`), not the snake_case MCP dispatch names.
    const SLIP_US = 350_000
    await invokeCmd(page, 'move_layer', {
      layerId: audioLayer,
      newTrackId: s0.tracks.find((t) => t.layers.some((l) => l.id === audioLayer))!.id,
      newTStartUs: SLIP_US,
      escapeLink: true,
    })
    const startOf = async (id: string | undefined) =>
      ((await summary(page)) as unknown as {
        tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }>
      }).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!.t_start_us

    expect(await startOf(audioLayer), 'the slip must be stored verbatim, not re-snapped to a frame').toBe(SLIP_US)
    const videoStart = await startOf(videoLayer)
    const offsetBefore = SLIP_US - videoStart

    // A whole-link move must shift both members by the same delta. A kind-blind
    // fan-out would drag the audio back onto the nearest video frame here.
    const MOVE_TO_US = 1_000_000 // frame 30 at 30 fps
    await invokeCmd(page, 'move_layer', {
      layerId: videoLayer,
      newTrackId: s0.tracks.find((t) => t.layers.some((l) => l.id === videoLayer))!.id,
      newTStartUs: MOVE_TO_US,
      escapeLink: false,
    })
    const movedOffset = (await startOf(audioLayer)) - (await startOf(videoLayer))
    expect(movedOffset, 'a whole-link move must preserve the slip exactly').toBe(offsetBefore)
    const slippedAfterMove = await startOf(audioLayer)

    // Save + reopen: the load repair must report nothing and move nothing.
    await invokeCmd(page, 'project_save')
    await invokeCmd(page, 'project_open', { path: projectDir })
    await waitForHook(page, 'exportTimeline')
    expect(await startOf(audioLayer), 'reopening must not repair a sample-aligned audio layer').toBe(slippedAfterMove)

    // …and the export still runs and stays audio-faithful from that geometry.
    const output = path.join(tmpDir('weftcut-e2e-audio-slip-'), 'slip.mp4')
    const r = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline' })
    if (!r.done.ok) throw new Error(`export failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`)
    const pcm = extractPcm(output)
    const cands = [toneHz(0), toneHz(1), toneHz(2), toneHz(3)]
    // The audio layer now starts at 1.35 s (1 s link position + the 350 ms slip), so
    // source second k occupies output [1.35 + k, 2.35 + k). Windows are inset 50 ms
    // from each boundary so the assertion reads ONE tone rather than a blend.
    const audioStartS = (MOVE_TO_US + SLIP_US) / 1_000_000
    expect(dominantToneIn(pcm, audioStartS + 0.05, audioStartS + 0.95, cands)).toBe(toneHz(0))
    expect(dominantToneIn(pcm, audioStartS + 1.05, audioStartS + 1.95, cands)).toBe(toneHz(1))
  })

  // ── Audio through a Group (ADR 0052) ────────────────────────────────────────
  // The slipped pair above, pre-composed. A Group is a composition placed as one
  // layer, and the mix is rendered by the Rust mixer walking the project
  // (`audio/mix.rs`) — so a Group is a second place that walk can stop, and the
  // two ways it fails are silence (never reached the layer) and a shift (reached
  // it without the ref's time offset). Both exports here are AUDIO-ONLY, which
  // is not a shortcut: the full export's audio stage IS this call
  // (`useExportFlow` runs the same Rust audio-only export and stream-copies the
  // result into the container), so the path under test is the shipping one, minus
  // an encode that has nothing to do with the mix.
  //
  // The slip rides along because it is the most fragile geometry available: a
  // sub-frame start survives pre-compose only if the member's own 48 kHz lattice
  // is what it is re-based on. Like the test above, the sub-frame OFFSET itself
  // is not asserted — AAC priming is 1024-2048 samples and swamps a <= 16.7 ms
  // signal. What is asserted instead is stronger than an envelope: the two
  // exports' decoded PCM is compared sample for sample as a signal-to-residual
  // ratio, CALIBRATED against a deliberately misplaced control (the same file
  // against itself, offset by one AAC frame — which scores about -3 dB, i.e.
  // worse than silence).
  //
  // Measured runs come out sample-IDENTICAL (infinite ratio). The assertion is
  // still a floor, for two reasons: there is no lossless audio target to export
  // to — the codec set is AAC and Opus (`exportSettings.ts`) — so both legs are
  // lossy encodes, and two independent encodes are only bit-identical while the
  // encoder is deterministic, which is a property of a build rather than a
  // contract. A floor forty-odd dB clear of the control is the strongest claim
  // that stays true if that ever stops holding.
  const AUDIO_ONLY = { includeVideo: false, includeAudio: true }

  /// Signal-to-residual ratio in dB between two decodes, `b` read `shift`
  /// samples late. Infinite when the two are bit-identical.
  const residualSnrDb = (a: Float32Array, b: Float32Array, shift = 0): number => {
    const n = Math.min(a.length, b.length - shift)
    let signal = 0
    let error = 0
    for (let i = 0; i < n; i++) {
      const x = a[i]!
      const d = x - b[i + shift]!
      signal += x * x
      error += d * d
    }
    return error === 0 ? Infinity : 10 * Math.log10(signal / error)
  }

  const peakOf = (pcm: Float32Array): number => {
    let peak = 0
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!))
    return peak
  }

  test('pre-composing a slipped A/V pair exports the same audio', async () => {
    test.setTimeout(300000)
    // 350_000 µs is exactly sample 16800 and exactly frame 10.5 — the sub-frame
    // geometry of the test above, minus the link move it already covers.
    const SLIP_US = 350_000
    const outDir = tmpDir('weftcut-e2e-group-audio-')
    const flatOut = path.join(outDir, 'flat.m4a')
    const groupedOut = path.join(outDir, 'grouped.m4a')

    await bootProject('e2e-group-audio-')
    const { layerId: videoLayer } = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE })
    const s0 = await summary(page)
    const audioLayer = s0.tracks
      .flatMap((t) => t.layers)
      .find((l) => l.params.kind === 'Audio')?.id
    expect(audioLayer, 'the AV source should have auto-paired an Audio layer').toBeTruthy()
    await invokeCmd(page, 'move_layer', {
      layerId: audioLayer,
      newTrackId: s0.tracks.find((t) => t.layers.some((l) => l.id === audioLayer))!.id,
      newTStartUs: SLIP_US,
      escapeLink: true,
    })

    const flat = await driveExport(
      page,
      { outputAbsPath: flatOut, settings: AUDIO_ONLY },
      { hook: 'exportTimeline' },
    )
    if (!flat.done.ok) throw new Error(`un-grouped audio export failed: ${flat.done.error}`)

    // Pre-compose the pair. The earliest start is the video's 0, so nothing
    // re-bases and the audio keeps its 350 ms start INSIDE the composition; the
    // Group layer is windowed over the whole thing from 0, so the mix has to come
    // out where it did before.
    const group = await invokeCmd<{ composition_id: string; layer_id: string }>(
      page,
      'groups_create',
      { layerIds: [videoLayer, audioLayer] },
    )
    const wire = await invokeCmd<{
      root_id: string
      compositions: Record<string, {
        duration_us: number
        tracks: Array<{ layers: Array<{ id: string; t_start_us: number; params: { kind: string; src_in_us?: number } }> }>
      }>
    }>(page, 'project_summary', {})
    const layersIn = (id: string) => wire.compositions[id]!.tracks.flatMap((t) => t.layers)
    expect(Object.keys(wire.compositions)).toHaveLength(2)
    expect(layersIn(wire.root_id).map((l) => l.params.kind)).toEqual(['CompositionRef'])
    expect(layersIn(wire.root_id)[0]!.t_start_us).toBe(0)
    expect(layersIn(wire.root_id)[0]!.params.src_in_us).toBe(0)
    const inside = layersIn(group.composition_id).find((l) => l.id === audioLayer)
    expect(inside?.t_start_us, 'pre-compose must re-base the audio on its OWN lattice').toBe(SLIP_US)

    const grouped = await driveExport(
      page,
      { outputAbsPath: groupedOut, settings: AUDIO_ONLY },
      { hook: 'exportTimeline' },
    )
    if (!grouped.done.ok) throw new Error(`grouped audio export failed: ${grouped.done.error}`)
    expect(existsSync(flatOut) && existsSync(groupedOut)).toBe(true)

    const flatPcm = extractPcm(flatOut)
    const groupedPcm = extractPcm(groupedOut)
    const cands = [toneHz(0), toneHz(1), toneHz(2), toneHz(3), toneHz(4)]
    // The audio starts at 0.35 s in both legs, so source second k occupies
    // output [0.35 + k, 1.35 + k); windows are inset 50 ms from each boundary so
    // each reads ONE tone rather than a blend (the helper's contract above).
    const audioStartS = SLIP_US / 1_000_000
    for (let k = 0; k < 4; k++) {
      expect(
        dominantToneIn(groupedPcm, audioStartS + k + 0.05, audioStartS + k + 0.95, cands),
        `output second ${k} of the GROUPED export must carry source second ${k}`,
      ).toBe(toneHz(k))
      expect(dominantToneIn(flatPcm, audioStartS + k + 0.05, audioStartS + k + 0.95, cands)).toBe(
        toneHz(k),
      )
    }

    // One AAC frame late is the smallest misplacement a broken offset could
    // produce, so its score is the bar the real comparison has to clear by a
    // wide margin — which is what makes the floor below a measurement rather
    // than a guess.
    const snr = residualSnrDb(flatPcm, groupedPcm)
    const control = residualSnrDb(flatPcm, flatPcm, 1024)
    console.log(
      `[e2e] group audio residual: snr=${snr.toFixed(1)} dB, one-AAC-frame control=${control.toFixed(1)} dB, ` +
        `len ${flatPcm.length} vs ${groupedPcm.length}, peak ${peakOf(flatPcm).toFixed(4)} vs ${peakOf(groupedPcm).toFixed(4)}`,
    )
    expect(
      Math.abs(flatPcm.length - groupedPcm.length) / 48000,
      'the two exports must be the same length',
    ).toBeLessThan(0.05)
    expect(Math.abs(peakOf(groupedPcm) - peakOf(flatPcm))).toBeLessThan(0.01)
    expect(
      snr,
      `the audio inside the Group is not the audio outside it (residual ${snr.toFixed(1)} dB; ` +
        `one AAC frame of misplacement scores ${control.toFixed(1)} dB). The mixer walks the ` +
        `project itself — check that it recurses through CompositionRef layers with the ref's offset.`,
    ).toBeGreaterThan(40)
    expect(snr - control, 'the residual must clear a one-frame misplacement by a wide margin').toBeGreaterThan(20)
  })

  test('Opus-in-MKV export is produced and stays audio-faithful', async () => {
    test.setTimeout(240000)
    // Whole-clip export to MKV with Opus: exercises libopus encode -> .mka ->
    // stream-copy into .mkv end to end.
    const output = path.join(tmpDir('weftcut-e2e-opus-'), 'opus.mkv')

    await bootAndExport({ output, settings: { container: 'mkv', audio: { codec: 'opus' } } })

    const report = analyze({ output, source: SOURCE, samples: [0], audio: true })
    console.log('[e2e] opus audio report:', JSON.stringify(report))
    expect(report.samples.filter((s: any) => !s.aligned)).toHaveLength(0)
    expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66)
    expect(report.pass).toBe(true)
  })

  test('mute export produces a video file with no audio track', async () => {
    test.setTimeout(240000)
    const output = path.join(tmpDir('weftcut-e2e-mute-'), 'mute.mp4')

    await bootAndExport({ output, settings: { audio: { include: false } } })

    const audio = hasAudioStream(output)
    test.skip(audio === null, 'ffprobe not on PATH — skipping the no-audio-track assertion')
    expect(audio).toBe(false)
  })

  test('keyframe interval setting controls the GOP cadence', async () => {
    test.setTimeout(240000)
    // Whole-clip export with a 2 s keyframe interval. The export sink forces a
    // keyframe every round(fps×2) frames (gopFrames), so ffprobe should see
    // keyframes ~2 s apart — clearly not the 1 s default.
    const output = path.join(tmpDir('weftcut-e2e-gop-'), 'gop.mp4')

    await bootAndExport({ output, settings: { keyframeIntervalSec: 2 } })

    const kf = keyframeTimestamps(output)
    test.skip(kf === null, 'ffprobe not on PATH — skipping the keyframe-spacing assertion')
    console.log('[e2e] keyframe timestamps (s):', JSON.stringify(kf))
    expect(kf!.length).toBeGreaterThanOrEqual(3)
    const gaps = kf!.slice(1).map((t, i) => t - kf![i]!).sort((a, b) => a - b)
    const medianGap = gaps[Math.floor(gaps.length / 2)]!
    expect(medianGap).toBeGreaterThan(1.5)
    expect(medianGap).toBeLessThan(2.5)
  })

  test('range export re-conforms only in-range audio after cache invalidation', async () => {
    test.setTimeout(300000)
    // Two distinct audio-only sources: A in the export range, B outside it.
    // Deleting both VCONF files while the store still carries conform_path
    // reproduces the stale-cache shape. The export's audio gate must detect A's
    // invalid cache, re-conform it, and hold the export until it lands; it must
    // NOT touch B — the Rust mix plan window-skips layers the export never reads.
    const WAV = fixture('test_tones_10s.wav')
    const MP3 = fixture('test_tones_10s.mp3')
    test.skip(!existsSync(WAV) || !existsSync(MP3), `tone fixtures not found under ${MEDIA_DIR}`)
    const output = path.join(tmpDir('weftcut-e2e-range-conform-'), 'range-conform.m4a')

    const projDir = await bootProject('e2e-range-conform-')
    // Documented cache layout (docs/audio.md): Cache/audio/{hash}.conform.
    const audioCacheDir = path.join(projDir, 'Cache', 'audio')
    const conformsIn = () =>
      existsSync(audioCacheDir)
        ? readdirSync(audioCacheDir).filter((f) => f.endsWith('.conform'))
        : []

    const place = async (mediaAbsPath: string, tStartUs: number) => {
      const r = await importAndPlaceMedia(page, { mediaAbsPath, tStartUs })
      expect(r.kind).toBe('Audio')
      return r.mediaId
    }
    await place(WAV, 0)
    await place(MP3, 12_000_000)

    // Both import-time conform jobs land (pending or final names — either counts).
    await waitFor(() => conformsIn().length === 2, 60000, 'import-time conform never landed for both')

    // Invalidate BOTH caches on disk; the store still says "conformed". Retried:
    // a preview Range read can hold a file open for a moment.
    for (const f of conformsIn()) {
      const file = path.join(audioCacheDir, f)
      for (let i = 0; ; i++) {
        try {
          rmSync(file, { force: true })
          break
        } catch (e) {
          if (i >= 20) throw e
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    }
    expect(conformsIn()).toHaveLength(0)

    // Audio-only range export [0, 2s) — covers only the WAV.
    const r = await driveExport(
      page,
      {
        outputAbsPath: output,
        range: { startUs: 0, endUs: 2_000_000 },
        settings: { includeVideo: false, includeAudio: true },
      },
      { hook: 'exportTimeline' },
    )
    if (!r.done.ok) throw new Error(`range-conform export failed: ${r.done.error}`)
    console.log(
      `[e2e] export kind=${r.lastKind}; conform files after export: ${JSON.stringify(conformsIn())}`,
    )

    // Exactly ONE conform regenerated: the gate re-conformed the in-range media
    // and never touched the out-of-range one.
    expect(conformsIn()).toHaveLength(1)

    // And the audio really rendered from the regenerated conform — the WAV's
    // per-second tone markers survive into the output.
    const pcm = extractPcm(output)
    const cands = [toneHz(0), toneHz(1), toneHz(2)]
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(0))
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(1))
  })

  test('software encoder export stays frame-aligned with low loss', async () => {
    test.setTimeout(240000)
    // hwAccel:"software" forces the native sink's software H.264 encode (these
    // settings leave encoderEngine on "auto", which resolves native). Assert it
    // works in the real renderer and stays frame-aligned + faithful (SSIM).
    test.skip(!existsSync(VIDEO_SOURCE), `video source not found at ${VIDEO_SOURCE}`)
    const output = path.join(tmpDir('weftcut-e2e-sw-'), 'sw.mp4')

    await bootAndExport({ output, source: VIDEO_SOURCE, settings: { hwAccel: 'software' } })

    const SSIM_FLOOR = exportSsimFloor()
    const report = analyze({ output, source: VIDEO_SOURCE, samples: [30, 90, 150], ssimMin: SSIM_FLOOR })
    console.log('[e2e] software-encode report:', JSON.stringify(report))
    expect(report.samples.filter((s: any) => !s.aligned)).toHaveLength(0)
    expect(report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)).toHaveLength(0)
    expect(report.pass).toBe(true)
  })
})
