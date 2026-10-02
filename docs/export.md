# Export

The export pipeline has three concerns:

1. **Visual preview + export** — both run through the PixiJS + WebCodecs
   compositor described in [`render.md`](render.md). One renderer
   module, mounted against a `<canvas>` on the main thread for
   preview and against an `OffscreenCanvas` in a Worker for export.
2. **Audio export** — the Rust block mixer sums conform PCM
   sample-accurately and pipes the mix to ffmpeg's encode tail
   (limiter + AAC/Opus), producing a temporary audio file when the
   user includes audio. The full audio architecture (conform cache,
   envelope contract, preview mixer) lives in [`audio.md`](audio.md).
3. **Final mux** — Rust stream-copy muxes the already-encoded video —
   written either by the WebCodecs path or by the native `ffmpeg` encode
   sink ([`render.md`](render.md)'s "Encode exits") — with the optional
   audio track into the user's chosen container.

This doc covers (2)'s export entry point and (3). For (1) see
[`render.md`](render.md) and [`preview.md`](preview.md); for the audio
engine itself see [`audio.md`](audio.md).

## Export settings and range

The renderer owns the `ExportSettings` schema in
`apps/desktop/src/shared/exportSettings.ts`; the host persists the saved blob as
opaque JSON. Audio settings are persisted:

- `include`: when false, JS skips audio export and produces video-only output.
- `codec`: `aac` or `opus`.
- `bitrate`: bits per second.
- `sampleRate`: `null` to follow the composition, otherwise a concrete output
  sample rate.
- `channels`: `null` to follow the composition, otherwise mono or stereo.

H.264 and HEVC can target `mp4`, `mov`, and `mkv`. AV1 can target `mp4` and
`mkv`; `mov` is rejected because ffmpeg's MOV muxer does not accept AV1. AAC is
valid in every supported container. Opus is restricted to `mkv` because
Opus-in-MP4/MOV playback is unreliable in Chromium/Electron. `mergeSettings` backfills
missing audio fields from `DEFAULT_AUDIO_SETTINGS` and snaps stale saved blobs
back to AAC if the selected container cannot hold the saved audio codec.

### Rate control

`rateMode` picks which of two mutually exclusive shapes reaches the encoder, and
the Rust seam models that exclusivity as an enum (`RateControl` in
`export/encoder_registry.rs`) rather than a bag of optional fields — so "a CRF
with a peak bitrate" does not exist as a representable state.

| `rateMode` | user-facing controls | ffmpeg args |
| --- | --- | --- |
| `vbr` | quality preset / target bitrate, optional maximum, optional buffer | `-b:v target`, plus `-maxrate peak -bufsize buf` when a maximum is set |
| `cbr` | quality preset / target bitrate, optional buffer | `-b:v target -maxrate target -minrate target -bufsize buf` |
| `quality` | CRF | `-crf n` (plus `-b:v 0` on libaom, whose default bitrate would otherwise constrain the CRF) |

The quality preset (`low`/`medium`/`high`/`custom`) is a **shortcut that seeds
the target bitrate**, not a parallel control: `computeBitrate` turns a preset
into `width × height × fps × bpp` scaled per codec, and `customBitrate`
overrides it outright. The dialog therefore shows the target bitrate at all
times in a bitrate mode — under a preset it displays the derived figure, and
typing into it flips the preset to `custom`. There is no state in which the
bitrate the export runs at is not on screen.

Both constraints are `null` by default, and `null` means *unchanged from what
shipped*: no `-maxrate` at all under VBR (plain ABR), and a `-bufsize` derived
as 2× the ceiling. A defaulted-to-derived peak would silently re-rate every
project exported before these fields existed. The derivation lives in the
encoder registry, not the renderer, so there is one place to keep honest.

Three invariants the two sides agree on, each enforced where it can be:

- **A peak below the target is rejected**, not reconciled — the encoder would
  abandon the target and emit at the ceiling. `bitrateConstraintIssue` disables
  the Export button and explains it; `validate_intent` rejects the intent before
  any encoder process is spawned.
- **CBR ignores a peak.** Its ceiling is its target by definition, so a value
  left behind by a VBR session is persisted but inert rather than honored.
- **Peak and buffer are native-only.** A WebCodecs `VideoEncoderConfig` carries
  `bitrate` + `bitrateMode` and nothing else, so under a WebCodecs pin the rows
  are absent (with a blurb saying why) instead of present and dead. The
  `maxBitrateApplies` / `bufferSizeApplies` predicates gate the UI rows *and*
  the IPC payload from the same source, so what ffmpeg receives is exactly what
  the user could see and edit.

### Export fps need not equal composition fps

The dialog offers its own frame rate, so an export can be resampled off the
timeline's rate. This is the one place the frame-grid guarantee narrows: "the
actor, the ruler, playback and export resolve the same canonical microsecond for
every frame index" holds **at a single rate**. Export at a different rate is an
output-sampling operation — the encoder samples the composition at its own
frame times, `round(i × 1e6 × den / num)` on the *export* rate — and those
instants generally do not coincide with edit points on the composition grid.

The consequence to expect: a cut authored exactly on a composition frame can
land mid-frame in the output and be quantised to the nearest export frame, up to
half an export frame away. Nothing is silently corrupted — the composition is
untouched and the operation is repeatable — but a frame-exact hand-off (a
conform, a round-trip through another tool) should export at the composition
rate. See [`docs/data-model.md`](data-model.md#timeline-field-alignment-composition-frame)
for the grid itself.

The export range is not persisted. `ExportSettingsDialog` keeps it as
dialog-local state: full project, or a custom `[startUs, endUs)` selected with
In/Out SMPTE timecode fields and "set to playhead" buttons. `clampExportRange`
keeps the span ordered and inside `[0, durationUs]`.

The shared renderer export flow threads the resolved range through all export stages:

- The readiness gate checks only video sources referenced by the export range.
- Motif layer frames are baked only for the export range before the Worker
  starts.
- `runPixiExport` receives `startUs` and `endUs`; the Worker renders that
  half-open range and resets output video timestamps to start at 0.
- `exportProjectAudioOnly` receives the same range so Rust trims the final
  audio mix to match.

## Agent export jobs

The Export UI and MCP agents share the renderer export flow. The Electron main
process owns job admission and status; the renderer retains the compositor
worker, media readiness gate, Motif baking, effects and native encode bridge.
An agent starts a job rather than waiting for one long MCP call to render.

`get_export_options {}` exposes saved/default settings, supported values and
root-composition output metadata. It can return `validation_issue` when saved
settings need compatible overrides before starting; inspection remains
available for an empty composition. `start_export` accepts an absolute
`output_path`, optional partial `settings`, optional half-open
`range: { startUs, endUs }` in timeline microseconds, and optional
`allow_experimental_10bit`. `get_export_status` and `cancel_export` address the
returned `job_id`. These tools are registered by the TypeScript host and are
available through the stdio shim's live catalog too.

Settings use the existing camelCase `ExportSettings` schema (including partial
nested `audio`) rather than a second MCP-only settings model. Omitted values
use saved settings with existing default backfills; invalid explicit overrides
fail instead of being repaired silently. Every existing export control is
available: stream inclusion, resolution/fps, codec/container, quality/bitrate,
rate control, profiles, CRF/preset, keyframe cadence, acceleration, decode/encode
engines, bit depth and audio codec/bitrate/sample rate/channels. Composition fps
remains rational when the fps override is omitted.

Omitted range exports the full root composition. Explicit ranges must be
nonempty and inside its duration. They snap to the composition frame grid and
return the resolved bounds; reject a span that becomes empty or invalid after
snapping. Both streams disabled is invalid. Audio-only
output uses `.m4a` for AAC or `.mka` for Opus; video output uses the selected
container's extension. Destination extensions must match. Existing destinations
are refused. Experimental 10-bit delivery exports require explicit opt-in.
The agent path uses no save dialog and no interactive encoder fallback.

Jobs report `preparing`, `rendering`, `finalizing`, then `completed`, `failed`
or `cancelled`, with progress where available. `completed` is reported only
after encoding/muxing and successful publication. Output is staged beside the
destination and published without overwriting, so a file created there while
the export runs is preserved. Agent publication uses an atomic hard link;
the destination directory must already exist and its filesystem must support
hard links (for example, NTFS). Filesystems without hard-link support, including
FAT/exFAT and some network shares, fail publication; choose a supported local
destination. There is no copy fallback that could expose a partial final file.
Failure and cancellation remove staged and
intermediate files instead of leaving a completed destination.

Only one export runs across agents and the Export UI. Project mutations,
undo/redo and project switching pause for the entire job; reads, status and
cancellation remain available. Terminal outcomes release this gate. Native
encoding, audio mixing and muxing participate in cancellation alongside the
worker and preparation stages. Renderer failure fails the job and releases
resources; project shutdown cancels before closing its backend. If native
cleanup fails, `phase: "cleanup_failed"` and `error` explain the failure, and
the mutation gate stays held until cleanup succeeds; retry cancellation.

MCP disconnect does not cancel the job. Any reconnected client can inspect its
job ID while the app process remains alive. Job records are process-session
state, not persisted project data, and app restart ends retention. Export does
not add a timeline undo entry. See [ADR 0089](adr/0089-agent-export-jobs-share-the-renderer-pipeline.md).

## Audio-only export

`export::export_audio_only(app, &project, &output_path, &audio, window_us)` is
the single entry point. It delegates to the audio engine
([`audio.md`](audio.md)):

1. `audio::mix::plan_for_project(project, window_us) → MixPlan` — every
   audible Audio layer resolved to conform-file placement + sampled
   gain/pan envelopes. "Audible" applies the full skip-rule set from
   [`audio.md`](audio.md): track `enabled`/`muted`/`solo` gates,
   `Layer.enabled`/`locked`/`AudioParams.mute`, and overlap with the
   half-open export window — a layer entirely outside `[start, end)` is
   neither planned nor required to have a conform cache. An audible
   in-window layer whose conform cache is missing fails the plan loudly
   with the media named (the renderer's readiness gate normally prevents
   reaching that state).
2. If the plan has no layers (or the window is empty): log a warning and
   return `Ok(())`. The mux step downstream tolerates a missing audio file.
3. Otherwise: spawn ffmpeg reading raw f32 from stdin —

   ```text
   -f f32le -ar 48000 -ac 2 -i - \
     -af alimiter=limit=0.891:level=0 \
     -ar <target_sr> -ac <target_ch> -c:a <aac|libopus> -b:a <bps> <output>
   ```

   — and run the block mixer on a blocking thread, summing 65 536-frame
   stereo blocks from conform reads and piping them in. The `alimiter`
   ceiling (−1 dB sample-peak, auto-normalize explicitly off) is what
   keeps overlapping layers from clipping at encode.
4. On non-zero exit, return an error with the last ~8 lines of stderr.

The JS orchestrator chooses the temp audio extension from the selected codec:
AAC writes `.m4a`; Opus writes `.mka`. No `export:*` events are emitted from
this path; the renderer owns ExportPanel state.

When `settings.audio.include` is false, `App.tsx` skips
`exportProjectAudioOnly` entirely. When it's true, the export readiness
gate first asks Rust `ensure_export_audio_conform(start_us, end_us)` for
the media whose conform cache is absent or invalid — the command shares
`plan_for_project`'s layer walk (`conform_waiting_media`), so the gate
and the plan can never disagree on selection, and it validates the cache
file itself (`cached_ok`), not the store's `conform_path` (which goes
stale if the cache dir is cleared). The command kicks a conform job per
missing media; the gate holds in "preparing" until a
`media:job_complete kind=conform` event lands for every returned id
(`createConformTracker` in `exportReadiness.ts` — listeners register
before the command so a fast job can't complete unseen).

## Final mux

`export::mux_to_file(video_path, audio_path, output)` runs a stream-copy mux:

```text
ffmpeg -y -hide_banner -nostats \
       -i <video.mp4> \
       [-i <audio.m4a|audio.mka>] \
       -c copy \
       <output_path>
```

The audio input is optional. If the user excluded audio, or the project has no
audio layers and `export_audio_only` produced no temp file, `mux_args` omits the
audio `-i` and writes a video-only file.

Every export has already written its final codec before this step runs —
either the WebCodecs path's direct encode, or the native `ffmpeg` sink
described in [`render.md`](render.md)'s "Encode exits", which also applies the
`hvc1` tag HEVC needs in MP4/MOV. `mux_to_file` never re-encodes; it only
copies streams into the user-chosen container.

## Coverage

The root behavior above is guarded by focused tests and diagnostics; see
[`conformance.md`](conformance.md) for the media fixtures and E2E gates:

- `exportSettings.test.ts`: default merge/backfill, audio codec/container
  validity, estimate size, and range clamping.
- `frameGrid.test.ts`: half-open export frame counts and timestamp grid.
- Rust unit tests in `export/mod.rs`: AAC/Opus encode args, missing-audio
  mux arguments, and a real-ffmpeg mixer round-trip (two overlapping
  layers → AAC → decode → analytic peak).
- Rust unit tests in `audio/`: envelope sampling (cross-language goldens),
  pan law, block-mixer placement/summing.
- `media_conformance --audio`: frequency-based audio export diagnostics;
  `--audio-envelope` / `--audio-pan`: analytic RMS-envelope, limiter-ceiling,
  and pan-law gates (`audio/audio.e2e.js`).

## Proxies

Import generates the H.264 proxies the WebCodecs renderer decodes,
cached under `<cache>/proxies/<file_hash>.mp4` (skip-if-cached). There
are two, for two roles (full detail in [`preview.md`](preview.md) and
[`data-model.md`](data-model.md); ADRs 0009–0011):

- **Quick proxy** (`jobs/quick_proxy.rs`) — 720p, short fixed GOP
  (`PROXY_GOP_FRAMES`), `libx264 -preset ultrafast`, yuv420p. The
  **preview** scrub source. The short GOP bounds the
  seek-to-key-then-decode-forward tail to a few frames — frame-accurate
  live scrubbing (ADR 0008; ADR 0003's no-reset-on-forward-GOP-crossing
  still holds).
- **Export master** (`jobs/proxy.rs`) — source-resolution (≤4K) H.264,
  `-preset fast -crf 18 -profile:v high` (auto level), short GOP,
  `-bf 0`, yuv420p, `+faststart`. Generated only for sources WebCodecs
  can't decode directly; export decodes it (never the quick proxy). A
  `PROXY_FORMAT_VERSION` bump or `proxy_path = Some(None)` invalidates
  it for re-encode on next open.

Both recipes assert the source's ffprobe color tags on the encode and
write the mp4 `colr` atom (`source_color_args` + `+write_colr`; the
quick proxy's remux path derives colr from the input VUI), keeping
proxies color-readable to mediabunny, which never parses the SPS VUI
(ADR 0014).

Sources WebCodecs *can* decode are bypassed (no proxy) or DirectExport
(export reads the original); see the decode-routing summary in
[`data-model.md`](data-model.md).

## Background jobs

All ffmpeg-driven derivatives live under `jobs/`:

| Job | Output | Trigger |
|---|---|---|
| `proxy.rs` / `quick_proxy.rs` | source-res (≤4K) export master + 720p scrub proxy | Auto on import |
| `thumbnails.rs` | per-source thumb strip | Auto on import |
| `waveform.rs` | `.peaks` binary file | Auto on import (audio-bearing sources) |
| `conform.rs` | `.conform` canonical PCM (48 kHz f32, [`audio.md`](audio.md)) | Auto on import (audio-bearing sources); `ensure_conform` backfill |
| `frame.rs` | single PNG at a t_us | On-demand via `media://{id}/frame/{t}` |
| `import.rs` | source bytes copied into `<workspace>/Media/` | User import action |

Each job runs in a single-worker FIFO so disk I/O doesn't thrash.
Progress is surfaced over backend events (`media:job_started`,
`media:job_complete`, `media:job_error`).
