# Agent bench after H1 — 2026-10-21

The baseline tasks (`agent-bench-baseline-2026-10-20.md`) rerun once layers
are born in a style and the app audits the result (`graphic_role`,
`project://taste`, token defaults, entrance presets that play,
`check_composition`).

## Environment

App `64a2f4ca` on the Windows bench host; H1 skill bundle; no TASTE.md (every
run in `weftcut-default`). Four tasks × Opus/Sonnet/Haiku 5.5, 12 cells
(6 re-run with the stand-in user). ≈ $8.4. Each run's `audit.json` is the
app's own `check_composition` of the final state.

## Findings

- **Engagement**: every cell passed its intent checklist; both baseline
  engagement failures were gone (trigger and "work on the open project"
  etiquette).
- **Style decides the look**: 6 of 6 title runs tagged roles and kept the
  style's entrance and exit (baseline 0 of 12); titles at the style's top
  position and 96 px; explainer title holds 3.0–5.0 s (baseline 2.5–3.0 s).
  The audit does not compare position with tokens, so a deliberate centred
  title card was not flagged.
- **Captions**: 8 of 9 runs ended with every line ≤ 42 chars (baseline 0 of
  12), but long tasks got there with one `update_layer_params` per cue (41–42
  calls) or by re-segmenting themselves — the case for `apply_transcripts`
  building cues to the caption tokens (since done).
- **Audit at handoff**: 10 of 12 editing runs audited on their own. The two
  that did not were cut-only (`explainer-tighten`): `end_agent_session`
  answered `audit: { state: "never" }`, both ended anyway and left 14 and 19
  `short-clip` fragments (shortest 0.24 s). A `never` is too quiet; this is why
  the handoff now runs the audit and holds the session once (ADR 0128).
- Whether an agent waits for a go-ahead at the plan stage varies run to run.
- Bench fix: the Claude driver reported only the last user turn's `num_turns`
  for sessions with a stand-in reply; it now sums them.
