/// Two lattices, ONE grid implementation.
///
/// Every layer edge, of every kind, lives on the composition frame grid (ADR 0037,
/// 0038), so a linked picture and its sound share their edges exactly. The fixed
/// 48 kHz mix lattice is kept for what is audio-only and inside a layer: audio
/// automation keys (`automationGrid`) and the source slip a sample nudge makes.
///
/// THE KEY FACT, and the reason this is not a second grid: a 48 kHz sample boundary
/// IS a frame boundary at rate 48000/1.
///   timeUsAtFrame(i, 48000, 1)  === round(i * 1e6 / 48000)   ← the sample time
///   frameIndexRound(us, 48000, 1) === usToFrame(us, 48000)   ← the mixer's index
/// (that second identity reduces to `(us*48000 + 500000)/1000000` on both sides —
/// asserted in `main/state/snap.test.ts`.) So `domain` NAMES the lattice for
/// diagnostics and messaging; it does not select a different algorithm. There is one
/// i128 leaf implementation, which is what makes "zero rounding at the render seam"
/// true rather than aspirational: the authoring index and the mixer's sample index
/// are the same integer.
///
/// Lives in the renderer tree, beside `frames.ts`, because BOTH sides need it: the
/// actor re-exports it through `main/state/snap.ts` (the same direction main already
/// takes for the eval leaf), and the timeline UI imports it directly for nudges and
/// readouts. A copy on each side would be exactly the drift this file prevents.
import { frameIndexRound, snapFrameCeil, snapFrameFloor, snapFrameRound, timeUsAtFrame } from './eval'
import type { GridDomain } from '../shared/commandErrors'

/** The mix lattice, hard-coded in BOTH engines (`native/src/audio/mix.rs`
 *  MIX_SAMPLE_RATE, and the TS twin's `chunkSchedule.ts` framesToUs). Do not add a
 *  third: this constant is the authoring half of that same pair.
 *
 *  NOT `composition.sample_rate` — that field is read only as the EXPORT target, so
 *  it is a delivery parameter, moves no edit, and is deliberately never locked. */
export const AUDIO_SAMPLE_RATE_HZ = 48_000

/** Samples per millisecond — the coarse nudge tier's step (1 ms = 48 samples). */
export const AUDIO_SAMPLES_PER_MS = AUDIO_SAMPLE_RATE_HZ / 1000

/** Which lattice a time lives on. Diagnostics only — see the note above.
 *  Declared in shared/commandErrors.ts (the refusal wire contract names it in
 *  `OffGridLayerBoundary.grid`); re-exported here so grid consumers keep one
 *  import site for all lattice vocabulary. */
export type { GridDomain } from '../shared/commandErrors'

/** A rate pair, structurally compatible with the actor's `Rational`. */
export interface RateLike {
  num: number
  den: number
}

/** A lattice: canonical times are `round(i * 1e6 * den / num)` for integer `i`. */
export interface Grid extends RateLike {
  domain: GridDomain
}

/** The 48 kHz sample lattice. A module constant because it never varies: the mix
 *  rate is fixed, so audio precision does NOT change when the video fps does. */
export const AUDIO_GRID: Grid = { domain: 'sample', num: AUDIO_SAMPLE_RATE_HZ, den: 1 }

/** The composition frame lattice for `fps`. */
export function frameGrid(fps: RateLike): Grid {
  return { domain: 'frame', num: fps.num, den: fps.den }
}

/** The lattice a layer's automation keys live on: the mix lattice for Audio, whose
 *  gain and pan the mixer evaluates per sample, the frame grid for everything that
 *  renders per frame. Keys are layer-local, so this never meets an edge.
 *
 *  `kind` is a plain `string` because the renderer reads kinds off the project
 *  summary and has no narrowed union to hand; an unrecognized kind answers the
 *  frame grid, and a corrupt kind is validate's to reject. */
export function automationGrid(kind: string, fps: RateLike): Grid {
  return kind === 'Audio' ? AUDIO_GRID : frameGrid(fps)
}

/** Which layers may not sit on top of each other on one track. */
export type OverlapClass = 'visual' | 'audio'

/** THE same-class rule: visual-class layers may not overlap visual, audio may not
 *  overlap audio, and the two classes coexist freely at the same time (the
 *  combined row the timeline draws).
 *
 *  Stated as "everything that is not Audio is visual" rather than as an allowlist
 *  of visual kinds, so a CompositionRef falls on the visual side by construction:
 *  a Group clip composites like any clip — it may hold audio INSIDE it and still
 *  be a picture — and may be a transition participant for the same reason
 *  (ADR 0052 §4).
 *
 *  Structural, taking a plain `string` kind: the actor's overlap scan reads it
 *  off a `LayerParams`, its batch
 *  pre-checks off a clone plan, and the ripple planner off its own view. Two
 *  copies of "what counts as the same class" is exactly the drift a shared seam
 *  prevents. */
export function layerOverlapClass(params: { kind: string }): OverlapClass {
  return params.kind === 'Audio' ? 'audio' : 'visual'
}

/** Nearest lattice point (half-up) — the snap every mutator uses. */
export function snapOnGrid(tUs: number, g: Grid): number {
  return snapFrameRound(tUs, g.num, g.den)
}

/** Lattice point at or below `tUs` — outward-safe for a low bound. */
export function snapDownOnGrid(tUs: number, g: Grid): number {
  return snapFrameFloor(tUs, g.num, g.den)
}

/** Lattice point at or above `tUs` — outward-safe for a high bound. */
export function snapUpOnGrid(tUs: number, g: Grid): number {
  return snapFrameCeil(tUs, g.num, g.den)
}

/** Index of the lattice point nearest `tUs`. For `AUDIO_GRID` this IS the mixer's
 *  sample-frame index (`usToFrame(tUs, 48000)`), which is what makes a one-sample
 *  nudge exact rather than approximately one sample. */
export function gridIndex(tUs: number, g: Grid): number {
  return frameIndexRound(tUs, g.num, g.den)
}

/** Canonical µs of lattice point `i`. */
export function timeUsAtGridIndex(i: number, g: Grid): number {
  return timeUsAtFrame(i, g.num, g.den)
}

/** True when `tUs` is a lattice point — equivalently, when snapping is identity.
 *  A degenerate rate has no lattice; `InvalidFps` owns that. */
export function isCanonicalOnGrid(tUs: number, g: Grid): boolean {
  if (g.num <= 0 || g.den <= 0) return true
  return snapOnGrid(tUs, g) === tUs
}

/** A move in time, stated as two instants: what sat at `fromUs` ends up at
 *  `toUs`. Never a µs delta: a frame is not a whole number of µs at most rates,
 *  so the same delta is a different number of frames depending on where it
 *  starts, and an edge plus a delta re-snapped rounds twice. Two instants
 *  project onto the grid (`travelSteps`), so every edge moves by the same whole
 *  number of points. */
export interface Travel {
  fromUs: number
  toUs: number
}

/** The travel `deltaUs` from `fromUs` — for a caller whose request IS a delta
 *  (a sweep length, an agent's `delta_us`). `fromUs` is the instant the delta
 *  is measured from, and it decides the projection, so pass the instant the
 *  request names (the seed's start, the sweep origin), not zero. */
export function travelBy(fromUs: number, deltaUs: number): Travel {
  return { fromUs, toUs: fromUs + deltaUs }
}

/** How many points of `g` a travel moves: the distance between the nearest
 *  points of `g` to its two instants. */
export function travelSteps(travel: Travel, g: Grid): number {
  return gridIndex(travel.toUs, g) - gridIndex(travel.fromUs, g)
}

/** A point of `g` moved by `steps` points, with no clamp at 0: a caller that
 *  can go negative refuses or floors before it gets here.
 *
 *  Resolved through the INDEX, never by adding a quantum's width in µs: lattice
 *  spacing is not a whole number of microseconds (48 kHz alternates 20/21 µs), so
 *  an additive step accumulates error and 10 000 nudges out and back would not
 *  return to the start. Index arithmetic makes out-and-back the identity. */
export function stepPointOnGrid(tUs: number, steps: number, g: Grid): number {
  return timeUsAtGridIndex(gridIndex(tUs, g) + steps, g)
}

/** One member of a set on the move: whatever carries a span. Neither side's
 *  layer model appears here — the actor adapts its `Layer`, the timeline adapts
 *  its `DragSubject` — so this stays a statement about the grid. */
export interface ShiftMember {
  id: string
  tStartUs: number
  tEndUs: number
}

/** Where every member of a set lands when the set makes `travel`.
 *
 *  THE arithmetic of a move, and the reason it is one function rather than one
 *  per caller: the mutations DECIDE where a clip goes while the timeline's move
 *  projection and the cross-Panel ghost PROMISE it in advance, and a promise
 *  computed by an arithmetic the mutation does not share is one the project can
 *  never satisfy.
 *
 *  Every endpoint moves by the same `travelSteps`, so the distance between any
 *  two edges of the set, a linked pair's included, is kept in whole frames. A
 *  stored edge is already a point of the grid (validate holds it there); one
 *  that is not, a layer entering a composition at another rate, first takes its
 *  nearest point there.
 *
 *  Pure, and deliberately free of policy: the zero boundary is `floorTravelAtZero`
 *  for a caller that CLAMPS and a refusal for a caller that does not
 *  (`applyMoveLayersToComposition` refuses, on the grounds that sliding a set off
 *  the picture it was placed against is not a repair). */
export function travelOnGrid(
  members: readonly ShiftMember[],
  travel: Travel,
  fps: RateLike,
): Map<string, { tStartUs: number; tEndUs: number }> {
  const g = frameGrid(fps)
  const steps = travelSteps(travel, g)
  const landings = new Map<string, { tStartUs: number; tEndUs: number }>()
  for (const m of members) {
    landings.set(m.id, {
      tStartUs: stepPointOnGrid(m.tStartUs, steps, g),
      tEndUs: stepPointOnGrid(m.tEndUs, steps, g),
    })
  }
  return landings
}

/** `travel`, or — when it would carry some member before 0 — the travel from
 *  the same instant that lands the EARLIEST member on 0: the set stopping as ONE
 *  body rather than each member clamped where it lands, which would flatten the
 *  set's phase against the boundary.
 *
 *  Counted in frames, the unit the members move by: the stop is the travel of
 *  minus the earliest member's frame, so that member lands exactly on 0 even
 *  when it is not yet a point of this grid (a layer entering from a composition
 *  at another rate takes its nearest frame first).
 *
 *  The stopped `toUs` is a point of the grid. That is what keeps a ghost and its
 *  commit on one travel: the timeline sends the anchor's landing as the request,
 *  and the mutation re-snapping it reaches this same `toUs`, which no longer
 *  crosses. The anchor must be one of `members`, so the earliest member's frame
 *  is at or before `fromUs`'s and no time before 0 is asked of the leaf. */
export function floorTravelAtZero(members: readonly ShiftMember[], travel: Travel, fps: RateLike): Travel {
  if (!travelCrossesZero(members, travel, fps)) return travel
  const g = frameGrid(fps)
  let earliest = Infinity
  for (const m of members) earliest = Math.min(earliest, gridIndex(m.tStartUs, g))
  return { fromUs: travel.fromUs, toUs: timeUsAtGridIndex(Math.max(0, gridIndex(travel.fromUs, g) - earliest), g) }
}

/** True when `travel` would carry some member before 0 — the strict callers'
 *  refusal test, read in the same points `travelOnGrid` moves by. Compared as
 *  indices, so no time before 0 is ever asked of the leaf. */
export function travelCrossesZero(members: readonly ShiftMember[], travel: Travel, fps: RateLike): boolean {
  const g = frameGrid(fps)
  const steps = travelSteps(travel, g)
  for (const m of members) if (gridIndex(m.tStartUs, g) + steps < 0) return true
  return false
}
