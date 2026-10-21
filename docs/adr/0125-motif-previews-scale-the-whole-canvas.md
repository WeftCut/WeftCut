---
status: accepted
---

# Motif previews scale the whole canvas

Date: 2026-10-21

## Context

`preview_motif` passed its `width`/`height` to the capture as the page's
viewport. A Motif page has fixed CSS dimensions, so a preview smaller than the
canvas showed the page's top-left corner. Every model on the agent bench read
the parameters as an output size: Haiku previewed a 1920×1080 title card at
640×360, saw an empty plate, and spent about thirty turns debugging a Motif
that was correct; Sonnet and Haiku in other runs hit the same crop and
recovered by previewing at full size
(`docs/notes/agent-bench-baseline-2026-10-20.md`).

## Decision

A preview always renders at the Motif's canvas size, as a placed layer does.
`width`/`height` bound the returned image: the whole frame is scaled to fit,
keeping its aspect ratio, by at most 2×. The PNG capture takes the factor as a
screenshot scale; the layout is never re-run at another size. The result names
the canvas and image sizes beside the revision.

## Consequences

A preview can no longer show part of a Motif, so a small preview is a cheap
whole-frame check rather than a trap. A request for a non-matching aspect
ratio returns a smaller image than asked for, not a stretched or cropped one.
Previewing a region at full detail is no longer possible; nothing used it.
Texture captures for playback and export are unchanged.
