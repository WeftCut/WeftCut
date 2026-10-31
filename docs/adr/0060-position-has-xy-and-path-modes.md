---
status: accepted
---

# Position has XY and path modes, not two synchronized representations

Date: 2026-10-04

## Context

Independent X/Y animation with arbitrary per-axis easing cannot, in general,
be represented by a small synchronized set of spatial keys without changing
the motion. An `Animated<Vec2>`, or XY and a path kept in sync, would mean
hidden lossy conversions and two competing sources of truth.

## Decision

- `PositionAnimation` is exactly one of `XY { x, y }` or
  `Path { path: { nodes }, progress }`. XY is the default; the user switches
  explicitly. Path geometry has no timestamps; `progress` (0–1 by arc length)
  is a scalar track using the normal temporal tangents.
- Switching modes never invents motion: XY → Path starts with one node at the
  current position and static progress 0; a single-node path returns to XY
  exactly in one undoable edit.
- Multi-node conversion is explicit, previewed and undoable: least-squares
  cubic fitting against a pixel error target, measured at frames,
  quarter-frames and key boundaries. No lossless round trip and no
  continuous-time guarantee is claimed; instantaneous jumps are refused; a
  target missed at node/key/frame-grid limits disables Apply.
- Progress extrapolation is Hold/Loop/PingPong only (Offset/Continue refused).
- Limits: 128 path nodes, 4096 keys per temporal track.
- Conversion math lives in Rust (`weftcut-conversion`, linking `weftcut-eval`),
  so there is one implementation of playback math and no TS numerical twin.

## Consequences

- Conversion needs allocation, so it is a separate std Wasm module, keeping
  the playback module small and allocation-free. `weftcut-eval`'s `hosted`
  feature drops its standalone exports when linked into conversion; the two
  Wasm artifacts must be built in **separate cargo invocations** or feature
  unification breaks the playback module (`scripts/build-eval-wasm.mjs`).
- Conversion runs in a disposable Worker (`render/runPositionConversion.ts`);
  cancellation terminates it and frees its linear memory.
- The arc-length table is evaluated in the Rust eval leaf and shared by
  preview and export.
- Record, node modes and editing ops: `data-model.md` § `Transform`.
