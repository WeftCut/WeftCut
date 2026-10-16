# ADR 0118: Review pays per commit only for what the commit touched

Status: Accepted

Builds on [ADR 0115](0115-agent-review-lives-beside-the-project-not-in-it.md),
[ADR 0116](0116-review-diff-compares-entities-without-causal-inference.md) and
[ADR 0117](0117-a-tack-is-outdated-when-its-range-plays-differently.md): what
they derive is unchanged; this records how its cost is bounded.

## Context

Review state is derived on read and re-read after every commit. Each tack is
replayed against the new snapshot. The Review view is re-diffed and pulled
by the renderer, which also re-reads a selected activity's diff. Measured on
2000 clips with a 2000-change ripple pending and 1000 tacks, one label edit
cost 82 ms in main against 4 ms without tacks. The Review view added 18 ms,
an expanded activity another 15 ms, and every commit resent the 1.2 MiB view
for the renderer to parse and rebuild its highlight (about 35 ms more). An
earlier marker-drag profile (`06cef5a7`) showed the same shape: per-item
passes over every layer on every commit.

## Decision

Derived review state is kept per model object, in WeakMaps behind each
module's interface. Immer keeps an unedited object's identity across commits,
so a commit re-derives only the objects it touched. No cache is ever
invalidated by hand, and none outlives the snapshots holding its keys.

- **Tacks** (`main/agent/rangePlayback.ts`) are indexed and remembered per
  object:
  - a track's layers are indexed by time, and a composition's transitions
    by layer;
  - a layer's content times are kept, since exact arithmetic is the dearest
    part;
  - the verdict on two objects of one layer is kept;
  - each playback's last answer is kept per track. A replay over tracks that
    still hold the same layer objects in its range answers without
    comparing anything.
- **Review diff** (`diffProjects`) keeps a modified layer's or marker's
  `Change` per pair of model objects and their places. A commit re-compares
  only what it touched, and an untouched change is the very same object.
- **Activity diffs** (`History.opDiff`) keep each run's diff per pair of
  snapshots, which never change. Only placing the changes on the current
  timeline is redone.
- **Transport:** the Review view carries a `content_revision` that moves only
  when what its reader reads does. The unreviewed list, the decorations and,
  when asked for, the user-only list each count. A reader sends the revision
  it holds and gets `ReviewViewUnchanged` (version and counts) while the
  lists are still those. A user's own edits move only the revision that
  includes the user-only list, so the timeline and status bar, which don't
  ask for it, re-read nothing.

Tacks stay pushed and changes stay pulled. A tack is small, there are at most
1000, and a commit changes few: main publishes only the tacks whose placement
moved. The Review view is large and wanted only while a surface shows it.
Pulling it with a held revision lets an unread view cost nothing and a read
one cost a version.

## Consequences

- Measured in the scenario above, per commit:

  | | Before | After |
  |---|---|---|
  | Commit with 1000 tacks | 82 ms | about 7 ms (3.5 ms without tacks) |
  | Review view | +18 ms | about +4.5 ms |
  | Expanded activity | +15 ms | about +0 ms |

  A commit that changes nothing a reader reads now sends a version instead of
  the lists.
- A cache is correct only while what it is keyed on determines its answer.
  Each cache documents its key. A derivation that reads something else (a
  Group layer's nested composition) is not cached; `replay` drops its memo
  over one.
- A first read after a large edit (a ripple of every clip) still pays in full.
  The caches bound repeat work, not the first diff.
