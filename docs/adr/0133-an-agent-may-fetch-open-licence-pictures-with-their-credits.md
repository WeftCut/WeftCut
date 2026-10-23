---
status: accepted
---

# An agent may fetch open-licence pictures, with their credits

Date: 2026-10-23

## Context

At the H3 checkpoint the user found the cuts monotonous. They were words on
paper, unlike the Vox-style explainers they want, which show the people,
objects, places and documents a talk names. Every picture in the H3 runs was
a still of the slide the speaker stood beside. The agents had nothing else:
- the lecture came with no other media;
- Claude models cannot output images;
- drawing meant forking a Motif per picture.

ADR 0132 listed the picture sources and said WeftCut calls no image service.
The user set the order instead:
1. their own media;
2. a search of open image libraries, when their media is missing a picture
   or does not cover a point;
3. a drawing, when the search finds nothing.

A client's own web fetch could find images. It would not record a licence,
and the bench's agent has no web tools.

## Decision

- **WeftCut searches Wikimedia Commons for the agent.**
  - `search_images` returns candidates as thumbnails with their licence and
    credit line, so the agent can look before it chooses.
  - `import_image` fetches one into the pool.
  - Both run on the MCP host. The actor never reaches the network.
- **Only licences that allow changes and commercial use:** CC0, public
  domain, CC BY and CC BY-SA. NC, ND and GFDL-only files are dropped before
  the agent sees them.
- **The licence comes from Commons, never from the call.** `import_image`
  asks Commons for the candidate again by its page id and credits it from
  that answer.
- **A credit is kept beside the project,** in `credits.json`, keyed by the
  pool item's content hash.
  - It follows the file through a relink or a move.
  - It needs no change to the project model, its diff or its schema.
  - `read_project { view: "credits" }` lists the credited items and whether
    the cut uses them.
  - The handoff report carries the credit lines. CC BY and CC BY-SA require
    credit; CC BY-SA also requires that adaptations be shared under the same
    licence. That is the user's to honour when publishing, and the report is
    how they learn it applies.
- **The user can turn it off.** The setting is Settings → "Let agents search
  open image libraries". It is on by default, and its hint says the search
  words go to Wikimedia. Off, both tools refuse, and the agent falls back to
  stills and drawings.
- **Downloads are untrusted.**
  - https only, from the URL Commons gave.
  - A JPEG, PNG, WebP or GIF by its content type.
  - At most 40 MB, and large files come as Commons' 2048 px rendering.
  - Imported through the same probe as any user file.
- **A drawing is an SVG the agent writes and imports.** `import_media` draws
  an `.svg` once to a PNG with its transparency kept. The SVG is drawn as an
  image, so it runs no script and loads nothing outside itself.
- **The source order is now:**
  1. the user's media;
  2. a still from the footage, cropped to a detail;
  3. an open-licence picture from `search_images`;
  4. a picture the agent's model generates, where it can;
  5. a drawing.

  This revises ADR 0132's list and its "WeftCut calls no image service".

## Consequences

- **Openverse is not used.** It aggregates Flickr and museum collections
  beyond Commons, but it answered every anonymous request from the test hosts
  with a Cloudflare challenge. Commons alone covers people, places, objects
  and old documents well; it covers recent people less well, whose photos are
  rarely free.
- **Network failures surface as tool errors.** The recipe then falls back to
  a drawing.
- **`credits.json` travels with the project folder.** A Save As that copies
  the folder carries it. A pool item imported again from the same file gets
  its credit back, by hash.
- **The catalog grows by two tools,** about 2 KB of the tool list's byte
  budget.
