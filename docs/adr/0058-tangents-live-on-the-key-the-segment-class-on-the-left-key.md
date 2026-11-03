---
status: accepted
---

# Tangents live on the key, the segment class on the left key

Date: 2026-09-03

## Context

A per-segment easing enum on the left key cannot ask a key to stay smooth: the
two sides of a key are unrelated numbers, so Smooth could only be a one-shot
bake that went stale when a neighbour moved, and an agent got an enum rather
than a per-key shape. Tracks also had no behaviour past their end keys.

Constraints: one generic `eval<T: Interpolate>` shared by the wasm preview, the
native export and the actor; `Rgba` interpolates in OkLab; preset names are
recovered by **exact** f64 reverse lookup, the linked-scale twin check is an
exact compare, and the Rust/TS goldens are bit-identical.

## Decision

- A key carries `in` and `out` tangents `{ x, y, mode: Auto | Free }`,
  normalized to the owning segment's unit square. A Spline segment `a → b` is
  `unit_bezier(a.out.x, a.out.y, b.in.x, b.in.y)`. Normalization makes a
  tangent a shape: it survives retime and value changes, and a preset is the
  same four numbers on every segment.
- `in` is stored **un-mirrored** (the cubic's own second control point); the
  handle at `in − (1, 1)` is presentation only. `1 − (1 − 0.58)` is not `0.58`
  in f64, so a mirrored store would break preset recovery, the twin check and
  the goldens. Identity sides are `1 / 3` and `2 / 3` as expressions, never
  decimal literals.
- **Auto is solved at write time** (clamped monotone) in the actor's track
  normalization, never in the engine, so every reader sees the same explicit
  numbers. `continuity: Smooth | Broken` is maintained by that pass ("out
  wins"), not enforced by validation or the engine. Trim/split/move never
  re-solve.
- `segment` on the left key names the class of `kf[i] → kf[i+1]`:
  `Spline | Hold | Linear | Elastic | Bounce`. Only Spline reads tangents.
- Track-level `extrapolate { before, after }`:
  `Hold | Loop | PingPong | Offset | Continue`, default Hold/Hold. Loop jumps
  back to the first value; nothing bridges it.
- The old record is refused by `parseProject` with a named error, never
  defaulted: a defaulted tangent is silently different motion.

## Consequences

- MCP exposes the record as is (`get_param_track` / `set_param_track`);
  `Interpolation` survives only as one segment's easing value, bridged by
  `segmentEasing` / `applySegmentEasing`.
- Every track write pays one solve pass.
- Colour has no scalar slope: its Auto sides resolve to identity.
- Wasm segment codes: `0` Hold, `1` Linear, `4` Spline, `5` Elastic,
  `6` Bounce; `2`/`3` are retired and never reassigned.
- Record shape and solver details: `data-model.md` § Animated values.

Rejected: Blender absolute `(t, v)` handles (preset identity lost per segment,
4-D colour handles); After Effects speed/influence (undefined for `Rgba`, lossy
on flat segments); solving Auto in the engine (four readers re-derive, disk ≠
screen); auto-bridged Loop (invents a segment, hides the jump); Hold/Linear as
Spline tangent configurations (Hold has no cubic; Linear would need an f64
diagonal test).
