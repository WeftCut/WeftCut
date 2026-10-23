# Agent bench after H4 — 2026-10-23

The H3 tasks again, plus a task with the user's own pictures, on the H4
build. H4 answers the H3 checkpoint, where the user found the cuts too wordy
for a Vox-style explainer. Since H3 the agent has:

- **The picture-led audit** (`e209bbb2`):
  - `word-heavy`: at least a third of the graphic elements are pictures;
  - `captions-covered`: nothing opaque sits above the captions;
  - `scene-share`: scenes cover at most half the cut;
  - a taste's `pace.pictures_min_share`.
- **Picture sources in the order the user set** (ADR 0133):
  1. their media;
  2. a still from the footage;
  3. `search_images` / `import_image` on Wikimedia Commons, with credits;
  4. an SVG drawing through `import_media`.
- **New sticker options:** the `cutout` frame, and the `mono` and `halftone`
  treatments.

## Environment and scope

- **App and skill.** The app is at `77f40eaa` on the remote host. The skill
  is the repo's `skills/weftcut`.
- **Tasks.**
  - `explainer-clipping-teaching` and `explainer-clipping-dense` are the H3
    tasks. Each gains picture-led ≥ 33 %, captions-visible and speaker-stays
    ≤ 50 %. Neither has pictures in the pool, so a picture has to be a still,
    a search or a drawing.
  - `explainer-clipping-pictures` is the teaching task with seven credited
    pictures imported into the pool (`2e97eaa8`):
    - Semon;
    - Cajal's neurons;
    - a brain;
    - two hippocampus pictures;
    - the Eiffel Tower in 1900;
    - a Paris map.

    It checks that at least three of them are used.
- **Runs.** Opus 5.5, Sonnet 5.5 and Haiku 5.5, one run each per task, $29.75
  in all. Results are at
  `apps/desktop/bench/results/2026-10-23T04-42-21-730Z/`. Exports and contact
  sheets are in `.scratch/agent-harness/checkpoint8/`.

## Results

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| **Pictures task** | **19/19** | 18/19 (one 0.64 s clip) | 15/18 |
| **Default task** | **18/18** (H3 15/15) | 17/18 (one 0.72 s clip) (H3 15/15) | 12/17 (H3 13/15) |
| **Dense task** | **19/19** (H3 16/16) | **19/19** (H3 16/16) | 12/18 (H3 7/16) |
| **Cost, pictures / default / dense** | $6.79 / $5.68 / $7.36 | $3.00 / $3.02 / $2.95 | $0.32 / $0.19 / $0.43 |
| **Final audit** | clean ×3 | clean, or one short clip | 8–27 warnings |

**Pictures, by source** (uses / distinct):

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Pictures task | user's 9/7, drawn 1 | user's 12/6, drawn 1 | user's 4/4 |
| Default task | searched 4/4, drawn 3, still 1 | searched 9/5, drawn 3 | none |
| Dense task | searched 7/4, drawn 3, still 5 | searched 12/5, still 2 | none |
| Picture share of graphics | 35–38 % | 35–48 % | 0–57 % |

**The source order held.**
- **With the user's pictures,** Opus and Sonnet used them first: 7 of 7 and 6
  of 7.
  - Each searched once, for Henry Molaison. Commons has no open-licence photo
    of him, so each drew a silhouette.
  - Neither searched for anything the pool already covered.
  - Both saw that `picture-semon.jpg` is Richard Semon, not Henry Molaison.
    Opus labelled it "RICHARD SEMON, 1904"; Sonnet left it out.
- **Without them,** they searched 5–7 times and imported 4–5 pictures:
  - a neuron micrograph and a neuron diagram;
  - the hippocampus and the cortex;
  - the Eiffel Tower;
  - old Paris maps;
  - a painted classroom for "the lesson".
- **Films:** for Memento and Finding Nemo they drew a Polaroid and a blue
  fish rather than look for film stills. Sonnet's handoff said why: the
  stills are copyrighted.
- **Credits:** handoffs list each fetched picture's credit line. Opus and
  Sonnet flagged the CC BY-SA picture: publishing it asks the video to carry
  the same licence.

**The rest of the rhythm held or improved.**
- **Jump cuts left bare:** 5–19 % (H3 15–18 %).
- **Captions:** visible in every run. Every scene sits below the caption
  track.
- **Scenes:** cover 18–32 % of the cut (H3: Haiku 60 %).
- **Dense pace:** met again, with an arrival every 7.8–7.9 s.

**Captioning cost fell for Sonnet.** It made 1–11 `transcribe_clip` calls
(H3: about 40). It mapped the full-clip transcript onto the tightened cut
and fixed names by hand. Opus still made 14–48 calls.

## What the frames show

- **Scenes are collages of real pictures.** Examples:
  - Cajal's drawing with the brain photo.
  - Gray's hippocampus beside the dissected hippocampus and a seahorse.
  - The 1900 Paris map, then the Eiffel Tower.
  - A neuron micrograph, then a labelled diagram.

  Labels name the pictures ("GREEK FOR SEAHORSE", "THE WALK = EVENT")
  rather than repeat her line.
- **Pictures over the speaker** sit beside her slide and add to it: Semon's
  portrait by her network slide, a seahorse photo by her hippocampus slide,
  the Eiffel Tower by "Paris". Opus's pointers still aim at parts of her
  slide.
- **The drawn people are clip art.** Five runs drew H.M. Four drew a flat
  cartoon head in a collar; Opus on the pictures task drew a dark silhouette. Next to newsprint and old
  engravings it is the one thing out of style. Dense Opus gave its drawing
  the `halftone` treatment, which helped. No other run used a treatment on a
  drawing.
- **A generic picture labelled as a person (dense Sonnet).** A Commons MRI
  of a hippocampus is stamped "HENRY MOLAISON · EPILEPSY SURGERY · 1950S".
  It is not his scan. Nothing checks what a picture is against what its
  label says.
- **Every scene ends on an empty plate.** The pieces leave 0.25–1.1 s before
  the scene ends, as the recipe asks ("take the pieces off, then slide the
  page out"). The plate then shows alone for about 0.6–1.5 s with only
  captions on it.
- **Scenes use half the frame.** Pictures sit at 25–35 % of the frame width,
  mostly in the left half; the right half often holds one label. This is
  better than H3 but still sparse.
- **Small stickers over the speaker (Sonnet, pictures task).** Its stickers
  sit at about 15 % of the frame width in the top-left corner, too small to
  read as pictures.
- **Haiku places pictures over her.** In the pictures task its stickers and
  quote cards cover the speaker's body (the Eiffel Tower at 147 s, the
  brain at 157 s). It built no scenes in any task, never searched, and in
  the two no-pool tasks showed no pictures at all. Its handoffs say so
  plainly.

## Bugs found and fixed

- **A pointer's label was drawn only for the `arrow` kind.**
  - **What happened:** Sonnet gave labels to circles and underlines, saw
    none drawn, and turned eleven pointers into headline tags.
  - **Fix:** the label now sits under an underline and below a circle
    (`12a960a3`).
- **`preview_motif` accepted arguments it does not take.**
  - **What happened:** Sonnet sent `times_s: [...]` without `t_sec`, got the
    t = 0 frame (nothing drawn yet), and read it as a broken Motif.
  - **Fix:** the tool now refuses a missing `t_sec` and any argument it does
    not take (`7734c62d`).
- **The audit's picture hints** did not name `search_images`. They now do.
- **A Haiku export** failed once on the remote host with
  `resource-capacity-exceeded` while the host was busy with other work. A
  retry succeeded.

## Your ratings (H3 vs H4)

Rate each 1–5. Compare against the H3 export of the same model
(`.scratch/agent-harness/checkpoint6/h3-*.mp4`); the pictures task compares
against H3's default task.

| | Editing rhythm | Overlays add information | Concept-scene quality | Picture-led (Vox-like) |
|---|---|---|---|---|
| Opus pictures | | | | |
| Sonnet pictures | | | | |
| Haiku pictures | | | | |
| Opus default | | | | |
| Sonnet default | | | | |
| Haiku default | | | | |
| Opus dense | | | | |
| Sonnet dense | | | | |
| Haiku dense | | | | |

## Open

- **Drawings in the style:** have the recipe ask for a treatment (`mono`,
  `halftone`) or the cut-out frame on a drawn picture, or give the style a
  drawing guide (line weight, ink, no flat fills).
- **A label that claims a picture shows something specific:** at least a
  recipe rule that a generic picture is not captioned as a particular person
  or event.
- **The empty plate at a scene's end:** let the last piece leave with the
  page, or shorten the gap the recipe asks for.
- **Scene layout and sticker size:** use more of the frame; set a minimum
  sticker size over the speaker.
- **Haiku:** it still neither builds scenes nor searches. The recipe may need
  a shorter path for small models, or Haiku is not a target for this task.
- **Ticket 33 (matte):** cut-outs of people from photos. The `cutout` frame
  was used 1–4 times per run, all on pictures with a plain background.
- **From H3:** re-captioning a tightened cut in one call (Sonnet's mapping
  shows it can be cheap), and a caption outline token in `clipping`.
