---
status: accepted
---

# New layers are born in the project's style

Date: 2026-10-21

## Context

The first agent bench found that the look of an edit is whatever the tools
default to: every model's titles and captions came out as the creation
defaults (`docs/notes/agent-bench-baseline-2026-10-20.md`). ADR 0126 put a
project's style into data the app reads; Q9 decided that data should be the
defaults, for agents and the UI alike, with a way back to it after edits.

## Decision

- **Text** created through the actor's text path — `add_text_layer`, the UI's
  text tool, dry runs — starts from the default params, then takes the merged
  text tokens of its `graphic_role` (`none`'s when untagged or when a custom
  role has none), then what the caller said explicitly (`x`/`y`, the role).
  A null `family` token means the app's default text font.
- **Transcript captions** (`apply_transcripts`) take the `caption` tokens,
  and are built to the style's caption limits, the same numbers the audit
  checks. Lines break at word boundaries. A segment too long for its lines or
  for the longest cue is split in time at its words. A cue too short to read
  joins the neighbour it reads with when the two still fit, or stays up
  into the following pause. An imported subtitle file keeps the
  styles and cues it carries.
- **`restyle_to_taste`** resets chosen Text layers — by ids, by role, or every
  caption — to the tokens in one recorded edit, by groups: `look`,
  `position`, `motion`. The default leaves position alone, so a placement an
  agent or user chose survives a restyle.
- Tokens are read from `project://taste` at each creation, so an edit to
  TASTE.md reaches the next layer without a reload. Pixel tokens scale with the
  composition height from a 1080-pixel reference.
- `weftcut-default` is chosen so that untagged text and the look of
  transcript captions are stored exactly as before. Only tagged roles change,
  and long transcript cues are broken to 42 characters × 2 lines and 1.2–6 s.

## Consequences

An agent that tags a title gets the style's title without reading the style,
which is the "correct by construction" rung of ADR 0123. Motif and image
layers take only the role for now; their look lives in the Motif or the
media. Captions no longer need an agent to break them by hand: the H1 bench
saw 41–42 `update_layer_params` calls per run for that
(`docs/notes/agent-bench-h1-2026-10-21.md`). `correct_caption_text`
re-segments to the manuscript's sentences and does not apply the limits; the
audit reports what it leaves.
