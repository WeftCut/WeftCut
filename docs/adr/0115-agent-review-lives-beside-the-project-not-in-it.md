---
status: accepted
---

# Agent review lives beside the project, not in it, and is settled as a whole

Date: 2026-10-17

## Context

Agents pointed users at material by writing markers, which are the user's
content: persisted, recorded, riding clips. Agent marks were indistinguishable
from the user's, removable only one by one, and outlived their purpose. A
flagged second marker kind would fork every marker consumer. After agent work
the user also had no answer to "what differs from what I last accepted"; the
activity stream is ordered by call, not by place.

Per-change approval was tried and cost the most of anything in review: a base
snapshot plus a per-entity overlay (with an "approved as gone" sentinel),
approved values bypassing the `*Everywhere` preference patches, and rules for
what one approval may take along — while offering no way to say "no" except
undo, which steps through time rather than rows.

## Decision

- **A Tack is not a marker.** It is runtime review state of the project
  opening, beside agent activity: not in `Project`, not recorded, serialized or
  exported, untouched by undo, checkpoint restore and the history lock. It has
  its own MCP verbs, panel and Review lane; no marker consumer knows it exists.
  Converting a tack into an ordinary recorded marker is the only path into
  project content. Placement and state: ADR 0117.
- **`History` owns the review baseline**: `{ base, effects, agentTouched }`, the
  state the user last accepted. It starts from the first work session's
  checkpoint or before the first agent commit, and resets with history when a
  project is opened. It lives in `History` because `History` already patches
  every snapshot with unrecorded preference changes; a snapshot held elsewhere
  would drift into false differences.
- **Values are compared, attribution is by commit source.** An entity differs
  when its baseline and current values differ (preference fields excluded); it
  is an unreviewed change when any Agent-sourced commit since the baseline
  touched it. A later user edit does not clear it. The diff itself: ADR 0116.
- **Settled as a whole.** *Approve all* makes the current state the baseline:
  records nothing, not under the history lock. *Revert all* records the
  baseline as the current state — a user restore, one undo step, under the
  history lock like every revert path; the baseline and `agentTouched` stay, so
  undoing it lists the same changes again. Both take the user's own differences
  with the agent's and say so. Both name the view the user acted on and do
  nothing when an agent has committed since. Dropping one change is left to
  editing (undo, or edit it back).

## Consequences

- Closing a project with unreviewed changes accepts them without record, as
  closing already discards undo. Tacks and baseline never outlive an opening.
- The baseline is in effect a private checkpoint: not listed, not deletable,
  and approving adds no checkpoint rows.
- Revert all also discards the user's own edits since the baseline; it is one
  undo away and the tooltip says so.

Rejected: agent markers with a flag or colour (still content, forks
consumers); persisting tacks and baseline (a full snapshot through the schema
upgrade chain, against history's opening scope that the fps rate lock relies
on); baseline as a listed checkpoint (clutter; deleting one would silently
change what is under review); per-change approval or per-change reject (a
per-entity revert is an edit with its own validity problems — overlaps,
transitions, links, ripple gaps); re-pinning the baseline per work session
(two runs before the user looks would hide the first).
