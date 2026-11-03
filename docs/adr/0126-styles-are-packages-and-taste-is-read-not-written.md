---
status: accepted
---

# Styles are packages, and TASTE.md is read, not written

Date: 2026-10-25

## Context

The first agent bench found that an edit's look is whatever the tools
default to: every model's titles, lower thirds and captions came out as the
creation defaults (`docs/notes/agent-bench-baseline-2026-10-20.md`). The look
had to be data the app holds, so tools and checks apply it whichever model
drives them. Two later measurements bounded what a style may prescribe:

- An audit rule that required each role to be drawn with the style's named
  Motif made a fixed set of six Motifs decide what every video could show.
- Worked examples became every model's answer: all ten H5 cuts placed
  `clipping-network` with its default seed, including for processes it does
  not show. With the examples removed, Opus, Sonnet and Flash still wrote
  Motifs in the style's spring, shadow and palette
  (`docs/notes/agent-bench-style-2026-10-25.md`).

## Decision

- **A style is a package:** a directory whose `STYLE.md` has YAML
  frontmatter (`name`, `version`, `description`, `roles`, `motifs`, `tokens`)
  and prose; every file in it counts toward a SHA-256 identity. Built-ins
  ship in `src/shared/styles/builtin` (`resources/styles/builtin` when
  packed) and shadow user packages in `<data root>/taste/styles/<name>/`.
- **A project's `TASTE.md`** (`extends: <style>[@<hash prefix>]`, `roles`,
  `motifs`, `tokens`, prose) sits in the project folder. Absent, the style is
  `weftcut-default`. **The app only reads it**; pinning and editing are file
  edits by the user or agent.
- **Reads never fail.** An invalid field is dropped with a diagnostic and the
  style's value stands; bad frontmatter or an unknown style falls back; a
  stale pin is a warning (no old package versions are kept). The merged
  view is `project://taste`, read fresh on every request.
- **Tokens map onto existing params only.** Pixel tokens are for a
  1080-pixel-tall frame and scale with the composition.
- **Layers are born in the style, not linked to it.** Text and transcript
  captions take their role's tokens at creation (captions are built to the
  style's caption limits); Motif layers take `tokens.motif` for any prop
  with that key and a fitting type, and `tokens.fonts.<slot>` for a
  `font_<slot>` string prop. Explicit arguments win. `restyle_to_taste`
  resets chosen layers; a later style edit changes nothing already placed.
- **A style's Motifs are examples, not a template.** It ships its vocabulary
  in prose and tokens plus only the pieces every edit needs (clipping:
  headline, stamp, paper, sticker). The audit never checks which Motif draws
  a role; it checks holds and drift on token-backed props.
- **Fonts are not bundled.** A slot lists open fonts, then common system
  faces; the taste view reports missing families.
- **Exits are written in the Motif** (`duration_s` as `max_duration_prop`,
  an `exit` enum), not a layer-level preset.

## Consequences

- One merged view feeds tools, UI and audit, so a style change reaches all
  three together; the style travels in prop keys, so agent-written Motifs
  stay in it.
- Departing from the examples costs authoring turns, and matching the style
  then depends more on the model and the user's review.
- Frames differ across machines with different installed fonts.
- A Motif that exits animates its whole length, so its held stretch is
  captured frame by frame; a non-frame-sized Motif cannot slide past its
  canvas and fades instead.

Rejected: a `role-motif` audit rule and a full component set per style
(examples become the answer); a layer-level exit preset for Motifs (a Motif
already animates itself); bundling font bytes.
