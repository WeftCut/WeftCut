import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { CalibrationService } from './calibrationService'
import { PLAYBACK_CALIBRATION } from '../shared/playback-calibration'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function setup(supported = true, reserve?: () => () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-calibration-test-'))
  fs.writeFileSync(path.join(dir, 'h264-4k60.mp4'), 'fixture')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ codec: 'h264', fps: 60,
    width: 3840, height: 2160, durationUs: 20_000_000,
    sha256: createHash('sha256').update('fixture').digest('hex') }))
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { child.emit('exit', null); return true }) })
  let run = ''
  const launch = vi.fn((_input: string, directory: string) => { run = directory; return child as unknown as ChildProcess })
  const fixture = { path: path.join(dir, 'h264-4k60.mp4'), width: 3840, height: 2160, fps: 60,
    durationUs: 20_000_000, bytes: 7, sha256: createHash('sha256').update('fixture').digest('hex') }
  const prepare = vi.fn(async (_signal: AbortSignal) => fixture)
  const toolsAvailable = vi.fn(() => true)
  const service = new CalibrationService({ supported, toolsAvailable, prepareFixture: prepare, runsDirectory: path.join(dir, 'runs'), launch,
    ...(reserve ? { reserve } : {}) })
  cleanups.push(async () => { service.cancel(); await vi.waitFor(() => expect(service.status().running).toBe(false)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { service, launch, child, prepare, fixture, toolsAvailable,
    ready: () => vi.waitFor(() => expect(launch).toHaveBeenCalledOnce()),
    write: (report: unknown) => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report)) }
}
describe('isolated calibration lifecycle', () => {
  it('holds parent resource capacity until the child exits and returns it once', async () => {
    const release = vi.fn(), reserve = vi.fn(() => release)
    const { service, child, ready } = setup(true, reserve)
    service.start(); service.start()
    await ready()
    expect(reserve).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled()
    service.cancel(); child.emit('exit', 0)
    expect(release).toHaveBeenCalledOnce()
  })
  it('does not spawn when the full fixed workload cannot be admitted', () => {
    const { service, launch } = setup(true, () => { throw new Error('resource-capacity-exceeded') })
    expect(() => service.start()).toThrow('resource-capacity-exceeded')
    expect(launch).not.toHaveBeenCalled()
    expect(service.status().running).toBe(false)
  })
  it('starts one fixed plan and preserves a completed result after the process exits', async () => {
    const { service, launch, child, write, ready } = setup()
    expect(service.start().running).toBe(true)
    service.start()
    await ready()
    expect(launch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(launch.mock.calls[0]![0], 'utf8')).protocol).toEqual(PLAYBACK_CALIBRATION)
    write({ state: 'complete', cells: [] })
    expect(service.status().running).toBe(true)
    child.emit('exit', 0)
    expect(service.status()).toMatchObject({ running: false, report: { state: 'complete' } })
  })
  it('cancellation cannot be overwritten by a late result and never offers a recommendation', async () => {
    const { service, child, write, ready } = setup()
    service.start(); await ready(); service.cancel()
    write({ state: 'complete', cells: [], recommendation: { maximum: {} } })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(service.status()).toMatchObject({ running: false, report: { state: 'cancelled', recommendation: null } })
    expect(service.status().report?.cells).toHaveLength(8)
  })
  it('records an early close instead of treating partial measurements as a pass', async () => {
    const { service, child, ready } = setup()
    service.start(); await ready(); child.emit('exit', 1)
    expect(service.status()).toMatchObject({ running: false, report: { state: 'error', recommendation: null } })
    expect(service.status().report?.cells.every(cell => cell.reasons.length > 0)).toBe(true)
  })
  it('does not launch unsupported platforms', () => {
    const { service, launch } = setup(false)
    expect(service.status()).toMatchObject({ available: false, unavailableReason: 'platform' })
    expect(() => service.start()).toThrow('unavailable')
    expect(launch).not.toHaveBeenCalled()
  })
  it('reports availability from tools, without requiring pre-generated media', () => {
    const { service, toolsAvailable } = setup()
    expect(service.status().available).toBe(true)
    toolsAvailable.mockReturnValue(false)
    expect(service.status()).toMatchObject({ available: false, unavailableReason: 'tools' })
  })
  it('keeps cancellation effective until media preparation tears down, without launching a test', async () => {
    const release = vi.fn()
    const { service, prepare, launch, fixture } = setup(true, () => release)
    let complete!: (value: typeof fixture) => void
    prepare.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    expect(service.start()).toMatchObject({ running: true, report: { state: 'preparing-media' } })
    service.start()
    expect(prepare).toHaveBeenCalledOnce()
    service.cancel()
    expect(prepare.mock.calls[0]![0].aborted).toBe(true)
    expect(release).not.toHaveBeenCalled()
    complete(fixture)
    await vi.waitFor(() => expect(service.status().running).toBe(false))
    expect(service.status().report).toMatchObject({ state: 'cancelled', recommendation: null })
    expect(launch).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
  it('releases admission and records preparation failure without launching', async () => {
    const release = vi.fn()
    const { service, prepare, launch } = setup(true, () => release)
    prepare.mockRejectedValueOnce(new Error('encoding failed'))
    service.start()
    await vi.waitFor(() => expect(service.status().running).toBe(false))
    expect(service.status().report).toMatchObject({ state: 'error', error: 'Error: encoding failed' })
    expect(launch).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
