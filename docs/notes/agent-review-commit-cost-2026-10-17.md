# Agent review: per-commit cost — 2026-10-17

Review state (tack placement, the Review view, activity diffs) is derived on
read and re-read after every commit. This records what that cost and the
caching rule that bounds it.

## Measurement

Project with 2000 clips, a 2000-change ripple pending review, 1000 tacks; one
label edit.

| Per commit | Before | After |
|---|---|---|
| Commit with 1000 tacks (main) | 82 ms (4 ms without tacks) | ~7 ms (3.5 ms without tacks) |
| Review view re-diff | +18 ms | ~+4.5 ms |
| Expanded activity re-diff | +15 ms | ~0 ms |
| Review view resent to renderer | 1.2 MiB, ~35 ms parse + highlight rebuild | a version only, when unchanged |

An earlier marker-drag profile (`06cef5a7`) had the same shape: per-item
passes over every layer on every commit.

## Rule that fixed it

- Derived review state is cached per model object in WeakMaps behind each
  module's interface. Immer keeps an unedited object's identity across
  commits, so a commit re-derives only what it touched; nothing is invalidated
  by hand and nothing outlives the snapshots holding its keys.
  - `main/agent/rangePlayback.ts`: per-track time index, per-composition
    transition index, per-layer content times, per-pair verdicts, and each
    playback's last answer per track (unchanged layer objects in range →
    no comparison).
  - `diffProjects`: a modified layer's or marker's `Change` per pair of model
    objects and places; an untouched change is the same object.
  - `History.opDiff`: per pair of snapshots (immutable); only placement on the
    current timeline is redone.
- A cache is valid only while its key determines the answer. A derivation that
  reads something else (a Group layer's nested composition) is not cached;
  `replay` drops its memo over one.
- Transport: tacks are pushed (≤1000, small; only moved ones are published);
  the Review view is pulled with a held `content_revision` and answers
  `ReviewViewUnchanged` while its lists are unchanged. The user-only list has
  its own revision (`content_revision_with_user`), so a user's edit does not
  make the timeline or status bar re-read.
- The first read after a large edit (a ripple of every clip) still pays in
  full; caches bound repeat work only.
