# ADR 0116: Review diff compares entities without causal inference

Status: Accepted

Per-change approval, and with it the approval overlay and approval isolation
below, is superseded by [ADR 0119](0119-review-is-settled-as-a-whole.md):
review is settled as a whole.

## Context

ADR 0115 inferred which edit moved surrounding content. Equal translations
became shift groups, carried entities disappeared under a carrier, and approval
could accept entities other than the selected one. Removed footprints and old
positions were reconstructed from neighbouring material. Those explanations
were not facts available from two snapshots and could change with unrelated edits.

## Decision

Review compares the effective baseline and current values by entity identity.
Each entity has its own stable change and is added, removed or modified.
Equal displacements, linked clips and tracks created with a composition remain
separate changes. A marker tied to the same clip on both sides is placed by its
anchor — the model's truth, `t_us` being a cache re-derived from the clip — so
it compares the source instant it names and a region's length: a marker riding
along with its clip is not a change (the clip's change says the clip moved),
while one moved within its clip is timing and reports its times. Tying,
untying or re-tying is placement. Approval selects only those entities.
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
Timeline start and end compare only within one composition: across a move to
another composition the two values sit on different clocks and are not the
same quantity, so such a move reports the composition (and any source-window
difference) alone. A point marker has no end value. A removed entity carries
its own baseline name (`before_name`: label, media or text name), since the
current project can no longer name it.
Wording repeats no fact: an edge measured as a trim is said by the trim alone
(its raw values stay on the change), and a row whose words state its whole
current place (both edges, or a point's start) shows no second notation for it. Otherwise a row gives its
place in the seconds its facts speak ("Cut 0.5 s from the start · Now 2.5 –
4.0 s"), the timecode only as that line's tooltip. A track row says it is a
track.

Current footprints and historical baseline footprints are separate fields.
Removed entities have no current footprint. Their ghosts and row timestamps
are explicitly labelled as baseline positions; locating them uses those
coordinates verbatim. No neighbour mapping or inferred ripple seam is drawn.
Because content may now occupy a removal's baseline place (a ripple closes
up over it), the historical footprint is drawn apart from current ranges
wherever it appears: the mini timeline paints it as a solid block in the removed
hue, in a row of its own under the current change band, for every removed kind,
markers and transitions included — running past the film's end, shaded, when
a footprint lies there, while seeking stays inside the film; and a focused
or hovered ghost lifts over the clips as its dashed edge alone, taking no
press — focused, named "removed" with its seconds in its corner: the
removed-hue twin of a move's "before" box, with no fill or hatch over the
clip that may now sit there (that would say it was the one removed).
Unfocused, a removed clip is never invisible: a thin removed-hue edge along
its lane's top spans its baseline stretch over the clips — the lane-top red
of the trim marks — without a box that would claim the clip now there was
removed; while that removal is focused its named box says it, and the edge
steps aside. Focusing a removal whose ghost has no lane (its track is gone), or
one with no ghost (a marker, a transition), washes its footprint across the
lanes hatched in the removed hue instead of the solid current-range wash. Under an activity's highlight the comparison is
against the project before that call, and ghosts and historical marks say
"before this call" rather than "baseline". A Group clip's "contains changes"
stretch paints under the changes' own marks, and its badge counts timeline
content (layers, markers, transitions), not tracks or links inside.
Trim cuts retain the original frontend's lane-top red triangles: centred on
the current edge, drawn after clips and the focus wash, with the original
theme-scaled size and pixel clustering. Clicking a mark focuses its first
change; tooltips list each change once. The adapter accepts only measured trim
cuts and cannot produce inferred ripple seams or carried-change annotations.
Markers are notes about the material, so the marker lane marks them lightly:
a changed marker wears a thin ring in its class hue around its glyph, leaving
its authored colour alone, and a removed one leaves a faded trace in the
removed hue at its baseline place, its baseline name struck through, under the
live marks; a click on the trace focuses its change. A marker gets no
historical bracket — its row says where it was.
Focus selects only the entity, and every other clip dims while a change is
focused, so the focused clip is the one lit thing. When its footprint changed,
its baseline place is a dashed box the shape of a clip in the neutral focus
hue, named "before" (with its seconds) in its corner, over the dimmed
neighbours — a layer over the timeline rather than a cut through the clip now
there. Because the rest is dimmed, the focus ends with the look: approving the
change or a press on the lanes anywhere but the focused clip lets it go; a
press on the focused clip keeps it, so it can still be selected and trimmed.
Esc on the timeline is left to its existing owners. Group badges follow explicit composition references.

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
