# Agent bench after H6 — 2026-10-25

The H5 tasks again, with the plan stage built on how editors plan a video
(`agent-editing-pipeline-2026-10-24.md`). The user asked to judge the cuts,
not the plans. Since H5:

- **The recipe plans in five steps** (`a6bb030a`):
  1. brief;
  2. outline with a visual budget, then gate 1;
  3. AV script;
  4. storyboards as fixed text frames;
  5. a review in order, then gate 2.

  Build places each element as its frame says. Before removing pauses, the
  agent checks them against her words.
- **The bench holds the edit until the plan is approved** (`8536dbf1`).
  - Under the three tasks' `plan_gate`, the proxy refuses calls to tools
    that change the project until the stand-in user's go-ahead.
  - The stand-in answers both gates.
- **Callouts leave with their picture** (`callout-outlives-picture`,
  `4653eca4`).
- **Motif frames no longer drop in export** (`daed977b`, from main).

## Environment and scope

- **App.** `e4b8e42e` on the remote host.
- **Skill.** The repo's `skills/weftcut` at `8536dbf1`.
- **Runs.** One run each, as in H5:
  - Opus 5.5, Sonnet 5.5 and DeepSeek Flash on all three tasks;
  - Haiku 5.5 on the default task.

  $37.95 in all.
- **Results** are in `apps/desktop/bench/results/`:
  - `2026-10-24T14-39-36-819Z`: Opus and Sonnet;
  - `2026-10-24T16-37-42-759Z`: Haiku;
  - `2026-10-24T16-46-31-472Z`: Flash.
- **Exports.** Each run was exported with that run's own Motifs, copied
  into the export profile. They are in `.scratch/agent-harness/checkpoint10/`,
  with a contact sheet every 5 s, and on the remote host in
  `Desktop\h6-review` next to each run's `plan.md`.
- **Dropped frames.** None in all ten exports.

## Results

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 | DeepSeek Flash |
|---|---|---|---|---|
| **Cost, pictures / default / dense** | $8.98 / $8.60 / $9.64 | $3.70 / $3.06 / $2.70 | — / $0.62 / — | $0.21 / $0.24 / $0.21 |
| **H5 cost** | $4.79 / $6.91 / $8.36 | $2.73 / $2.08 / $2.97 | — / $0.38 / — | $0.15 / $0.23 / $0.23 |
| **Checklist fails** | none | default: callouts, one short clip; dense: one short clip | callouts, drawn-as-motifs | default: 9 short clips |
| **Final audit** | clean, or one `bare-jump-cuts` | clean, or one short clip | clean | clean, or 9 short clips |
| **Writes refused before approval** | 0 | 0 | 1 (`remove_pauses`) | 1–2 a run (`remove_pauses`, `split_layer`, `add_track`) |

- **Gates.** Every run stopped at gate 1 and was sent on to the
  storyboards, except Flash on the pictures task, which showed storyboards at
  its first stop.
- **`callout-outlives-picture`** is in no final audit.

**What she says is kept.** Every run lowered the pause threshold, to
0.0015–0.006. Counted against the source transcript, as whole words cut
from mid sentence:

| | H5 | H6 |
|---|---|---|
| Opus | 8–15 | 7–9 |
| Sonnet | 7–26 | 8–12 |
| Haiku (default) | 47 | 5 |
| Flash dense | 47 | 13 |
| Flash pictures / default | 7 / 18 | 16 / 19 |

About seven words count as cut in every run, the best included, so they
are likely the transcript's timing error. Flash's default cut (19) is the
one to listen to.

**The city walk.**

| Run | City-walk animation | Its own network |
|---|---|---|
| Opus pictures | `route-map` | `memory-network`, not the example's |
| Opus default | `clipping-walk-to-map` | no, the example |
| Opus dense | `clipping-city-map` | no, the example |
| Sonnet pictures | `city-walk-to-map` | no, the example |
| Sonnet default | `clipping-route` | no, the example |
| Sonnet dense | none: `clipping-network` reused (151–180 s) | no, the example |
| Flash pictures | `clipping-consolidate`, 8 s only | no, the example |
| Flash default | `route-map` | no, the example |
| Flash dense | `city-map` | no, the example |
| Haiku | none: `clipping-network` reused (155–173 s) | no; the example placed twice in a row as well (12–60 s) |

H5 had four network reuses for the walk; H6 has two (Sonnet dense, Haiku).

**From the contact sheets** (a first look; the user's review follows):
- **Opus, default task.**
  - A Henry Molaison scene: portrait, a brain with both hippocampi marked
    BOTH REMOVED, and NEW: LOST / OLD: KEPT.
  - A walk animation: landmarks collected on a film strip, then the grid
    map.
- **Flash, default task.**
  - Its Henry Molaison scene is thin: a silhouette, a small brain, small
    labels, much empty paper.
  - Its walk animation is a few lines on bare kraft.

## Open

- **The user's review of the ten cuts.**
- **Cost.** Opus costs 1.2–1.9× H5 and Sonnet 0.9–1.5×, mostly from the plan
  stage.
- **Reuse remains.** Sonnet dense and Haiku still reuse the network example
  for the walk. The ablation without the example is next.
