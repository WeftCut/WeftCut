# Agent bench baseline — 2026-10-20

The first bench run of ADR 0123's harness: what three Claude models do with
WeftCut **before** any craft rule, recipe or style exists. It is the reference
every later harness change is measured against, and the source of the first
`craft/` entries.

The short version: on the machine-checkable intent of each task the models are
close, and where they miss it is engagement (finding the app at all), not
quality. On **look**, there is no model gap to speak of — every model lands on
the same tool defaults: white system-sans text with a black outline, no plate,
no entrance, captions exactly as the transcription tool emits them. The style of
a WeftCut edit today is decided by tool defaults, not by the model. That makes
"correct by construction" (style tokens as tool defaults, ADR 0123) the lever
with the most reach, and it says the anti-pattern list should be written
against those defaults.

## Environment and scope

- Branch `feat/agent-harness-h0` (bench at `abaf0856`); the app on the remote
  host at `233a732b` (no app-code difference).
- Skill under test: **main's** shipped bundle (`skills/weftcut` at `e3c184dc`,
  staged by `build:skills`), i.e. before the craft/recipe layers and the Motif
  scope rule. Snapshot kept in `.scratch/agent-harness/baseline-skill/`.
- Agent: Claude Code 2.1.304, headless, isolated workdir, default effort per
  model; MCP over an ssh tunnel. App host: Windows 11, i5-13400, 32 GB,
  RTX 3050 (d3d11va decode, app in the interactive session).
- Fixtures: `talking-head-interview` (CC BY 4.0, 2:31) and `explainer-memory`
  (CC BY-SA 4.0, 3:35), both transcoded to H.264/AAC MP4, `direct-export`
  route; each run starts from a copied project template (media wait 0 s).
- Six tasks × Opus 5.5, Sonnet 5.5, Haiku 5.5 × 1 run = 18 runs, sequential,
  54 min wall clock. Results:
  `apps/desktop/bench/results/2026-10-20T18-06-16-545Z/` (local, not committed).
- Cost at API rates: Opus $0.77–1.91 per run ($6.98), Sonnet $0.13–0.73
  ($2.95), Haiku $0.002–0.06 ($0.18); total ≈ $10.1.

## Intent checklist

Automated items only; items marked for a person are excluded.

| Task | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| interview-pause-cleanup-captions | 6/6 | 6/6 | 6/6 |
| interview-title-lower-third | 9/9 | 9/9 | 9/9 |
| interview-social-cut | 7/7 | 7/7 | **3/7** — asked for a save path, edited nothing |
| explainer-title-lower-third-captions | 10/10 | 10/10 | 10/10 |
| explainer-tighten | 4/4 | 3/4 — 138.6 s, target 140–170 | **3/4** — never found the app |
| explainer-chapter-callouts | 7/7 | 7/7 (rescored, below) | 7/7 |
| **Total** | 43/43 | 42/43 | 38/43 |

The checklist is lenient by design (it asks whether the thing was done), so it
separates engagement failures, not quality.

## Observed defaults

### Engagement

- **Haiku did not find WeftCut in 2 of 6 tasks.** On `explainer-tighten`
  ("tighten this lecture excerpt…") it never loaded the skill or searched the
  MCP tools, assumed a text-editing job and asked for a transcript (2 turns).
  On `interview-social-cut` it called `create_project` and stopped to ask for
  a save folder. Neither prompt names WeftCut; both describe editing the clip
  the user has open. Opus and Sonnet engaged every time.
- Sonnet on `explainer-tighten` cut pauses only and explicitly declined to cut
  content without a transcript — a reasonable call, 1.4 s short of the range.

### Text (titles, lower thirds)

- Every model used the app's default face (`Liberation Sans, Noto Sans SC`),
  pure white, bold; legibility from a black outline and/or drop shadow. **No
  run used a plate or backdrop, and no run gave text an entrance or exit**
  (`intro`/`outro` null everywhere): text pops on and off.
- Titles: centred, 72–120 px, either frame centre (960, 480–540) — on the
  interview that is over the speaker's face — or top (960, 140). Held
  2.9–5.0 s.
- Lower thirds: left-aligned at x 120–200, y 720–900, 44–52 px, two lines
  (name, affiliation). Held **2.0 s** (Opus, Sonnet on the explainer) to
  6.9 s; the 2.0 s ones are too short to read two lines. Haiku centred the
  name instead and overlapped it with the title.

### Captions

- Identical across all models and tasks: the transcription tool's style
  (54 px white, 3.24 px black outline, y 993.6, box 1613 px). No model
  restyled captions.
- Cue length is the transcription segmentation passed through: up to 68–80
  characters per cue, median 3.0–6.1 s; minimum 0.42 s (Sonnet,
  pause-cleanup). Only Opus re-split cues for the social cut (max 58 chars,
  median 2.5 s).

### Cuts

- Pause removal is the same for every model (18–21 clips, shortest 0.67–
  0.75 s): one tool, one default, one result. This is the clearest evidence
  in the run that a tool default equalises models.
- Tightening diverges: Opus 76 clips (median 1.72 s, shortest 0.52 s);
  Sonnet 129 clips (median **0.84 s**, shortest **0.28 s**) from an
  aggressive pause pass — a jump-cut stutter no editor would ship.
- Social cut: Opus kept one continuous 57.9 s passage; Sonnet two passages
  (56.1 s); Haiku none.
- No run used a transition or a marker.

### Motifs (explainer-chapter-callouts)

All three authored new Motifs (chapter card + a callout used twice), all
through `open_motif_draft {kind: empty}` + `update_motif_files`; **none wrote
a local working folder**, so the directory path and its proxy were unused.
None tried to put footage inside a Motif.

| | Canvas | Positioning | Purposes per package |
|---|---|---|---|
| Opus | 1920×1080 | hard-coded inside the page (card at 1010,92; callout at 1404,630) | 2 (one package, `mode: chapter\|callout`) |
| Sonnet | element-sized (760×420, 860×160) | layer transform | 1 each |
| Haiku | 1920×1080 for both | `box_x/box_y/target_x/target_y` props | 1 each |

Each placement drew one visual purpose (a card, with a small decorative
glyph), so the "whole frame in one Motif" failure did not occur on this task;
the scope problems that did occur are frame-sized canvases (2 of 3) and
position baked into the page (2 of 3). Opus alone produced an editorial look
from "think Vox": paper card, serif headline, highlighter sweep, accent rule.

## What this says about the harness

| Finding | Rung (ADR 0123) |
|---|---|
| Look converges on tool defaults for every model | **Construction**: style tokens become tool defaults (Q9); write the first style against these defaults |
| Text pops on/off, no plate; title over the speaker | Construction (token defaults include entrance and plate) + check (title vs. face region, later) |
| Lower thirds held 2.0 s | Check: role-specific minimum hold |
| Caption cues up to 80 chars, 0.42 s minimum | Construction (`apply_transcripts` re-segments to the style's caption limits) + check |
| Sub-second jump-cut fragments after tightening | Check (`hard`: fragment shorter than a floor) + craft number |
| Frame-sized Motif canvases, positions baked in | Contract (M1–M3 now on the branch) + check (M4) |
| Haiku misses the app when the prompt doesn't name it | Skill description / `initialize` instructions: trigger on video-editing requests whenever the weftcut server is connected |

## Craft candidates (draft, not shipped)

Numbers to validate on the bench before they enter `skills/weftcut/craft/`:

- Title: hold ≥ 3 s; on talking-head footage, never centred over the
  speaker — top third or on a plate.
- Lower third: hold ≥ 4 s for two lines; enters and exits (200–400 ms),
  never pops.
- On-screen text over footage sits on a plate or a scrim, not on an outline
  alone.
- Captions: ≤ 42 characters per line, ≤ 2 lines, cue 1.2–6 s.
- Cuts: no clip shorter than 1 s unless the plan says why.
- Motif: canvas is the element's bounds; position comes from the layer.

## Bench issues found

- `chapter-card` false negative, fixed: Sonnet's card splits the title across
  `line_one`/`line_two` props, joined with a newline, and the regex expected a
  space. Text matching now collapses whitespace first. Rescoring both batches
  from their `final.json` changed only that run (5/7 → 7/7).
- A session limit was reported per run and the bench carried on: after the
  limit, every remaining run burned 12 s and recorded an error. Fixed: the
  first account-limit error now skips the rest of the plan.

## Batch 2 — repeat (same configuration)

`apps/desktop/bench/results/2026-10-20T19-01-16-850Z/`. The subscription's
session limit was reached during the 7th run, so only the two interview tasks
(pause cleanup, social cut) × three models completed; the 12 runs after it
errored at once and carry no data. Those six pairs answer the run-to-run
question:

| Within one model, across two runs | Stable? |
|---|---|
| Cuts made with a deterministic tool (`remove_pauses`) | **Identical** (same 21 or 18 clips, both runs, every model). Opus picks a longer breathing pad than Sonnet/Haiku — consistently. |
| Opus's choice of the social-cut passage | Identical (the same 57.9 s) |
| Sonnet's social cut | 2 passages / 56.1 s, then 3 / 48.2 s (with a checkpoint restore) |
| Caption segmentation | **Coin flip**: Sonnet 48 cues (median 2.5 s) then 31 (4.55 s); Opus 48 then 40 |
| Caption restyle on the social cut | Sonnet both runs (64 px); Opus second run only; Haiku second run only (68 px) |
| Process: tacks, exports | Opus left tacks in run 2 only and never exported; Sonnet exported unasked both times |
| Haiku | Least stable: social cut failed (run 1) then succeeded (run 2) — by **creating a new project**, re-importing the clip and exporting, rather than editing the project the user had open; pause cleanup cost 6× more in run 2 (58 turns, deleted and rebuilt the caption track) |

So run-to-run divergence lives exactly where model divergence does: in what
the tools leave to the agent (caption segmentation and style, process steps),
not in what a tool decides. The same lever applies to both.

Finding added to the harness table: Haiku editing a **new** project instead
of the open one is an etiquette failure (L0) — the skill says to read the
open project first; the `initialize` instructions and the skill should say
plainly that the job is the project already open in the app.
