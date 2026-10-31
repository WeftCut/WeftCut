# Captions

Every caption cue is an independent **`Text` layer** on a caption-role track
(`TrackRole::Caption`). Captions render through `TextSprite` like any text, in
preview and in the export Worker, so burn-in is ordinary compositing and every
layer tool works on them. Why: [ADR 0026](adr/0026-captions-as-text-layers.md).
Tool contracts: [mcp.md](mcp.md); the Transcribe command:
[features.md](features.md) § Transcribe and voiceover.

## Ingestion

Two sources, one packing mutation (`add_caption_track`,
`main/state/mutations/captions.ts`), one history entry per apply (*Added
captions*).

- **Subtitle documents.** `.srt` / `.vtt` / `.ass` files enter the pool as
  `Subtitle` items (no derivatives; the workspace copies them like any source).
  `apply_subtitles { media_id, t_start_us? }` — or dragging the item onto the
  timeline, where only the drop *time* counts — reads the file, parses it with
  `subtitles::parse_subtitle_cues(body, None)` (format sniffed; the
  `parse_subtitles` compute), shifts every cue by `t_start_us` and packs the
  whole document. Cues are copies: removing the item leaves them; applying it
  twice lays it twice. No partial apply. Imported cues keep the file's styles.
- **Transcription.** `transcribe_clip` returns a normalized transcript with
  timeline-absolute times ([ADR 0036](adr/0036-pluggable-speech-backends-normalized-transcript.md));
  `apply_transcripts` lays it, keeping per-word timing as caption metadata
  (below). With a project style, transcript cues are born in its caption
  tokens and split to its caption limits (`project://taste` → `caption`);
  without one they land as transcribed. Cue times snap to the Text frame grid.
  A result whose source project, composition or clip signature changed since
  the read is refused.
- **Low-volume check (UI only).** Before a Transcribe press reads anything, the
  cached raw waveform of each source window is checked; a peak below −24 dBFS
  (or a missing waveform, "unchecked") prompts Cancel / Continue / Normalize
  and transcribe. Normalize applies constant gain toward −3 dBFS peak, capped
  at +24 dB, to a private per-run copy of the extracted WAV only
  (`normalize_audio` on the tool; `renderer/speech/transcriptionInput.ts`).

**Packing.** Candidates are the target composition's unlocked caption tracks
in track order. Each cue goes to the first whose layers leave its snapped span
free (the same overlap predicate every placement uses); a cue that collides
with all of them opens a new caption track, which joins the candidates. A
Group's captions never spill into the root's tracks. The mutation returns the
track the first cue landed on. So repeated transcriptions fill one caption
track, and a second lane appears only where cues truly overlap.

## Cue layout

`cue_to_text_params` (Rust, `subtitles/layout.rs`) and its TS twin
`cueToTextParams` build a cue's `TextParams`. A styleless cue gets white fill,
a black outline (6 % of size, at least 1 px), no shadow, size 5 % of
composition height, bottom-centre inside `SAFE_AREA_MARGIN` (8 %). A shadow
appears only when an ASS style asks for one (`Shadow` 0 gives none). Every cue
gets `box_w` = composition width less the margin on both sides and
`box_h = null` (Auto height: wraps without shrinking —
[ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md)), so a
one-line machine transcript wraps at its own size. Older captions without a
box load as Auto width unchanged.

ASS: V4+ styles plus `\an \pos \c/\1c \b \i \fs \fn \fad`; karaoke, drawings,
clips, `\t`/`\move`, rotations and blur are stripped with the text kept, and
`simplified: true` is reported. VTT is read at SRT level (region and cue
settings ignored).

## Fonts

Liberation Sans and Noto Sans SC are bundled and loaded into the preview
(`document.fonts`) and the export Worker (`self.fonts`) before compositing
(`renderer/render/fonts/registry.ts`). The default caption family is the chain
`"Liberation Sans, Noto Sans SC"`. Other families are resolved best-effort
before the Worker starts (`resolveFontsForFamilies` → `font:resolve` →
`main/fonts/resolveSystemFont.ts`, an sfnt `name`-table scan) and passed in as
bytes; the Worker never resolves fonts. Unresolved families fall back to the
bundled chain. Only the bundled fonts are deterministic across machines.

## Caption panel

`CaptionsPanel` lists the cues of **every** caption-role track in the project,
flattened in time order. Activating a cue selects its layer, seeks to its
start and reveals it in the Timeline; inline text edits commit on blur via
`update_layer_params`. The style row (size, outline width, colour) calls
`restyle_captions` over all caption tracks in one undo step; outline width 0
stores `null` (no outline); colour commits are debounced. `restyle_captions`
also takes `font_family` and `layer_ids` (MCP only). `merge_captions` folds
cues of one lane into the earliest; `export_captions` returns an SRT/VTT body
(MCP only).

## Text correction / 文字校正

The panel's **Text correction** dialog edits one project manuscript
(`settings.correction_script`, unrecorded, saved with the project; clearing it
leaves captions alone). Applying is a separate recorded edit
(`correct_caption_text`; one undo restores the captions, keeps the manuscript).
Scope: selected captions, else all captions of the open composition; a locked
target refuses the whole run; inputs that changed while the dialog awaited a
save refuse rather than apply stale. Re-running on unchanged input records
nothing.

Matching (`shared/textCorrection.ts`) aligns caption text to the manuscript
locally, with gaps on either side. It corrects context-supported Chinese
homophones, equivalent formatting, near sounds with confusable initials and
single misread Chinese numerals (五老师 / 吴老师) when two exact tokens match on
each side and the reference has one spelling. Quantity/ordinal contexts,
numeric targets, negation and ambiguous colloquial numbers are preserved;
extra speech stays, unmatched manuscript text is not inserted, conflicting
repeated contexts abstain. No acoustic model, network or forced alignment.

Resegmentation: manuscript line breaks and sentence-ending punctuation set
caption boundaries (ASR boundaries may join; pauses and length add none).
Cuts use the caption's `weftcut.caption_timing` metadata (version 1: text,
duration, provenance, caption-relative word spans, source id + signature;
`shared/captionTiming.ts`) when its words are usable; otherwise — imported or
edited captions, stale or zero-length words, a break inside a word — the cut is
estimated by character coverage within the original cue and recorded as
`interpolated_from_cue`. Cuts snap to the frame grid. Moves keep the metadata;
text/duration or source changes make it ineligible. Output that cannot fit as
valid non-overlapping captions keeps the original boundaries and updates text
only. Differing styles, positions or sources are not combined; animated,
linked, transitioned or marker-anchored captions keep their boundaries.

## Scope

Video export is burn-in only; there is no soft-subtitle mux or sidecar file
export in the export dialog. Not built: word-level/karaoke highlight,
per-project font files, kinsoku line breaking.
