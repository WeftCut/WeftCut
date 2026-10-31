---
status: accepted
---

# A Motif may show a still from the media pool

Date: 2026-10-25

## Context

Explainer scenes show their idea in pictures. A Motif could not show
project media (the capture host blocked it), and an image layer shows a
picture as it is, with no cut-out, shadow or entrance in the style. ADR 0045
froze the props schema at four scalar variants, none of which carries a
picture.

Moving footage was weighed and kept out: a browser `<video>` is not
frame-accurate under seeking, its frames could not be cached, and trim,
retime and audio would duplicate the video layer.

A Wikimedia Commons search (`search_images`, `import_image`, licence
filtering, a `credits.json` beside the project, a Settings switch) was built
and removed: an image library is a service of its own (an API, licences,
terms, a network path from the app, a credit record only it writes), none of
it editing. Openverse answered every anonymous request from the test hosts
with a Cloudflare challenge.

## Decision

- **A fifth prop variant, `media`**, default `""`. A value is a string:
  `""` (none), `"<media_id>"` (a pool image) or `"<media_id>@<t_us>"` (one
  frame of a pool video). The schema stays a data plane; the picture is data.
- **Served on the Motif's own origin.** Before `setup`, each media prop
  becomes `motif://<id>/.media/<picture key>`; the protocol serves only
  pictures a capture resolved. The render CSP is unchanged and no bytes
  cross the capture channel per frame. A video frame is extracted once with
  the bundled ffmpeg at full size and kept in `<cache>/motif-media/`.
- **The picture key is the file's content hash** (plus `@<t_us>` for a
  frame), and frame cache keys include it, so replacing the file redraws the
  Motif.
- **Placing a ref the pool cannot draw is refused** (missing item, audio, a
  frame time on an image); a ref that goes missing later resolves to `""`
  and the Motif draws its fallback.
- **No moving footage inside a Motif.** A video sticker is a Group of the
  video layer and a frame Motif.
- **Exported Motif packages carry no media**; the picture belongs to the
  project.
- **WeftCut calls no image library.** Pictures come from the user's media,
  a still from the footage, an image the agent's model generates, or an SVG
  it draws, each imported like any file. A point no picture covers is
  reported, not fetched. The app records no licences or credits.

## Consequences

- Every PropSpec switch handles a fifth case: the shared catalog, the
  golden fixture, the fallback form, the picker and the taste's token fit.
- Video stills accumulate in `motif-media/`, one PNG per frame used.
- A media prop resolves against the project open in the app; without one it
  is `""`.
- An agent that wants a found picture fetches it with its client's tools;
  licences stay the user's business.
