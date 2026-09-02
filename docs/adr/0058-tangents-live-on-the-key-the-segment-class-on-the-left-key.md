---
status: accepted
---

# Tangents live on the key, the segment class on the left key

## Context

An animated parameter is `Animated<T>`: `Static(T)` or a sorted list of
keyframes. The keyframe used to carry one field beyond `(id, t_us, value)`:
`interp`, a per-segment enum stored on the segment's left key —
`Hold | Linear | Bezier{p1, p2} | Elastic{…} | Bounce{…}` — where `Bezier` is a
unit bezier (x = time progress, y = value progress, the CSS `cubic-bezier`
lineage), named presets bake to their canonical `Bezier` params, and the name
comes back by exact-param reverse lookup against an append-only table.

That shape says everything about a segment and nothing about a key. The two
sides of a key are two unrelated numbers in two unrelated enums, so no key can
be asked to stay smooth: the Smooth command was a one-shot bake that wrote
matching tangents into the two adjacent segments and was never re-run when a
neighbour moved. The curve graph's handles were segment handles. An agent
reading `get_param_track` got an enum, not a shape it could reason about per
key. And a track had no behaviour outside its keys — before the first and after
the last it clamped, full stop — while Motifs, text FX and agents all reach for
"keep going", "repeat", "swing back".

Several facts about the ground made the alternative cheap. The engine is one
generic `eval<T: Interpolate>` — segment search, `u` from the segment's timing
function, `T::lerp` — and a unit bezier is four numbers that split naturally
into two per key: the leaving cubic's first control point and the arriving
cubic's second. The wasm ABI is a resident per-property buffer with a segment
code table that already has retired codes. The actor normalizes every track
write through one funnel (frame-snap, sort, dedupe-last-wins), which is exactly
where a solver belongs. `Rgba` already interpolates in OkLab with premultiplied
alpha and clamps at the byte. And there is no released file: `SCHEMA_VERSION`
is 1 and the migration chain is empty.

## Decision

1. **Tangents are per key, per side, and normalized.** A keyframe carries
   `in: { x, y, mode }` and `out: { x, y, mode }`, each a point in the owning
   segment's unit square — fractions of that segment's time span and value
   span. The segment `a → b` evaluates as
   `unit_bezier(a.out.x, a.out.y, b.in.x, b.in.y)`: `out` is the leaving
   cubic's first control point, `in` the arriving cubic's second. The identity
   sides are `(1/3, 1/3)` for `out` and `(2/3, 2/3)` for `in`, written as the
   expressions `1 / 3` and `2 / 3` in both languages and never as decimal
   literals, so the two twins produce the same bits. Normalization is what
   makes a tangent a *shape*: it survives a retime, a value change and a
   time-scale unchanged, and a preset is the same four numbers on every
   segment it is applied to.

2. **`in` is stored un-mirrored.** The handle a user drags on an in-side sits
   at `in − (1, 1)` from the key, and the natural per-key reading of the
   record is "the mirror of `p2`". The stored number is nevertheless the
   cubic's own control point, exactly as the engine consumes it; the
   mirroring is a presentation convention of the curve graph. The reason is
   float exactness: `1 − (1 − 0.58)` is `0.5799999999999999` in f64. Preset
   recovery is an exact-equality reverse lookup, the linked-scale twin check
   is an exact compare, and the goldens are bit-identical across Rust and
   TypeScript; a mirrored store would break all three on the very presets the
   table exists to name. Between the store and the engine there is zero
   arithmetic.

3. **Mode is per side, `Auto | Free`, and Auto is solved when the track is
   written.** Auto is clamped monotone — Blender's Auto Clamped, the feel the
   Smooth command had: the slope through a key is taken from its neighbours,
   forced to zero at an extremum, an endpoint or a sign change, and the
   resulting `y` is clamped to `[0, 1]` so a value never overshoots. The solve
   runs in the actor's write normalization, beside frame-snap, sort and
   dedupe, and never in the engine. Stored tangents are therefore always
   explicit numbers: the curve graph, `get_param_track`, the wasm preview and
   the native export read the same values, and no reader has to know a rule.
   A different Auto flavour later is one more enum value, not a migration.

4. **Continuity is `Smooth | Broken`, maintained by authoring and never
   enforced.** It is neither a validator invariant nor an engine input; it
   says what the normalization does when both sides of a key are Free and
   both adjacent segments are Spline. Smooth then re-derives the in-side's
   slope from the out-side — *out wins* — keeping `in.x` and rewriting `in.y`.
   Out wins because main receives a whole track and cannot know which handle
   moved; the renderer writes both sides itself when the user drags an
   in-handle, so the rule only ever fires when a neighbour edit changed the
   segment's Δv/Δt under an unchanged key. Structural edits — trim, split,
   move — do not re-solve anything: explicit numbers are what keep the motion
   byte-identical on both sides of a cut.

5. **The segment class stays on the left key.** `segment` on `kf[i]` names the
   class of `kf[i] → kf[i+1]`: `Spline | Hold | Linear | Elastic{dir,
   amplitude, period} | Bounce{dir}`. Only Spline reads tangents. Hold is a
   step no cubic represents. Linear is kept as its own class so its glyph and
   its meaning need no f64 test against the diagonal. Elastic and Bounce are
   the procedural escape hatch — parameters instead of handles, evaluated
   closed-form. Sides adjacent to a non-Spline segment hold the identity and
   are ignored; the first key's `in` and the last key's `out` are stored but
   read by no segment. A preset applied to `A → B` writes `A.out` and `B.in`
   as Free and `A.segment = Spline` (or the class, with identity sides, for a
   non-Spline preset), and leaves `B.out` alone, so smoothness downstream of
   the preset survives. `preset_id` is the exact reverse lookup over
   `(this.out, next.in)`.

6. **Extrapolation is a track-level pair.** `Keyframed { value, extrapolate:
   { before, after } }`, each side `Hold | Loop | PingPong | Offset |
   Continue`, default `Hold / Hold` — the clamp. The period is `last.t −
   first.t`; a single-key track never extrapolates. Loop returns to
   `first.value` at `last + period`, a visible jump when the two differ, and
   nothing bridges it — After Effects' `loopOut("cycle")` and Blender's Cycles
   show the same jump. PingPong runs odd periods backwards. Offset adds
   `n · (last − first)` per period in the value type's interpolation space
   (colour in OkLab, clamped at the byte). Continue extends a line at the last
   segment's end velocity, which is zero after a Hold or a procedural
   segment. `before` and `after` are independent.

7. **No migration.** Version 1 is redefined in place: `SCHEMA_VERSION` stays 1
   and the chain stays empty, the pre-release rule `data-model.md`
   § Versioning states. `parseProject` REFUSES the old shape — a key carrying
   `interp` or lacking any of `in`, `out`, `continuity`, `segment`, or a
   keyframed track lacking `extrapolate` — with a named error, and never
   defaults. The additive-field rule that document already records is the
   reason: a field left `undefined` reaches the renderer as a blank screen,
   and a *defaulted* tangent is worse than blank, it is silently different
   motion. The four goldens (edits, f64 eval, Rgba eval, audio envelope) and
   the v1 fixture are rewritten to the new record with every expected value
   unchanged; that identity is the proof the engine refactor preserves shape.
   The wasm ABI keeps its segment codes — `0` Hold, `1` Linear, `4` Spline,
   `5` Elastic, `6` Bounce, `2`/`3` retired and never reassigned — and the
   per-key slot count grows.

## Considered options

**Blender's absolute `(t, v)` handles.** Rejected. A handle in value units
makes a preset a different set of numbers on every segment, so a flat segment
has no recoverable preset identity, a colour needs a four-dimensional handle,
and the engine grows new math for the same curve the unit bezier already
draws.

**After Effects' speed / influence.** Rejected. Speed is undefined for `Rgba`
and unit-dependent for an agent, and the representation is lossy on a flat
segment, where a speed of zero says nothing about the shape. Normalized
tangents are the same information without the units.

**Solving Auto in the engine, or storing continuity as a constraint.**
Rejected. Four readers would each re-derive the slope, the numbers on screen
would not be the numbers on disk, and `get_param_track` would stop being the
truth. Solving once at write time costs a pass over the keys and makes the
stored record complete.

**An auto-bridged Loop.** Rejected. Bridging invents a segment nobody
authored, changes the period, and hides the jump every reference tool shows.
A user who wants a seamless cycle ends the track on its starting value.

**Hold and Linear as tangent configurations of Spline.** Rejected. Hold has no
cubic at all, and Linear would have to be recognised by an f64 test against
the identity sides to draw its glyph. A class on the left key is the exact
answer.

**A migration step.** Rejected. There is no released file to migrate, a step
would freeze a shape nobody has on disk, and defaulting the old record into
the new one would silently re-shape every existing curve.

## Consequences

- **MCP exposes the record itself.** `get_param_track` returns, per key,
  `{ id, t_us, t_local_us, value, in, out, continuity, segment, preset_id? }`
  plus the track's `extrapolate`, and `set_param_track` takes the same shape.
  `set_keyframe_easing` keeps its "segment leaving a key" meaning and writes
  `this.out`, `next.in` and `this.segment`, both sides Free. `smooth_keyframes`
  means "set Auto on the key(s)" — the same word the editor uses. The per-side
  and per-track writers the record calls for, `set_keyframe_tangents` and
  `set_extrapolation`, are the remaining additions.
- **Every track write pays the solve.** One pass over the keys; only Auto
  sides and the in-sides of Smooth keys are rewritten, and a track with no
  Auto and no Smooth is untouched.
- **`Interpolation` survives as the easing of ONE segment as a value** — what
  the preset table holds and what `set_keyframe_easing` takes — and two pure
  bridges (`segmentEasing`, `applySegmentEasing`) map it onto `(left.out,
  right.in, left.segment)` and back. Nothing else reads it.
- **A value type with no scalar order has no slope to solve.** Colour's Auto
  sides resolve to the identity numbers with their mode kept; only its
  extrapolation is type-specific (Offset and Continue in OkLab, clamped at the byte).
- **Spatial motion paths remain the one future chain step.** `Animated<Vec2>`
  merges two tracks rather than adding fields, and no in-place redefinition
  covers that.
