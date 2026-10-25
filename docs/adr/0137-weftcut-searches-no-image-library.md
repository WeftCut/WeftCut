---
status: accepted
---

# WeftCut searches no image library

Date: 2026-10-25

## Context

ADR 0133 gave the agent `search_images` and `import_image`: a Wikimedia
Commons search run by the MCP host, with licence filtering, a download path,
a `credits.json` beside the project, a `credits` view and a Settings switch.
It was added when the H3 cuts had no pictures to show.

Shrinking the harness (ADR 0135, 0136) asked what belongs in the app. An
image search is a service of its own: a library's API, its licences, its
terms, a network path from the app, and a credit record that only this one
source writes. None of that is editing. The client an agent runs in has its
own web tools, or the user has the pictures.

## Decision

- **WeftCut calls no image library.** `search_images`, `import_image`, the
  `credits` view, `credits.json` and the Settings switch are removed. This
  supersedes ADR 0133 and restores ADR 0132's position.
- **Pictures come from the user, the footage, or the agent's own hand.** The
  recipe's order is the user's media, a still from the footage, an image the
  agent's model generates, a drawing it writes as SVG.
- **A missing picture is reported, not fetched.** The handoff names each
  point no picture covers, so the user can supply one for the next round.

## Consequences

- **Licences stay the user's business.** The app records no credit; media
  the user imports is theirs to clear.
- **An agent that wants a found picture fetches it with its client's tools**
  and imports the file. The app treats it like any user file.
- **The bench's pictures task stands:** its pictures are imported at setup
  as the user's own, and its missing-picture item expects a drawing, a still
  or a note, never a search.
