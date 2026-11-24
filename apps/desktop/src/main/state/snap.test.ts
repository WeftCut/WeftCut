import { describe, it, expect } from 'vitest'
import {
  AUDIO_GRID,
  AUDIO_SAMPLE_RATE_HZ,
  floorTravelAtZero,
  frameGrid,
  gridForLayerKind,
  gridIndex,
  isCanonicalOnGrid,
  snapFrameRound,
  snapOnGrid,
  spanOnGrid,
  timeUsAtGridIndex,
  travelCrossesZero,
  travelOnGrids,
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

describe('travelOnGrids', () => {
  const clip = (id: string, kind: string, t0: number, t1: number) => ({ id, kind, tStartUs: t0, tEndUs: t1 })
  const FRACTIONAL = [{ num: 30_000, den: 1001 }, { num: 60_000, den: 1001 }, { num: 24_000, den: 1001 }]

  it('moves t_end by the same point count rather than adding a duration to the landing', () => {
    // A duration is the DIFFERENCE of two lattice points and is not itself one,
    // so `landing + duration` leaves the grid wherever a frame is not a whole
    // number of microseconds. 61 frames at 30 fps landing on frame 1: the sum
    // says 2_066_666, the lattice says 2_066_667.
    const fps = { num: 30, den: 1 }
    const landed = travelOnGrids([clip('a', 'Color', 0, 2_033_333)], { fromUs: 0, toUs: 33_333 }, fps).get('a')!
    expect(landed.tStartUs).toBe(33_333)
    expect(landed.tEndUs).toBe(2_066_667)
    expect(landed.tEndUs).not.toBe(landed.tStartUs + 2_033_333)
  })

  it('lands every endpoint on its own lattice, across the rates whose points are not whole microseconds', () => {
    for (const fps of [{ num: 60, den: 1 }, { num: 30, den: 1 }, { num: 24, den: 1 }, { num: 25, den: 1 }, ...FRACTIONAL]) {
      const g = frameGrid(fps)
      const t1 = timeUsAtGridIndex(61, g)
      for (let frame = 0; frame < 24; frame++) {
        const set = [clip('v', 'Color', 0, t1), clip('a', 'Audio', 0, snapOnGrid(t1, AUDIO_GRID))]
        const landed = travelOnGrids(set, { fromUs: 0, toUs: timeUsAtGridIndex(frame, g) }, fps)
        expect(isCanonicalOnGrid(landed.get('v')!.tStartUs, g)).toBe(true)
        expect(isCanonicalOnGrid(landed.get('v')!.tEndUs, g)).toBe(true)
        expect(isCanonicalOnGrid(landed.get('a')!.tStartUs, AUDIO_GRID)).toBe(true)
        expect(isCanonicalOnGrid(landed.get('a')!.tEndUs, AUDIO_GRID)).toBe(true)
      }
    }
  })

  // The relation of a linked pair, in the audio's own points: its start against
  // the sample nearest the video's start. A fresh pair at a fractional rate has
  // 0 here while its µs edges differ; a slipped one has the slip.
  const relation = (v: { tStartUs: number }, a: { tStartUs: number }) =>
    gridIndex(a.tStartUs, AUDIO_GRID) - gridIndex(v.tStartUs, AUDIO_GRID)
  // A walk of frame-sized drags in both directions, as a user's would be.
  const step = (i: number) => ((i * 37) % 23) - 11

  it('keeps a linked pair\'s relation exactly through any number of moves', () => {
    for (const fps of FRACTIONAL) {
      const g = frameGrid(fps)
      for (const slip of [0, 7, -7]) {
        const v0 = timeUsAtGridIndex(300, g)
        let v = clip('v', 'VideoClip', v0, timeUsAtGridIndex(400, g))
        let a = clip('a', 'Audio', timeUsAtGridIndex(gridIndex(v0, AUDIO_GRID) + slip, AUDIO_GRID), snapOnGrid(v.tEndUs, AUDIO_GRID))
        for (let i = 0; i < 200; i++) {
          const to = timeUsAtGridIndex(gridIndex(v.tStartUs, g) + step(i), g)
          const landed = travelOnGrids([v, a], { fromUs: v.tStartUs, toUs: to }, fps)
          v = { ...v, ...landed.get('v')! }
          a = { ...a, ...landed.get('a')! }
          expect(relation(v, a)).toBe(slip)
        }
      }
    }
  })

  it('NEGATIVE CONTROL: adding the µs delta and re-snapping each member drifts the relation', () => {
    // The arithmetic this replaced, inline. If it kept the relation too, the
    // test above would prove nothing about the travel.
    const g = frameGrid(FRACTIONAL[0])
    let v = timeUsAtGridIndex(300, g)
    let a = snapOnGrid(v, AUDIO_GRID)
    let drifted = false
    for (let i = 0; i < 200 && !drifted; i++) {
      const delta = timeUsAtGridIndex(gridIndex(v, g) + step(i), g) - v
      v = snapOnGrid(v + delta, g)
      a = snapOnGrid(a + delta, AUDIO_GRID)
      drifted = relation({ tStartUs: v }, { tStartUs: a }) !== 0
    }
    expect(drifted).toBe(true)
  })
})

describe('spanOnGrid', () => {
  it('reads a linked pair\'s merged span as each member\'s own span', () => {
    // The span a ripple closes for a deleted V+A pair is the union of the two
    // members' footprints, which at 29.97 starts and ends a few µs off either
    // lattice's edge. Each lattice must read it as its own member's span.
    const g = frameGrid({ num: 30_000, den: 1001 })
    for (let k = 1; k < 30; k++) {
      const vs = timeUsAtGridIndex(1000 + k, g)
      const ve = timeUsAtGridIndex(1100 + k, g)
      const as = snapOnGrid(vs, AUDIO_GRID)
      const ae = snapOnGrid(ve, AUDIO_GRID)
      const union = { s: Math.min(vs, as), e: Math.max(ve, ae) }
      expect(spanOnGrid(union.s, union.e, g)).toEqual({ s: vs, e: ve })
      expect(spanOnGrid(union.s, union.e, AUDIO_GRID)).toEqual({ s: as, e: ae })
    }
  })
})

describe('floorTravelAtZero', () => {
  const clip = (id: string, kind: string, t0: number) => ({ id, kind, tStartUs: t0, tEndUs: t0 + 1_000_002 })

  it('stops the set as one body, keeping the phase between its members', () => {
    // The earliest member lands exactly on 0 and the later one keeps its
    // distance. Clamping per member would put BOTH on 0 and spend the offset.
    const fps = { num: 30, den: 1 }
    const g = frameGrid(fps)
    const late = timeUsAtGridIndex(15, g)
    const set = [clip('late', 'Color', late), clip('early', 'Color', timeUsAtGridIndex(6, g))]
    const landed = travelOnGrids(set, floorTravelAtZero(set, { fromUs: late, toUs: 0 }, fps, g), fps)
    expect(landed.get('early')!.tStartUs).toBe(0)
    expect(landed.get('late')!.tStartUs).toBe(timeUsAtGridIndex(9, g))
  })

  it('returns a travel that clears zero untouched, in both directions', () => {
    const fps = { num: 30, den: 1 }
    const set = [clip('a', 'Color', 1_000_000)]
    const left = { fromUs: 1_000_000, toUs: 500_000 }
    const right = { fromUs: 1_000_000, toUs: 1_500_000 }
    expect(floorTravelAtZero(set, left, fps, frameGrid(fps))).toBe(left)
    expect(floorTravelAtZero(set, right, fps, frameGrid(fps))).toBe(right)
    expect(floorTravelAtZero([], left, fps, frameGrid(fps))).toBe(left)
  })

  it('stops on the first point of the anchor\'s lattice nobody crosses, and re-flooring its landing is the same travel', () => {
    // The timeline sends the anchor's floored landing as the request and the
    // mutation re-snaps it on the anchor's lattice and floors again; the two
    // must reach one travel or the commit lands off the ghost.
    for (const fps of [{ num: 30_000, den: 1001 }, { num: 60_000, den: 1001 }, { num: 25, den: 1 }]) {
      const g = frameGrid(fps)
      for (const slip of [-9, -1, 0, 1, 9]) {
        const v0 = timeUsAtGridIndex(40, g)
        const set = [
          clip('v', 'VideoClip', v0),
          clip('a', 'Audio', timeUsAtGridIndex(gridIndex(v0, AUDIO_GRID) + slip, AUDIO_GRID)),
        ]
        const travel = floorTravelAtZero(set, { fromUs: v0, toUs: snapOnGrid(-5_000_000, g) }, fps, g)
        expect(isCanonicalOnGrid(travel.toUs, g)).toBe(true)
        expect(travelCrossesZero(set, travel, fps)).toBe(false)
        const before = { fromUs: v0, toUs: timeUsAtGridIndex(gridIndex(travel.toUs, g) - 1, g) }
        expect(travelCrossesZero(set, before, fps)).toBe(true)
        const landed = travelOnGrids(set, travel, fps)
        const again = floorTravelAtZero(set, { fromUs: v0, toUs: snapOnGrid(landed.get('v')!.tStartUs, g) }, fps, g)
        expect(travelOnGrids(set, again, fps)).toEqual(landed)
      }
    }
  })
})
