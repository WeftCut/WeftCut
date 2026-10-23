---
status: accepted
---

# A Motif may show a still from the media pool

Date: 2026-10-22

## Context

Explainer scenes show their idea in pictures, and words label them. The
first example scene (ADR 0131) was all words, because nothing in a style could
draw a picture:
- A Motif could not show project media. The capture host blocked it, so that
  footage and photos stayed WeftCut layers.
- An image layer shows a picture as it is: no paper cut-out, no tape, no
  shadow, no entrance in the style.

The user wanted picture stickers in scenes. ADR 0045 froze the props schema at
four variants (string, color, number, enum), so that the schema stays a data
plane and presentation lives in a Motif's own params page. A picture is data,
not presentation, and none of the four can carry it.

Moving footage was weighed and kept out. A browser `<video>` is not
frame-accurate under seeking, its frames could not be cached, and trim,
retime and audio would be duplicated from the video layer.

## Decision

- **A fifth prop variant, `media`.** Its default is `""`. A value is a
  string, so props stay scalar wherever they travel:
  - `""`: no picture;
  - `"<media_id>"`: a pool image;
  - `"<media_id>@<t_us>"`: one frame of a pool video, at source time `t_us`.

  This revises ADR 0045's "no fifth variant": the schema stays a data plane,
  and the variant is data. The fallback form renders it as a media list,
  plus the frame time for a video.
- **The capture host serves the picture on the Motif's own origin.** Before
  `setup`, each media prop becomes `motif://<id>/.media/<picture key>`. The
  motif protocol serves only pictures a capture resolved. The render CSP is
  unchanged, and no bytes cross the capture channel per frame. A video frame
  is taken once with the bundled ffmpeg, at full size, and kept on disk.
- **The picture key is the file's content hash,** plus the frame time for a
  video. The project view carries each Motif layer's picture keys, and frame
  cache keys include them. Replacing the file redraws the Motif, and a Motif
  without a media prop keeps its old cache keys.
- **Placing a ref the pool cannot draw is refused:** a missing item, audio,
  or a frame time on an image. A ref that goes missing later resolves to
  `""`, and the Motif draws its fallback.
- **The scope rule narrows** from "the user's media stays outside" to "no
  moving footage inside a Motif". A video sticker is a Group of the video
  layer and a frame Motif.
- **Exported Motif packages carry no media.** The picture belongs to the
  project.
- **A built-in role `illustration`** tags a picture element: a photo, a still,
  a drawing. The audit's `scene-all-words` (review) asks a scene Group made
  only of words for one.
- **`clipping` gains `clipping-sticker`.** It pastes the picture on as a paper
  cut-out, can crop it to a region (the slide behind a speaker), and draws its
  own `art.svg` when there is none. A fork replaces the SVG with a drawing of
  its own.
- **Where pictures come from is the agent's to say.** WeftCut calls no image
  service (revised by ADR 0133: it searches Wikimedia Commons for the agent,
  and the order below gains that search after the footage). In order of
  preference:
  1. the user's media;
  2. a still from the footage;
  3. an image the agent's own model generates, imported like any file;
  4. an SVG drawing in a fork of the sticker.

  The report lists each generated or drawn picture, like an outside fact.

## Consequences

- **Fallback for generations.** A client whose model cannot output images
  falls back to drawing, which takes more authoring.
- **Disk use.** Video stills accumulate in the cache directory
  (`motif-media/`), one PNG per frame used.
- **Rendering depends on the open project.** A media prop is resolved against
  the project open in the app. Without one it is `""`.
- **Every PropSpec switch handles a fifth case:** the shared catalog, the IPC
  twin, the golden fixture, the fallback form and the taste's token fit.
