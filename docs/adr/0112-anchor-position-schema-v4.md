---
status: accepted
---

# Position is the transform anchor for all visual clips

Date: 2026-10-12

## Context

Media and Group Position described the unrotated top-left while Text Position
described the anchor. Inspector Scale and on-canvas resize therefore behaved
differently, and a resize gesture needed Position compensation, adding
position keys when the user only meant to scale.

## Decision

- Schema v4: Position is the anchor's composition-space location for every
  clip with a Transform. `world = Position + R·S·(local − anchor·naturalSize)`.
  Scale writes only scale; rotation only rotation.
- Moving the on-canvas anchor compensates Position by `R·S·deltaPivot` (picture
  stays put); a numeric anchor edit leaves Position fixed (content moves).
- New media and Motifs initialize Position to half the source size so their
  footprint is unchanged; plain Groups use half the referenced composition
  size (their identity transform). Text is created centred. Crop and proxy
  dimensions never redefine the anchor.
- The v3 → v4 step translates constant offsets and bakes XY where scale or
  anchor is animated. It is import-free; the host injects source sizes and the
  frozen **v3 numerical evaluation** contract, never current defaults. It
  refuses missing source sizes rather than guessing from proxies.
- Opening an upgraded file first writes and verifies a byte-identical
  `project.pre-vN.json`; failure refuses the open.

## Consequences

- Baked clips match per frame, not between samples or after later retiming;
  each bake is logged.
- Future evaluator changes must keep a v3-compatible evaluator for this step.
- Migration details: `data-model.md` § v3 → v4 Position migration.
