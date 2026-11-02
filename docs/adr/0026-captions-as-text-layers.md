---
status: accepted
---

# Captions are Text layers; a subtitle document is pool media

Date: 2026-10-31

## Context

A libass/JASSUB subtitle layer rendered into its own canvas: the export Worker
(an `OffscreenCanvas`, no DOM) could not run it, so every export silently
dropped subtitles; cues were not addressable, so no layer tool worked on them;
and it was a second render path outside the compositor. `TextSprite` already
renders identically in preview and in the export Worker. The Worker has no
font-loading event, so fonts must be loaded explicitly, and CJK needs a CJK
face in that set.

Subtitle files were later consumed at import (`import_media` answered two
shapes) and `apply_subtitles` took an inline body, so a document could neither
stay in the project nor be placed at a time.

## Decision

- **Every cue is an independent `Text` layer on a `TrackRole::Caption` track.**
  There is no subtitle layer kind. Burn-in is ordinary compositing.
- **One parser**: `subtitles::parse_subtitle_cues` (SRT / VTT / ASS, format
  sniffed) is the only path from subtitle text to `Cue`s, shared by subtitle
  documents and the SRT transcript style (ADR 0036).
- **One packing mutation**: `add_caption_track` lays cues onto the target
  composition's existing unlocked caption tracks first, opening a new track
  only for a cue that collides with all of them; one history entry per apply.
- **A subtitle file is pool media.** `import_media` pools `.srt/.vtt/.ass` as
  a `Subtitle` item like any file. `apply_subtitles { media_id, t_start_us?,
  composition_id? }` (or a pool drag, which takes only the drop time) lays the
  whole document, its time 0 at `t_start_us`. The offset is an argument
  because packing depends on where each cue falls. The cues are copies; nothing
  ties them back to the item.
- **Bundled fonts** (Liberation Sans, Noto Sans SC) load into preview and the
  export Worker before compositing. Other families are resolved best-effort on
  the main thread before the Worker starts and passed in as bytes; the Worker
  never resolves fonts (the determinism boundary).
- **ASS is "tier 3"**: V4+ styles plus `\an \pos \c \b \i \fs \fn \fad`; other
  tags are stripped with the text kept, and `simplified: true` is reported.

## Consequences

- Every layer tool and keyframe works on captions with no caption-specific
  code; preview and export share one render path.
- Burn-in with bundled fonts is deterministic across machines; user fonts are
  not, and fall back to the bundled chain (never tofu).
- Video export is burn-in only; `export_captions` returns an SRT/VTT body to
  an agent, and no soft-subtitle mux exists.
- No partial apply: a document for an untrimmed clip lands whole. An agent
  holding text writes a file first; one holding cue data uses
  `apply_transcripts`.
- Complex ASS loses karaoke, drawings and animated transforms.

Rejected: JASSUB plus an ffmpeg `subtitles` burn-in stage (still a second
render path, cues still opaque); an inline-body `apply_subtitles` (invites
hand-rendered timestamps from structured data).
