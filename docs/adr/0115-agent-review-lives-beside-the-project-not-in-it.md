# ADR 0115: Agent review lives beside the project, not in it

Status: Accepted

## Context

Agents pointed users at material by writing markers. Markers are the user's
content: persisted, recorded in history, riding clips (ADR 0056). Review marks
written by an agent were indistinguishable from the user's own, could only be
removed one by one, and stayed in the project after their purpose was served.

After agent work the user also had no structural answer to "what differs from
what I last accepted". The activity stream (ADR 0065) is ordered by call, not
by place on the timeline.

ADR 0056 refused a second marker kind because it forks every marker consumer.
That argument assumes the second kind is project content with the same
lifecycle. Review material has a different one.

## Decision

**A Tack is not a marker.** It is runtime agent-review state owned by
the project opening, beside agent activity: not in `Project`, not recorded,
not serialized, not exported, untouched by undo, checkpoint restore and the
history lock. It names a time range whose position is derived when it is
read. No marker consumer
(lane model, `Ctrl+K`, `summary.ts`, serialize, validate) learns that it
exists; it has its own MCP verbs and its own panel. Users do not create or
reply to tacks; they resolve, dismiss, clear, or **convert** one into an
ordinary recorded marker — the single path from review material into project
content.

**A tack follows content, and says when it lost it.** Unless the agent pins
the range to one clip, each end anchors to the clip under it (A-roll first,
then track order) by source time, keeping its timeline time only over a gap and
as the fallback. A ripple moves a tack with its material; a cut inside the
range shrinks it. When the start's material is deleted the tack is stale —
listed, never painted somewhere it no longer means; when the clips it covers
change other than by moving, it is outdated. The agent is told both in the
result of the call that caused it and again when it ends its session, and is
asked to describe content rather than timecodes and to tack after its edits.
This is the web-annotation pattern (a content selector first, a position
selector as fallback, orphaned when neither holds) applied to clip source
time, as OTIO places a clip's markers.

**The Review baseline is owned by `History`.** It is the state the user last
accepted, initialized from the first work session's checkpoint or before the
first agent commit, and advanced only by approval. It is not a checkpoint and
does not depend on one surviving. It lives in `History` because `History`
already patches every stored snapshot with unrecorded preference changes; a
snapshot held elsewhere would drift into false differences. It resets with
history when a project is opened, so neither tacks nor the baseline
outlive a project opening — consistent with history and activity.

**Review compares values, attributes by commit source.** Differences are
entity-level between the effective baseline (base snapshot plus per-entity
approvals) and the current state; preference-shaped fields are excluded.
A difference is an Unreviewed change when any Agent-sourced commit since the
baseline touched the entity — a later user edit does not clear it. Pure
translations of timing are grouped as shifts so a ripple reads as one change.

## Considered options

**Agent-authored markers with a flag or a dedicated colour.** Rejected: still
project content, still in undo, still persisted; the flag forks every consumer
exactly as ADR 0056 warned, and bulk removal becomes a recorded edit.

**Persisting tacks and the baseline.** Rejected: it would write a full
project snapshot to disk and carry it through the schema upgrade chain
(ADR 0047), and contradict history's project-opening scope, on which the fps
rate lock's `locked_by: "history"` release already depends.

**Mapping tack positions through each edit.** Rejected: editors that map
positions through every change (ProseMirror, CodeMirror) work on a
one-dimensional document whose edits are axis operations. Timeline edits are
entity operations; inferring a time-axis map from them is guesswork that
anchoring to content does not need.

**Baseline as a checkpoint.** Rejected: checkpoints are user-visible restore
points; one per approval recreates the clutter this ADR removes, and a user
deleting a checkpoint must not silently change what is under review.

**Synthesizing a baseline project for partial approval.** Rejected: a project
assembled from some approved entities need not validate. The baseline is only
compared, so a per-entity overlay suffices.

## Consequences

- Closing a project with unreviewed changes accepts them without record, as
  closing already discards undo.
- The diff walks both projects; it is computed only while a review surface is
  visible and memoized on baseline and actor revisions.
- Approved entity values bypass the `*Everywhere` patches. This is sound while
  the only patch that rewrites layer timing (fps re-snap) is refused with
  content present; revisit if that lock changes.
- Spatial tacks (regions on the frame) is deferred and will need its own
  decision about coordinates under transforms.
- Tacks paint in a Review lane of their own under the marker lane, not in it:
  sharing the row mixed them with the user's markers and hid them with
  markers. The lane exists while the Review overlay is on and the project
  opening has had a work session or a tack — never by the open-tack count, so
  an agent at work does not reflow the timeline — at a fixed two sub-rows of
  packed chips; what fits in neither is counted in a "+n" badge.
- Approval is refused when the view the user acted on is no longer current
  (an agent committed in between); nothing is approved and the fresh list is
  shown to review again.
