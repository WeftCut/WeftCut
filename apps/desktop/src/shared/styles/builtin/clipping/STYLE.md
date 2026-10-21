---
name: clipping
version: 1
description: Editorial cut-and-paste — torn paper, tape, newsprint and a highlighter laid over the footage, entering with one calm spring.
roles: []
motifs:
  title: clipping-headline
  lower_third: clipping-stamp
  callout: [clipping-quote, clipping-pointer]
  plate: clipping-paper
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
  # Plain text is the fallback for a role drawn without its Motif (the audit
  # reports it as role-motif). It keeps the default style's legible look.
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
    shadow: null
    max_chars_per_line: 42
    max_lines: 2
    min_cue_s: 1.2
    max_cue_s: 6
---

# Clipping

An editorial cut-and-paste look for explainers: the footage stays the user's
own, and what the edit adds is paper. It looks like torn strips, tape, newsprint,
a rubber stamp and a highlighter, as if pasted onto the frame. The motion is
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
  headline, with an optional red kicker tag (`CHAPTER 01`) and a piece of
  tape. `band: ink` or `red` turns the strip dark for a chapter card. Put them
  in the top third, or over a `clipping-paper` plate for a full title card.
- **Lower thirds** (`clipping-stamp`) are the name on a paper strip and the role
  in a red rubber stamp below it. Place one bottom-left inside the safe area,
  when the person first speaks, for at least 4 seconds.
- **Callouts** quote or point:
  - `clipping-quote` is a newsprint clipping. The highlighter sweeps the words
    `highlight_from` to `highlight_to`, counted from 0, and CJK counts
    characters. Use it for the line the viewer should remember.
  - `clipping-pointer` is a red marker arrow with a label, a circle, or an
    underline drawn onto the footage. Turn it with `angle_deg` to point at
    the thing.
- **Plates** (`clipping-paper`) are full-frame kraft, newsprint or paper grounds.
  Put one between on-camera stretches as an insert, and lay titles, quotes and
  images on it.
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
