# Motif authoring contract

The rules a Motif document must satisfy to render correctly in WeftCut. This is
the authoritative authoring spec: the in-app source panel, external editors, and
MCP agents all write against it. It is self-contained on purpose — a copy ships
with the app to agent clients, where no other WeftCut document is reachable.

A Motif is one parameterized, time-varying overlay element (a lower-third, a
countdown, a title card), placed as a layer among the user's footage, images
and text on the WeftCut timeline. It is authored as a real web page — one HTML
document plus a JSON manifest — and that page is the canvas for this one
element, not for the whole frame. Placed on the timeline, it is captured frame
by frame by a harness that owns the clock. Any HTML/CSS/SVG/canvas/WebGL and
any animation idiom (CSS, WAAPI, GSAP-style tweens, rAF loops) work, subject to
the scope rule and the one law below.

## Scope: one element or one interaction

A Motif draws one element with one purpose — a title, a lower third, a
callout, a credit, a logo, a full-frame background plate — with one entrance
and one exit. If describing what it shows needs "and", it is several Motifs on
several layers. Splitting keeps the frame editable in the NLE: each element is
retimed, moved and retexted on the timeline, the audit sees its role, and a
prop change recaptures only that element.

The one exception is an **interaction**: elements whose motion depends on each
other may share a Motif, because a Motif cannot see another layer. Examples
are a cover torn off to reveal a word, a lid that opens and what spills out,
and a leader line tied to a moving object. An interaction Motif:

- says in a comment why its pieces share it;
- exposes its text as props;
- exposes its key times as number props named `cue_<name>_s`, in seconds of
  its own time, so the user can retime it in the inspector. Trimming the
  layer's head advances `src_in_us` and leaves cues where they were in the
  Motif's time; retime by changing the cue prop.

Anything that enters, holds and leaves on its own is still its own layer.

- **No moving footage inside a Motif.** A Motif may show one still picture
  from the project's media through a `media` prop: an image, or one frame of
  a video. Moving footage is a WeftCut video layer, and Motifs decorate or
  annotate it from the layers above. A video sticker is a Group of the video
  layer and a frame Motif.
- **Plan the layers before writing code.** Overlay work with more than one
  element starts with a layer plan: for each layer, its kind (video, image,
  text or Motif), what it is for, and its in and out times on the timeline.
- **Stagger on the timeline.** Elements that enter one after another are
  separate layers offset on the timeline, not delays inside one page. A Motif
  times only its own animation: an element that animates in and then holds
  declares that entrance as `content_duration_s`, and its layer's placement
  decides when it appears and for how long.
- **`size` is the element's own bounds.** Size the manifest to what the
  element covers — a lower third is a strip, a callout a box — and let the host
  place it. A frame-sized Motif is for full-frame purposes only: a title card,
  a background plate, an animation of a process.

One element may still be large or intricate — a chart, a title card, a map
with its route. The rule counts purposes, not pixels.

**A scene of pictures is a Group.** A full-frame scene that shows a concept
through pictures and their labels is a Group (`create_group`) of a plate, one
layer per independent element, and at most a few interaction Motifs. The
editor moves and trims it as one clip and opens it to change an element.
Author it in this order:

1. **Treatment:** the scene's one idea, its hero moment, and its cues, taken
   from the words they go with.
2. **Key stills:** `preview_motif` of each element and of the plate, looked
   at before anything moves.
3. **Layers:** each element placed in the Group at its cue.
4. **Motion:** entrances, interactions and exits.
5. **Look:** the rendered frames of the Group (`render_frames`).

**A process is an animation.** When the speech explains how something works
(it grows, links, flows, sends, transforms, builds up), show it happening. The
scene is one frame-sized Motif that draws it: every piece moves because of
the others, so it is one interaction, and it is a scene by itself, with no
Group. Write it as a new Motif for the process the talk explains. The parts of
a concept animation:

- **Steps on words.** Storyboard it first: three to six steps, each with
  what moves and the word it starts on. Each step is a `cue_<step>_s` prop
  set from the word's time in the layer's own time.
- **A canvas, closed in t.** Build the structure in `setup` from a `seed`
  prop: where the elements are, what links to what, and when each signal
  leaves. Then draw each frame from t alone, so any frame renders on its own.
- **Moves that explain:**
  - a camera: close on one element, then out to the whole, then in on what
    matters;
  - growth: lines drawn on by their length, elements appearing in a wave
    from where it starts;
  - flow: a bead with a short tail along a path, and a flash where it
    arrives;
  - focus: the rest dims, and what the point is about lights in the
    accent;
  - a lens: a circle inset joined to its spot by a cone, for a detail at
    another scale.
- **No words it does not need.** The captions carry the speech. Label only
  a term the drawing cannot show.
- **The style's vocabulary:** its ground, its ink line, its one accent.
  Paper frames and tape are not needed. A `ground` prop draws the paper, so
  the animation is a scene below the captions; `ground: none` draws it over
  the footage instead.
- **Check it:** `preview_motif` at each cue and between cues before placing
  it, then `render_frames` once it is placed.

## The one law

> Any visible state MUST be computable **from `t` alone** — via declared
> animations or `frame(t)` — never via mutation that accumulates over time.

The harness drives the page to arbitrary times in arbitrary order (scrubbing,
re-export, cache fills). A document that accumulates state renders wrong the
first time it is seeked backwards.

```js
setInterval(() => { n++; label.textContent = n; }, 1000);   // ✗ stubbed, not seekable
frame(t) { label.textContent = Math.floor(t); }             // ✓ closed-form in t
```

| Forbidden pattern | Why | Write instead |
|---|---|---|
| `setInterval` / self-advancing rAF accumulating state | stubbed, not seekable | closed-form in `frame(t)` |
| fetching remote data, fonts, images | the document is fully offline | bundle relative files or embed `data:` / `blob:` resources |
| reading `Date.now()` for motion | returns virtual time | use `t` |
| unseeded physics / particle integration | depends on the prior frame | closed-form `f(t)` or a generator from `ctx.random(key)` |
| global state accreted across instances | leaks after a prop-change rebuild | keep `setup` self-contained |

## Lifecycle: `motif.define`

The harness injects a global `motif` (and the clock takeover) before any author
code runs. The document MUST declare its lifecycle with exactly one call:

```js
motif.define({
  // Runs once per distinct props value. Build the scene, declare animations,
  // load and await assets.
  async setup(props, ctx) { /* ... */ },
  // OPTIONAL: only when content must read the clock (e.g. a countdown number).
  frame(t, ctx) { /* ... */ },
});
```

- **`setup(props, ctx)`** — async; runs once per distinct props value, and
  re-runs whenever a prop changes. It MUST be self-contained: rebuild the DOM
  it owns, declare animations fresh, and `await` every asset (fonts included —
  see below) before resolving. No state may survive from a previous run.
- **`frame(t, ctx)`** — optional; called at every seeked time. `t` is content
  time in **seconds**. Pure-declarative Motifs omit it.
- **`ctx`** = `{ duration, width, height, fps, frame, random }` — `duration`
  in seconds, `ctx.fps` the composition's frame rate (`ctx.frame` is the
  integer frame index `round(t × ctx.fps)`; `setup` sees t = 0).
  `ctx.random(key)` takes a string and returns a deterministic generator
  (each call yields a number in [0, 1)); the same key gives the same sequence.
  Call it with a key — it throws without one.

Declared animations are seeked by pausing and setting `currentTime`; they are
never cancelled or committed. So animations MUST stay alive and well-defined at
every `t`: use `fill: "both"` (or equivalent), and never remove a finished
animation — deleting it breaks seeking back to earlier times.

## The manifest

```json
{
  "name": "Lower Third",
  "size": [1280, 320],
  "default_duration_s": 5.0,
  "content_duration_s": 0.8,
  "graphic_role": "lower_third",
  "props_schema": {
    "title":  { "type": "string", "default": "Jane Doe", "max_length": 40 },
    "accent": { "type": "color",  "default": "#ff4d4d" }
  }
}
```

- **`id` / `version`** — app-assigned; anything the document claims is ignored,
  and a minted id can never shadow a built-in.
- **`name`** — the display name; must not be empty.
- **`size`** `[w, h]` — the natural authoring size in CSS px, top-left origin,
  each axis 1–8192. Lay out within it and write no resolution/DPR code: capture
  resolution, placement transform, and layer opacity are all applied by the
  host.
- **`default_duration_s`** — the initial placed-layer length. MUST be finite
  and positive (as must every duration field).
- **`graphic_role`** — optional: what a placed layer of this Motif is for, the
  role a style's tokens attach to. One of the built-ins (title, lower_third,
  callout, credit, logo, plate, illustration, none) or a custom name: a
  lowercase letter, then up to 31 lowercase letters, digits or underscores
  (anything else fails validation). A placed layer takes it unless the placing
  call names its own; absent means untagged.
- **`settle_rafs`** — real browser frames the harness waits after a seek before
  capturing; `{0, 1, 2}`, default `2`. Only built-in Motifs' values take
  effect today: a user package's manifest island drops the field, and
  shared-texture capture always waits 2. Write animation that is correct after
  two frames.
- **`fonts`** — declares bundled font files; meaningful only for Motifs
  installed as a directory with an `assets/` folder. A single-file
  Motif embeds fonts as `data:` URIs instead.

### Duration: three shapes

A layer is a *window* into the Motif's content, the way a video clip windows
its media. The manifest picks one of three content-duration shapes:

| Manifest declares | Content duration | The placed layer | For |
|---|---|---|---|
| `max_duration_prop` (names a `number` prop) and/or `max_duration_s` | the prop's live value, else the static cap | **capped** to that length; windowable | bounded clips — a countdown |
| `content_duration_s` | that fixed value | **freely extendable**; frames past the end hold the last content frame | animate-in-then-hold overlays — a lower-third |
| none of the above | the layer's own width | extendable; animates over the placed duration | unbounded overlays |

The load-bearing distinction: `max_duration_s` also caps the layer;
`content_duration_s` does not. A holdable overlay SHOULD declare
`content_duration_s` (the length of its in-animation): the held tail costs one
capture, and trimming the layer never invalidates cached frames.

### `props_schema`

Exactly five variants exist, at most 64 props. Each prop MUST carry a
`default` that satisfies its own constraints.

| Variant | Constraints |
|---|---|
| `string` | optional `max_length` (counted in Unicode scalar values); optional `multiline` (renders a textarea) |
| `color` | hex string: `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` |
| `number` | optional `min` / `max`, both **inclusive**; values must be finite |
| `enum` | `options`: the exhaustive string list; `default` must be one of them |
| `media` | `default` must be `""`. A value is `""`, `"<media_id>"` (a pool image) or `"<media_id>@<t_us>"` (one frame of a pool video, at source time `t_us`) |

**A `media` prop arrives as a URL.** Before `setup`, the host replaces its
value with a URL on the Motif's own origin that serves the picture, or with
`""` when there is none. Load it with an `<img>` and `await img.decode()` in
`setup`, and draw a fallback of your own for `""`. A video frame comes at the
video's full size. Exported Motif packages carry no media: the picture belongs
to the project, not the Motif.

Validation is strict on keys and lenient on recovery: unknown prop keys reject,
missing keys fall back to defaults, and values are canonicalized into a stable
key order so identical inputs produce identical bytes and identical cache keys.
The schema carries **data only** — no labels, order hints, grouping, or widget
hints. The host generates the editing form from it: one row per prop in the
manifest's authored key order, keys title-cased (`bg_color` → "Bg Color"),
widget switched on the variant. Design prop keys to read well through that
transform, or ship a parameter page (below).

## Style Motifs

A project's style (`project://taste`) reaches a Motif through its prop keys,
not its id. That holds for a built-in, a fork or a Motif written from scratch.
The style also names example Motifs for some roles (the taste's motifs).
They show its vocabulary in use: place one as it is, fork it, or write a new
one with the same keys.

- **Shared keys.** A prop whose key is in the taste's `tokens.motif` (for the
  clipping style: ink, paper, accent, highlight and step_fps) is
  filled from it when the layer is placed or restyled, if the value fits the
  prop's type. A colour token may name a palette entry. The manifest default
  should be the style's own value, so a preview without a project looks
  right.
- **Font slots.** A `string` prop named `font_<slot>` gets the families of
  `tokens.fonts.<slot>` installed on the machine, in order (the whole list
  when none is installed), as a CSS stack (`'Anton', 'Impact'`). Give it a
  `max_length` of about 200. Use it as a `font-family` value with a generic
  family appended, and `document.fonts.load` it per weight and size in
  `setup`. Installed families need no `@font-face`. Frames follow the
  machine's fonts, which is the price of not bundling them.
- **Leaving.** A Motif that leaves, not just holds, declares a `number` prop
  `duration_s` as its `max_duration_prop`. `ctx.duration` is then the
  layer's length, and the layer is capped to it. Play the exit in the last
  ~0.5 s, chosen by an `enum` prop `exit` (none, lift, fade,
  slide_left … slide_down). Take the pieces off in reverse order of entry,
  a few frames apart. A slide fades as it goes unless the Motif is
  frame-sized, since nothing can travel past its own canvas.

  The placing call sets `duration_s` to the layer's length. A held Motif
  without an exit keeps `content_duration_s` instead.
- **Spring, tilt, shadow.** Motion and paper detail that are not tokens
  live in the Motif's code. A fork keeps them by keeping that code.

Dropping a shared key is a departure from the style: `check_composition`
reports drift only on the keys a layer has.

## Runtime environment

The document renders in an offline, isolated capture host. Hard limits:

- **A self-contained file or directory.** A directory has `index.html` plus
  companion JS, CSS, models, textures and fonts. Inline scripts/styles and
  local ES modules work. Use relative URLs: the app assigns the package's id,
  including when forking or publishing. Bare imports such as `three` need a
  local import map or a bundle produced before import; the app does not
  resolve npm packages. Root `target` and `.revisions` are reserved paths.
- **Local resource loading.** Render pages may fetch their own `motif://<id>/`
  files and `data:` / `blob:` URLs. Images may use those same sources; fonts may
  use local files or `data:` URLs. Other Motifs, `file:`, project-media schemes,
  HTTP(S), WebSocket and remote scripts are blocked. Dedicated local/Blob
  Workers and WASM compilation are available during `setup` for decoder
  initialization. JavaScript `eval` is blocked; use the CSP-compatible Basis
  build from the 3D template.
- **Packages.** A package is a folder with `index.html` plus companions; its
  manifest is `manifest.json` when present, else an island in `index.html`.
  It moves as a ZIP holding one Motif folder (or its contents at the ZIP root),
  at most 256 MiB compressed or expanded and 10,000 entries; symbolic
  links, escaping paths, ambiguous paths and case collisions are rejected.
  **Import Motif** in the app takes a `.zip` (a single-file Motif goes in as
  `index.html`) and copies it into a new draft with a new identity; editing
  the original folder later does not edit that copy. **Export Motif ZIP**
  writes `<motif-id>/index.html` and every companion, including `params.html`,
  without private `target` metadata. Keep only distributable assets in the
  folder.
- **Edits invalidate frames.** Companion file names and bytes enter the
  content hash, just like HTML edits. Edit/fork and publish preserve the
  complete directory. The source panel edits `index.html`; companion files are
  edited on disk.
- **The clock is virtual.** `Date.now`, `performance.now`, `setTimeout`,
  `setInterval`, and `requestAnimationFrame` are all owned by the harness. Do
  not capture references to time sources before `motif.define` runs.
- **Transparency is real.** The capture preserves alpha: keep
  `html, body { background: transparent }` unless the Motif is deliberately
  opaque.
- **Initialization and frames time out.** Setup has 30 seconds; normal
  frame/CDP operations have 5 seconds. A timeout tears down the capture host.
  Await all decoding in setup; Workers may only be created during setup, at
  most eight live, and are terminated when it completes or fails. Workers do
  not drive frame animation.

### Three.js

Ship the library and any addons locally. Build the scene and `await` loaders in
`setup`, then calculate transforms from the absolute `t` and call
`renderer.render(scene, camera)` in `frame(t)`. For example,
`mesh.rotation.y = t * speed`, never `mesh.rotation.y += speed`. Keep
`settle_rafs: 2`, use `alpha: true` for transparent overlays, and dispose the old
renderer/geometries/materials/textures when rebuilding after a props change.
`GLTFLoader.loadAsync('./assets/model.glb')` and texture loaders read local
files, including embedded GLB textures materialized as Blob URLs.

For Draco geometry and KTX2 ETC1S/UASTC textures, start with the offline template
described in [motif-three-model.md](motif-three-model.md). It bundles pinned
Three.js, local decoders and a Basis build that does not require JS eval.
Create fresh decoder loaders for each setup, and dispose their pools before
returning. Worker clocks are not virtualized. GPU output is not promised to
be bit-identical across hardware.

### Fonts

`await document.fonts.ready` is NOT sufficient — it can resolve before a lazy
`@font-face` fetch even starts, letting the first capture paint a fallback
font. A font-using Motif MUST force each face it renders, per weight and size,
before `setup` resolves:

```js
await document.fonts.load('700 56px "Inter"');
```

Embedded `data:` fonts are the deterministic choice; `system-ui` stacks render
differently across machines. A Style Motif's `font_<slot>` props name installed
families on purpose (*Style Motifs* above).

## Parameter UI

The host-generated form described above is the normal path — a Motif is fully
editable with zero UI effort. A Motif MAY instead ship a `params.html` beside
its `index.html` to own its whole parameter panel; presence of the file is the
only switch. That page is a separate, sandboxed document (opaque origin, no
network, no storage) with its own message protocol. An empty draft gets the
generated form; a draft copied from an existing Motif keeps its parameter page
with the rest of its files.

## Authoring over MCP

Use the directory/file workflow in [motif-workspaces.md](motif-workspaces.md):
`open_motif_draft` takes a linked directory, a ZIP, an existing Motif or an
empty package; clients without filesystem access use `read_motif` and
`update_motif_files`. A read returns a revision; pass it to file updates and
to `install_motif` after reviewing `preview_motif`. The app never rewrites a
linked directory to assign ids, and copying a Motif never selects an
overwrite target — name one explicitly when publishing an update.
