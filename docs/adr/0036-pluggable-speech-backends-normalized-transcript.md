---
status: accepted
---

# Speech runs over pluggable backends, normalized to one word-timed transcript

Date: 2026-10-31

## Context

Transcription has to run on the OpenAI cloud, on local engines (whisper.cpp,
FunASR) and on any OpenAI-compatible server (whisper-server, speaches, vLLM,
LocalAI). Their output differs: OpenAI's `whisper-1` gives SRT, whisper.cpp
`-ojf` gives token offsets, sherpa-onnx gives per-character JSON, servers give
words at the top level, per segment, not at all, or refuse `verbose_json`.
Consumers (caption packing, text correction, cut points) need one shape and
must know whether a word time is exact or estimated. OpenAI's upload cap is
25 MB, which the 16 kHz mono WAV every engine is fed reaches at about 13
minutes. A copy of speech config pushed onto the native `Backend` drifted from
Settings (a custom profile's key outlived a switch to a local model until
relaunch).

## Decision

- **One entry, strict selection.** `transcribe_clip` resolves the selected
  model only (`speech::resolve_transcriber`) or the per-call `backend` arg
  (`resolve_transcriber_exact`); neither substitutes another engine, so a local
  choice never degrades into a cloud upload. Errors name the remedy. TTS keeps
  a default-order fallback (`DEFAULT_ORDER`; OpenAI is its only provider).
- **Backends emit a style, parsers normalize.** `Transcriber` returns a
  format-tagged `RawTranscript` (SRT, whisper JSON, FunASR JSON, OpenAI
  verbose JSON); one parser per style yields `Transcript { segments[{
  t_start_us, t_end_us, text, words[] }], language, word_timing }` with
  `WordTiming = Exact | InterpolatedFromCue | None`. SRT words are spread over
  the cue by length; space-less CJK splits per character. The SRT style reuses
  `subtitles::parse_subtitle_cues` — one SRT parser in the code.
  `word_timestamps` defaults to true.
- **Local engines are one-shot CLI sidecars** (`whisper-cli`,
  `sherpa-onnx-offline`) over the shared extracted WAV, with an audio-scaled
  hang guard; no linked inference library, no long-lived server.
- **`byo_endpoint`** posts to the user's full URL, negotiating the format:
  `verbose_json` with word+segment granularity first; a 400/415/422 or an
  answer without `segments` retries once as `srt`, and the working format is
  remembered per URL for the process. A result is `exact` only when every
  segment carried the server's word times.
- **Network engines get long audio in pieces**: over 10 minutes, cut at the
  quietest 200 ms within ±30 s of each 10-minute mark, a tail under 1 minute
  joining the previous piece; pieces run one at a time and are reassembled on
  the WAV time base (`speech/split.rs`). Local engines get the whole window.
- **Config splits by secrecy and travels with each call.** Keys stay in
  `safeStorage` (`cloud_keys.json`, name kept so stored keys survive; the
  endpoint key under its own tag); non-secret engine config lives in
  `speech_config.json`. Electron main builds the snapshot at call time
  (`toSpeechBackendSnapshot`) and injects it as `speech_config` into
  `transcribe_clip`, `synthesize_speech` and the Settings status reads. It is
  never advertised or logged, and it is part of a transcription job's
  identity. The Rust side holds no speech state between calls.

## Consequences

- Adding an engine is an enum variant, an availability probe and, only for a
  new output style, a parser. `Capabilities::exact_word_timing` badges engines
  statically; `byo_endpoint` reports per result.
- A key saved or a model switched is what the next call uses.
- A network piece can, rarely, cut inside a word when a minute has no pause;
  the first call to a server without `verbose_json` costs two requests.

Rejected: in-process `whisper-rs` FFI (links C++ into the addon, holds the
model in the app's address space); per-backend output types; a second SRT
parser; giving the `openai` backend a URL (its tag is a wire and on-disk key
shared with TTS).
