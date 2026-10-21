---
status: accepted
---

# Styles are packages, and TASTE.md is read, not written

Date: 2026-10-21

## Context

ADR 0123 puts a project's look in data the app holds — a style plus the
project's own overrides — so tools and checks can apply it whichever model
drives them. The first agent bench showed why it matters: every model's
titles, lower thirds and captions came out as the tool defaults
(`docs/notes/agent-bench-baseline-2026-10-20.md`).

## Decision

A **style** is a directory whose `STYLE.md` carries YAML frontmatter (`name`,
`version`, `description`, `roles`, `tokens`) and prose; any other file in the
directory is part of the package. Its identity is a SHA-256 over every file's
path and bytes. Built-in styles ship with the app (`src/shared/styles/builtin`,
packed to `resources/styles/builtin`); user styles live in
`<data root>/taste/styles/<name>/`. A built-in name cannot be shadowed. The
app ships one, `weftcut-default`, which keeps today's untagged text look and
gives the tagged graphic roles and captions the craft timings.

A project's **TASTE.md** sits in its folder: `extends: <style>[@<hash
prefix>]`, `roles` (custom role declarations), `tokens` (overrides) and prose.
No TASTE.md means `weftcut-default`. The app only reads it.

Tokens (schema v1) are limited to values that map onto params a layer
already has — per-role text tokens, caption tokens, a named palette, and
`floors` that tighten craft thresholds. Pixel tokens are for a 1080-pixel
frame and scale with the composition. The merge is per field at a fixed
depth; `outline`, `shadow`, `position` and `anchor` replace whole. Every merged
leaf records whether the style or TASTE set it.

Author mistakes never fail the read. An invalid field is dropped with a
diagnostic naming its path and the style's value stands; unparseable
frontmatter falls back to the style; an unknown style falls back to the
default; a pin that no longer matches the installed package is a warning,
since the app keeps no old package versions to fall back to.

The merged result is `project://taste` and `read_project { view: "taste" }`,
read fresh on each request and answered on the start screen too (the default
style alone).

## Consequences

Layer creation and the lint (later tickets) read one merged view, so a style
change reaches tools, UI and checks together. Styles are shareable folders
with an identity, like Motif packages. Because the app never writes TASTE.md,
pinning and editing are the user's or the agent's file edits; the view reports
the state and the hash to pin. Token kinds that need new layer params (a text
plate, transition sets, motion timings) wait for those params.
