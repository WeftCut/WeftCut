---
status: accepted
---

# The audit is a craft table of rules with a right answer, and the host remembers it

Date: 2026-10-25

## Context

The first bench (`docs/notes/agent-bench-baseline-2026-10-20.md`) showed what
agents leave unchecked — titles held under 3 s, 80-character caption lines,
0.28 s jump-cut fragments — while every agent reported its work done. A
self-report is not evidence. After H1, agents that never audited were told
`audit: never` at handoff and ended anyway, leaving 14–19 sub-second clips
(`docs/notes/agent-bench-h1-2026-10-21.md`).

The audit then grew rules about how good a cut is (density, pictures vs
words, scene counts, echoes of speech). Each moved the number it counted; the
cuts did not improve. The user, watching five cuts, found that design quality
followed the model and its reviewer, and that weaker models met the counts
instead of the idea (a sticker every 30 s to keep a beat).

## Decision

- **One craft table**, `src/shared/craft.ts`: per rule an id, severity
  (`hard`, `warning`, `review`), threshold and direction, a one-line ask and
  the observed failure behind it. The skill's `craft/rules.md` is rendered from
  it and a test fails when they differ. A style's `tokens.floors` and caption
  tokens tighten a threshold, never loosen it.
- **Only rules with a right answer**: placement (`text-offscreen`,
  `title-safe`, `motif-off-frame`), readability (caption rules, holds,
  `text-pops`, `captions-covered`, `short-clip`) and consistency with the style
  (`undeclared-role`, `role-inconsistency`, `token-drift`). Density, pictures
  vs words and animation are the user's review. `tokens.pace` does not exist.
- **`check_composition`** (read-only) checks a whole composition from project
  data alone; text extents are estimated (layout runs in the renderer), so
  those rules err toward silence. A range narrows the findings returned only.
- **The host remembers** the last result per composition, keyed by a hash of
  the composition and the taste revision, for the project opening.
  `start_export` audits the root unless fresh and reports beside the job.
  `end_agent_session` does the same, and when that handoff audit finds `hard`
  or `warning` findings the session stays open once and the findings go back
  to the agent; ending again with no edit in between ends it. A forced
  takeover is never held. Nothing blocks the user or an export.

## Consequences

- A recipe's `audit.clean` exit is something the app confirms, and a handoff
  says whether the work was checked after its last change.
- Adding a rule is a table row plus its check. Rules that need pixels or
  loudness are not in the audit.
- A dense, sparse or slideshow-like cut reaches the user's review unflagged;
  the bench's density items no longer gate and the bench is a regression check
  (flow runs, cost, audit).
- The removed rules' history stays in the bench notes in case a rule with a
  right answer needs to come back.
