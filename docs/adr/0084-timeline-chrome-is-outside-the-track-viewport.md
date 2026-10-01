---
status: accepted
---

# Timeline chrome is outside the track viewport

## Context

Ruler, markers, the add-track strip and tracks shared one scrolling ancestor.
The sticky ruler and overflowing track-height handles competed at the same
stacking level. A real Electron regression reproduced a point on the ruler
hit-testing as a resize handle after vertical scrolling. Editing cursors also
inherited through the common ancestor. DOM row rectangles alone could report
scrolled-out tracks as drop targets over the fixed chrome.

## Decision

The timeline shell has four rows: ruler, markers, add-track strip and a track
viewport that takes the remaining height. The first three rows independently
clip their contents. Only the track viewport scrolls; it clips and isolates all
track editing decorations. Each track and its header are rendered together,
including the paired keyframe sections. Blank space below the last track is
still an explicit selection surface.

The track viewport owns both scroll offsets. Fixed rows consume horizontal
offsets through the existing per-composition scroll store, applying transforms
without re-rendering the track tree. Wheel gestures on the shell continue to
operate that one viewport. Playback draws a separate head in the ruler and a
line in the track viewport, both reading the same projected moment.

Editing cursor state and sample-region pointer capture handling belong to the
track viewport. Height drags highlight only their own handle and use the shared
pointer lifecycle, restoring the original height on cancellation.

Both local and foreign clip drags use `timelineDestination`: the add-track
strip owns only its visible rectangle, while track bands may be resolved only
inside the track viewport and outside its header column. Keyframe sub-lanes
retain their owning track's destination semantics. A foreign spawn preview is
portaled into the add-track strip, where its geometry and clipping belong.
Upward link badges on the first track reserve space inside the track viewport.

This supersedes ADR 0051's inclusion of the add-track strip as a marquee anchor
and its description of a ruler nested under the marquee scroll body. The strip
now accepts drops without starting selection gestures. The ruler, marker lane
and add-track strip are siblings of the editing viewport.

## Validation

The Electron layout regression first failed with `ruler: false` and
`cursor: ns-resize`; after the split it hits the ruler. It also checks fixed
row geometry during height changes, cancellation, horizontal alignment,
sticky headers and marker-row collapse. Existing marquee, keyframe, marker and
drop tests exercise the real gestures. Unit coverage checks destination
visibility, header exclusion and expanded sub-lane bands.
