import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { PLAYBACK_CALIBRATION, type CalibrationReport, type CalibrationSnapshot } from '../shared/playback-calibration'

export interface CalibrationServiceOptions {
  supported: boolean
  fixtureDirectory: string
  runsDirectory: string
  launch(input: string, directory: string): ChildProcess
}

/** Owns one isolated run; UI lifetimes never own processes or overwrite settings. */
export class CalibrationService {
  private child: ChildProcess | null = null
  private report: CalibrationReport | null = null
  private output: string | null = null
  private cancelled = false
  private watchdog: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly options: CalibrationServiceOptions) {}

  status(): CalibrationSnapshot {
    if (this.output && !this.cancelled) {
      try { this.report = JSON.parse(fs.readFileSync(this.output, 'utf8')) } catch { /* not published yet */ }
    }
    const fixture = path.join(this.options.fixtureDirectory, 'h264-4k60.mp4')
    const available = this.options.supported && fs.existsSync(fixture)
    return { available, unavailableReason: available ? undefined : this.options.supported ? 'fixture' : 'platform',
      running: this.child !== null, report: this.report }
  }

  start(): CalibrationSnapshot {
    if (this.child) return this.status()
    if (!this.status().available) throw new Error('Performance test is unavailable')
    const fixturePath = path.join(this.options.fixtureDirectory, 'h264-4k60.mp4')
    const manifest = JSON.parse(fs.readFileSync(path.join(this.options.fixtureDirectory, 'manifest.json'), 'utf8'))
    const sha256 = createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex')
    if (manifest.sha256 !== sha256 || manifest.codec !== 'h264' || manifest.fps !== 60
      || manifest.width !== 3840 || manifest.height !== 2160 || manifest.durationUs !== 20_000_000) {
      throw new Error('Performance test media is invalid')
    }
    fs.mkdirSync(this.options.runsDirectory, { recursive: true })
    const directory = fs.mkdtempSync(path.join(this.options.runsDirectory, 'run-'))
    const input = path.join(directory, 'input.json')
    this.output = path.join(directory, 'report.json')
    fs.writeFileSync(input, JSON.stringify({ fixture: { ...manifest, path: fixturePath }, protocol: PLAYBACK_CALIBRATION }))
    this.cancelled = false
    this.report = { state: 'preparing', cells: PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: 'not-run', reasons: [] })) }
    try {
      const child = this.options.launch(input, directory)
      this.child = child
      const finish = (error?: string) => {
        if (this.child !== child) return
        this.status()
        this.child = null
        if (this.watchdog) clearTimeout(this.watchdog)
        this.watchdog = null
        if (!this.cancelled && this.report?.state !== 'complete') this.fail(error ?? this.report?.error ?? 'Test window closed before completion')
      }
      child.once('error', error => finish(String(error)))
      child.once('exit', () => finish())
      this.watchdog = setTimeout(() => {
        this.fail('Performance test timed out')
        this.cancelled = true
        child.kill()
      }, 360_000)
    } catch (error) { this.fail(String(error)); throw error }
    return this.status()
  }

  cancel(): CalibrationSnapshot {
    if (this.child) {
      this.cancelled = true
      this.fail('Cancelled', 'cancelled')
      this.child.kill()
    }
    return this.status()
  }

  private fail(error: string, state = 'error'): void {
    this.output = null
    this.report = { ...this.report, state, error, recommendation: null,
      cells: (this.report?.cells ?? []).map(cell => cell.status === 'not-run' ? { ...cell, reasons: [error] } : cell) }
  }
}
