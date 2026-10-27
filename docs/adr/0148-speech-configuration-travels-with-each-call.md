# ADR 0148: Speech configuration travels with each call

Status: Accepted

Brings speech in line with video understanding, whose configuration already
arrives with each call (`vlm_config`). The split of config by secrecy from
[ADR 0036](0036-pluggable-speech-backends-normalized-transcript.md) is
unchanged; only where the merged result lives changes.

## Context

Speech kept its configuration on the native `Backend`: a map of keys, local
engine paths and the endpoint, filled by five napi setters
(`set_cloud_key`, `set_local_backend`, `set_endpoint_backend` and their
`clear_*` twins) that Electron main called at boot, on every Settings write,
after a content download and whenever the active model changed. Video
understanding took the same kind of map as a call argument.

The pushed copy had to be kept in step by every writer, and it drifted. A
custom OpenAI profile's key stayed in it after the user switched to a local
model, until the next launch replaced it with a different key. A write path
that forgot to push left the resolver on old config with nothing to show
for it. Two subsystems answering the same question in two ways was the
cost of nothing.

## Decision

- Electron main builds the speech snapshot at call time
  (`toSpeechBackendSnapshot`): the OpenAI key (the selected cloud model's own,
  else the `openai` tag's, which TTS uses whatever transcribes), every local
  engine in `speech_config.json`, and the selected model's endpoint with its
  key and timeout. A blank key is absent, never `""`.
- It is injected as `speech_config` into `transcribe_clip` (MCP and renderer,
  through `callClipComputeTool`) and `synthesize_speech` (at the compute
  facade), and as `speechConfig` into `settings_get_speech_backends`,
  `settings_get_api_key_status` and `settings_test_provider`. It is never
  advertised, and `transcribe_clip` never serializes it into log details.
- `Backend.speech_config` and the five setters are gone.
- `speech_config` is part of a transcription job's identity, hashed like
  `vlm_config`: two calls on different engines never join one job.

## Consequences

- A key saved, a path picked or a model switched is what the very next call
  uses; no writer has a push to forget.
- What the Settings panel reports and what a transcription resolves come from
  the same snapshot, built by one function.
- Every speech call reads the key store, a small synchronous file read; a call
  already pays far more for audio extraction.
