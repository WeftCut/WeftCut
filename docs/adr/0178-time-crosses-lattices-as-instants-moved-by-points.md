---
status: accepted
---

# Time crosses lattices as instants, and every layer moves by points of its own

Date: 2026-11-24

## Context

- ADR 0038 puts audio edges on the 48 kHz sample lattice and visual edges on
  the frame lattice. At 29.97/59.94 a frame time is not a sample time, so a
  linked V+A pair that was added or split together has edges a few µs apart.
- The edit arithmetic still took one µs quantity across both lattices: a move
  added a µs delta to every member and snapped each on its own lattice, and
  the ripple planner merged the holes of both kinds into one µs span and
  compared every layer against it.
- That failed in two ways. A ripple delete of the piece before a cut, or a
  `shift_layers` closing it by the video hole, was refused about four times in
  five at those rates (`RippleInsideHole` on the audio piece that starts a
  sample before the video cut, or `RippleCollision` from re-rounding it onto
  its neighbour). And every move re-rounded a pair's residue, so its relation
  in samples could drift by one per move.

## Decision

- **A move is two instants.** `Travel { fromUs, toUs }` replaces the µs
  delta. Each layer moves by `travelSteps`: the distance between the nearest
  points of its own lattice to the two instants, applied to both endpoints by
  index (`travelOnGrids`). A pair's relation in its own points is then an
  invariant of every move, not an approximation.
- **A span is read on each lattice.** A hole, a sweep origin or an insert
  point is compared with a layer through its projection onto that layer's
  lattice (`spanOnGrid`, `snapOnGrid` of the instant), and a ripple closes each
  layer by the points of its lattice that the holes to its left cover.
- **A floor keeps the anchor's instant.** A gesture that floors at 0 restates
  the travel with the same `fromUs` and a `toUs` on the anchor's lattice
  (`floorTravelAtZero`), so the mutation that re-snaps the anchor's landing
  reaches the same travel the ghost drew. The set stops as one body: a pair
  whose earlier member is slipped ahead of its video stops short of 0 rather
  than lose the slip.
- **µs stays the unit.** Timeline times remain integer µs on the wire, in the
  project file and in the MCP contract; the lattices remain ADR 0037/0038's.
  Only the arithmetic between edges changes.

## Consequences

- Linked edits close cleanly at every preset rate, through the timeline's
  ripple delete and through `shift_layers`, and a slipped pair survives any
  number of moves exactly.
- A strict caller (MCP) is refused when the travel's landings, not the µs
  delta, would carry a member before 0.
- Remaining sites that compare or offset edges across lattices in raw µs —
  linked trim alignment, split's spanning test, group create/ungroup offsets,
  paste offsets, marker containment on audio layers, keyframe batch nudges,
  gap detection — follow this rule as they are fixed.
