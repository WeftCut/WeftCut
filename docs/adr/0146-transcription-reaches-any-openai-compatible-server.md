# ADR 0146: Transcription reaches any OpenAI-compatible server

Status: Accepted

Extends the pluggable speech backends of
[ADR 0036](0036-pluggable-speech-backends-normalized-transcript.md). The
normalized transcript, strict selection and the split of config by secrecy
are unchanged.

## Context

Transcription could run on the OpenAI cloud or on a local sidecar, nothing
else. A user with a GPU server on the local network asked to send the work
there (#69): whisper.cpp's `whisper-server`, speaches, vLLM and LocalAI all
serve OpenAI's `/v1/audio/transcriptions`, but the OpenAI backend hard-coded
`api.openai.com` and `whisper-1`. Its `"openai"` tag is also a wire and
on-disk constraint, and TTS shares its key, so it could not simply grow a URL.

The servers share the request shape but not the answer. OpenAI gives word
timestamps in `verbose_json` at the top level, whisper-server per segment,
some servers not at all, and some do not accept `verbose_json`. The cloud
path also refused clips longer than about 13 minutes: OpenAI's upload cap is
25 MB, and the 16 kHz WAV every engine is fed reaches it there.

## Decision

- A new speech backend, `byo_endpoint`: the user's full URL, an optional model
  name (whisper-server ignores it), an optional key in `safeStorage` under its
  own tag (`speech_endpoint` for the built-in entry, `model-<id>` for custom
  ones, never the vision endpoint's), and an optional request timeout. It is
  URL-gated like the vision endpoint, last in the default order, and only
  ever used when selected.
- The format is negotiated: `verbose_json` with word and segment granularity
  first; a 400 / 415 / 422, or an answer with no `segments` array, retries
  once as `srt`. The format that worked is remembered per URL for the life of
  the process, and only one that worked. A transcript is `exact` only when
  every segment carried the server's own word times.
- On a network engine (OpenAI and `byo_endpoint`), audio longer than 10
  minutes goes in pieces cut at the quietest 200 ms within ±30 s of each
  10-minute mark; a tail under a minute joins the piece before it. Pieces run
  one at a time and are reassembled on the WAV's time base, before the
  playback-rate and timeline projection. Local engines still get the whole
  window.
- The endpoint's request timeout defaults to the local sidecars' hang guard,
  scaled with the audio. A timeout, a 413 and a 401 each fail naming their
  remedy.

## Consequences

- An intranet transcription server is a model like any other: verified with
  a real request before it is selected, chosen in the same picker, used by the
  agent and the renderer alike.
- Long clips transcribe on the cloud, at the cost of a cut that can, rarely,
  fall inside a word when a minute of audio has no pause.
- The first call to a server without `verbose_json` costs two requests.
- The static "exact word timing" badge is off for the endpoint; each result's
  `word_timing` says what the server actually gave.
