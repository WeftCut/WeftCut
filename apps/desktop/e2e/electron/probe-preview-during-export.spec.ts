// PROBE (never merge): drives the preview while an export encodes, with the
// preview resumed right after admission (`__probeResumeAfterAdmission`), and
// compares each output with a suspended-preview baseline. Writes a JSON report.
import { test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir } from './helpers/driver'
import { installResourceDiagnostics } from './helpers/resourceDiagnostics'

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
import { mergeSettings } from '../../src/shared/exportSettings'
import { exportTerminal, type ExportJob } from '../../src/shared/exportJob'

const ffmpegPlatform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux']
const ffmpeg = process.env.FFMPEG ?? fileURLToPath(new URL(`../../resources/ffmpeg/${ffmpegPlatform}/ffmpeg${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
const SECONDS = Number(process.env.PROBE_SECONDS ?? 15)
const MODES = (process.env.PROBE_MODES ?? 'base,seek,play,remount,base2').split(',')
const WITH_MOTIF = process.env.PROBE_MOTIF !== '0'
const HW_ENCODE = process.env.PROBE_HW_ENCODE === '1'
const OUT = process.env.PROBE_OUT ?? tmpDir('probe-report-')

function media(): { a4k: string; b1080: string } {
  const dir = process.env.PROBE_MEDIA_DIR ?? tmpDir('probe-media-')
  fs.mkdirSync(dir, { recursive: true })
  const make = (name: string, size: string, src: string) => {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `${src}=size=${size}:rate=30`, '-t', String(SECONDS),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', file], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`fixture ${name}: ${r.stderr}`)
    return file
  }
  return { a4k: make(`a4k_${SECONDS}s.mp4`, '3840x2160', 'testsrc2'), b1080: make(`b1080_${SECONDS}s.mp4`, '1920x1080', 'mandelbrot') }
}

function frameMd5(file: string): string[] {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`framemd5 ${file}: ${r.stderr}`)
  return r.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop()!.trim())
}

function psnr(file: string, ref: string): { min: number; below40: number; frames: number } {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-i', ref, '-lavfi', 'psnr=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const vals = r.stdout.split('\n').map(l => /psnr_avg:(\S+)/.exec(l)?.[1]).filter(Boolean).map(v => v === 'inf' ? Infinity : Number(v))
  return { min: Math.min(...vals), below40: vals.filter(v => v < 40).length, frames: vals.length }
}

type Sample = Record<string, unknown>

test('probe: preview driven during export', async () => {
  test.setTimeout(60 * 60_000)
  fs.mkdirSync(OUT, { recursive: true })
  const { a4k, b1080 } = media()
  const { app, page } = await launchApp()
  await installResourceDiagnostics(app, page)
  if (process.env.PROBE_MEMORY_MIB) await invokeCmd(page, 'app_settings_set', { patch: { resource_policy: { memory_mib: Number(process.env.PROBE_MEMORY_MIB) } } })
  const ledger = () => app.evaluate((_e, addon) => {
    const native = process.getBuiltinModule('module').createRequire(addon)(addon)
    return JSON.parse(native.resourcesSnapshot())
  }, addon).catch(e => String(e))
  const consoleLines: string[] = []
  page.on('console', m => { const t = m.text(); if (/capacity|wedge|stall|superseded|error|fail/i.test(t)) consoleLines.push(`[${m.type()}] ${t.slice(0, 300)}`) })
  const report: Record<string, unknown> = { platform: process.platform, seconds: SECONDS, withMotif: WITH_MOTIF, hwEncode: HW_ENCODE, memoryMiB: process.env.PROBE_MEMORY_MIB ?? 'default', runs: {} }
  const outputs: Record<string, string> = {}
  const hook = <T>(fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => (window as any).__weftcutTest[fn](...args), { fn, args }) as Promise<T>
  try {
    for (const mode of MODES) {
      const t0 = Date.now()
      await newProject(page, { parentFolder: tmpDir(`probe-${mode}-`), name: `probe-${mode}`, canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
      const A = await importAndPlaceMedia(page, { mediaAbsPath: a4k })
      const B = await importAndPlaceMedia(page, { mediaAbsPath: b1080 })
      for (const m of [A, B]) await page.evaluate(id => (window as any).__weftcutTest.waitMediaExportReady({ mediaId: id }), m.mediaId)
      let motifLayer: string | null = null
      if (WITH_MOTIF) motifLayer = await hook<string>('addMotifLayer', { motifId: 'countdown', durationUs: SECONDS * 1_000_000, props: { seconds: SECONDS } })
      const setupMs = Date.now() - t0
      const resume = mode !== 'base' && mode !== 'base2'
      await app.evaluate(() => { const f = (globalThis as any).__e2eResourceFailures; if (f) f.length = 0 })
      await page.evaluate(r => { (globalThis as any).__probeResumeAfterAdmission = r; delete (globalThis as any).__probeResumedAt }, resume)

      const output = path.join(OUT, `${mode}.mp4`)
      fs.rmSync(output, { force: true })
      const settings = mergeSettings({ encoderEngine: 'native', hwAccel: HW_ENCODE ? 'auto' : 'software', includeAudio: false })
      const started = Date.now()
      const { job_id } = await invokeCmd<ExportJob>(page, 'export_job_start', { output_path: output, on_conflict: 'fail', settings })
      const status = () => invokeCmd<ExportJob>(page, 'export_job_status', { job_id })
      const samples: Sample[] = []
      const seeks: Sample[] = []
      let resumedAtMs: number | null = null
      let job = await status()
      let i = 0
      let remounted = 0
      while (!exportTerminal(job.state)) {
        if (resume && resumedAtMs === null && await page.evaluate(() => (globalThis as any).__probeResumedAt != null)) resumedAtMs = Date.now() - started
        if (resumedAtMs !== null) {
          if (mode === 'seek') {
            // Deterministic spread over the timeline, away from the end.
            const target = Math.round(((i * 7919) % (SECONDS * 30 - 15)) * 1_000_000 / 30)
            const s0 = Date.now()
            await hook('transportSeekUs', target)
            let bound = false
            let probe: any = null
            while (Date.now() - s0 < 4000) {
              probe = await hook<any>('activeClipProbe', A.layerId)
              if (probe && probe.ringFirstPtsUs != null && probe.ringFirstPtsUs <= target + 34_000 && (probe.ringLastPtsUs ?? -1) >= target - 34_000) { bound = true; break }
              await page.waitForTimeout(25)
            }
            seeks.push({ target, bound, ms: Date.now() - s0, kind: probe?.sourceKind, ring: probe?.ringSize, disposed: probe?.sourceDisposed })
            i++
          } else if (mode === 'play') {
            const rp = await hook<any>('previewResourceProbe')
            if (!rp?.playing) { if ((rp?.positionUs ?? 0) > (SECONDS - 1) * 1_000_000) await hook('transportSeekUs', 0); await hook('transportPlay') }
          } else if (mode === 'remount' && remounted < 3 && Date.now() - started > resumedAtMs + 1500 * (remounted + 1)) {
            await page.evaluate(() => { const d = (globalThis as any).__probeDock; d.closePanel('preview') })
            await page.waitForTimeout(300)
            await page.evaluate(() => { const d = (globalThis as any).__probeDock; d.openPanel('preview') })
            remounted++
            await page.waitForTimeout(500)
            await hook('transportSeekUs', 2_000_000 * remounted).catch(() => {})
          }
        }
        if (samples.length === 0 || Date.now() - (samples.at(-1)!.at as number) - started > 1000) {
          const perf = await hook<any>('compositorPerfSnapshot').catch(() => null)
          const rp = await hook<any>('previewResourceProbe').catch(() => null)
          const res = await ledger()
          samples.push({ at: Date.now() - started, state: job.state, progress: job.progress ?? null, playing: rp?.playing, positionUs: rp?.positionUs,
            presented: rp?.presentedCompositeCount, sync: perf?.sync, underrun: perf?.underrun, motifReader: perf?.motifReader, motifs: perf?.motifs,
            clips: perf?.clips?.map((c: any) => ({ layer: c.layerId, kind: c.sourceKind, ring: c.ringSize, decoded: c.decodedFrameCount, first: c.ringFirstPtsUs, last: c.ringLastPtsUs })),
            res })
        }
        await page.waitForTimeout(mode === 'seek' ? 50 : 150)
        job = await status()
      }
      const exportMs = Date.now() - started
      if (mode === 'play') await hook('transportPause').catch(() => {})
      // Preview after the job: still alive?
      await hook('transportSeekUs', 3_000_000).catch(() => {})
      await page.waitForTimeout(1500)
      const after = await hook<any>('activeClipProbe', A.layerId).catch(e => String(e))
      const refusals = await app.evaluate(() => ((globalThis as any).__e2eResourceFailures ?? []).map((f: any) => ({ at: f.at, channel: f.channel, request: f.request, error: String(f.error).slice(0, 200) })))
      const run: Record<string, unknown> = { refusals, state: job.state, error: (job as any).error ?? null, setupMs, exportMs, resumedAtMs, remounted, samples, seeks, after,
        seekSummary: seeks.length ? { n: seeks.length, bound: seeks.filter(s => s.bound).length, medianMs: [...seeks.map(s => s.ms as number)].sort((a, b) => a - b)[seeks.length >> 1], maxMs: Math.max(...seeks.map(s => s.ms as number)) } : null }
      if (job.state === 'completed') {
        outputs[mode] = output
        const ref = outputs.base
        if (ref && mode !== 'base') {
          const a = frameMd5(output), b = frameMd5(ref)
          const diff = a.reduce((n, h, k) => n + (h !== b[k] ? 1 : 0), 0) + Math.abs(a.length - b.length)
          run.vsBase = { frames: a.length, baseFrames: b.length, differing: diff, ...(diff ? { psnr: psnr(output, ref) } : {}) }
        }
      }
      ;(report.runs as Record<string, unknown>)[mode] = run
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...report, console: consoleLines.slice(-200) }, null, 1))
      console.log(`[probe] ${mode}: ${job.state} export ${exportMs} ms resumedAt ${resumedAtMs} ${JSON.stringify(run.seekSummary)} ${JSON.stringify(run.vsBase ?? null)}`)
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...report, console: consoleLines.slice(-200) }, null, 1))
    await app.close()
  }
})
