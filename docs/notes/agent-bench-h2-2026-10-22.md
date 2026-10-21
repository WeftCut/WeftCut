# Agent bench after H2 — 2026-10-22

The first recipe on the first drawn style, end to end. A project that
`extends: clipping` asks for an editorial explainer cut of the lecture. The
H2 build gives the agent:

- the style's example Motifs, which take the project's tokens;
- exits written in the Motifs;
- the `teaching-explainer` recipe;
- captions built to the style's limits;
- the audit at handoff.

## Environment and scope

- **App and skill.** The app is at `5ea6158a` on the remote host. The skill
  is the repo's `skills/weftcut`, with the recipe and craft rules.
- **Task.** `explainer-clipping-teaching` (bench `d3590bab`). The project's
  TASTE.md is `extends: clipping`. The prompt asks for:
  - pause tightening;
  - a title, and a name card;
  - two or three callouts on key points;
  - one paper insert (pull quote or chapter card);
  - captions.
- **Runs.** Opus 5.5, Sonnet 5.5 and Haiku 5.5, one run each. Results are at
  `2026-10-21T16-17-50-865Z` (Haiku) and `2026-10-21T16-23-26-532Z` (Opus,
  Sonnet) under `apps/desktop/bench/results/`.
- **Exports.** Each final project was exported through the app's own
  pipeline (`.scratch/agent-harness/checkpoint3/`).
- **Fonts on the host.** The style resolved with no diagnostics. The host
  lacks Anton, Bebas Neue, Noto Serif and IBM Plex Mono, so the font slots
  fell back to Impact, Microsoft YaHei, Georgia and Consolas. The taste
  view's `fonts` reported this, and Haiku and Opus passed it on to the user.

## Results

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Checklist (automated) | **12/12** | 11/12 (one 0.76 s clip) | 11/12 (15 clips < 1 s) |
| Final audit | clean | 1 warning (`short-clip`, tacked) | 15 warnings (`short-clip`, tacked) |
| Cut length (from 3:35) | 3:20.6 | 3:00.8 | 2:28.0 |
| Cost / turns | $4.04 / 89 | $1.26 / 94 | $0.17 / 38 |
| Stand-in go-ahead | used | used | not needed |
| Motif layers | 7 | 7 | 6 |
| Callouts | 3 quotes | 3 quotes | 2 quotes |
| Caption cues; longest line; cue length | 65; 42; 1.3–5.7 s | 60; 42; 1.2–5.0 s | 59; 42; 1.2–4.5 s |

**Every run built the whole beat list from the recipe:**

- a title in the first half second;
- a name card in the first 5 s;
- quote callouts with her exact words and a highlighted phrase;
- one kraft paper insert.

Each insert is a plate that slides in, with a chapter headline on a band. The
headline lifts off about 0.15–1 s before the page slides out, as the recipe
says. Every Motif's `duration_s` matched its layer, and every element has an
exit:

- lift for titles and quotes;
- slide_left for the name card;
- the plate's slide.

Colour and font props were left to the tokens in all 20 Motif layers; the
agents' own patches were position and scale only.

**Captions held to the style's limits with no per-cue work.** That compares
with 41–42 `update_layer_params` calls per run in H1.

- **Sonnet:** one cue text fix.
- **Opus:** one `correct_caption_text` call.

**None of the three forked an example or wrote a Motif.** The prompt did not
call for anything the examples could not show.

## What the frames show

The checklist and the audit pass more than the frames earn. Contact sheets of
each Motif settled and mid-exit (`checkpoint3/*-sheet.jpg`) show:

- **Titles over the face.**
  - **What happens:** the first 2 s are a wide shot, then a medium shot of
    her. Opus and Haiku placed the title in the top third from the first
    frame, so after the cut it covers her head. Sonnet's smaller top-right
    title clears her.
  - **Why the checks miss it:** nothing checks a layer against the frames
    under its whole span. That is H3's `look` stage.
- **A name card off the frame.**
  - **What happens:** Haiku's stamp sits at x 330 at full scale, and its left
    third is off screen ("…ENZEL").
  - **Why the checks miss it:** `text-offscreen` covers Text layers only. A
    Motif's bounds (manifest size × scale around its position) are known
    without rendering, so the rule can cover Motif layers.
- **Captions on the paper insert.**
  - **What happens:** white captions over kraft are hard to read in all three
    runs.
  - **Why it matters:** the clipping caption tokens have no shadow, and a
    plate under the captions is what the style is for. It needs a caption
    treatment that survives paper, such as an ink outline or shadow token.
- **Small quotes.** Opus's quotes at 0.75 scale and Sonnet's at 0.6 put the
  body text at about 25–33 px on a 1080 frame. Nothing checks the rendered
  size of a Motif's text.
- **Quotes over the slide screen.** All three put the quotes over the
  lecture slides. That clears her, as asked, but covers the diagram she is
  pointing at.

## Re-captioning after a cut

- **The problem.** `transcribe_clip` takes one layer. After tightening, the
  A roll is 27–79 clips:
  - **Opus and Sonnet** transcribed every clip again (28 and 36 calls).
  - **Haiku** transcribed the original clip once, before the cut. It then
    wrote cue times onto the tightened timeline itself (`word_timing: none`,
    59 cues). That cost one call and the cues land roughly right, but the
    timing is the model's estimate.
- **Fix candidates:**
  - transcription over a time range across clips;
  - `remove_pauses` carrying an existing transcript through the cut.

## Compared with H1

- **What carried over:** the H1 explainer tasks were text-only. The H1 gains
  hold here: roles, the style's look, caption limits, and audits run by the
  agent. They now reach drawn overlays: every model produced the same visual
  language, from the same tokens, with exits.
- **Short clips:** the H1 cut-only failure is narrower. Opus left none, and
  Sonnet undid its first pass when it left 15 short clips. Haiku kept 15 and
  tacked them, which the skill allows, but it reads as stutter.

## Open

- `text-offscreen` over Motif layers, from manifest size, scale and position.
- A caption outline or shadow token in `clipping`, so captions read over
  paper.
- Re-captioning a tightened cut in one call.
- Title placement against the footage under the whole span: H3's `look`
  stage.
