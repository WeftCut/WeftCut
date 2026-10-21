---
status: accepted
---

# Text entrance and exit presets play

Date: 2026-10-21

## Context

Text params have carried `intro` and `outro` (`FadeIn`, `FadeOut`, `SlideUp`,
`SlideDown`, `Typewriter`) since the canonical model, mirrored in Rust, but
nothing set them and nothing rendered them: no tool, patch or panel wrote the
fields, and the renderer's text view did not carry them. On the first agent
bench every title and lower third popped on and off
(`docs/notes/agent-bench-baseline-2026-10-20.md`), and the style tokens and
the lint's `text-pops` rule (ADR 0126, H1) had nothing real to point at.

## Decision

The presets play. One pure function (`shared/textAnimation.ts`) says what a
preset does at a layer-local time given the layer's length, and the renderer's
text resolution applies it, so preview and the export bake — which share the
composition walk — play the same frames.

- An entrance or exit lasts 400 ms, or a third of the layer when that is
  shorter, with an ease-out curve. Fades scale the layer's own opacity; slides
  travel half the font size (up into place for `SlideUp`, and up and away on
  exit); `Typewriter` reveals a character per 40 ms over at most half the
  layer.
- Presets are directional: `intro` takes `FadeIn | SlideUp | SlideDown |
  Typewriter`, `outro` takes `FadeOut | SlideUp | SlideDown`.
- They are semantic, not keyframes: they stay attached to the layer's own
  start and end, so trimming or moving a layer keeps its entrance at the head
  and its exit at the tail — the reason to prefer them over opacity keys.
- `update_layer_params` sets and clears them on Text (`null` clears).

## Consequences

Style tokens that name an entrance now change what the viewer sees, and the
lint's `text-pops` finding has a one-field fix. Existing projects are
unchanged: nothing could have set the fields before. Duration and travel are
fixed; a per-layer duration is a later param if the bench asks for one. The
properties panel does not expose the presets yet.
