# ADR 0119: Review is settled as a whole

Status: Accepted

Supersedes the per-change approval of
[ADR 0115](0115-agent-review-lives-beside-the-project-not-in-it.md) and
[ADR 0116](0116-review-diff-compares-entities-without-causal-inference.md),
and with it the per-entity approval overlay. The baseline's ownership,
lifecycle, attribution, the version guard and entity-level comparison are
unchanged.

## Context

The Changes tab offered Approve on each row and Approve all, and no way to
reject. Rejection was left to undo and checkpoint restore, which step back
through time rather than through rows, so nothing on a row answered "no".
A per-row Approve was then only a tick on a reading list, and it cost the
most of anything in review: the baseline became a base snapshot plus a
per-entity overlay (with an "approved as gone" sentinel), the comparison had
to merge the two, approved values bypassed the `*Everywhere` preference
patches (a documented caveat), and ADR 0116 needed rules for what one
approval may and may not take along.

The two whole-list actions also disagreed with what the tab showed. Approve
all made the current state the baseline, so it took the user's own
differences with the agent's, while "show my changes" rows offered no action
at all and the button counted only the agent's.

## Decision

The list is settled as a whole, by two actions that compare whole states:

- **Approve all** makes the current state the baseline. It records nothing,
  changes nothing in the project and is not under the history lock.
- **Revert all** records the baseline as the current state — a checkpoint
  restore to it, by the user, undoable as one step. As a revert path it is
  under the history lock, like undo and checkpoint restore. The baseline and
  the set of agent-touched entities stay as they were, so undoing the revert
  lists the same changes again; the restored entry carries the baseline's op
  lineage, so the agent calls it took back read as reverted.

Both take the user's own differences with the agent's, and both say so.
Both name the view the user acted on and do nothing when it has moved on.

The baseline is one whole snapshot plus the agent-touched set — in effect a
private checkpoint. It is still not a listed checkpoint: the user cannot
delete it, approving does not add rows to the checkpoint list, and it keeps
attribution a checkpoint does not have.

Dropping one change is left to editing: undo it, or edit it back. Restoring a
single entity to the baseline would be a new edit that must keep overlaps,
transitions, links and ripple gaps valid; review does not author edits.

## Considered options

**Keep per-change approval and add per-change reject.** Rejected: a
per-entity revert is an edit with its own validity problems, and the
approval overlay with its patch caveat stays.

**Drop approval; re-pin the baseline at every work session.** Rejected: two
agent runs before the user looks would hide the first run's changes, and
agent edits outside a session would never clear.

**Approve all creates a checkpoint and the baseline points at it.**
Rejected for the reasons ADR 0115 gave: the checkpoint list fills with one
snapshot per approval, and deleting one would silently change what is under
review.

## Consequences

- `History` keeps `{ base, effects, agentTouched }`; the comparison is two
  plain projects. The `*Everywhere` patches reach the baseline as they reach
  every snapshot, with no exception.
- `review_approve` is gone; `review_revert_all` joins `review_approve_all`
  under the same version guard. A refused action says which one did nothing.
- Reverting discards the user's own edits since the baseline as well. It is
  one undo away, and the button's tooltip says it.
