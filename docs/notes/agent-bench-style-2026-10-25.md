# Agent bench: does the style hold without its examples? — 2026-10-25

Backs ADR 0126 (a style ships its vocabulary and basic pieces, not worked
answers) and ADR 0135 (the audit keeps only rules with a right answer).

## Environment and probe

- Clipping style after `becc227e` and `b1a0d0c0`: the test talk's own
  content (a worked Henry Molaison scene, the neuron-network animation,
  talk-specific Motif defaults) replaced by neutral placeholders;
  `clipping-network` hidden from every run.
- Freeze: the second talk was chosen after these commits; once its
  transcript was read, only bench mechanics changed.
- Plan check and plan review run in the bench proxy, not the app: the agent
  writes its timetable to a `check_plan` tool, and a second session reviews
  the plan against the footage at the plan gate.
- Round 1: 15 plans on the memory talk. Round 2: full edits of
  `explainer-exoplanets` (Yamila Miguel, 242 s, CC BY-SA), teaching task
  with plan gate, check and review. One run per model.

## Round 1: plans

Plans using the removed example's phrases dropped from 7–11/15 to 0–1/15.
The Henry Molaison passage varied (timelines, split frames, animated
brains); a timeline appeared in 3/15 plans before review and 8/15 after.
Every plan that covered the city walk gave it its own animation. Haiku on
the pictures task asked which transcription engine to use and stopped.

## Round 2: full edits

| | Haiku 5.5 | Opus 5.5 | Sonnet 5.5 | Flash | Flash, Opus reviews |
|---|---|---|---|---|---|
| Cost, edit + review | $0.71 + $0.01 | $9.37 + $0.36 | $4.18 + $0.12 | $0.23 + $0.03 | $0.30 + $0.36 |
| Motif layers: examples / own | 2 / 8 | 4 / 5 | 9 / 7 | 12 / 2 | 6 / 11 |
| Own Motifs | 2 | 3 | 3 | 2 | 6 |
| Own Motifs use shared spring and shadow | no | yes | yes | yes | yes |
| Off-palette colours | 1 | 6 | 1 | 0 | 0 |
| Final audit | 7 findings | 1 `token-drift` | clean | clean | clean |

No export dropped a frame. Haiku's cut reads as plain diagrams, not
collage; Sonnet's is closest to the style; Opus draws paper-ground
animations; Flash mostly places examples well.

## Findings

1. **The style holds without its examples** for Opus, Sonnet and Flash:
   their own Motifs use the shared spring, the paper shadow and the
   ink/paper/accent props, and their colours stay in the palette. Haiku's
   do not.
2. **The reviewer shapes the design.** Round 1's timelines came mostly from
   review; Flash with an Opus reviewer took the review's options almost
   word for word and landed closer to Opus than to Flash alone. An Opus
   review costs $0.36, about a whole Flash edit.
3. **Captions are unreadable on full-frame paper scenes** in every cut that
   has one: white captions on cream paper. No agent changed them and the
   audit does not flag it. Open: a box, a shadow or an ink colour when a
   scene sits behind the captions.
4. The user's review of these cuts found Opus's overlays the only good ones:
   design follows the model and its reviewer, not the audit's density and
   picture counts (ADR 0135).

## Plan bench, 2026-10-24 (before this round)

Twelve plans per recipe version (Opus, Sonnet, Haiku, DeepSeek Flash on
three H5 tasks), replayed from a recorded intake with writes refused.
Practice basis: paper edit and two-column AV script (documentary), "write
to the pictures" (broadcast), Mayer's multimedia principles (2020),
Murch's rule of six.

- **Examples narrow the gap between models.** With `clipping-network`
  available, every model placed it with its default seed, so that passage
  looked the same in all ten H5 cuts and its quality was the example's.
  Where a model had to design (the city walk) the spread showed at once.
- **A plan with a brief and a gapless AV script beats a list of
  overlays.** The old recipe's plans stated no message (0/12) and listed
  additions, not what the viewer sees at every moment; with a brief,
  outline and AV script 10/12 stated a message and the argument, and Opus,
  Sonnet and Flash gave the city walk its own animation. Cost rose from
  $4.94 to about $7.3 per twelve plans. The current recipe keeps the brief
  and the timetable; it dropped the second (storyboard) gate.
- Flash 0/3 and Haiku 1/3 stopped for approval before writing, under
  either recipe.
