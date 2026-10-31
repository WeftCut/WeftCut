---
status: accepted
---

# Agent guidance is one app-bundled skill; the app holds the evidence, the client runs the loop

Date: 2026-10-25

## Context

WeftCut is an MCP server. Claude Code, Codex, Claude Desktop and others run
their own loops and prompts, so WeftCut cannot inject a pipeline or own the
loop. Tool descriptions carry per-call contracts; cross-tool process knowledge
(checkpoint first, ask before taking over the UI, the Motif authoring loop)
must reach an end user's agent, which has no repo. Nothing in MCP loads before
the first tool call: prompts are user-invoked, resources are read on demand.

A client-side artifact drifts: the app updates and a stale skill teaches every
connected agent tools that no longer exist, on machines we don't control. Each
link of the delivery chain (an empty copy, an extraResource filter matching
nothing, a startup refresh that cannot tell empty from absent) fails silently.

Bench runs (`docs/notes/agent-bench-*.md`) showed that look follows tool
defaults rather than the model, and that taste rules (density, pictures vs
words) made weaker models meet counts instead of ideas; the user's review of
plan and cut was what held quality.

## Decision

- **One skill**, `skills/weftcut/`, described as "use BEFORE calling any
  weftcut MCP tool". Sibling files (`craft/`, `recipes/`, the Motif docs) are
  disclosed by pointer; no skill series until trigger failures are observed.
- **Boundary rule**: the skill carries only what no tool description can
  (etiquette, composition, process). A skill that must restate a tool's
  contract means the description is too weak — fix it there.
- **Single-sourced, skill version = app version**: `build-skills.mjs` stages
  `skills/` plus the docs in `REQUIRED_DOCS` (copied verbatim, so they link to
  no other doc); it ships as an extraResource and is refreshed to
  `<userData>/skills/` at startup. No marketplace copy. No embedded example
  Motifs: built-ins are read live with `read_motif`.
- **A missing skill is a failure**: `build:skills` and the afterPack gate
  assert shape and version stamp; startup reports `installed` / `stale` /
  `unavailable` with its fault; the panel shows the fault with a retry, and a
  packaged build that is not `installed` raises a retractable startup notice.
- **Names are pinned**: `mcp.skill-conformance.test.ts` checks every backticked
  tool/resource/prompt name and the recipe stage/signal vocabulary against the
  advertised catalog.
- **The app holds the evidence**: style-token defaults, refusals, the audit
  (ADR 0128), the handoff report of `end_agent_session` and the review
  baseline (ADR 0115) work whether or not the client follows the skill. A rule
  sits on the lowest rung that holds it: construction → refusal → lint →
  skill prose → human review.
- **No self-certification, no in-app judge**: the agent's opinion of its own
  work is never an exit condition, and there is no server-side critic or model.
  Taste is the user's review; Motif install waits for the user's approval in
  the app preview, since not every agent can see images.

## Consequences

- A stale client fails loudly on its first call against the catalog instead of
  following drifting prose.
- The harness stays light: one skill, objective checks, human review. Guidance
  is added only when a bench run shows the default it fixes.
- Recipes are skill files with a closed stage/signal vocabulary; no MCP prompt
  is generated from them.

Rejected: MCP-native-only guidance (arrives after the mistakes it should
prevent); a skill series (standing context per description); marketplace-first
distribution (drift on day one); growing the `initialize` instructions into a
harness (they stay ten lines of etiquette); numeric taste scores as a gate;
agent self-review as the Motif install gate.
