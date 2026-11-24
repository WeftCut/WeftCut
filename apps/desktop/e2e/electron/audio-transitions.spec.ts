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

async function previewAt(page: Page, timeUs: number): Promise<{ samples: number[]; sampleRate: number }> {
  return page.evaluate(async (target) => {
    const hook = (window as any).__weftcutTest
    hook.transportPause()
    hook.transportSeekUs(Math.max(0, target - 300_000))
    hook.transportPlay()
    const deadline = performance.now() + 60_000
    while (performance.now() < deadline) {
      const state = hook.audioTransportSnapshot()
      if (state?.phase === 'error') throw new Error('preview playback failed')
      if (state?.phase === 'playing' && state.positionUs >= target) {
        const sample = hook.audioPreCompressorSamples()
        if (sample) return sample
      }
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    throw new Error(`preview did not reach ${target}`)
  }, timeUs)
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
    const state = await rootSummary(page) as { transitions: unknown[] }
    expect(state.transitions).toHaveLength(2)
    await expect.poll(async () => (await summary(page)).media.filter(m => media.includes(m.id) && m.conform_path).length, { timeout: 90_000 }).toBe(2)
    await waitForHook(page, 'audioPreCompressorSamples')
    await expect.poll(() => page.evaluate(() => (window as any).__weftcutTest.previewResourceProbe())).not.toBeNull()
    const before = await previewAt(page, 500_000)
    const mid = await previewAt(page, 1_500_000)
    const after = await previewAt(page, 2_500_000)
    const previewRatios = [amplitude(mid.samples, 400, mid.sampleRate) / amplitude(before.samples, 400, before.sampleRate),
      amplitude(mid.samples, 800, mid.sampleRate) / amplitude(after.samples, 800, after.sampleRate)]
    console.log('preview ratios', previewRatios)
    for (const ratio of previewRatios) {
      expect(ratio).toBeGreaterThan(0.60)
      expect(ratio).toBeLessThan(0.80)
    }
    await page.evaluate(() => (window as any).__weftcutTest.transportPause())
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
    const retimeBefore = await previewAt(page, 250_000)
    const retimeMid = await previewAt(page, 750_000)
    const retimeAfter = await previewAt(page, 1_250_000)
    const retimedPreviewRatios = [amplitude(retimeMid.samples, 400, retimeMid.sampleRate) / amplitude(retimeBefore.samples, 400, retimeBefore.sampleRate),
      amplitude(retimeMid.samples, 800, retimeMid.sampleRate) / amplitude(retimeAfter.samples, 800, retimeAfter.sampleRate)]
    console.log('retimed preview ratios', retimedPreviewRatios)
    for (const ratio of retimedPreviewRatios) {
      expect(ratio).toBeGreaterThan(0.55)
      expect(ratio).toBeLessThan(0.85)
    }
    await page.evaluate(() => (window as any).__weftcutTest.transportPause())
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
