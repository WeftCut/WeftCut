import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { driveExport, invokeCmd, launchApp, newProject, rootSummary, summary, tmpDir, waitForHook } from './helpers/driver'

function amplitude(samples: readonly number[], hz: number, rate: number): number {
  let re = 0, im = 0, weight = 0
  for (let i = 0; i < samples.length; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1))
    const phase = 2 * Math.PI * hz * i / rate
    re += samples[i]! * w * Math.cos(phase)
    im += samples[i]! * w * Math.sin(phase)
    weight += w
  }
  return 2 * Math.hypot(re, im) / weight
}

/// A capture of the pre-compressor mix, with the transport position read with it.
interface Capture { positionUs: number; samples: number[]; sampleRate: number }

/// Plays from `fromUs` to the composition's end and captures the mix on every
/// animation frame. The run ends when the preview pauses itself at the end, a
/// state that holds once reached; a position past a bound near the end shows
/// only in the few frames before that pause, which a stalled poll can miss.
async function capturePlayback(page: Page, fromUs: number): Promise<Capture[]> {
  return page.evaluate(async (from) => {
    const hook = (window as any).__weftcutTest
    hook.transportPause()
    hook.transportSeekUs(from)
    // The transport is the engine itself: play leaves it 'preparing' before it
    // returns, so the 'paused' below is the stop at the end, not this pause.
    hook.transportPlay()
    const captures: { positionUs: number; samples: number[]; sampleRate: number }[] = []
    const deadline = performance.now() + 60_000
    for (;;) {
      const state = hook.audioTransportSnapshot()
      if (state?.phase === 'error') throw new Error('preview playback failed')
      if (state?.phase === 'paused') return captures
      if (performance.now() > deadline) throw new Error(`preview never finished playing: ${state?.phase} at ${state?.positionUs}`)
      if (state?.phase === 'playing') {
        const capture = hook.audioPreCompressorSamples()
        if (capture) captures.push(capture)
      }
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  }, fromUs)
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

// The captured samples are the mix being rendered, which runs ahead of the
// heard position the transport reports by the device's output latency, plus
// up to a frame of the position's snapping and of the poll: a capture's
// position places it only roughly in the fade. Equal power holds everywhere in
// the fade, so it is checked in the fade's middle, where a linear fade would
// fall to 0.68 or lower and a fade that went missing rises toward 2.
const MIDDLE = 0.2
// Out² + in² of one capture: the gain changes across the 43 ms analyser
// window, and the AAC tones carry a little leakage.
const POWER_TOLERANCE = 0.15
// A tone's level away from the fade, which the rough position cannot blur.
const CLEAR_US = 150_000
// A stalled runner can leave a stretch without captures; the play is repeated.
const PLAYS = 3

/// Every capture in the middle of the fade `[startUs, startUs + durationUs]`
/// keeps the power of either tone alone: out² + in² = 1. Each tone's level is
/// read where it plays alone, from `fromUs` and until `toUs`.
async function expectEqualPowerPreview(page: Page, fromUs: number, startUs: number, durationUs: number, toUs: number) {
  const endUs = startUs + durationUs
  const level = (c: Capture, hz: number) => amplitude(c.samples, hz, c.sampleRate)
  for (let play = 1; ; play++) {
    const captures = await capturePlayback(page, fromUs)
    const outAlone = captures.filter(c => c.positionUs < startUs - CLEAR_US)
    // Bounded by `toUs`: the position holds on the last frame while the mix,
    // rendered ahead of it, runs past the clip's end into silence.
    const inAlone = captures.filter(c => c.positionUs > endUs + CLEAR_US && c.positionUs <= toUs)
    const middle = captures.filter(c => c.positionUs >= startUs + MIDDLE * durationUs && c.positionUs <= endUs - MIDDLE * durationUs)
    if (outAlone.length === 0 || inAlone.length === 0 || middle.length === 0) {
      expect(play, `captures before (${outAlone.length}), inside (${middle.length}) and after (${inAlone.length}) the fade`).toBeLessThan(PLAYS)
      continue
    }
    const outRef = median(outAlone.map(c => level(c, 400)))
    const inRef = median(inAlone.map(c => level(c, 800)))
    const powers = middle.map(c => (level(c, 400) / outRef) ** 2 + (level(c, 800) / inRef) ** 2)
    console.log('preview fade powers', powers.map(p => +p.toFixed(3)))
    for (const power of powers) expect(Math.abs(power - 1), `out² + in² = ${power}`).toBeLessThan(POWER_TOLERANCE)
    return
  }
}

function decode(file: string): number[] {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 4_000_000 })
  return Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4))
}

function windowAt(pcm: readonly number[], time: number): number[] {
  const center = Math.round(time * 48_000)
  return pcm.slice(center - 2_400, center + 2_400)
}

test('linked crossfade is equal-power in preview before compression and in export', async () => {
  test.setTimeout(300_000)
  const dir = tmpDir('weftcut-e2e-audio-transitions-')
  const sources = [400, 800].map((hz, i) => {
    const out = path.join(dir, `tone-${hz}.mp4`)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${i ? 'blue' : 'red'}:s=160x90:r=30:d=2`,
      '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-shortest', out])
    return out
  })
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dir, name: 'Audio transitions', canvas: { width: 160, height: 90, fpsNum: 30, fpsDen: 1 } })
    const initial = await rootSummary(page) as { tracks: Array<{ id: string }> }
    const trackId = initial.tracks[0]!.id
    const media = [await invokeCmd<string>(page, 'import_media', { path: sources[0] }),
      await invokeCmd<string>(page, 'import_media', { path: sources[1] })]
    const from = await invokeCmd<string>(page, 'add_media_layer', { trackId, mediaId: media[0], tStartUs: 0 })
    const to = await invokeCmd<string>(page, 'add_media_layer', { trackId, mediaId: media[1], tStartUs: 2_000_000 })
    await invokeCmd(page, 'add_transition', { fromLayerId: from, toLayerId: to, durationUs: 1_000_000, audio: 'linked' })
    const state = await rootSummary(page) as { transitions: Array<{ id: string; from_layer: string }>; tracks: Array<{ layers: Array<{ id: string; kind: string }> }> }
    expect(state.transitions).toHaveLength(2)
    const audioIds = new Set(state.tracks.flatMap(track => track.layers.filter(layer => layer.kind === 'Audio').map(layer => layer.id)))
    const audioTransition = state.transitions.find(transition => audioIds.has(transition.from_layer))!
    const visualTransition = state.transitions.find(transition => !audioIds.has(transition.from_layer))!
    await expect(page.locator(`[data-testid="transition-chip"][data-transition-id="${visualTransition.id}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="transition-chip"][data-transition-id="${audioTransition.id}"]`)).toHaveCount(0)
    await expect.poll(async () => (await summary(page)).media.filter(m => media.includes(m.id) && m.conform_path).length, { timeout: 90_000 }).toBe(2)
    await waitForHook(page, 'audioPreCompressorSamples')
    await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.previewResourceProbe())).not.toBeNull()
    await expectEqualPowerPreview(page, 200_000, 1_000_000, 1_000_000, 2_800_000)
    const output = path.join(dir, 'Audio transitions', 'crossfade.m4a')
    const exportResult = await driveExport(page, { outputAbsPath: output, settings: { includeVideo: false, includeAudio: true } }, { hook: 'exportTimeline' })
    expect(exportResult.done.ok, exportResult.done.error).toBe(true)
    const pcm = decode(output)
    const exportRatios = [amplitude(windowAt(pcm, 1.5), 400, 48_000) / amplitude(windowAt(pcm, 0.5), 400, 48_000),
      amplitude(windowAt(pcm, 1.5), 800, 48_000) / amplitude(windowAt(pcm, 2.5), 800, 48_000)]
    console.log('export ratios', exportRatios)
    for (const ratio of exportRatios) {
      expect(ratio).toBeGreaterThan(0.60)
      expect(ratio).toBeLessThan(0.80)
    }

    const layerIds = (await summary(page)).tracks.flatMap(track => track.layers.map(layer => layer.id))
    const group = await invokeCmd<{ layer_id: string }>(page, 'groups_create', { layerIds })
    await invokeCmd(page, 'retime_layers', { layerIds: [group.layer_id], target: { kind: 'Rate', value: { num: 2, den: 1 } } })
    await expectEqualPowerPreview(page, 50_000, 500_000, 500_000, 1_450_000)
    const retimed = path.join(dir, 'Audio transitions', 'retimed.m4a')
    const retimeExport = await driveExport(page, { outputAbsPath: retimed, settings: { includeVideo: false, includeAudio: true } }, { hook: 'exportTimeline' })
    expect(retimeExport.done.ok, retimeExport.done.error).toBe(true)
    const retimedPcm = decode(retimed)
    const retimedRatios = [amplitude(windowAt(retimedPcm, 0.75), 400, 48_000) / amplitude(windowAt(retimedPcm, 0.25), 400, 48_000),
      amplitude(windowAt(retimedPcm, 0.75), 800, 48_000) / amplitude(windowAt(retimedPcm, 1.25), 800, 48_000)]
    console.log('retimed ratios', retimedRatios)
    for (const ratio of retimedRatios) {
      expect(ratio).toBeGreaterThan(0.55)
      expect(ratio).toBeLessThan(0.85)
    }
  } finally {
    await app.close()
  }
})
