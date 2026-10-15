# ADR 0116: Review diff compares entities without causal inference

Status: Accepted

## Context

ADR 0115 inferred which edit moved surrounding content. Equal translations
became shift groups, carried entities disappeared under a carrier, and approval
could accept entities other than the selected one. Removed footprints and old
positions were reconstructed from neighbouring material. Those explanations
were not facts available from two snapshots and could change with unrelated edits.

## Decision

Review compares the effective baseline and current values by entity identity.
Each entity has its own stable change and is added, removed or modified.
Equal displacements, linked clips, anchored markers and tracks created with a
composition remain separate changes. Approval selects only those entities.
Commit-source attribution, preference exclusions and version-checked approval
remain as defined in ADR 0115.

Timing details report start, end, source start and source end before/after
values. Rates, parameter keys, effect differences and flags are also computed
from the entity's own values. Trim descriptions additionally measure the
layer's own window-edge differences at an unchanged rate. Equal source-window
translations are not trims; without source timing, only nested spans describe
edge cuts/extensions. The raw before/after values remain available. No editing
intent, ripple cause, carrier,
residual motion or operation sequence is inferred.

Current footprints and historical baseline footprints are separate fields.
Removed entities have no current footprint. Their ghosts and row timestamps
are explicitly labelled as baseline positions; locating them uses those
coordinates verbatim. No neighbour mapping or inferred ripple seam is drawn.
Trim cuts retain the original frontend's lane-top red triangles: centred on
the current edge, drawn after clips and the focus wash, with the original
theme-scaled size and pixel clustering. Clicking a mark focuses its first
change; tooltips list each change once. The adapter accepts only measured trim
cuts and cannot produce inferred ripple seams or carried-change annotations.
Focus selects only the entity, with a historical frame when its footprint
changed. Group badges follow explicit composition references.

Activity comparisons retain their historical facts. Only surviving entities'
current footprints are resolved by identity; later edits never rewrite a
historical footprint or manufacture a current location for a removal.

`reviewEntities` owns comparison indexes, equality, touched keys and approval
overlays. `reviewDiff` exposes only entity diff calculation, identity-based
location and Group decoration. Wire types live in `shared/review`; the renderer
formats facts and paints those declared footprints. A change's `keys` is a
single-element tuple, so grouped approvals are not representable.

## Consequences

- A ripple can produce several review rows. Every affected entity remains
  visible and independently reviewable.
- Approving a deletion does not approve clips or markers that moved nearby.
- A historical ghost can overlap current content. Its label explains its
  coordinate system; it does not claim material was removed at that place today.
- The geometry-based movement, carried-change and ripple cut-mark portions of ADR 0115
  are superseded. Tack anchoring and its independent lifecycle are unchanged.
- Regression tests cover entity independence, approval isolation, historical
  position stability, activity projection, Group containment and renderer output.
