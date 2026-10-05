import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { CalibrationService } from './calibrationService'
import { PLAYBACK_CALIBRATION } from '../shared/playback-calibration'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function setup(supported = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-calibration-test-'))
  fs.writeFileSync(path.join(dir, 'h264-4k60.mp4'), 'fixture')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ codec: 'h264', fps: 60,
    width: 3840, height: 2160, durationUs: 20_000_000,
    sha256: createHash('sha256').update('fixture').digest('hex') }))
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { child.emit('exit', null); return true }) })
  let run = ''
  const launch = vi.fn((_input: string, directory: string) => { run = directory; return child as unknown as ChildProcess })
  const service = new CalibrationService({ supported, fixtureDirectory: dir, runsDirectory: path.join(dir, 'runs'), launch })
  cleanups.push(() => { service.cancel(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { service, launch, child, write: (report: unknown) => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report)) }
}
describe('isolated calibration lifecycle', () => {
  it('starts one fixed plan and preserves a completed result after the process exits', () => {
    const { service, launch, child, write } = setup()
    expect(service.start().running).toBe(true)
    service.start()
    expect(launch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(launch.mock.calls[0]![0], 'utf8')).protocol).toEqual(PLAYBACK_CALIBRATION)
    write({ state: 'complete', cells: [] })
    expect(service.status().running).toBe(true)
    child.emit('exit', 0)
    expect(service.status()).toMatchObject({ running: false, report: { state: 'complete' } })
  })
  it('cancellation cannot be overwritten by a late result and never offers a recommendation', () => {
    const { service, child, write } = setup()
    service.start(); service.cancel()
    write({ state: 'complete', cells: [], recommendation: { maximum: {} } })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(service.status()).toMatchObject({ running: false, report: { state: 'cancelled', recommendation: null } })
    expect(service.status().report?.cells).toHaveLength(8)
  })
  it('records an early close instead of treating partial measurements as a pass', () => {
    const { service, child } = setup()
    service.start(); child.emit('exit', 1)
    expect(service.status()).toMatchObject({ running: false, report: { state: 'error', recommendation: null } })
    expect(service.status().report?.cells.every(cell => cell.reasons.length > 0)).toBe(true)
  })
  it('does not launch unsupported platforms', () => {
    const { service, launch } = setup(false)
    expect(service.status()).toMatchObject({ available: false, unavailableReason: 'platform' })
    expect(() => service.start()).toThrow('unavailable')
    expect(launch).not.toHaveBeenCalled()
  })
})
