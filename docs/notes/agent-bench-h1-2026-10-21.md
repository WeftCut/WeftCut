# Agent bench after H1 — 2026-10-21

What changed once layers are born in a style and the app audits the result
(H1: `graphic_role`, `project://taste`, token defaults, entrance presets that
play, `check_composition`). Compared with the baseline
(`agent-bench-baseline-2026-10-20.md`), same tasks, same fixtures.

## Environment and scope

- App at `64a2f4ca` on the remote host (native addon rebuilt); skill: the H1
  bundle (`.scratch/agent-harness/h1-skill/`). No TASTE.md, so every run is in
  `weftcut-default`.
- Tasks: `interview-title-lower-third`, `explainer-title-lower-third-captions`,
  `explainer-tighten`, `interview-social-cut` × Opus 5.5, Sonnet 5.5,
  Haiku 5.5.
- First batch (`2026-10-21T05-48-03-235Z`): 9 runs, ≈ $5.1. Three stopped at
  the plan waiting for a go-ahead, and the subscription's session limit cut the
  three social-cut cells.
- Re-run with the stand-in user (`ff462048`), bench otherwise unchanged: the
  three stopped cells and the three social-cut cells, 6 runs, ≈ $3.3
  (`2026-10-21T10-14-58-662Z`, `…T10-17-44-866Z`, `…T10-22-24-169Z`,
  `…T10-24-03-657Z`). Below, each cell counts its completed run: 12 cells.
- Results under `apps/desktop/bench/results/`. Each run's `audit.json` is the
  app's own `check_composition` of the final state.

## Intent checklist

Automated items only.

| Task | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| interview-title-lower-third | 9/9 | 9/9 | 9/9 |
| explainer-title-lower-third-captions | 10/10 | 10/10 | 10/10 |
| explainer-tighten | 4/4 | 4/4 — 140.2 s (baseline 3/4) | **4/4** — 142.3 s (baseline 3/4, never found the app) |
| interview-social-cut | 7/7 | 7/7 | **7/7** (baseline 3/7, edited nothing) |

Both baseline engagement failures are gone: Haiku found the open project on
both tasks it missed (ticket 06's trigger and etiquette).

## Text: roles, placement, entrances

Every run that built titles (6 of 6) tagged the title and the lower third with
their roles, and both kept the style's entrance and exit — against 0 of 12
baseline runs with any entrance.

| | Baseline (12 runs) | H1 (6 runs) |
|---|---|---|
| Graphic role on title and lower third | — (field did not exist) | 6 of 6 |
| Intro and outro on both | 0 of 12 | 6 of 6 |
| Title position | centre (y 460–540, over the speaker on the interview) in 9, top in 3 | top (y 172.8, the style's) in 5; centred on a black card before the interview in 1 (Opus, below) |
| Title size | 72–120 px | 96 px in 5; Sonnet 72 px on the interview (flagged `token-drift`, review) |
| Explainer title hold | 2.5–3.0 s | 3.0–5.0 s |
| Lower third hold | 4.0–6.9 s | 5.1–6.7 s |

The style, not the model, now decides the look: three models produced the same
title and lower third. Opus on the interview, once given the go-ahead, did
what it had proposed: it delayed the interview by 4 s for a title card on
black, centred, with the style's size and entrances. That centre position is a
card, not a title over the speaker. The audit does not compare position with
the tokens, so it did not flag the move.

## Captions

The audit's caption rules changed what agents leave: 8 of 9 H1 runs with
captions ended with every caption line at most 42 characters (two-line cues),
against 0 of 12 baseline runs.

- The short social cuts (14–18 cues) got there in one or two
  `apply_transcripts` calls each, with no per-cue edits (longest line 38–41).
- The long tasks got there expensively. In the first batch, Opus and Haiku
  broke lines with 41–42 `update_layer_params` calls, one per cue, and Sonnet
  and Haiku re-applied transcripts with their own segmentation. On the re-run,
  Opus wrote the interview's 46 cues itself through `apply_transcripts`, also
  to fix the names the transcript got wrong (longest line 39, cues 1.8–5.4 s).
- Sonnet's interview run left 28 over-long lines after reading the audit,
  without the tack the skill asks for.

This is the strongest case for the deferred construction step:
`apply_transcripts` should break and segment cues to the caption tokens itself.

## Audit and engagement

- 10 of the 12 runs that edited ran `check_composition` on their own, and their
  final audits were clean except the Sonnet run above.
- **The two that did not are the cut-only task.** Haiku and Sonnet on
  `explainer-tighten` removed pauses and ended the session without an audit.
  `end_agent_session` answered `audit: { state: "never" }` and neither acted on
  it; Sonnet had read the recipe's `audit` stage in the same session. Both
  left fragments the audit would have caught: `short-clip` 14 (Haiku, 75
  clips, shortest 0.32 s) and 19 (Sonnet, 79 clips, shortest 0.24 s). Opus on
  the same task audited and left none under 1 s (47 clips, median 3.4 s). The
  baseline had the same fragments (Sonnet 0.28 s) with no audit to report them.
  A `never` at handoff is too quiet to make an agent audit.
- **The stand-in user** answered in 2 of the 6 re-runs (Sonnet on
  `explainer-tighten` and on `interview-social-cut`); both went on to finish
  the job after one reply. The two cells that stopped in the first batch for
  Opus and Haiku did not stop this time: whether an agent waits for a go-ahead
  varies run to run.
- The Claude driver reported only the last user turn's `num_turns` for a
  session with a stand-in reply (`total_cost_usd` is already cumulative). It
  now sums them. The two affected runs took 18 and 43 turns, not the recorded
  9 and 32.

## Open

- Caption construction: segmentation and line breaks to the caption tokens in
  `apply_transcripts`.
- Audit at handoff: the cut-only runs show that `audit: never` in
  `end_agent_session` does not get an agent to audit. Candidates: run the audit
  there as `start_export` does, or make the skill's handoff step require a
  fresh audit.
- Position is outside `token-drift`; a title card and a title over footage
  need different placements, so this wants a design before a rule.
