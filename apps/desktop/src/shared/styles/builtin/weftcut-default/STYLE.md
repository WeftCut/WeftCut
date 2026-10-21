---
name: weftcut-default
version: 1
description: WeftCut's neutral house style — legible white type over any footage, with the timings an editor would ship.
roles: []
tokens:
  palette:
    ink: "#FFFFFF"
    shade: "#000000"
    accent: "#FFD23F"
  text:
    # Untagged text keeps the app's long-standing default, so nothing a user
    # makes without a role changes look.
    none:
      family: null
      size_px: 72
      weight: 400
      italic: false
      color: ink
      align: Center
      position: [0.5, 0.5]
      anchor: [0.5, 0.5]
      box_w: null
      outline: null
      shadow: null
      intro: null
      outro: null
    title:
      family: null
      size_px: 96
      weight: 700
      italic: false
      color: ink
      align: Center
      position: [0.5, 0.16]
      anchor: [0.5, 0.5]
      box_w: 0.8
      outline: { color: shade, width: 3 }
      shadow: { color: "#00000099", offset_x: 0, offset_y: 4, blur: 12 }
      intro: FadeIn
      outro: FadeOut
    lower_third:
      family: null
      size_px: 48
      weight: 600
      italic: false
      color: ink
      align: Left
      position: [0.08, 0.84]
      anchor: [0, 1]
      box_w: 0.5
      outline: { color: shade, width: 2 }
      shadow: { color: "#00000099", offset_x: 0, offset_y: 3, blur: 10 }
      intro: SlideUp
      outro: FadeOut
    callout:
      family: null
      size_px: 44
      weight: 600
      italic: false
      color: ink
      align: Left
      position: [0.62, 0.3]
      anchor: [0, 0.5]
      box_w: 0.3
      outline: { color: shade, width: 2 }
      shadow: { color: "#00000099", offset_x: 0, offset_y: 3, blur: 10 }
      intro: FadeIn
      outro: FadeOut
    credit:
      family: null
      size_px: 36
      weight: 400
      italic: false
      color: ink
      align: Center
      position: [0.5, 0.9]
      anchor: [0.5, 1]
      box_w: 0.8
      outline: { color: shade, width: 1.5 }
      shadow: null
      intro: FadeIn
      outro: FadeOut
  caption:
    family: null
    size_px: 54
    weight: 400
    italic: false
    color: ink
    position: [0.5, 0.92]
    anchor: [0.5, 1]
    box_w: 0.84
    outline: { color: shade, width: 3.24 }
    shadow: null
    max_chars_per_line: 42
    max_lines: 2
    min_cue_s: 1.2
    max_cue_s: 6
---

# WeftCut default

The style a project is in until its TASTE.md says otherwise. It is deliberately
plain: white type in the app's bundled face, kept legible over any picture by
an outline and a soft shadow rather than a box, so it suits footage nobody has
graded for it.

- **Titles** sit in the top third, not the centre, so they never cover a
  speaker's face, and fade in and out.
- **Lower thirds** sit bottom-left inside the safe area, two lines at most —
  name, then affiliation — and slide up.
- **Callouts** sit beside what they point at, short and one idea each.
- **Captions** keep the transcription look: white with a black outline at the
  bottom centre, at most two lines of 42 characters, each cue on screen for
  1.2 to 6 seconds.

Pixel sizes are for a 1080-pixel-tall frame and scale with the composition.
