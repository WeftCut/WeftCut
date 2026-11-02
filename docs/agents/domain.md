# Domain Docs

Single-context repo: one `CONTEXT.md` at the root, decisions in `docs/adr/`.

## Before exploring, read these

- **`CONTEXT.md`** — the glossary. Terms, one-line meanings, relations.
- **`docs/architecture.md`** — the map: processes, where each area lives, which topic doc owns it.
- **`docs/adr/`** — the ADRs that touch the area you're about to work in.

## Where knowledge goes

Put each fact in exactly one place; link to it from elsewhere.

| What | Where |
|---|---|
| A domain term and what it means | `CONTEXT.md` (no implementation, no history) |
| What a capability does for the user | `docs/features.md` |
| How a subsystem works now: invariants, contracts, non-obvious behavior | the topic doc in `docs/` |
| A decision that passes the ADR bar below | `docs/adr/NNNN-*.md` |
| A measurement, experiment, rejected approach, or engine/platform fact | `docs/notes/` (dated, with environment and probe) |
| Anything the code, types or tests already say | nowhere — don't restate it |

Docs describe the present. No "used to", changelogs or plans; git and issues hold those.

## The ADR bar

Write an ADR only if **all** hold:

1. **Hard to reverse** — changing it later costs real migration or rework.
2. **Surprising without context** — a reader of the code would plausibly "fix" it back.
3. **Forced** — by a constraint, a measurement, or a real trade-off, not a taste call or an arbitrary pick.

Otherwise put the content in the topic doc or a note. When a decision changes, rewrite the existing ADR or delete it; don't stack an amendment ADR on top. ADR numbers are never reused; gaps are fine.

Format: frontmatter `status: accepted`, `# Title`, `Date:`, then `## Context` (the constraint, with numbers), `## Decision`, `## Consequences`. Target ≤ 60 lines, hard cap 100. No implementation narration, file lists or build history.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a proposal, a test name), use the term as `CONTEXT.md` defines it. If the concept isn't there, either you're inventing language the project doesn't use (reconsider) or there's a real gap (add the term).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0023 (audio mixes by role) — but worth reopening because…_
