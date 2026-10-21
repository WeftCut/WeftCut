---
status: accepted
---

# Motif file updates accept exact-match edits

Date: 2026-10-21

## Context

ADR 0094 gave clients without a shared filesystem `update_motif_files`, whose
text entries replace a whole file. The first agent bench
(`docs/notes/agent-bench-baseline-2026-10-20.md`) ran every Motif task through
that route: the app was on another machine, so each agent, following the skill,
started an empty draft. Every fix after a preview resent the complete
`index.html` (5–10 KB per round), where a file-tool client would have sent a few
hundred characters. The cost grows with package size and rounds, and it falls
on exactly the clients that cannot use a working folder.

## Decision

A `update_motif_files` entry may carry `edits: [{old, new}]` instead of `text`,
`file_id` or `delete`. Edits apply in order to the file's current UTF-8 text;
each `old` must occur exactly once in the text the previous edit left. A miss
or an ambiguous match refuses the whole batch, naming the file and the edit, so
nothing is half applied. Edits need an existing file; creating one still uses
`text`. Everything else in the transaction — expected revision, whole-package
validation, write-through and rollback for linked drafts — is unchanged.

The skill teaches edits for partial changes, and tells an agent unsure whether
the app can read its folder to try the directory source once before falling
back, since a refused `open_motif_draft` is the only reliable test.

## Consequences

The file-only route costs about what a file-tool edit costs, so the choice
between a working folder and app-owned drafts no longer decides the token bill.
Exact-once matching mirrors the edit tools agents already use; there is no
regex, line-number or fuzzy form. Binary files still go through transfers.
