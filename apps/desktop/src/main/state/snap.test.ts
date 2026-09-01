import { describe, it, expect } from 'vitest'
import {
  AUDIO_GRID,
  AUDIO_SAMPLE_RATE_HZ,
  floorShiftAtZero,
  frameGrid,
  gridForLayerKind,
  gridIndex,
  isCanonicalOnGrid,
  shiftOnGrids,
  snapFrameRound,
  snapOnGrid,
  timeUsAtGridIndex,
  usToFrame,
} from './snap'

describe('snapFrameRound (wasm leaf re-export)', () => {
  it('snaps to the nearest 30fps frame boundary (half-up)', () => {
    // 30fps frame ≈ 33_333.33µs; the wasm uses i128 half-up rounding.
    expect(snapFrameRound(0, 30, 1)).toBe(0)
    expect(snapFrameRound(33_333, 30, 1)).toBe(33_333)
    expect(snapFrameRound(50_000, 30, 1)).toBe(snapFrameRound(50_000, 30, 1)) // stable
    expect(snapFrameRound(50_000, 30, 1)).toBe(66_667) // 1.5 frames → rounds up to frame 2
  })
  it('is a no-op for degenerate fps (renderer/seek may pass 0)', () => {
    expect(snapFrameRound(12_345, 0, 1)).toBe(12_345)
    expect(snapFrameRound(12_345, 30, 0)).toBe(12_345)
  })
})

// ── The kind-keyed grid lookup (spec R2-D6) ──────────────────────────────────
// One function, three enforcement sites. These are the properties the sites rely on.
describe('gridForLayerKind', () => {
  const FPS = { num: 30_000, den: 1001 }

  it('answers the sample lattice for Audio and the composition frame grid for every visual kind', () => {
    expect(gridForLayerKind('Audio', FPS)).toEqual(AUDIO_GRID)
    for (const kind of ['VideoClip', 'ImageOverlay', 'Text', 'Motif', 'Color'] as const) {
      expect(gridForLayerKind(kind, FPS)).toEqual(frameGrid(FPS))
    }
    // A corrupt / unknown wire kind answers the frame grid — the conservative default
    // (`repairGrid` runs before the cast to Project, so it can hand this in).
    expect(gridForLayerKind('', FPS)).toEqual(frameGrid(FPS))
  })

  it('the audio lattice does NOT move when fps does — that was the defect', () => {
    for (const fps of [{ num: 24, den: 1 }, { num: 30_000, den: 1001 }, { num: 60, den: 1 }]) {
      expect(gridForLayerKind('Audio', fps)).toEqual({ domain: 'sample', num: AUDIO_SAMPLE_RATE_HZ, den: 1 })
    }
  })

  it('is the SAME leaf math the export mixer uses (twin, not a parallel implementation)', () => {
    // `mix.rs` / `chunkSchedule.ts` place audio via `us_to_frame(us, 48000)`. The
    // authoring index must be that identical integer, or a "one sample" nudge would be
    // approximately one sample and the two would drift the way `snapFrameFloor` did.
    for (const us of [0, 1, 17, 20_833, 33_367, 999_999, 1_000_000, 3_600_000_000]) {
      expect(gridIndex(us, AUDIO_GRID)).toBe(usToFrame(us, AUDIO_SAMPLE_RATE_HZ))
    }
  })

  it('µs storage represents the sample lattice exactly: distinct, invertible, ~20.83 µs apart', () => {
    // Below ~1 µs spacing (≈1 MHz) this would stop holding; nothing approaches it.
    for (let i = 0; i < 2000; i++) {
      const t = timeUsAtGridIndex(i, AUDIO_GRID)
      expect(gridIndex(t, AUDIO_GRID)).toBe(i)
      expect(isCanonicalOnGrid(t, AUDIO_GRID)).toBe(true)
      if (i > 0) {
        const span = t - timeUsAtGridIndex(i - 1, AUDIO_GRID)
        expect(span).toBeGreaterThanOrEqual(20)
        expect(span).toBeLessThanOrEqual(21)
      }
    }
  })

  it('the frame lattice is an exact sublattice of 48 kHz at every rate EXCEPT 29.97 / 59.94', () => {
    // Not a curiosity — it is why a co-aligned A/V pair is exact at six of the eight
    // matrix rates and ~8 µs apart at the other two, and why fixtures that only test
    // 30/1 cannot tell a kind-blind snap from a correct one.
    const nests = (num: number, den: number) => {
      for (let i = 0; i < 200; i++) {
        const t = timeUsAtGridIndex(i, frameGrid({ num, den }))
        if (!isCanonicalOnGrid(t, AUDIO_GRID)) return false
      }
      return true
    }
    for (const [num, den] of [[24_000, 1001], [24, 1], [25, 1], [30, 1], [50, 1], [60, 1]] as const) {
      expect(nests(num, den), `${num}/${den} should nest inside 48 kHz`).toBe(true)
    }
    for (const [num, den] of [[30_000, 1001], [60_000, 1001]] as const) {
      expect(nests(num, den), `${num}/${den} should NOT nest inside 48 kHz`).toBe(false)
    }
  })

  it('snapOnGrid is idempotent on both lattices', () => {
    for (const grid of [AUDIO_GRID, frameGrid(FPS)]) {
      for (const raw of [0, 1, 12_345, 33_366, 33_367, 1_234_567]) {
        const once = snapOnGrid(raw, grid)
        expect(snapOnGrid(once, grid)).toBe(once)
        expect(isCanonicalOnGrid(once, grid)).toBe(true)
      }
    }
  })
})

describe('shiftOnGrids', () => {
  const clip = (id: string, kind: string, t0: number, t1: number) => ({ id, kind, tStartUs: t0, tEndUs: t1 })

  it('snaps t_end rather than adding a duration to the landing', () => {
    // A duration is the DIFFERENCE of two lattice points and is not itself one,
    // so `landing + duration` leaves the grid wherever a frame is not a whole
    // number of microseconds. 61 frames at 30 fps landing on frame 1: the sum
    // says 2_066_666, the lattice says 2_066_667. One microsecond, and the whole
    // reason this is one function instead of four.
    const fps = { num: 30, den: 1 }
    const landed = shiftOnGrids([clip('a', 'Color', 0, 2_033_333)], 33_333, fps).get('a')!
    expect(landed.tStartUs).toBe(33_333)
    expect(landed.tEndUs).toBe(2_066_667)
    expect(landed.tEndUs).not.toBe(landed.tStartUs + 2_033_333)
  })

  it('lands every member on its OWN lattice, so a slipped A/V offset survives', () => {
    // The video member takes the frame grid, the audio member the 48 kHz sample
    // lattice. Snapping the audio one on the frame grid would drag it to the
    // nearest video frame and silently spend the offset (R2-D7).
    const fps = { num: 30, den: 1 }
    const landed = shiftOnGrids(
      [clip('v', 'VideoClip', 0, 1_000_000), clip('a', 'Audio', 1_000, 1_001_000)],
      33_333,
      fps,
    )
    expect(landed.get('v')!.tStartUs).toBe(snapOnGrid(33_333, frameGrid(fps)))
    expect(landed.get('a')!.tStartUs).toBe(snapOnGrid(34_333, AUDIO_GRID))
    // Not the same number: the two lattices are genuinely different here, which
    // is what the per-member grid is for.
    expect(landed.get('a')!.tStartUs).not.toBe(landed.get('v')!.tStartUs)
  })

  it('is what applyMoveLayer lands, across the rates whose frame is not whole microseconds', () => {
    // The property the four call sites exist to share, checked directly: for
    // every rate and every landing frame, both endpoints are canonical.
    for (const fps of [{ num: 60, den: 1 }, { num: 30, den: 1 }, { num: 24, den: 1 }, { num: 30_000, den: 1001 }, { num: 25, den: 1 }]) {
      const g = frameGrid(fps)
      const t1 = timeUsAtGridIndex(61, g)
      for (let frame = 0; frame < 24; frame++) {
        const delta = timeUsAtGridIndex(frame, g)
        const landed = shiftOnGrids([clip('a', 'Color', 0, t1)], delta, fps).get('a')!
        expect(isCanonicalOnGrid(landed.tStartUs, g)).toBe(true)
        expect(isCanonicalOnGrid(landed.tEndUs, g)).toBe(true)
      }
    }
  })
})

describe('floorShiftAtZero', () => {
  const clip = (id: string, t0: number) => ({ id, kind: 'Color', tStartUs: t0, tEndUs: t0 + 1_000_000 })

  it('stops the set as one body, keeping the phase between its members', () => {
    // The earliest member lands exactly on 0 and the later one keeps its
    // distance. Clamping per member would put BOTH on 0 and spend the offset.
    const set = [clip('late', 500_000), clip('early', 200_000)]
    const delta = floorShiftAtZero(set, -900_000)
    expect(delta).toBe(-200_000)
    const landed = shiftOnGrids(set, delta, { num: 30, den: 1 })
    expect(landed.get('early')!.tStartUs).toBe(0)
    expect(landed.get('late')!.tStartUs).toBe(300_000)
  })

  it('leaves a delta that clears zero alone, in both directions', () => {
    const set = [clip('a', 1_000_000)]
    expect(floorShiftAtZero(set, -500_000)).toBe(-500_000)
    expect(floorShiftAtZero(set, 500_000)).toBe(500_000)
    // An empty set has no earliest member to floor against, and answering
    // `-Infinity` would poison every landing computed from it.
    expect(floorShiftAtZero([], -500_000)).toBe(-500_000)
  })
})
