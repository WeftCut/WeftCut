---
status: accepted
---

# The status bar answers three questions

Date: 2026-11-14

## Context

The editor's status bar grew one pill per source: a background export, the
work pill, unreviewed agent changes, Not saved, a System badge for
environment notices, an update offer and a Logs toggle carrying the error
count. Each was right on its own; together they read as a row of unrelated
colours. Several led to the same place twice (Not saved and the System badge
both opened the System panel, whose first card was the save failure), the
error count sat on a button separate from the log line it explained, and in
agent mode, which has no status bar, environment notices and update offers
were not visible at all.

The header has no room to take any of this over: the search box is
right-aligned, about 90 px are free at the minimum window width, and a
display-capped layout theme switches to compact chrome.

## Decision

The bar answers three questions, one element each:

- **What just happened** — the log line. Its leading segment (level dot,
  time, source, chevron) is the button that opens the console, a target
  whose width does not follow the message; the message only reads. Errors
  since the console was last open show as a red count in place of the level
  dot.
- **What is running** — the work pill. The background export joins it as the
  first group instead of keeping a pill of its own.
- **What needs me** — the bell. It opens the notification center, a flat list
  of what needs the user and has no entry of its own: agent changes to review,
  environment notices, an offered update. Its dot is the most severe item not
  dismissed; it carries no number, because most items are states, not
  messages.

Colour carries severity and nothing else.

One exception: **Not saved** keeps a place in the bar, beside the bell, with
its own popover holding the recovery actions. It must never be missed, and a
row among the bell's could be. It is not also listed in the bell; one problem
has one way in.

Dismissal ("Got it", "Later") folds a row and clears its share of the dot. It
lasts while its cause stands: a notice dismissed stays dismissed until main
settles a notice set without it, and an update dismissed stays so for that
version only. Dismissals are main-owned app settings, so they survive
restarts; review items cannot be dismissed, they leave once reviewed.

In agent mode the titlebar carries the same Not saved pill and the same bell,
their popovers dropping down in place.

## Consequences

- The System status panel, the review badge, the System badge, the update
  pill, the standalone export pill and the Logs toggle are gone. An update
  offer also marks the Help menu.
- The bar's right side is at most three items, so it fits the minimum window
  at every layout theme; the log line truncates instead.
- Recovering from a failed save no longer leaves agent mode.
- A notice whose cause comes and goes within one run stays dismissed until the
  next settled notice set without it; only startup and the agent Skill
  reinstall settle one today.
