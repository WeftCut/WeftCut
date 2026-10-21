# Agent bench after H1 — 2026-10-21 (partial)

What changed once layers are born in a style and the app audits the result
(H1: `graphic_role`, `project://taste`, token defaults, entrance presets that
play, `check_composition`). Compared with the baseline
(`agent-bench-baseline-2026-10-20.md`), same tasks, same fixtures.

## Environment and scope

- App and bench at `64a2f4ca` on the remote host (native addon rebuilt);
  skill: the H1 bundle (`.scratch/agent-harness/h1-skill/`). No TASTE.md, so
  every run is in `weftcut-default`.
- Tasks: `interview-title-lower-third`, `explainer-title-lower-third-captions`,
  `explainer-tighten`, `interview-social-cut` × Opus 5.5, Sonnet 5.5,
  Haiku 5.5. The subscription's session limit stopped the batch at
  `interview-social-cut`: no social-cut run completed. 9 runs below, ≈ $5.1.
- Results: `apps/desktop/bench/results/2026-10-21T05-48-03-235Z/`. Each run's
  `audit.json` is the app's own `check_composition` of the final state.

## Text: roles, placement, entrances

Every run that built titles (5 of 5 that got past planning) tagged the title
and the lower third with their roles, and both kept the style's entrance and
exit — against 0 of 12 baseline runs with any entrance.

| | Baseline (12 runs) | H1 (5 runs) |
|---|---|---|
| Graphic role on title and lower third | — (field did not exist) | 5 of 5 |
| Intro and outro on both | 0 of 12 | 5 of 5 |
| Title position | centre (y 460–540, over the speaker on the interview) in 9, top in 3 | top (y 172.8, the style's) in 5 |
| Title size | 72–120 px | 96 px in 4; Sonnet 72 px on the interview (flagged `token-drift`, review) |
| Explainer title hold | 2.5–3.0 s | 3.0–5.0 s |
| Lower third hold | 4.0–6.9 s | 5.1–6.0 s |

The style, not the model, now decides the look: three models produced the same
title and lower third.

## Captions

The audit's caption rules changed what agents leave: 4 of 5 H1 runs ended with
every caption line at most 42 characters (two-line cues), against 0 of 12
baseline runs. They got there expensively — Opus and Haiku broke lines with
41–42 `update_layer_params` calls, one per cue; Sonnet and Haiku re-applied
transcripts with their own segmentation. Sonnet's interview run left 28
over-long lines after reading the audit, without the tack the skill asks for.
Cue durations are unchanged (the tools still segment as transcribed).

This is the strongest case for the deferred construction step:
`apply_transcripts` should break and segment cues to the caption tokens itself.

## Audit and engagement

- Every run that edited (6) read the taste and ran `check_composition` on
  its own; final audits were clean except the Sonnet run above.
- **Haiku found the app** on `explainer-tighten`, which it never did in the
  baseline (ticket 06's trigger).
- **Three runs stopped at the plan** and asked for a go-ahead with nothing
  changed: Opus on `interview-title-lower-third` (proposing to add a title
  card before the interview), Sonnet and Haiku on `explainer-tighten`. The
  skill's batch etiquette asks for one; a headless run has no user. The bench
  now answers once in the user's place (`ff462048`, the stand-in user); these
  cells need a re-run.

## Open

- Re-run the three stopped cells and the three `interview-social-cut` cells
  with the stand-in user.
- Caption construction: segmentation and line breaks to the caption tokens in
  `apply_transcripts`.
