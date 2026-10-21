---
status: accepted
---

# A style's Motifs are examples, and take its tokens

Date: 2026-10-22

## Context

ADRs 0126 and 0129 put a project's look into tokens that Text layers are born
in. An editorial explainer look (the `clipping` idiom: torn paper, tape,
newsprint, a stamp and a highlighter over the user's footage) is mostly
drawn, not typeset, so it lives in Motifs. Three questions followed:

- How does a Motif get the project's palette and fonts?
- Must a role always be drawn with the style's Motif?
- How does an element leave?

The first design answered "always" to the second. Its audit rule `role-motif`
reported a role drawn as plain Text where the style names a Motif, and
`role-inconsistency` reported one role drawn with different Motifs. A
checkpoint sample showed what that costs: a fixed set of six Motifs decides
what every video can show. The same sample hard-cut its paper inserts away,
which reads worse than taking the pieces off. A layer-level exit preset model
for Motifs was proposed and rejected as too heavy for what a Motif can already
animate itself.

## Decision

- **A style names example Motifs per role.** `STYLE.md` (and a TASTE.md, per
  role) carries `motifs: { <role>: <id> | [<id>…] }`. `project://taste` lists
  them with their props schemas. They are a starting point: an agent uses one
  as it is, forks it into a draft and adapts it, or writes a new Motif. The
  audit does not report which Motif draws a role. It still checks holds on
  Motif layers by role and drift on their token-backed props.
- **The style reaches a Motif through shared prop keys.**
  - The token group `motif: { <prop key>: value }` fills any prop with that
    key and a fitting type, wherever the Motif came from. A colour may name a
    palette entry.
  - The token group `fonts: { <slot>: [family…] }` fills a string prop
    `font_<slot>` with the slot's families installed on the app's machine, in
    order, as a CSS stack.
  - `add_motif_layer` and `add_motif` apply these under explicit props, and
    `restyle_to_taste` resets them.
  - A Motif that keeps the keys is in the style; one that drops them is a
    deliberate departure.
- **Fonts are not bundled.** A style lists open fonts first, then faces most
  systems have. The taste view reports each slot's missing families so the
  user can install them. A project renders with what the machine has.
- **Exits are written in the Motif.** A Motif that leaves declares a
  `duration_s` number prop as its `max_duration_prop`, so it knows where its
  layer ends. It plays its exit in the last half second, picked by an `exit`
  enum prop: `none`, `lift`, `fade` or `slide_*`. Its pieces leave in reverse
  order of entry. A full-frame plate may also take `enter`. A sequence of
  elements leaves by ending their layers one after another. There is no
  layer-level exit preset for Motifs and no model change.

## Consequences

- **Agent freedom.** An agent can make a video the examples did not foresee
  and still land in the style, because the look travels in the prop keys, not
  in the Motif ids.
- **Effort.** It pays for that freedom with authoring work when it departs.
- **The bench changes.** It checks the role, the hold and the token-backed
  props, not whether a style's Motif was used.
- **Layer length and `duration_s` move together.** The layer is capped to
  `duration_s`, so lengthening an element means changing both.
- **The held stretch costs frames.** A Motif that exits animates over its
  whole length, so its held stretch is captured frame by frame rather than as
  one held frame.
- **Small elements cannot leave the frame.** They cannot travel past their
  own canvas, so their slides fade as they go. Only full-frame Motifs truly
  slide out of the frame.
- **Rendering differs across machines.** Different installed fonts give
  different frames. If export needs the same frames everywhere, the resolved
  font's bytes could later be handed to the Motif as a `data:` URL.
