# Agent bench after H5 — 2026-10-24

The H4 tasks again, on the H5 build, with a DeepSeek model alongside the
Claude models. H5 answers the H4 checkpoint, where the user found the cuts
still leaning on paper cards and asked for the neuron passage to be animated
(ADR 0134). Since H4 the agent has:

- **`clipping-network`** (`9bb4ba4d`): a built-in example of a process as an
  animation. One neuron grows, links, spreads into a network, signals run
  through it with a lens on a synapse, and one pattern lights up as a memory.
  Its steps are `cue_<step>_s` props set from the word times.
- **Tape is optional** on the clipping Motifs, and off by default.
- **The plan names what the viewer sees** for each beat, with a storyboard
  for each animation (`50fc1861`). Build step 4 builds each animation as one
  frame-sized Motif.
- **The audit takes a drawn animation for a scene** (`still-scenes`, and a
  drawn scene covers jump cuts and counts in scene share).
- **A dsh driver** (`4148b55d`) runs DeepSeek models through DeepSeek Harness,
  with the same withheld tools as the Claude driver.

## Environment and scope

- **App and skill.** The app is at `8e9f38ec` on the remote host (the branch
  through `50fc1861`, merged with main's v0.5.3). The skill is the repo's
  `skills/weftcut`.
- **Tasks.** The three H4 tasks (pictures, default and dense), each with two
  new items: `animated-concept` (at least one drawn animation) and the human
  item `animation-shows-it`.
- **Runs.** One run each:
  - Opus 5.5, Sonnet 5.5 and DeepSeek V4.1 Flash (`deepseek-flash`, through
    dsh 0.2.1-rc.2) on all three tasks;
  - Haiku 5.5 on the default task only.

  $28.84 in all. Results are in `apps/desktop/bench/results/`:
  `2026-10-23T15-37-31-500Z` (Opus, Sonnet), `2026-10-23T17-00-07-852Z`
  (Haiku) and `2026-10-23T17-06-28-515Z` (Flash). Exports and contact sheets
  are in `.scratch/agent-harness/checkpoint9/`; `*-anim.jpg` shows each
  animation just after each of its steps.

## Results

Scores are re-evaluated with `3d495a1e` (an animation's steps count as
arrivals; see *Bugs found*).

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 | DeepSeek Flash |
|---|---|---|---|---|
| **Pictures task** | **20/20** | **20/20** | — | **20/20** |
| **Default task** | **19/19** | 18/19 (one short clip) | 13/18 | **18/18** |
| **Dense task** | **20/20** | 19/20 (two short clips) | — | 17/20 (15 short clips, one callout) |
| **Cost, pictures / default / dense** | $4.79 / $6.91 / $8.36 | $2.73 / $2.08 / $2.97 | — / $0.38 / — | $0.15 / $0.23 / $0.23 |
| **Time, pictures / default / dense** | 13 / 14 / 18 min | 12 / 9 / 14 min | — / 6 / — | 14 / 20 / 20 min |
| **Final audit** | clean ×3 | clean, or short clips | 22 warnings | clean, or 15 short clips |

**Every run animated the neuron passage.** All ten placed `clipping-network`
over "Neurons are the nerve cells in our brain … A memory is such a unique
network", with its cues set from her words. Haiku and Flash too.

**Five animations were written from scratch.**

| Run | Animation | Passage | What it shows |
|---|---|---|---|
| Opus, dense | `clipping-map-walk` | the city walk, 150–170 s | A walk on a grid card collects a house, a café and a church as frames on a film strip labelled HIPPOCAMPUS; a CORTEX card builds a line map, a second route is added in red, a pin drops for the restaurant and the route to it lights up. |
| Sonnet, dense | `clipping-city-map` | the city walk, 139–165 s | A red dashed walk passes landmarks on a grid; at "stored as an event" a HIPPOCAMPUS card holds it beside a still from her footage; an arrow to a CORTEX card that builds the abstract map, adds the new route, pins NEW RESTAURANT, and finds it. |
| Flash, dense | `clipping-recall` | "When you activate this exact same set … the extent … determines the detail", 26–37 s | The network from the neuron passage, one set lit; it dims, the same set relights, and the lit set grows with "extent". |
| Flash, dense | `clipping-map` | the city walk, 121–145 s | A red route through landmark icons on a grid, then the route alone as an abstract line, a second route added. No hippocampus or cortex. |
| Flash, default | `clipping-consolidation` | "The memory for learning a fact isn't the same…", 118–134 s | A route in a circle labelled EPISODE, then the same shape on a card labelled GIST. Small, in the left third of the frame. |

- Opus and Sonnet's city-walk animations follow her words step by step and
  keep the clipping look (paper cards, ink, the red accent). Each previewed
  its draft 3–9 times before placing it.
- Flash's `clipping-recall` is the closest fit of any animation to its
  words. Its map and consolidation animations are thinner: no named parts,
  much empty frame.

**Where nothing was written, the network example was reused for the city
walk.** Four of the seven non-dense runs placed a second `clipping-network`,
in `dot` mode, over the city-walk passage:

- Opus on the pictures and default tasks;
- Sonnet on the default task;
- Haiku.

A network of dots spreading and lighting a path stands for a map only
loosely: no streets, landmarks, hippocampus or cortex. Flash on the pictures
task did better with the same Motif: it laid the dot network on no ground
over the Paris map and the Eiffel Tower, inside a scene.

**The first network is the example, unchanged.** Every run kept the default
seed and layout and set only the cue times, so the passage looks the same in
all ten cuts. Two runs put words over it:

- Sonnet (dense) tagged NEURON, NETWORK and SYNAPSE: the words the user asked
  to drop.
- Flash (dense) added "UP TO 120 M/S" and "THOUSANDS OF LINKS EACH". Neither
  is said in the talk, and the first is a claim the agent supplied itself.

**The rhythm held.**
- **Jump cuts left bare:** 2–26 % (H4 5–19 %). Haiku 58 %.
- **Captions** are visible in every run.
- **Scenes and plates** cover 24–48 % of the cut.
- **Dense pace:** with animation steps counted, Opus and Sonnet bring
  something new every 7.4–7.8 s; Flash every 8.0 s.

**DeepSeek Flash** scored with Sonnet on the checklist at about a twelfth of
its cost: $0.15–0.23 a run, all off-peak. It is slower (14–20 min) and
renders more frames to check its work (10–24 `render_frames` calls; Claude
2–9). Its dense cut kept 15 clips under 1 s from removing pauses, as Haiku's
did. Its pictures-task scenes are well composed: Gray's hippocampus with a
seahorse, H.M.'s brain with "BOTH REMOVED", the Paris map with a network
over it. In the default task it took stills of her own slides (the brain,
the city map) as stickers, so some scenes repeat what was just on screen.

**Haiku** placed `clipping-network` twice in a row (9–38 s), the second
starting again from one neuron, and a third time for the city walk. It left a
54 s stretch of bare talk and 15 short clips.

## Bugs found

- **The beat-gap checks counted an animation as one arrival.** A 20 s
  network scored as a 23 s wait, and the dense task's beats-every-8s failed
  for it. Each `cue_<step>_s` step now counts, in the audit's `sparse-beats`
  and the bench's `beat_gaps` (`3d495a1e`).
- **An export without a Motif the project uses finished without error.** The
  agents' own animations were unpublished drafts in the bench app's profile
  (the skill has the user approve publishing). Exported from a fresh profile,
  every frame of those layers was missing — the footage showed through —
  and the export reported `completed`. Reopening the drafts fixed the
  exports.
- **Dropped Motif frames in export.** Three re-exports, made while the remote
  host was busy, have single frames where a Motif layer is missing and the
  footage shows: 60 in Flash's dense cut, 11 in Sonnet's, 8 in Flash's
  default. They hit `clipping-network` as well as the agents' Motifs. The
  first-round exports of the same projects have none.
  A second re-export of the same three projects, the host still busy, drops
  more, at other times: 87, 18 and 13 frames. Every export reported
  `completed`. In the export's Motif stream a failed read fails the export
  (`motifStream.ts`), so these frames are likely read without error but
  empty; not yet diagnosed. The review copies are the first re-exports.

## Your ratings (H4 vs H5)

Rate each 1–5. Compare against the H4 export of the same model and task
(`.scratch/agent-harness/checkpoint8/h4-*.mp4`); Flash has no H4 run.

| | Rhythm | Overlays add information | Animation shows the process | Picture-led |
|---|---|---|---|---|
| Opus pictures | | | | |
| Sonnet pictures | | | | |
| Flash pictures | | | | |
| Opus default | | | | |
| Sonnet default | | | | |
| Haiku default | | | | |
| Flash default | | | | |
| Opus dense | | | | |
| Sonnet dense | | | | |
| Flash dense | | | | |

## Open

- **One example, reused for another process.** The recipe could say that
  `clipping-network` is for networks of cells, and that a different process
  (a walk becoming a map) gets its own animation, as the dense runs wrote.
- **Drafts at handoff.** A cut that uses a draft depends on the app profile
  and the folder the draft is linked to. The handoff could list the drafts
  the cut uses and ask the user to publish them; the export could refuse, or
  warn about, a layer whose Motif it cannot find.
- **Words over animations:** a recipe line that an animation carries no
  labels for what it already draws, and no figures the talk does not give.
- **Links at synapses** in `clipping-network` (from the prototype review).
- **Short clips after removing pauses** (Flash, Haiku): the audit reports
  them; both left them.
- **From H4:** drawings in the style, labels that claim specificity, scene
  layout and sticker size, ticket 33 (matte).
