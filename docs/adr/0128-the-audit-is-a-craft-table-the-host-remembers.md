---
status: accepted
---

# The audit is a craft table the host remembers

Date: 2026-10-21

## Context

ADR 0123 asks the app to hold the evidence an agent's loop stops on. The
first bench showed what agents leave behind unchecked — titles held under three
seconds, 80-character caption lines, 0.28 s jump-cut fragments
(`docs/notes/agent-bench-baseline-2026-10-20.md`) — and every agent reported
its work as done. A self-report is not evidence; a check the app runs and
remembers is.

## Decision

**One craft table.** `src/shared/craft.ts` lists each rule with its id,
severity (`hard`, `warning`, `review`), threshold and direction, a one-line
ask and the observed failure behind it. The skill's `craft/rules.md` is
rendered from it and a test fails when they differ, so the prose an agent
reads and the numbers the lint checks are one source. A style's
`tokens.floors` and caption tokens tighten a threshold, never loosen it.

**`check_composition`** (read-only) checks one composition against the table
and the project's merged taste, from project data alone (Q11): undeclared
graphic roles and text wholly off frame are `hard`; holds, missing entrances,
title-safe, caption line length, lines and cue duration, A-roll fragments and
one role in several looks are `warning`; a tagged layer departing from its
role's tokens is `review`. Text extents are estimated from the params, since
layout runs in the renderer; those rules err toward silence. A range narrows
the findings returned; the whole composition is always what is checked.

**The host remembers** the last result per composition with a revision —
a hash of the composition and the taste revision — for the project opening.
`start_export` audits the root unless the last audit is fresh and returns
the summary beside the job. `end_agent_session` does the same, and when that
audit, run at the handoff, finds `hard` or `warning` findings, the session stays
open and the findings go back to the agent. Ending again with no edit in
between ends it, so the agent is held once, to see what it is handing over.
The bench showed why reporting is not enough at the handoff: agents that never
audited were told `never` and ended anyway, leaving 14–19 sub-second clips
(`docs/notes/agent-bench-h1-2026-10-21.md`). Nothing blocks the user or an
export. Attended mode reports (Q10). Blocking on `hard` belongs to unattended
mode (H5).

## Consequences

A recipe's `audit.clean` exit is something the app can confirm, and a handoff
says whether the work was checked after its last change without trusting the
agent. Adding a rule is a table row plus its check; the doc follows. Rules
that need pixels or loudness wait for the look stage (H3). A bare state actor
answers the same tool against the craft table alone, without a style or a
memory.
