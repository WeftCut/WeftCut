import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { CalibrationFixture } from '../shared/calibration-fixture'
import { PLAYBACK_CALIBRATION, type CalibrationReport, type CalibrationSnapshot } from '../shared/playback-calibration'

export interface CalibrationServiceOptions {
  supported: boolean
  toolsAvailable(): boolean
  prepareFixture(signal: AbortSignal): Promise<CalibrationFixture>
  runsDirectory: string
  launch(input: string, directory: string): ChildProcess
  reserve?: () => () => void
}
interface Run {
  controller: AbortController
  child: ChildProcess | null
  release(): void
  watchdog: ReturnType<typeof setTimeout> | null
}

/** Owns preparation and one isolated run; UI lifetimes never own processes or settings. */
export class CalibrationService {
  private active: Run | null = null
  private report: CalibrationReport | null = null
  private output: string | null = null
  constructor(private readonly options: CalibrationServiceOptions) {}

  status(): CalibrationSnapshot {
    if (this.output && !this.active?.controller.signal.aborted) {
      try { this.report = JSON.parse(fs.readFileSync(this.output, 'utf8')) } catch { /* not published yet */ }
    }
    const available = this.options.supported && this.options.toolsAvailable()
    return { available, unavailableReason: available ? undefined : this.options.supported ? 'tools' : 'platform',
      running: this.active !== null, report: this.report }
  }

  start(): CalibrationSnapshot {
    if (this.active) return this.status()
    if (!this.status().available) throw new Error('Performance test is unavailable')
    this.output = null
    this.report = { state: 'preparing-media', cells: PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: 'not-run', reasons: [] })) }
    let release: () => void
    try { release = this.options.reserve?.() ?? (() => {}) }
    catch (error) { this.fail(String(error)); throw error }
    const run: Run = { controller: new AbortController(), child: null, release, watchdog: null }
    this.active = run
    run.watchdog = setTimeout(() => this.stop(run, 'Test media preparation timed out'), 600_000)
    void this.prepare(run)
    // Return immediately so the user can cancel even during first-use encoding.
    return this.status()
  }

  private async prepare(run: Run): Promise<void> {
    try {
      const fixture = await this.options.prepareFixture(run.controller.signal)
      run.controller.signal.throwIfAborted()
      fs.mkdirSync(this.options.runsDirectory, { recursive: true })
      const directory = fs.mkdtempSync(path.join(this.options.runsDirectory, 'run-'))
      const input = path.join(directory, 'input.json')
      this.output = path.join(directory, 'report.json')
      fs.writeFileSync(input, JSON.stringify({ fixture, protocol: PLAYBACK_CALIBRATION }))
      this.report = { ...this.report!, state: 'preparing' }
      const child = this.options.launch(input, directory)
      run.child = child
      child.once('error', error => this.finish(run, String(error)))
      child.once('exit', () => this.finish(run))
      if (run.watchdog) clearTimeout(run.watchdog)
      run.watchdog = setTimeout(() => this.stop(run, 'Performance test timed out'), 360_000)
    } catch (error) { this.finish(run, String(error)) }
  }

  cancel(): CalibrationSnapshot {
    if (this.active) this.stop(this.active, 'Cancelled', 'cancelled')
    return this.status()
  }

  private stop(run: Run, error: string, state = 'error'): void {
    if (this.active !== run) return
    this.fail(error, state)
    run.controller.abort()
    run.child?.kill()
  }

  private finish(run: Run, error?: string): void {
    if (this.active !== run) return
    this.status()
    this.active = null
    if (run.watchdog) clearTimeout(run.watchdog)
    run.release()
    if (!run.controller.signal.aborted && this.report?.state !== 'complete') {
      this.fail(error ?? this.report?.error ?? 'Test window closed before completion')
    }
  }

  private fail(error: string, state = 'error'): void {
    this.output = null
    this.report = { ...this.report, state, error, recommendation: null,
      cells: (this.report?.cells ?? []).map(cell => cell.status === 'not-run' ? { ...cell, reasons: [error] } : cell) }
  }
}
