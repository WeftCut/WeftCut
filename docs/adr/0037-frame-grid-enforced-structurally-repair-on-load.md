---
status: accepted
---

# The frame grid is enforced structurally, with one leaf implementation, and off-grid data on disk is repaired on load

Date: 2026-07-25

## Context

Composition rate is rational (`{num, den}`), timeline times are integer µs, and
a canonical time is `round(i × 1e6 × den / num)`. Snapping was a per-mutator
convention that nothing checked: trims, `add_transition` and markers each wrote
sub-frame times, and the grid had several implementations — a truncating Rust
`snap_frame_floor` beside a half-up TypeScript `snapFrameFloor` (one name, two
results at fractional rates), plus local arithmetic for ticks, stepping and the
last-frame anchor. TypeScript doubles are not a safe home for the arithmetic: a
24 h timeline at 60000/1001 evaluates `frame × 1e6 × den ≈ 5.18e15`, only 1.7×
under 2^53.

## Decision

- **One implementation.** `time_us_at_frame`, `frame_index_floor/_round/_ceil`,
  `frame_count` and `snap_frame_floor/_round/_ceil` live in `weftcut-eval`
  (i128) and cross the scalars-only wasm ABI; `renderer/frames.ts` is the only
  TypeScript surface (main reaches it through `main/state/snap.ts`). Nothing
  reimplements a primitive.
- **Index policy is separate from output rounding.** Choosing a frame
  (floor / nearest / ceil) is a policy; a boundary's µs value is always half-up.
  There is no truncating variant. The nominal frame length is
  `approxFrameDurUs`, for display and estimates only, never a time step.
- **Validation is the backstop.** The commit validator rejects any layer
  endpoint, `composition.duration_us` or marker time that is not canonical on
  its field's grid. The endpoint grid is chosen per layer kind
  (`gridForLayerKind`), which is how audio sits on the 48 kHz lattice
  (ADR 0038). Grid errors carry `snap_to`.
- **Deliberately unenforced.** `transition.duration_us` / `extended_us` are
  distances, not boundary times (a one-frame transition at 30000/1001 is
  33 367 µs at one cut and 33 366 µs at the next), so only `overlap ==
  duration_us` is enforced. Keyframe `t_us` is snapped on write but not
  enforced: trim and split rebase keys by a delta, and re-snapping would
  dedupe-merge two keys landing on one frame, losing authored data.
- **Repair on load, reject on edit.** `project_open` runs the same validator,
  so `parseProject` snaps every grid-bound field in its single normalize pass
  (`repairGrid` in `main/state/serialize.ts`), re-derives transition durations
  from the repaired geometry, and reports what moved. Negative starts are a
  separate bound (`NegativeLayerStart`), not a grid rule.

## Consequences

- A mutator that forgets to snap fails loudly; the actor-wide property test at
  eight rates (`main/state/__tests__/pbt/grid-invariant.test.ts`) and the
  cross-language golden (`renderer/snapFrameGolden.fixture.json`) gate it.
- Markers quantize (up to half a frame), as in Premiere/Resolve; a transition
  or region below half a frame is refused, not rounded to nothing.
- The repair report is emitted after the workspace commit, because that commit
  rotates the per-workspace LogBus.
- The ruler's tick model (`renderer/timeline/rulerModel.ts`) is windowed to the
  viewport and fed scroll from its own store, not timeline-root React state:
  ~61 nodes at any length instead of 5 184 001 at 24 h. Zoom (`pxPerSec`) is
  still root React state, so ctrl+wheel re-renders the tree.

Rejected: refusing off-grid files on open (older projects would not open); a
TypeScript twin of the primitives (precision ceiling, and twins drift).
