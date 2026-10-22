# Agent bench after H3 — 2026-10-23

The H2 task again, plus a dense variant, on the H3 build. Since H2 the agent
has:

- the look stage (`render_frames`);
- scene Groups and interaction Motifs (ADR 0131), with `clipping-reveal`;
- the `media` prop and `clipping-sticker` (ADR 0132): a still from the footage
  or a pool picture, pasted on as a paper cut-out;
- the audit's rhythm rules (`bare-talk`, `bare-jump-cuts`, `sparse-beats`,
  `scene-count`, `scene-all-words`) and a taste's `pace`.

## Environment and scope

- **App and skill.** The app is at `136a3e5c` on the remote host. The skill
  is the repo's `skills/weftcut`.
- **Tasks.**
  - `explainer-clipping-teaching`: the H2 prompt and TASTE.md
    (`extends: clipping`), plus checks for scenes, pictures, jump cuts and
    bare talk.
  - `explainer-clipping-dense`: the same prompt, with a pace in TASTE.md:
    `{ beat_every_s: 8, bare_talk_max_s: 12, scenes_per_min: 1 }`. It checks
    3+ scenes, a new element at least every 8 s, and no more than 12 s of
    bare speaker.
- **Runs.** Opus 5.5, Sonnet 5.5 and Haiku 5.5, one run each per task.
  Results are at `apps/desktop/bench/results/2026-10-22T17-10-20-975Z/`.
  Exports and contact sheets are in `.scratch/agent-harness/checkpoint6/`.
- **No user pictures.** The teaching task stays footage-only, so H2 and H3
  compare. The footage carries her slides, so the still-from-footage path is
  what the runs could use. A task with pool pictures (a CC0 pack, licences
  checked) is still open.
- **Rescored.** Two false positives in the checks were fixed after the run
  (`18b0adb6`), and the tables use the rescored checklist:
  - Opus grouped its title with a paper plate. The bench's role checks read
    the root alone and found no title, and both `scene_pictures` and the
    audit's `scene-all-words` asked the card for a picture.
  - A role selector now looks inside Groups, and a plate plus titles is a
    title card, not a scene.

## Results

### Default task (vs H2)

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Checklist (automated) | **15/15** (H2 12/12) | **15/15** (H2 11/12) | 13/15 (H2 11/12) |
| Failed | — | — | one 0.64 s clip; captions run 0.08 s past the picture |
| Final audit | 1 review (the title card, now fixed) | clean | 3 warnings |
| Cut length | 3:06.6 (H2 3:20.6) | 2:51.4 (H2 3:00.8) | 3:02.6 (H2 2:28.0) |
| Cost / turns | $6.75 / 229 (H2 $4.04 / 89) | $3.14 / 219 (H2 $1.26 / 94) | $0.73 / 164 (H2 $0.17 / 38) |
| Scene Groups; time on screen | 3 + title card; 48 s | 2; 25 s | 9; 110 s |
| Stickers; distinct stills | 4; 3 | 3; 3 | 9; 6 |
| Jump cuts bare | 18 % (H2 97–100 %) | 15 % | 39 % |
| Longest bare talk | 19.8 s (H2 59–75 s) | 16 s | 14.9 s |
| Longest wait for something new | 23.8 s | 20.6 s | 25.4 s |
| `render_frames` calls | 9 | 12 | 5 |

### Dense variant

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Checklist (automated) | **16/16** | **16/16** | 7/16 |
| Final audit | clean | clean | 27 warnings |
| Cost / turns | $6.97 / 229 | $2.56 / 184 | $0.28 / 44 |
| Scenes (3+ asked) | 4, 73 s | 3, 49 s | 0 (2 ungrouped plates) |
| Longest wait / bare talk | 7.8 s / 3.8 s | 7.5 s / 3.9 s | 31.8 s / 28.6 s |
| Overlays (Motif layers) | 44 | 47 | 10 |

**The rhythm moved.**
- **Jump cuts:** H2 left 97–100 % of them bare. Now Opus and Sonnet cover
  80–90 %, with punch-ins (the next clip at scale 1.15) and scenes.
- **Bare talk:** the longest stretch fell from about a minute to 15–20 s.
- **The pace:** given one, Opus and Sonnet met it exactly, with an arrival
  every 7.5–7.8 s.

**Every scene in every run is a Group** of a plate, a sticker of her own
slide (the network, the hippocampus, the cortex, the city map), a headline,
and a reveal or pointer or two.
- No run drew a picture or wrote a Motif.
- No run forked a Motif.

**Cost rose with the work.**
- **Opus:** about 1.7× H2.
- **Sonnet:** about 2.5× H2.
- **Haiku:** about 4× H2 (still $0.73).
- **Where it goes:** 40–49 `transcribe_clip` calls per run re-caption the
  tightened cut. H2 already flagged this, and it has not changed.
- **The dense pace** adds little beyond that.

## What the frames show

- **Captions hidden under scenes (dense Sonnet, dense Haiku).**
  - **What happens:** Sonnet placed its three scene Groups on tracks above
    the caption track, so for the scenes' 49 s there are no captions. Haiku
    did the same with its plates, and said so in its handoff.
  - **Why the checks miss it:** `captions_over_picture` asks for footage
    under a cue, not for the cue to be visible. Nothing in the audit checks
    track order against captions.
- **Density by words (dense Sonnet).**
  - **What happens:** to meet an 8 s beat Sonnet put a headline card in the
    top-left every 4 s: about 25 of them. Many restate the line being said
    ("NEURONS" as she says "Neurons are the nerve cells").
  - **Why the checks miss it:** `overlay-echoes-speech` catches verbatim
    echoes, not paraphrase.
  - **What it shows:** the pace counts arrivals of any kind. Opus met the
    same pace with pointers aimed at parts of her slide, reveals and four
    scenes.
- **Haiku's scenes are a slideshow (default task).**
  - **What happens:** 9 scenes of plate + sticker + one headline, the same
    stills reused, covering her for 110 s of the 183 s cut.
  - **Why the checks miss it:** every check passes. Nothing limits how much
    of the cut scenes may cover.
- **The picture is her slide again.**
  - **What happens:** every sticker is a still of the slide she stands
    beside. Inside a scene it is framed, labelled and revealed, which helps.
    But the viewer saw it a moment earlier behind her.
  - **What would change it:** a picture that adds something, from the user's
    media or a drawing. The runs had no media to use and did not draw.
- **Opus's pointers land on the slide.** "ENGRAM" points into the network,
  "ONE PER HEMISPHERE" at the hippocampus, and "PINNED TO THE MAP" at the new
  restaurant. This is the look stage at work.
- **Scenes leave space empty.** Stickers sit at about 30 % of the frame
  width, and the elements cluster in one corner of a full-frame plate.
- **Captions on paper** are still white without an outline: readable on
  newsprint, weak on kraft. This is from H2 and still open.
- **Haiku on the dense task stopped early.** It ran 44 turns, built no
  scenes, and left 15 sub-second clips. It then misstated the pace in its
  handoff ("this has three to four" scenes; there were none). Haiku had
  regressed in the same way in H1 and H2.

## Your ratings (H2 vs H3)

Rate each 1–5 against the H2 export of the same model
(`.scratch/agent-harness/checkpoint3/cp3-*.mp4`):

| | Editing rhythm | Overlays add information | Concept-scene quality |
|---|---|---|---|
| Opus H3 | | | |
| Sonnet H3 | | | |
| Haiku H3 | | | |
| Opus dense | | | |
| Sonnet dense | | | |
| Haiku dense | | | |

## Open

- **Captions over scenes:** an audit rule that flags a full-frame layer above
  the caption track while cues are up. Alternatively, new tracks could go
  below the caption track.
- **A share-of-cut limit for scenes,** so a cut does not become a slideshow
  that hides the speaker.
- **Variety under a pace:** arrivals by kind, so a dense cut is not one
  headline after another. Paraphrase echoes too.
- **A user-media task,** to exercise picture sources 1 and 4 of ADR 0132.
- **Scene layout:** element scale and the use of the frame.
- **From H2:** re-captioning a tightened cut in one call, and a caption
  outline token in `clipping`.
