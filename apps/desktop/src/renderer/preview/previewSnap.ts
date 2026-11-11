// Where a preview gesture's result gets pulled onto an alignment line. Pure —
// no renderer, no DOM, no store reads — for the same reason `gizmoGeometry.ts`
// is: the whole decision table below is unit-testable without a pointer, and the
// overlay and the committed value cannot disagree because both come from here.
//
// Everything in this module speaks COMPOSITION pixels. The threshold arrives
// already converted (`thresholdComp`), because the setting is a SCREEN-pixel
// radius — see `snapThresholdComp`.
//
// Two callers, two shapes, one reason they differ:
//   move / free resize → the landing point is reachable on both axes
//   uniform resize     → one degree of freedom, so at most one axis can be hit
// Spec: docs/features.md#on-canvas-transform-gizmo

import type { Pt } from "./gizmoGeometry";
import { nearestGridLine, type GridAxis, type PreviewGrid } from "./gridGeometry";

/// A candidate alignment line, and where it came from. The source is carried
/// rather than inferred from array position because it decides ties, and a
/// tie-break that depends on construction order is exactly what
/// `timeline/snapping.ts` gets away with only because its boundary set has a
/// stable track order.
export type SnapSource = "composition" | "layer" | "grid";

export interface SnapTarget {
  /// The line's position on its axis, composition pixels.
  at: number;
  source: SnapSource;
}

const SOURCE_RANK: Record<SnapSource, number> = { composition: 0, layer: 1, grid: 2 };

export interface SnapTargets {
  /// Vertical lines — candidate `x` values.
  xs: readonly SnapTarget[];
  /// Horizontal lines — candidate `y` values.
  ys: readonly SnapTarget[];
  grid?: PreviewGrid | undefined;
}

/// An axis-aligned box in composition pixels. What a rotated layer contributes
/// to (and snaps by) — the range it occupies on screen, which is what a person
/// aligning things means, rather than its true corners.
export interface Aabb {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/// The bounding box of a mapped quad. Null on a malformed quad, matching the
/// `rotateHandle` / `scaleHandlePoints` convention.
export function quadAabb(quad: readonly Pt[]): Aabb | null {
  const [a, b, c, d] = quad;
  if (!a || !b || !c || !d) return null;
  return {
    left: Math.min(a.x, b.x, c.x, d.x),
    top: Math.min(a.y, b.y, c.y, d.y),
    right: Math.max(a.x, b.x, c.x, d.x),
    bottom: Math.max(a.y, b.y, c.y, d.y),
  };
}

/// The three candidates a box offers on one axis: its two edges and its midpoint.
function axisCandidates(low: number, high: number): [number, number, number] {
  return [low, (low + high) / 2, high];
}

/// The composition's own lines plus every other staged layer's box. `others`
/// arrives already resolved and mapped — building it needs the animated tracks
/// and so belongs to the caller, which is what keeps this module pure.
///
/// The composition contributes its four edges and two centre lines. A `Color`
/// layer must NOT appear in `others`: it fills the composition, so its edges are
/// already here, and a duplicate line would only make the tie-break do work that
/// changes nothing.
export function snapTargets(
  compW: number,
  compH: number,
  others: readonly Aabb[],
  { alignment = true, grid }: { alignment?: boolean; grid?: PreviewGrid | undefined } = {},
): SnapTargets {
  if (!alignment) return { xs: [], ys: [], grid };
  const xs: SnapTarget[] = [
    { at: 0, source: "composition" },
    { at: compW / 2, source: "composition" },
    { at: compW, source: "composition" },
  ];
  const ys: SnapTarget[] = [
    { at: 0, source: "composition" },
    { at: compH / 2, source: "composition" },
    { at: compH, source: "composition" },
  ];
  for (const box of others) {
    for (const at of axisCandidates(box.left, box.right)) xs.push({ at, source: "layer" });
    for (const at of axisCandidates(box.top, box.bottom)) ys.push({ at, source: "layer" });
  }
  return { xs, ys, grid };
}

/// The setting's SCREEN-pixel radius in composition pixels. Zero (or worse)
/// disables snapping entirely, which is how the caller expresses both "the
/// preference is off" and "Ctrl is held" without a second flag — the same
/// `threshold <= 0` short-circuit `timeline/snapping.ts` uses.
export function snapThresholdComp(strengthPx: number, fitScale: number): number {
  if (!(fitScale > 0) || !Number.isFinite(fitScale)) return 0;
  return Math.max(0, strengthPx) / fitScale;
}

/// One axis' outcome: how far to move, and the line to draw for it.
interface AxisHit {
  /// Added to the raw value to land on the line.
  delta: number;
  /// The line's position — where a guide is drawn.
  at: number;
}

/// The smallest move that puts one of `candidates` onto one of `targets`.
///
/// Ranked by (distance, source). Existing targets win grid ties, and
/// composition targets win layer ties.
function snapAxis(
  candidates: readonly number[],
  targets: readonly SnapTarget[],
  thresholdComp: number,
  grid?: GridAxis | null,
): AxisHit | null {
  if (!(thresholdComp > 0)) return null;
  let best: AxisHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;
  const consider = (at: number, candidate: number, rank: number) => {
    const distance = Math.abs(at - candidate);
    if (distance > thresholdComp || distance > bestDistance) return;
    if (distance === bestDistance && rank >= bestRank) return;
    bestDistance = distance;
    bestRank = rank;
    best = { delta: at - candidate, at };
  };
  for (const target of targets) {
    const rank = SOURCE_RANK[target.source];
    for (const candidate of candidates) consider(target.at, candidate, rank);
  }
  if (grid) {
    for (const candidate of candidates) consider(nearestGridLine(candidate, grid), candidate, SOURCE_RANK.grid);
  }
  return best;
}

/// Where a guide should be drawn on each axis, composition pixels. Null means
/// that axis did not snap — at most one line per axis exists by construction,
/// which is why the overlay needs two fixed elements and not a list.
export interface SnapGuides {
  x: number | null;
  y: number | null;
}

const NO_GUIDES: SnapGuides = { x: null, y: null };

export interface MoveSnapResult {
  /// Correction to ADD to the raw drag delta.
  dx: number;
  dy: number;
  guides: SnapGuides;
}

/// The correction that pulls a move drag onto the nearest lines.
///
/// LANDMINE: `box` must be the layer's AABB at the RAW, un-snapped position. The
/// box depends on the override, the override depends on this result, and this
/// result depends on the box — reading the box after the write is the only
/// ordering of those three that fails to terminate.
///
/// The axes are solved independently, so a drag can land flush against the left
/// edge and vertically centred at once. A single global best — right for
/// `timeline/snapping.ts`, where time is one-dimensional — would make that
/// unreachable.
export function snapMove(
  box: Aabb,
  targets: SnapTargets,
  thresholdComp: number,
): MoveSnapResult {
  const x = snapAxis(axisCandidates(box.left, box.right), targets.xs, thresholdComp, targets.grid?.x);
  const y = snapAxis(axisCandidates(box.top, box.bottom), targets.ys, thresholdComp, targets.grid?.y);
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    guides: { x: x?.at ?? null, y: y?.at ?? null },
  };
}

/// Which axes a resize handle actually drives — `HANDLE_DIR`'s `hx`/`hy` with
/// the zero meaning preserved. Part of the handle's identity, never inferred
/// from an offset that happens to be zero (`gizmoGeometry.handleDrives`).
export interface DrivenAxes {
  x: boolean;
  y: boolean;
}

export interface ScaleSnapResult {
  /// The snapped point to hand to `solveScale`.
  target: Pt;
  guides: SnapGuides;
}

/// Snap a free (non-uniform) resize by moving its TARGET POINT onto the lines.
///
/// Exact at any rotation, flip or aspect, and that is worth knowing because
/// rotation makes it look like it should need a correction: `solveScale` produces
/// `S₁·u = R⁻¹·(target − P)`, so the handle's composed landing point is
/// `P + R·(S₁·u) = target` identically. Snap the point and the handle lands on
/// the line — no second pass.
///
/// Masked by `drives`, and that mask is load-bearing for CORRECTNESS here rather
/// than for cursors — see `gizmoGeometry.handleDrives`.
export function snapScaleTarget(
  target: Pt,
  drives: DrivenAxes,
  targets: SnapTargets,
  thresholdComp: number,
): ScaleSnapResult {
  const x = drives.x ? snapAxis([target.x], targets.xs, thresholdComp, targets.grid?.x) : null;
  const y = drives.y ? snapAxis([target.y], targets.ys, thresholdComp, targets.grid?.y) : null;
  return {
    target: { x: target.x + (x?.delta ?? 0), y: target.y + (y?.delta ?? 0) },
    guides: { x: x?.at ?? null, y: y?.at ?? null },
  };
}

export interface UniformScaleSnapResult {
  /// The snapped uniform factor. Equal to `rawT` when nothing was hit.
  t: number;
  guides: SnapGuides;
}

/// Snap a UNIFORM resize (a `scale_linked` layer, or Shift) by intersecting the
/// handle's ray with a target line.
///
/// Under uniform scaling `S₁ = t·S₀`, so the handle travels `P + t·ray` with
/// `ray = R·S₀·u` fixed at pointerdown — one degree of freedom. A snapped target
/// point is therefore generally unreachable, and least squares would spread the
/// miss across both axes and leave the handle beside the guide it is drawing. So
/// this solves `t` directly, which is exact and one division per line:
///
///   vertical   x = X  ⇒  t = (X − P.x) / ray.x
///
/// At most ONE axis can be hit, since one parameter cannot satisfy two
/// equations. That is not a weaker guarantee than `snapScaleTarget` — it is what
/// one degree of freedom exactly permits, and it is why a linked layer's guide
/// never lies.
///
/// LANDMINE — the distance metric is the resulting DISPLACEMENT `|Δt|·|ray|`,
/// not the perpendicular distance to the line. Using the perpendicular distance
/// explodes as the ray approaches parallel with the line: a layer whose ray is
/// `(0.01, 100)` sitting 5 px from a vertical line needs `Δt = 500`, i.e. a
/// 500× scale-up, from a gesture that asked for a nudge. Measuring the
/// displacement makes a near-parallel ray fail the threshold on its own, needs
/// no epsilon, and makes a zero component harmless — `t` comes out `±Infinity`
/// or `NaN`, and the finiteness check drops it. It also unifies the two
/// branches: for a free resize the along-axis displacement IS the perpendicular
/// distance, so both ask "how far would snapping move the handle?".
export function snapUniformScale(
  pivot: Pt,
  ray: Pt,
  rawT: number,
  drives: DrivenAxes,
  targets: SnapTargets,
  thresholdComp: number,
): UniformScaleSnapResult {
  if (!(thresholdComp > 0)) return { t: rawT, guides: NO_GUIDES };
  const rayLen = Math.hypot(ray.x, ray.y);
  if (!(rayLen > 0) || !Number.isFinite(rayLen)) return { t: rawT, guides: NO_GUIDES };

  let bestT: number | null = null;
  let bestShift = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestGuides: SnapGuides = NO_GUIDES;

  const consider = (
    lines: readonly SnapTarget[],
    origin: number,
    component: number,
    axis: "x" | "y",
    grid?: GridAxis | null,
  ): void => {
    const considerLine = (at: number, rank: number) => {
      const t = (at - origin) / component;
      if (!Number.isFinite(t)) return;
      const shift = Math.abs(t - rawT) * rayLen;
      if (shift > thresholdComp || shift > bestShift) return;
      if (shift === bestShift && rank >= bestRank) return;
      bestShift = shift;
      bestRank = rank;
      bestT = t;
      bestGuides = axis === "x" ? { x: at, y: null } : { x: null, y: at };
    };
    for (const line of lines) considerLine(line.at, SOURCE_RANK[line.source]);
    // On each driven axis, the nearest line in that axis also minimizes |delta t|.
    if (grid) considerLine(nearestGridLine(origin + rawT * component, grid), SOURCE_RANK.grid);
  };

  if (drives.x) consider(targets.xs, pivot.x, ray.x, "x", targets.grid?.x);
  if (drives.y) consider(targets.ys, pivot.y, ray.y, "y", targets.grid?.y);

  return bestT === null ? { t: rawT, guides: NO_GUIDES } : { t: bestT, guides: bestGuides };
}
