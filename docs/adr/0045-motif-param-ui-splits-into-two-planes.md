---
status: accepted
---

# A Motif's parameter surface splits in two: the schema is the data plane, the Motif owns the UI plane

Date: 2026-08-17

## Context

`props_schema` is at once the persistence contract, the MCP drafting contract
and the source of the host-generated parameter form. Every control the form
lacked (slider, boolean, section, conditional row) was a wire-contract change
in five places: the shared catalog, the hand-copied `PropSpec` twin in the
renderer IPC, the behaviour golden, the MCP tool descriptions and the form
generator. Labels could not be localized: user- and agent-authored Motifs are
arbitrary on-disk documents whose prop keys the host cannot enumerate, so no
registry can hold their strings. Motifs are shareable author documents; a host
vocabulary that must grow for every author's UI idea makes each idea wait for a
host release.

## Decision

- **The schema is data only.** It keeps validation, defaults, lenient
  canonicalization, persistence, the key-wise `update_layer_params` merge,
  `max_duration_prop` and the drafting contract. No variant gains a label,
  description, order, group or widget hint. A new variant is admitted only for
  new *data* (`media`, ADR 0132); there are five.
- **The UI plane is a `params.html` page the Motif ships.** File presence is the
  only switch: `has_params_ui` is a catalog payload decoration from a `stat`,
  never a manifest field, so no manifest can claim a page it lacks.
- **The page is untrusted.** It runs in an iframe with `sandbox="allow-scripts"`
  and no `allow-same-origin` (opaque origin, no storage, no network). The host
  authenticates the sender by window identity, shape-checks every payload, drops
  keys outside the schema and lenient-canonicalizes the rest against the current
  manifest. A hostile page yields a wrong-looking value, never an invalid
  project.
- **Five verbs.** Host → page `motif:init`, `motif:propsChanged`; page → host
  `motif:preview` (per-layer overlay, no command, no history; 250 ms
  leading+trailing throttle; only the on-screen sprite reads it),
  `motif:commit` (one `update_layer_params`, one undo entry for the whole
  patch), `motif:resize` (advisory, clamped to [80, 1200] px, default 240).
- **Theme and locale ride `init`;** the host registers no Motif strings. The
  curated theme-token list is a page-facing contract.
- **The params CSP is its own:** `default-src 'none'`, inline plus `motif:`
  scripts, styles, images and fonts, no `connect-src` and no `'self'` (it
  matches nothing on an opaque origin). The renderer frames only `motif:`.
- **The fallback form stays, frozen.** Bare keys title-cased, deliberately
  unlocalized, one key per gesture. countdown and lower-third stay on it so it
  stays exercised.

## Consequences

- Two surfaces are supported forever: the protocol and the fallback form.
- Renaming a theme token silently unstyles author pages; the list changes like
  a wire contract.
- Multi-key atomicity exists only on pages; the fallback commits one key per
  gesture.
- Page bytes are package bytes and enter the render content hash (ADR 0079).

Rejected: growing the vocabulary (a migration per control, still no
conditional rows or localizable labels); host-mounted author components (runs
untrusted code in the trusted shell, forecloses sharing); a manifest flag
(second source of truth); previews through the state actor (floods history,
pushes recaptures into the serialized ~80–100 ms capture pipeline);
`allow-same-origin` (hands author code the app's DOM and schemes).
