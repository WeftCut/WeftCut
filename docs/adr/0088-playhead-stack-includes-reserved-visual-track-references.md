---
status: accepted
---

# Playhead stack includes reserved visual track references

## Context

ADR 0044 deliberately excluded reserved lanes from the Playhead Panel and
clamped its ordering menu to the non-reserved stack. A user could not position
an overlay above, between or below A/B-roll lanes. Showing only their current
clips would leave the same limitation whenever a lane has a gap.

## Decision

The Now playing visual stack merges hidden-track clip rows with persistent
reference rows for reserved A-roll, B-roll and caption tracks, in descending
actual track order. A reference shows its current visual clip, or an empty
placeholder. At a cut the incoming clip owns the reference. Audio-role tracks
are excluded. Nearby remains the time-ordered discovery list of hidden clips.

Reference rows are measured drop targets, never draggable sources. They are
read-only, compact single-line rows showing the track name and current clip or gap.
They share the clip rows' full-width shape, with neutral fill and muted text;
occupied references have no selection action or hover/selection highlight.
Category filters hide content
but retain references and distinguish filtered content from a gap. References
remain separate from clip rows, so a link cannot erase a reserved boundary.

Every listed clip has its own row, including linked clips. Each row keeps its
own category, time information and position in the visual stack. A chain icon
and shared accent identify links without a member count, stacked thumbnails or
disclosure. Restacking addresses only the dragged visual clip; link membership
and the other members' content and timing remain unchanged. Each linked row
retains the Unlink action in its context menu.

`restack_layer` accepts exactly one of `anchor_layer_id` and `anchor_track_id`.
Both resolve stable identity at apply time; track anchors work when empty.
Audio movers, audio anchors, cross-composition anchors and self-track anchors
are refused. Both address forms share movement, splitting, cleanup and no-op
logic. Reserved tracks keep their identity and relative order. No project
schema change is required.

Dragging snapshots the complete stack, including references. It emits no edit
until drop, then one history entry; Escape and pointercancel cancel the gesture.
A hint shows the chosen placement. The existing four menu actions use the
complete visible stack, and explicit above/below actions address each reserved
reference, including empty lanes.

This supersedes ADR 0044's non-reserved menu boundary and layer-only anchor
contract. The editing object remains the clip, not a track-management surface.

## Validation

Renderer tests cover occupied/empty references, filters, pointer drop and the
keyboard menu. State tests cover both wire contracts, refusal without mutation,
one-entry history, undo/redo and no-op semantics. The Electron restack gate
drags an overlay below empty A-roll and checks actual project order and undo.
