# Agent bench: does the style hold without its examples? — 2026-10-25

After H6 the user asked for two things:

- `check_plan` and the plan review stay outside the app;
- the bench should test whether the style skill alone shapes the look, so
  that no model copies a ready-made Motif.

## What agents could copy, and what was removed

The style and the skill held the test talk's own content:

- the Henry Molaison scene as a worked example;
- the neuron-network animation in the style's examples;
- defaults like "HIPPOCAMPUS" and another bench speaker's name.

`becc227e` and `b1a0d0c0` replace all of these with neutral placeholders:

- `clipping-network` leaves the style's example list but stays in the
  catalog;
- the recipe's storyboard example is now a template;
- Motif defaults, filler words and the sticker art are now neutral;
- tool descriptions and lint hints use generic examples.

The bench can also hide a Motif (`--hide-motif`). Every run below hides
`clipping-network`.

**The freeze.** The second talk was chosen after these commits. After its
transcript was read, only bench mechanics changed. The style, the skill and
the reviewer prompt did not change.

## Plan stage, outside the app

`7570a6bd` moves the plan check and the review into the bench proxy:

- **`--plan-check`.** The agent writes its timetable to a `check_plan` tool.
  The proxy answers it from the agent's own transcript, with no app change.
  For real use it is a skill script.
- **`--plan-review same|driver:model`.** A new session reviews the plan
  against the footage at gate 2. Its notes go back to the planner as the
  user's reply.

## Round 1: plans only, memory talk (15 plans)

These are the plan-bench tasks on the cleaned style. They are compared with
the same tasks before the cleanup (v3). The table counts plans that use the
removed example's phrases:

| Phrase from the old example | Before review, v3 | Before review, cleaned |
|---|---|---|
| BOTH REMOVED | 11/15 | 1/15 |
| NEW: LOST | 7/15 | 0/15 |
| OLD: KEPT | 10/15 | 1/15 |

- **The Henry Molaison scene now varies.** Plans use timelines, split
  frames and animated brains. A timeline is in 3/15 plans before review and
  in 8/15 after review.
- **The city walk.** Every plan that covered it gave it its own animation
  (a street map, a route or pins). None reused the network.
- **Haiku, pictures task.** It asked which transcription engine to use and
  stopped, with no plan ($0.03).

## Round 2: full edits, a new talk

- **The talk.** Yamila Miguel on finding exoplanets, 242 s, CC BY-SA
  (`explainer-exoplanets`). It is the second explainer fixture.
- **The task.** The teaching task, with the plan gate, `--plan-check`, a
  review, and `clipping-network` hidden.
- **Exports.** In `.scratch/agent-harness/checkpoint11/`, and on the remote
  host in `Desktop\h6-review\exoplanets\`. Each run has a contact sheet
  every 5 s and its plan before and after review. None of the five exports
  dropped a frame.

| | Haiku 5.5 | Opus 5.5 | Sonnet 5.5 | Flash | Flash, Opus reviews |
|---|---|---|---|---|---|
| **Cost, edit + review** | $0.71 + $0.01 | $9.37 + $0.36 | $4.18 + $0.12 | $0.23 + $0.03 | $0.30 + $0.36 |
| **Motif layers: examples / own** | 2 / 8 | 4 / 5 | 9 / 7 | 12 / 2 | 6 / 11 |
| **Own Motifs** | 2 | 3 | 3 | 2 | 6 |
| **Own Motifs: shared spring and paper shadow** | no | yes | yes | yes | yes |
| **Off-palette colours** | 1 | 6, blues | 1 | 0 | 0 |
| **Final audit** | 7 findings | 1 `token-drift` | clean | clean | clean |
| **Writes refused before approval** | 0 | 0 | 0 | 1 | 2 |

`Flash` ended with an API error ("tool input is invalid JSON"). This came
during its last look at frames, after a clean audit, so the cut is complete.

**What each cut draws** (from the contact sheets):

- **Haiku.**
  - Bare line drawings on plain paper: a timeline, a lighthouse outline, a
    distance ladder.
  - The last 50 s are a full-frame transit diagram, and the speaker is gone.
  - It reads as a diagram, not as collage.
- **Opus.**
  - Paper-ground animations:
    - a lighthouse whose glare swallows the fly, then a magnifier;
    - a light pulse from Earth to the Moon, Jupiter and the nearest planet;
    - a transit whose light curve draws as the planet crosses.
  - It keeps her bulb demo, as its reviewer suggested.
- **Sonnet.** The closest to the style.
  - Small torn paper cards beside her: a drawn sky that fills with planets,
    and the nearest one ringed red.
  - Sticker tags: GLARE, DISTANCE, 1,000,000×.
  - Her bulb demo sits inside a paper card next to its light curve.
  - At the end, a small and a big planet's dips side by side.
- **Flash.**
  - Mostly examples placed well. It rings the tiny planet on her own screen
    and adds a red "1992 → TODAY" stamp.
  - Its two animations are a transit and a spectrum with H2O / CH4 / CO2
    bars.
- **Flash, Opus reviews.**
  - It follows the review closely:
    - a red ring and 1,000,000× on her own screen;
    - a light-curve strip along the bottom of her bulb demo;
    - a lighthouse animation.
  - It has the most own Motifs (6), all in the shared spring, shadow and
    palette.

**Where the designs came from.** The fly and the lighthouse, the distance
board (1 s / 30 min / 4 years) and the bulb demo are all in her talk and
on her studio screens. The fly and lighthouse line art in the Sonnet and
Flash cuts is the source footage's own graphic. Flash made no image search,
and nothing but the video is on screen at that moment. The table relations
(a comparison, a scale) come from the plan template, which has no examples.

## Findings

1. **The style holds without its examples, for Opus, Sonnet and Flash.**
   - Their own Motifs use the shared spring, the paper shadow and the
     ink/paper/accent props.
   - Their colours stay in the palette.
   - Haiku's do not, and look like plain diagrams.
2. **The reviewer shapes the design.**
   - Round 1 showed it: the timeline came mostly from review.
   - Flash with an Opus reviewer took the review's options (b) and (c) almost
     word for word, and its cut is closer to Opus's than to Flash alone.
   - An Opus review costs $0.36, the same as Flash's whole edit.
3. **Captions are unreadable on full-frame paper scenes.** In every cut with
   a paper scene (Haiku, Opus, both Flash cuts, Sonnet's last section), the
   white captions sit on cream paper. No agent changed the captions for
   these scenes, and the audit does not flag it. All five models do it, so
   the fix belongs in the style or the audit.
4. **Speaker presence.** Haiku and Opus let paper scenes run for long
   stretches. Sonnet and both Flash cuts keep her in frame.

## Open

- **The user's review** of the five cuts in `h6-review\exoplanets\`.
- **Caption contrast on paper scenes**: a box, a shadow, or an ink colour
  when a scene is behind the captions.
- **Whether to offer an Opus review to cheaper planners as a product
  option.**
- **One run each**: the spread between runs is unmeasured.
