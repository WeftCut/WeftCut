import { describe, it, expect } from 'vitest'
import {
  AUDIO_GRID,
  AUDIO_SAMPLE_RATE_HZ,
  automationGrid,
  floorTravelAtZero,
  frameGrid,
  gridIndex,
  isCanonicalOnGrid,
  snapFrameRound,
  snapOnGrid,
  timeUsAtGridIndex,
  travelCrossesZero,
  travelOnGrid,
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

// ── The two lattices ─────────────────────────────────────────────────────────
// Every layer edge is on the frame grid; the 48 kHz lattice carries audio
// automation keys and source slips. These are the properties those uses rely on.
describe('automationGrid', () => {
  const FPS = { num: 30_000, den: 1001 }

  it('answers the sample lattice for Audio and the composition frame grid for every visual kind', () => {
    expect(automationGrid('Audio', FPS)).toEqual(AUDIO_GRID)
    for (const kind of ['VideoClip', 'ImageOverlay', 'Text', 'Motif', 'Color'] as const) {
      expect(automationGrid(kind, FPS)).toEqual(frameGrid(FPS))
    }
  })

  it('keeps Audio keys on the mix lattice whatever the composition rate', () => {
    for (const fps of [{ num: 24, den: 1 }, { num: 30_000, den: 1001 }, { num: 60, den: 1 }]) {
      expect(automationGrid('Audio', fps)).toEqual({ domain: 'sample', num: AUDIO_SAMPLE_RATE_HZ, den: 1 })
    }
  })
})

describe('the 48 kHz lattice', () => {
  const FPS = { num: 30_000, den: 1001 }

  it('is the SAME leaf math the export mixer uses (twin, not a parallel implementation)', () => {
    // `mix.rs` / `chunkSchedule.ts` place audio via `us_to_frame(us, 48000)`. The
    // authoring index must be that identical integer, or a "one sample" nudge would
    // be approximately one sample.
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

  it('holds every frame at every rate EXCEPT 29.97 / 59.94', () => {
    // Why slip and mixer fixtures run at 29.97: there an audio edge is a frame
    // the mixer rounds to its nearest sample, and a sample step is visibly not a
    // frame step. At the other six rates the two coincide, so a fixture there
    // cannot tell them apart.
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

describe('travelOnGrid', () => {
  const clip = (id: string, t0: number, t1: number) => ({ id, tStartUs: t0, tEndUs: t1 })
  const FRACTIONAL = [{ num: 30_000, den: 1001 }, { num: 60_000, den: 1001 }, { num: 24_000, den: 1001 }]
  const ALL = [{ num: 60, den: 1 }, { num: 30, den: 1 }, { num: 24, den: 1 }, { num: 25, den: 1 }, ...FRACTIONAL]

  it('moves t_end by the same point count rather than adding a duration to the landing', () => {
    // A duration is the DIFFERENCE of two lattice points and is not itself one,
    // so `landing + duration` leaves the grid wherever a frame is not a whole
    // number of microseconds. 61 frames at 30 fps landing on frame 1: the sum
    // says 2_066_666, the lattice says 2_066_667.
    const fps = { num: 30, den: 1 }
    const landed = travelOnGrid([clip('a', 0, 2_033_333)], { fromUs: 0, toUs: 33_333 }, fps).get('a')!
    expect(landed.tStartUs).toBe(33_333)
    expect(landed.tEndUs).toBe(2_066_667)
    expect(landed.tEndUs).not.toBe(landed.tStartUs + 2_033_333)
  })

  it('lands every edge of every member on a frame, at every rate', () => {
    for (const fps of ALL) {
      const g = frameGrid(fps)
      const set = [clip('v', 0, timeUsAtGridIndex(61, g)), clip('a', timeUsAtGridIndex(3, g), timeUsAtGridIndex(50, g))]
      for (let frame = 0; frame < 24; frame++) {
        // A request instant that is not itself a frame.
        const landed = travelOnGrid(set, { fromUs: 0, toUs: timeUsAtGridIndex(frame, g) + 7 }, fps)
        for (const m of landed.values()) {
          expect(isCanonicalOnGrid(m.tStartUs, g)).toBe(true)
          expect(isCanonicalOnGrid(m.tEndUs, g)).toBe(true)
        }
      }
    }
  })

  it('moves every edge by the same whole frames, keeping a linked pair\'s shared edges through any number of moves', () => {
    // A walk of frame-sized drags in both directions, as a user's would be.
    const step = (i: number) => ((i * 37) % 23) - 11
    for (const fps of FRACTIONAL) {
      const g = frameGrid(fps)
      for (const lead of [0, 2, -2]) {
        // A linked pair sharing its edges, and a third member `lead` frames off it.
        let set = [
          clip('v', timeUsAtGridIndex(300, g), timeUsAtGridIndex(400, g)),
          clip('a', timeUsAtGridIndex(300, g), timeUsAtGridIndex(400, g)),
          clip('b', timeUsAtGridIndex(300 + lead, g), timeUsAtGridIndex(350, g)),
        ]
        // Every edge's frame index, relative to the first member's start.
        const relation = (s: typeof set) => {
          const edges = s.flatMap((m) => [gridIndex(m.tStartUs, g), gridIndex(m.tEndUs, g)])
          return edges.map((e) => e - edges[0])
        }
        const kept = relation(set)
        for (let i = 0; i < 200; i++) {
          const to = timeUsAtGridIndex(gridIndex(set[0].tStartUs, g) + step(i), g)
          const landed = travelOnGrid(set, { fromUs: set[0].tStartUs, toUs: to }, fps)
          set = set.map((m) => ({ ...m, ...landed.get(m.id)! }))
          expect(set[1].tStartUs).toBe(set[0].tStartUs)
          expect(set[1].tEndUs).toBe(set[0].tEndUs)
          expect(relation(set)).toEqual(kept)
        }
      }
    }
  })

  it('first puts a member that is off this grid on its nearest frame, then moves it with the rest', () => {
    // A layer entering a composition at another rate: 3.5 s is a frame at 30 fps
    // and half-way between two at 25.
    const fps = { num: 25, den: 1 }
    const g = frameGrid(fps)
    const landed = travelOnGrid([clip('x', 3_500_000, 4_000_000)], { fromUs: 0, toUs: timeUsAtGridIndex(3, g) }, fps)
    expect(landed.get('x')).toEqual({
      tStartUs: timeUsAtGridIndex(gridIndex(3_500_000, g) + 3, g),
      tEndUs: timeUsAtGridIndex(gridIndex(4_000_000, g) + 3, g),
    })
  })
})

describe('floorTravelAtZero', () => {
  const clip = (id: string, t0: number) => ({ id, tStartUs: t0, tEndUs: t0 + 1_000_002 })

  it('lands a member that is not yet a frame on 0, not a frame after it', () => {
    // A set entering from a composition at another rate: half a frame at 25 fps
    // rounds up to frame 13, so the stop is minus 13 frames from the anchor.
    const fps = { num: 25, den: 1 }
    const g = frameGrid(fps)
    const set = [clip('anchor', 1_000_000), clip('early', 500_000)]
    const travel = floorTravelAtZero(set, { fromUs: 1_000_000, toUs: 0 }, fps)
    expect(travelOnGrid(set, travel, fps).get('early')!.tStartUs).toBe(0)
    expect(isCanonicalOnGrid(travel.toUs, g)).toBe(true)
    expect(travelCrossesZero(set, travel, fps)).toBe(false)
  })

  it('stops the set as one body, keeping the phase between its members', () => {
    // The earliest member lands exactly on 0 and the later one keeps its
    // distance. Clamping per member would put BOTH on 0 and spend the offset.
    const fps = { num: 30, den: 1 }
    const g = frameGrid(fps)
    const late = timeUsAtGridIndex(15, g)
    const set = [clip('late', late), clip('early', timeUsAtGridIndex(6, g))]
    const landed = travelOnGrid(set, floorTravelAtZero(set, { fromUs: late, toUs: 0 }, fps), fps)
    expect(landed.get('early')!.tStartUs).toBe(0)
    expect(landed.get('late')!.tStartUs).toBe(timeUsAtGridIndex(9, g))
  })

  it('returns a travel that clears zero untouched, in both directions', () => {
    const fps = { num: 30, den: 1 }
    const set = [clip('a', 1_000_000)]
    const left = { fromUs: 1_000_000, toUs: 500_000 }
    const right = { fromUs: 1_000_000, toUs: 1_500_000 }
    expect(floorTravelAtZero(set, left, fps)).toBe(left)
    expect(floorTravelAtZero(set, right, fps)).toBe(right)
    expect(floorTravelAtZero([], left, fps)).toBe(left)
  })

  it('stops on the first frame where nobody is before 0, from the same instant, and re-flooring its landing is the same travel', () => {
    // The timeline sends the anchor's floored landing as the request and the
    // mutation floors it again; the two must reach one travel or the commit
    // lands off the ghost.
    for (const fps of [{ num: 30_000, den: 1001 }, { num: 60_000, den: 1001 }, { num: 25, den: 1 }]) {
      const g = frameGrid(fps)
      for (const lead of [-9, -1, 0, 1, 9]) {
        const v0 = timeUsAtGridIndex(40, g)
        const set = [clip('v', v0), clip('a', timeUsAtGridIndex(40 + lead, g))]
        const travel = floorTravelAtZero(set, { fromUs: v0, toUs: snapOnGrid(-5_000_000, g) }, fps)
        expect(travel.fromUs).toBe(v0)
        expect(isCanonicalOnGrid(travel.toUs, g)).toBe(true)
        expect(travelCrossesZero(set, travel, fps)).toBe(false)
        const before = { fromUs: v0, toUs: timeUsAtGridIndex(gridIndex(travel.toUs, g) - 1, g) }
        expect(travelCrossesZero(set, before, fps)).toBe(true)
        const landed = travelOnGrid(set, travel, fps)
        expect(Math.min(...[...landed.values()].map((m) => m.tStartUs))).toBe(0)
        const again = floorTravelAtZero(set, { fromUs: v0, toUs: landed.get('v')!.tStartUs }, fps)
        expect(travelOnGrid(set, again, fps)).toEqual(landed)
      }
    }
  })
})
