---
name: clipping
version: 1
description: Editorial cut-and-paste — torn paper, newsprint, ink drawings and a highlighter laid over the footage, entering with one calm spring; processes animate in ink and red.
roles: []
motifs:
  title: clipping-headline
  lower_third: clipping-stamp
  callout: [clipping-quote, clipping-pointer, clipping-reveal]
  plate: clipping-paper
  illustration: clipping-sticker
tokens:
  palette:
    ink: "#16130F"
    paper: "#F2ECDF"
    red: "#D2261C"
    highlight: "#FFE9A6"
    white: "#FFFFFF"
    shade: "#000000"
  # Every clipping Motif reads these props; a TASTE changes them in one place.
  motif:
    ink: ink
    paper: paper
    accent: red
    highlight: highlight
    step_fps: 0
  # Open fonts first (download links below), then faces most systems have.
  # A Motif takes the families installed on this machine, in this order.
  fonts:
    headline: [Anton, Bebas Neue, Impact, Arial Black, Noto Sans SC Black, Microsoft YaHei]
    cjk: [Noto Sans SC Black, Source Han Sans SC Heavy, PingFang SC, Microsoft YaHei]
    body: [Noto Serif, Source Serif 4, Georgia, Times New Roman, Noto Serif SC, Source Han Serif SC, Songti SC, SimSun]
    folio: [IBM Plex Mono, Menlo, Consolas]
  # Plain text, for a role an agent chooses to set as Text rather than a
  # Motif. It keeps the default style's legible look.
  text:
    none:
      family: null
      size_px: 72
      weight: 400
      italic: false
      color: white
      align: Center
      position: [0.5, 0.5]
      anchor: [0.5, 0.5]
      box_w: null
      outline: null
      shadow: null
      intro: null
      outro: null
  caption:
    family: null
    size_px: 54
    weight: 400
    italic: false
    color: white
    position: [0.5, 0.92]
    anchor: [0.5, 1]
    box_w: 0.84
    # Captions also run over the paper inserts: a heavier ink outline than
    # the transcription default (6 % of the size) keeps white text legible
    # on kraft and newsprint as well as on footage.
    outline: { color: ink, width: 5 }
    shadow: null
    max_chars_per_line: 42
    max_lines: 2
    min_cue_s: 1.2
    max_cue_s: 6
---

# Clipping

An editorial cut-and-paste look for explainers: the footage stays the user's
own, and what the edit adds is paper. It looks like torn strips, newsprint, a
rubber stamp and a highlighter, as if pasted onto the frame, and ink drawings
that move on paper where the talk explains how something works. The motion is
calm, not jittery. Everything enters with one shared spring (damping 18, mass
0.75, stiffness 110), one element after another, never two on the same frame.
The paper feel is static: a slight tilt, one shared soft shadow, torn edges and
grain.

**The Motifs below are examples, not a template.** They show the vocabulary in
use. Use one as it is, fork it (`open_motif_draft` from a copy) and change what
the video needs, or write a new Motif in the same vocabulary: the palette and
fonts through the shared props (`ink`, `paper`, `accent`, `highlight`,
`font_<slot>`), the spring, the tilt and shadow, torn paper. A fork keeps those
props, so it takes the project's tokens like the originals.

**Leaving.** Each example knows its layer's length through `duration_s` (keep
it equal to the layer's), and leaves in its last half second by `exit`:
- `lift`: taken off the page;
- `slide_*`: thrown aside;
- `fade`;
- `none`: hold to the cut.

Its pieces leave in reverse order of arrival. For a big transition, take the
elements off one by one, by ending their layers a beat apart, then move the
page. `clipping-paper` slides in with `enter` and out with `exit`, across the
whole frame.

- **Titles** (`clipping-headline`) are a torn paper strip carrying a condensed
  headline, with an optional red kicker tag (`CHAPTER 01`). `band: ink` or `red` turns the strip dark for a chapter card. Put them
  in the top third, or over a `clipping-paper` plate for a full title card.
- **Lower thirds** (`clipping-stamp`) are the name on a paper strip and the role
  in a red rubber stamp below it. Place one bottom-left inside the safe area,
  when the person first speaks, for at least 4 seconds.
- **Callouts** quote or point:
  - `clipping-quote` is a newsprint clipping. The highlighter sweeps the words
    `highlight_from` to `highlight_to`, counted from 0, and CJK counts
    characters. Use it for the line the viewer should remember.
  - `clipping-pointer` is a red marker arrow, circle or underline drawn onto
    the footage, with its label at the arrow's tail, under the underline or
    below the circle. Turn it with `angle_deg` to point at the thing.
  - `clipping-reveal` is a word on a torn strip, hidden under a newsprint,
    kraft or paper cover that is torn off at `cue_tear_s`. Set the cue to
    the word's time, so the tear lands as she says it. It is an
    interaction: the cover and the word share one Motif because the tear
    shows the word.
- **Plates** (`clipping-paper`) are full-frame kraft, newsprint or paper grounds.
  Put one between on-camera stretches as an insert, and lay titles, quotes and
  images on it.
- **Illustrations** (`clipping-sticker`) are a picture pasted on as a paper
  cut-out. The picture comes through its `photo` media prop: a
  pool image, or a still from the footage cropped with `crop_*` to what
  matters. `frame: cutout` follows the picture's own outline with a hand-cut
  paper edge, for a person or an object on a transparent ground (a cut-out
  PNG, a drawing); `paper` and `torn` mount it as a rectangle. `treatment`
  prints a photo `mono` or as newsprint `halftone` dots in `ink`, so pictures
  from different sources sit together. Without a photo it draws its own
  `art.svg`, an ink drawing in flat colour. To draw a picture of your own,
  write an SVG with the same heavy ink line and flat fills on a transparent
  ground and `import_media` it: it becomes a PNG in the pool, ready for
  `photo`.
- **Pictures lead; words label them.** This is a collage look. The people,
  objects, places and documents the talk names are pasted in as pictures,
  and the strips, stamps and tags name them: a name stamped under a
  portrait, a date on a document. When she names someone, their portrait
  can be slapped on beside her, with a stamp. Most of what the edit adds is
  pictures, not headline strips. A picture the user's media lacks can come
  from an open image library (`search_images`), credited.
- **Scenes** explain a concept in full frame while she talks. A process is an
  animation (above). Anything else is a collage on a plate: a hero picture over about half the frame, one or two
  smaller pictures, and labels and pointers on them. It is a Group, and
  every piece in it that moves on its own is its own layer. Its pieces:
  - a `clipping-paper` plate;
  - `clipping-sticker` pictures, the hero large and the others smaller;
  - a `clipping-stamp` or a small `clipping-headline` tag naming a picture,
    on it or beside it;
  - a `clipping-pointer` or a `clipping-reveal` for what the viewer should
    find, on its word.

  The pieces leave a beat apart, the last with the plate. Put the scene's
  track below the captions so they stay readable over it. Build scenes from
  what the talk explains, not from this list.
- **Animations** show a process happening, drawn in ink on the paper ground
  with the red accent for what matters. Write one as a Motif in this
  vocabulary: a camera that moves from one element to the whole and in on
  what matters, lines drawn on, beads of red travelling along paths, the
  rest dimmed for focus, a lens for a detail. Set each step's cue from the
  time of its word. It needs no words: the captions carry the speech. Drawn
  on its own paper ground, it is a scene by itself, below the captions.
- **Tape** is optional. The examples take `tape: none`, and their pieces sit
  on the frame by their shadow. `tape: strip` adds a strip of masking tape,
  for a scrapbook look.
- **Decoration** (`clipping-scrap`: a newsprint strip, a torn piece, tape) is
  untagged. Use it sparingly, to tuck behind an image or a quote.
- **Captions** stay plain white type at the bottom, at most two lines of 42
  characters, each cue on screen for 1.2 to 6 seconds. The paper is for what
  the edit adds, not for every word spoken.

`step_fps` (0 = smooth) holds each pose for 1/step_fps s. Set it to 12 in a
TASTE for a hand-made, stop-motion feel.

Small text exits mid-shot. Paper inserts and chapter cards should not cut out:
lift their pieces off and slide the page away.

Fonts are not bundled. Each Motif uses the first of its slot's families that is
installed, and `project://taste` lists the missing ones. The open faces this
style is drawn for:

- Anton: https://fonts.google.com/specimen/Anton
- Bebas Neue: https://fonts.google.com/specimen/Bebas+Neue
- Noto Sans SC: https://fonts.google.com/noto/specimen/Noto+Sans+SC
- Noto Serif: https://fonts.google.com/noto/specimen/Noto+Serif
- Noto Serif SC: https://fonts.google.com/noto/specimen/Noto+Serif+SC
- IBM Plex Mono: https://fonts.google.com/specimen/IBM+Plex+Mono

Pixel sizes are for a 1080-pixel-tall frame and scale with the composition.
