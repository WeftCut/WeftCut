# Captions

Imported subtitles are not a special layer kind. Every cue from an SRT, VTT,
or ASS file becomes an independent, first-class **`Text` layer** on a dedicated
caption-role track. The same PixiJS `Text` path that renders any other text
renders captions — in preview and in the export Worker — so captions burn into
exported video as a consequence of normal compositing, with no subtitle-specific
render code and no separate export stage.

The rationale (why this replaced the previous libass/JASSUB design) lives in
[ADR 0026](adr/0026-captions-as-text-layers.md). This document describes how the
feature works.

## The model, in one paragraph

A subtitle import produces one or more tracks with `role: "caption"`, each
holding one `Text` layer per cue, positioned in composition time from the cue's
own timestamps. Because every cue is an ordinary `Text` layer, all existing
layer operations — move, trim, split, delete, restyle, keyframe, and the MCP
tools behind them — work on captions with no new code. Captions have no special
status at render time: they composite through `TextSprite` like any text.

## Ingestion — one parser, one mutation

Three entry points feed captions, and all of them converge on a single Rust
chokepoint so there is exactly one parsing path and one mutation:

- **File import.** Dropping or importing a `.srt` / `.vtt` / `.ass` file is
  intercepted in `import_media` by extension. Subtitle files are **consumed at
  import** — parsed straight into a caption track. They are never added to the
  media pool and produce no proxy or derivative jobs.
- **MCP `apply_subtitles`.** An agent passes a subtitle body inline. Cue timings
  come from the body; the cues land on the composition's caption tracks (see
  *Cues pack into the caption tracks already there*, below) and the tool
  returns the id of the track the first cue landed on.
- **Transcription.** `transcribe_clip` returns a normalized transcript
  envelope with timeline-absolute timestamps. The app passes this structure to
  `apply_transcripts`, preserving word timing alongside the generated captions.
  The rendered `srt` field remains available to subtitle consumers.
  A person starts the flow with **Transcribe selected clip**
  on a `VideoClip` / `Audio` layer's context menu, in the Edit menu and in the
  search palette: no dialog — the language is the engine's to detect — so the
  press reads every selected clip with sound, one at a time in timeline order,
  applies all successful normalized transcripts in ONE `apply_transcripts` call, and
  reveals the Caption panel so the cues are visible. One subject per source: a
  linked picture clip yields to its selected same-media audio, and the same
  source span selected twice is read once ([ADR 0070](adr/0070-captions-land-where-there-is-room-and-a-transcription-reads-each-selected-source-once.md)).
  There is no review step between the two — the result is editable `Text`
  layers on a caption track, and `CaptionsPanel` already edits them per cue,
  which is strictly more than a review list offers ([features.md](features.md)
  § Transcribe and voiceover).

File and inline subtitle imports call `subtitles::parse(body, format)` →
`Cue { start_us, end_us, text, style }`; normalized transcripts supply cues
directly. Both converge on the same caption packing mutation. Format is sniffed
(`subtitles::sniff`) when a subtitle caller does not supply one. The whole import is a
single history entry, *Added captions* (one undo removes the whole import,
however many cues).

## Text correction / 文字校正

The Caption Panel's **Text correction** button opens a plain-text manuscript
dialog. One manuscript belongs to the project (`settings.correction_script`,
optional for older v1 files); edits use unrecorded project settings, survive
closing the dialog, and save with the project. Clearing it does not clear
captions. Applying correction is a separate recorded transaction: one undo
restores the preceding captions while retaining the manuscript.

The default scope is selected caption Text layers when any are selected,
otherwise all captions of the open composition. The dialog shows the count.
Locked targets refuse the whole operation. Every run uses current caption
text, including manual changes, and the current manuscript. The dialog captures
its input before awaiting manuscript saves; changed text, times, target sets or
manuscripts refuse the operation instead of applying to stale inputs. There are no
review markers, confirmation states, or protected-manual-text flags.

`shared/textCorrection.ts` prepares a normalized manuscript index, finds local
candidate windows, and aligns text sequences with gaps on either side.
Context-supported Chinese homophones and equivalent formatting may be
corrected; numerical/negation conflicts, ambiguous colloquial numbers and unsupported substitutions are
preserved. Extra spoken text remains and unmatched manuscript text is not
inserted. Repeated contexts with conflicting spellings abstain. No acoustic
model, cloud request, or forced alignment is part of this operation.

New transcriptions retain optional version-1 `weftcut.caption_timing` metadata
on each caption: text, caption duration, timing provenance, relative word
spans, and a source identity/signature when available. The renderer's
transcription response captures the source before asynchronous recognition;
ingestion refuses results whose project, composition or source window changed.
Metadata follows the ordinary project save path. Caption moves preserve
relative spans; text/duration edits or source changes make the mapping
ineligible rather than guessing new timestamps.

With usable engine word times, correction can split or combine adjacent
captions using manuscript punctuation, observed gaps and caption length.
Static appearance is inherited, different styles/positions are not combined,
and animated captions keep their boundaries. Links, transitions and anchored
markers also prevent resegmentation. Imported captions and interpolated
timings support text/punctuation correction with their existing time bounds.
The `exact` provenance is not itself proof of a usable boundary: word coverage,
ordering and duration are checked before resegmentation. Repeating a correction
with unchanged input produces no new history entry.

**Cues pack into the caption tracks already there.** `add_caption_track` tries
the composition's own unlocked caption tracks first, in track order, and lands
each cue on the first whose layers leave the cue's span free; a new caption
track opens only for a cue that collides with every one of them, and then joins
the candidates ([ADR 0070](adr/0070-captions-land-where-there-is-room-and-a-transcription-reads-each-selected-source-once.md)). So a second
transcription — another clip on the same timeline, transcribed later — lands
beside the first on the same caption track, and only cues that genuinely
overlap in time fan onto additional tracks, keeping each track non-overlapping
— the same linear-timeline invariant every other layer class obeys. Locked
caption tracks are never candidates. A transcription, whose cues never overlap,
adds to a single track.

## Cue layout and ASS support

`cue_to_text_params` turns a cue into a `Text` layer's parameters. A styleless
cue (plain SRT/VTT) gets the default caption look: white fill and a thin black
outline — no shadow — font size proportional to composition height,
bottom-centre anchored with a safe-area margin. The outline alone is the
legibility device; a shadow is only ever what an ASS style asked for, and a style
whose `Shadow` is 0 gets none rather than a 1 px one. Neither field has an
inspector control, which is why the default carries nothing a user could not
take off again.

Every cue — styled or not, imported or transcribed — is also born with a **wrap
width**: `box_w` is the composition width less the safe-area margin on each side,
and `box_h` stays null. Both numbers come from the one `SAFE_AREA_MARGIN`
constant that the position inset is derived from, so the margin a caption sits
inside and the width it wraps at cannot drift apart. `(set, null)` is Auto height
([ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md)), which
wraps *without* shrinking — the reason it is not Fixed: a machine transcript's
cue is a single unbroken line with no `\n`, and Auto height breaks it inside the
safe area at exactly the size its style asked for, where a fixed box would
compress the long cues and leave two cues of one file at different font sizes.
The wrap width is not applied retroactively and there is no migration: a caption
layer stored without a box loads as Auto width and renders exactly as it did.

ASS is supported at "Tier 3": the V4+ Style table plus the inline override tags
that matter for captions — `\an` (alignment, mapped to anchor + position), `\pos`,
`\c`/`\1c` (colour), `\b`, `\i`, `\fs`, `\fn`, `\fad`. Advanced tags (karaoke
`\k`, drawings `\p`, clips, animated transforms `\t`/`\move`, rotations, blur) are
stripped while the cue text is preserved; the parser sets a `simplified` flag the
UI and MCP tool surface so the user knows styling was dropped.

VTT is parsed at SRT level — text and timing only; region and cue-setting
directives are ignored.

## Fonts and burn-in determinism

Burned-in text must render identically in preview and export and must not fall
back to tofu (missing-glyph boxes). Two font families are bundled with the app
and loaded into **both** surfaces before any compositing begins — the preview
`Compositor` on startup (`document.fonts`) and the export Worker before its encode
loop (`self.fonts`):

- **Liberation Sans** — broad Latin/Cyrillic/Greek; the default caption face.
- **Noto Sans SC** — Simplified Chinese and full CJK coverage.

These bundled fonts carry the cross-OS export-determinism guarantee. The default
caption font is the fallback chain `"Liberation Sans, Noto Sans SC"`, so any glyph
Liberation lacks falls through to Noto.

A user may set a caption (or any `Text` layer) to a font outside the bundled set.
The main-thread renderer resolves it best-effort via `window.api.font.resolve`
(`resolveFontsForFamilies`) **before the export Worker starts**, and merges the
resolved bytes into the export request; the Worker only consumes pre-resolved
fonts and never calls the resolver itself — that separation is the determinism
boundary. On the main process, `resolveSystemFont` matches a family name by a
hand-rolled scan of the platform font directories' sfnt `name` tables (no external
font-enumeration dependency). User-font resolution is explicitly **outside** the
determinism contract — a font on the author's machine may be absent on a
collaborator's — and when a family does not resolve it is omitted, so rendering
falls back to the bundled chain. Captions never tofu.

## Editing — the Caption panel

The Caption panel is a Project-wide corpus surface: it reads **every**
caption-role track and lists their cues flattened in time order, including
overlapping lanes. Activating a cue (its timecode) selects that `Text` layer,
seeks the playhead to its start, and reveals it in the Timeline — keeping caption
navigation and timeline context in sync. Each row also offers inline text editing
of the single cue, committed on blur through `update_layer_params`. The style
row batch-applies size, outline width and colour across every `Text` layer on
**all** caption-role tracks in a single undo step (`restyle_captions`, whose
patch also carries a font family the panel does not yet expose). Outline width
0 removes the outline — stored as `null`, the same absent style the Text tool
writes — which is how the one style the default look adds beyond the file's own
can be taken off again. The colour commit is debounced because it fans out to
every caption layer in the project. A selected caption cue remains editable as an
ordinary `Text` layer in the Attribute panel.

Because cues are plain `Text` layers, they are also editable directly on the
timeline and in the inspector like any other layer — the panel is a convenience
for navigating and bulk-styling a caption set, not the only way to edit it.

## Scope

v1 export is **burn-in only**: captions composite into the video frame like any
text. Soft-subtitle tracks (stream-muxed SRT/ASS into MKV/MP4) and sidecar
subtitle-file export are deferred — the data already lives in `Text` layers and is
available to a future ffmpeg subtitle-mux stage. Word-level/karaoke highlight and
per-project user-supplied font files are out of scope, as is kinsoku (the CJK
line-breaking prohibitions) on top of the wrap width above.

## Pointers

- Decision record and trade-offs: [ADR 0026](adr/0026-captions-as-text-layers.md).
- The text box a cue is born with (resize modes, why the box never scales
  glyphs): [ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md).
- Layer/track data model and the `apply_subtitles` tool contract: [data-model.md](data-model.md).
- How `Text` layers render (and how bundled fonts load into the export Worker):
  [render.md](render.md).
- MCP surface: [mcp.md](mcp.md).
