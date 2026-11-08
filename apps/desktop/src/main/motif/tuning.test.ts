import { describe, expect, it, vi } from 'vitest'
import { configureMotifCore, resolveMotifTuning } from './tuning'
import { MOTIF_TUNING_DEFAULTS, MOTIF_TUNING_SPEC, motifTuningArgument, readMotifTuningArgument } from '../../shared/motifs/tuning'

const resolve = (value: string | undefined, parallelism = 16) => {
  const warn = vi.fn()
  return { tuning: resolveMotifTuning({ WEFTCUT_MOTIF_TUNING: value }, parallelism, warn), warn }
}

describe('resolveMotifTuning', () => {
  it('uses the defaults without the variable, and warns about nothing', () => {
    const { tuning, warn } = resolve(undefined)
    expect(tuning).toEqual({ ...MOTIF_TUNING_DEFAULTS, bandThreads: 2 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('applies valid overrides, the ends of a range included', () => {
    const { tuning, warn } = resolve(' readsInFlight=4 , writeSlots=1,captureFrameRate=240,')
    expect(tuning).toMatchObject({ readsInFlight: 4, writeSlots: 1, captureFrameRate: 240, framesInFlight: 3 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the default for an out-of-range, unknown or garbled entry, with one warning naming each', () => {
    const { tuning, warn } = resolve('framesInFlight=0,captureHosts=2,lanes=4,gpuLanes=two,readsInFlight=2.5,garbage,writeSlots=4')
    expect(tuning).toEqual({ ...MOTIF_TUNING_DEFAULTS, writeSlots: 4, bandThreads: 2 })
    expect(warn).toHaveBeenCalledOnce()
    const message = warn.mock.calls[0]![0] as string
    for (const part of ['framesInFlight=0', 'captureHosts=2', "'lanes'", 'gpuLanes=two', 'readsInFlight=2.5', "'garbage'"]) {
      expect(message).toContain(part)
    }
  })

  it('returns a frozen object', () => {
    const { tuning } = resolve('readsInFlight=4')
    expect(Object.isFrozen(tuning)).toBe(true)
    expect(() => { (tuning as { readsInFlight: number }).readsInFlight = 9 }).toThrow()
  })

  it('gives a frame one band thread per divisor of hardware threads, from one to the cap', () => {
    expect(resolve(undefined, 1).tuning.bandThreads).toBe(1)
    expect(resolve(undefined, 8).tuning.bandThreads).toBe(1)
    expect(resolve(undefined, 16).tuning.bandThreads).toBe(2)
    expect(resolve(undefined, 64).tuning.bandThreads).toBe(2)
    expect(resolve('bandThreadDivisor=2,maxBandThreads=6', 8).tuning.bandThreads).toBe(4)
  })
})

describe('the tuning argument', () => {
  it('carries the resolved tuning to another process unchanged', () => {
    const { tuning } = resolve('readsInFlight=5,scratchIdleBytes=0', 32)
    const read = readMotifTuningArgument(['--other', motifTuningArgument(tuning)])
    expect(read).toEqual(tuning)
    expect(Object.isFrozen(read)).toBe(true)
  })

  it('is null when absent or when it does not parse cleanly', () => {
    expect(readMotifTuningArgument(['--weftcut-layout-theme=x'])).toBeNull()
    const text = motifTuningArgument({ ...MOTIF_TUNING_DEFAULTS, bandThreads: 1 })
    expect(readMotifTuningArgument([text.replace('readsInFlight=3', 'readsInFlight=99')])).toBeNull()
    expect(readMotifTuningArgument([text.replace('bandThreads=1', 'bandThreads=0')])).toBeNull()
    expect(readMotifTuningArgument([text.replace(',bandThreads=1', '')])).toBeNull()
  })
})

describe('MOTIF_TUNING_SPEC', () => {
  it('holds every default inside its range', () => {
    for (const { default: value, range: [min, max] } of Object.values(MOTIF_TUNING_SPEC)) {
      expect(Number.isSafeInteger(value) && min <= value && value <= max).toBe(true)
    }
  })
})

describe('configureMotifCore', () => {
  it('hands the native core its band threads and idle scratch bytes', () => {
    const motifConfigure = vi.fn()
    configureMotifCore({ motifConfigure }, { ...MOTIF_TUNING_DEFAULTS, bandThreads: 2 })
    expect(motifConfigure).toHaveBeenCalledWith({ scratchIdleBytes: 32 * 1024 * 1024, bandThreads: 2 })
  })

  it('refuses an addon without motifConfigure', () => {
    expect(() => configureMotifCore({}, { ...MOTIF_TUNING_DEFAULTS, bandThreads: 1 })).toThrow(/motifConfigure/)
  })
})
