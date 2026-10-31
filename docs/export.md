# Export

Export renders the project's root composition to one file. Pixel work (export
Worker, encode exits) is in [`render.md`](render.md); the audio mixer is in
[`audio.md`](audio.md#export-mixer). This doc covers settings, orchestration,
finalization and the job/preset surfaces.

## Pipeline

`ExportJobs` (`src/main/exportJobs.ts`) admits one job per app session (UI or
MCP, [ADR 0111](adr/0111-ui-and-mcp-share-session-export-jobs.md)), resolves
settings, probes the destination via `export_prepare_output` (which also
creates the same-directory staging file), and allocates encoded temp files in
the OS temp dir (`weftcut-export-<id>-video.{mp4|mov}`, `-audio.{m4a|mka}`).
The renderer's `createExportRunner` (`src/renderer/app/exportRunner.ts`) then
runs, in order:

1. **No-material guard** — a video export with nothing visible in range fails
   with "no video material" rather than encoding black.
2. **Readiness gates** — decode-routing/proxy readiness for video referenced
   by the range; audio conform and baked-effect readiness for audible layers
   ([`audio.md`](audio.md#readiness-and-errors)).
3. **Encode target** — `resolveEncodeTarget` (render.md § Encode exits);
   resource plans from `prepareExportResourcePlans`.
4. **Audio** — `exportProjectAudioOnly` writes the encoded audio file before
   any video resource is reserved.
5. **Admission** — `admitExportResources` reserves one working set
   ([ADR 0104](adr/0104-export-finalization-retains-admission-and-encoded-files.md)).
6. **Video** — the Worker renders the half-open range into the native sink or
   the WebCodecs fMP4 path.
7. **Finalization** — stream-copy mux into the staging file, then publication.

Audio-only (`includeVideo: false`) skips the video stages and writes the audio
straight to the staging path. Video-only keeps the full pipeline and omits the
audio input at mux.

## Settings

`ExportSettings` lives in `src/shared/exportSettings.ts` (the renderer module
re-exports it); Rust stores the project's `export.json` as opaque JSON.
`mergeSettings` overlays a saved blob on `DEFAULT_EXPORT_SETTINGS` and snaps
invalid combinations instead of failing: an intermediate codec forces `mov`;
an audio codec the container cannot hold becomes AAC; an invalid bit depth is
reset; a `webcodecs` encoder pin with an intermediate or 10-bit falls back to
`auto`; an unknown `decodeEngine` becomes `auto`; a non-positive
`maxBitrate`/`bufferSize` becomes `null`.

| Codec | Containers | Bit depth | Engine |
| --- | --- | --- | --- |
| H.264 | mp4, mov, mkv | 8 | native, or WebCodecs pin |
| HEVC | mp4, mov, mkv | 8, 10 | native; WebCodecs pin for 8-bit only |
| AV1 | mp4, mkv (ffmpeg's MOV muxer rejects AV1) | 8, 10 | as HEVC |
| ProRes | mov | 10 | native only |
| DNxHR | mov | 8 | native only |

10-bit HEVC/AV1 is experimental: the dialog labels it and confirms the click
because preview stays 8-bit SDR; MCP must pass `allow_experimental_10bit`.
AAC muxes into any container; Opus only into `mkv` (Opus-in-MP4/MOV playback
is unreliable in Chromium). Audio-only output is `.m4a` (AAC) or `.mka` (Opus).
Audio `sampleRate`/`channels` of `null` follow the composition.

### Rate control

`rateMode` selects one of two exclusive shapes; Rust models it as the
`RateControl` enum in `export/encoder_registry.rs`, so "CRF with a peak" is
unrepresentable.

| `rateMode` | ffmpeg args |
| --- | --- |
| `vbr` | `-b:v target`; with a peak, `-maxrate peak -bufsize buf` |
| `cbr` | `-b:v target -maxrate target -minrate target -bufsize buf` |
| `quality` | `-crf n` (plus `-b:v 0` on libaom-av1) |

The quality preset only seeds the target bitrate (`computeBitrate`:
`w × h × fps × bpp × codec multiplier`); typing a bitrate flips it to `custom`,
so the effective bitrate is always on screen. `maxBitrate`/`bufferSize`
default to `null`: no `-maxrate` under VBR, and `-bufsize` = 2× the ceiling,
derived only in the registry. A defaulted peak would silently re-rate old
projects. Invariants:

- A peak below the target is rejected (`bitrateConstraintIssue` disables
  Export; `validate_intent` rejects before spawning ffmpeg).
- CBR ignores a stored peak.
- Peak and buffer are native-only; `maxBitrateApplies` / `bufferSizeApplies`
  gate both the dialog rows and the IPC payload.

### Frame rate and range

The export frame rate may differ from the composition's. Output frame `i` is
sampled at `timeUsAtFrame(i)` on the export rate (`worker/frameGrid.ts`), so a
cut on a composition frame can land up to half an export frame away. A
frame-exact hand-off should export at the composition rate
([`data-model.md`](data-model.md#timeline-field-alignment-composition-frame)).

The range is not persisted: the dialog holds full project or a custom
`[startUs, endUs)`, and `clampExportRange` returns `null` (never the whole
project) when nothing usable remains. Every stage receives the same range; the
Worker resets output timestamps to start at 0 and Rust trims the audio mix to
it.

## Audio

`export::export_audio_only_cancellable` plans the mix
(`audio::mix::plan_for_project`, or role stems from `audio::retime` when any
layer is retimed), pipes 65 536-frame f32 blocks into ffmpeg's limiter + encode
tail, and returns `false` without spawning ffmpeg when the range has no audible
layer. Skip rules, the encode tail and the conform gate are in
[`audio.md`](audio.md#export-mixer).

## Finalization

`export::mux_to_file` runs `ffmpeg -i video [-i audio] -c copy <out>`. It never
re-encodes (the native sink already applied codec tags such as `hvc1`). The
audio input is omitted when no audio file exists, unless the run produced
audio (`audioRequired`), which is then an error rather than a silent
video-only file. Mux takes its CPU slot through the finalization reservation
(`resources::continue_finalization`, 15 s wait).

Publication (`export/publication.rs`) moves the complete staging file to the
destination in the same directory. With overwrite it renames over the target;
otherwise it hard-links, falling back to the platform's atomic no-replace
rename (`renameat2(RENAME_NOREPLACE)`, `renamex_np(RENAME_EXCL)`, `MoveFileExW`
without replace). There is no copy fallback; `export_prepare_output` proves the
operation works in that directory before rendering.

If mux or publication fails after encoding, the job becomes `awaiting_retry`
and the panel offers **Retry finishing export** (stream-copy only; never
re-encodes or rereads the project) and **Discard export**. Retrying a
publication failure reuses the muxed file. An existing destination is never
truncated. Recovery is session-local: the error cannot be dismissed by
accident, closing the window asks before discarding, and success, discard or
editor teardown releases the reservation and deletes the intermediates
(`render/exportFinalization.ts`). Intermediates are not in the cache LRU.

## Failure messages

A failed export's panel leads with a summary and keeps the raw error under
**Technical details**. A resource refusal (`resource-capacity-exceeded`)
says what to wait for or which Performance setting to raise. A stalled
encoder, an ffmpeg child its progress watchdog stopped (`ffmpeg-stalled`;
[architecture.md](architecture.md#3-ffmpeg-never-composites)), reads "The
encoder stopped responding" and suggests exporting again with **Video
encoder** set to **Software** on the Video tab; when only finishing can be
retried, the retry hint replaces that suggestion. Anything else gets the
generic hint.

## Export jobs (UI and MCP)

Both entry points submit to `ExportJobs` and control the same job; editing is
frozen while a job is active or awaiting retry (ADR 0111).

- **Conflicts.** The UI follows the app-level `export_auto_overwrite`
  preference (default off; the checkbox persists across projects). With
  overwrite off, a collision shows a hint and an optional free-name
  suggestion, adopted only on click. MCP `on_conflict` is `rename` (default,
  numbered name) or `fail`; MCP never overwrites. Renaming during retry keeps
  the directory and extension and clears that job's overwrite consent.
- **MCP tools.** `get_export_options`, `start_export`, `get_export_status`,
  `retry_export`, `cancel_export`. A repeated `request_id` with identical
  arguments returns the same job; different arguments conflict. Records
  survive reconnects, not app restart. Agents must report the completed
  `output_path`. MCP settings are per-job overrides; MCP never falls back from
  native to WebCodecs.

## Export presets

An export preset is a named, versioned copy of portable output values
(`src/shared/export-presets.ts`): `ExportSettings` minus `encoderEngine`,
`decodeEngine` and `hwAccel`. Paths, conflict policy and range are never part
of a preset. Built-ins (`builtin:match`, `builtin:hd` 720p, `builtin:fullhd`
1080p, `builtin:uhd` 2160p) are read-only and seed explicit bitrates for
standard and high frame rates. Personal presets and `default_export_preset_id`
live in `app_settings.json`; library changes are individual
create/update/rename/delete operations in main. Names are capped at
`EXPORT_PRESET_NAME_LIMIT` (40).

- **Copy, not reference.** Applying a preset copies its values into the dialog
  through `applyExportPreset`, which keeps the height-based, downscale-only,
  aspect-preserving resolution contract (a larger target follows the project;
  fractional project rates stay fractional). Projects keep their own snapshot
  when a preset changes or is deleted.
- **Precedence.** Saved project settings, then the personal default, then
  `builtin:match` (also the fallback for a missing default). UI and MCP share
  the resolver.
- **UI.** The export dialog's title menu is the only management surface:
  choices, current/default markers, save-as, update (modified personal
  preset), restore (any modified preset), rename/delete (personal), set
  default.
- **MCP.** Preset tools work without an open project. `get_export_options` and
  `start_export` take an optional `preset_id`: preset values first, then
  per-job overrides. An admitted job snapshots its preset. A personal copy made
  without a project copies a built-in's fixed standard-rate values.
- Entries are validated by the shared export validator; a corrupt entry is
  dropped on its own.

Gates: [`conformance.md`](conformance.md). Export-specific specs under
`apps/desktop/e2e/electron/`: `export_codecs`, `export_eos_tail`,
`export-finalization-retry`, `export-resource-admission`,
`export-stalled-encoder`, `export-presets`, `mcp-export`.
