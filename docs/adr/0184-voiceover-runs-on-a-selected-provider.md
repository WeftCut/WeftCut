---
status: accepted
---

# Voiceover runs on a selected provider that declares its voices and limits

Date: 2026-11-27

Replaces the TTS part of ADR 0036 (the `DEFAULT_ORDER` fallback). Its
transcription decisions stand; ElevenLabs Scribe joins them as a backend.

## Context

Voiceover had one provider, OpenAI `tts-1`, and every layer assumed it: the
synthesizer walked `DEFAULT_ORDER` and took the first backend with a key, so
a key saved for transcription quietly chose the voiceover engine; the MCP
`voice` argument and the dialog listed `tts-1`'s six voices; the dialog
hard-coded its 4096-character cap and 0.25–4.0 speed; the cache key named
neither provider nor model and the cache file was always `.mp3`. ElevenLabs
offers both text-to-speech and transcription (Scribe), and its facts differ
on every one of those points, so a second provider does not fit without
changing them.

Measured against the live API and its documentation before deciding:

- Voices belong to the account (`GET /v2/voices`, paged): premade, cloned and
  library voices, identified by case-sensitive ids. Premade ids are being
  retired, so no voice id can be built in.
- Speed is a per-model fact, and the newest models have none.
  `eleven_multilingual_v2` and `eleven_flash_v2_5` apply
  `voice_settings.speed` within 0.7–1.2; `eleven_v3` accepted any value and
  ignored it; the `eleven_v4` documentation states "Style and Speed sliders
  are not available in Eleven v4"
  (<https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4>).
- The per-request character cap is per model: 100 000 for `eleven_v4`,
  40 000 for `eleven_flash_v2_5`, 10 000 for `eleven_multilingual_v2`.
- API keys are scoped: a key may lack `user_read` and still synthesize and
  transcribe, so only a real inference proves a key works for a feature.
- Scribe accepts whole files of hours (5 GB, 15 h) and chunks them itself in
  8-minute pieces, three in parallel. Word times are seconds; punctuation is
  its own entry or glued to the next word; `spacing` and `audio_event`
  entries carry no words. Without a language hint, `scribe_v3` writes a
  Mandarin sentence inside English speech as pinyin; with `zh` it keeps the
  characters.

## Decision

- **Voiceover is its own model family.** Settings gains a Voiceover
  selection with the ADR 0064 rules: a profile becomes active only after a
  minimal inference succeeds, None is the fresh-install default, and nothing
  falls back. `synthesize_speech` runs the selected profile only; with none
  selected it fails naming Settings → Voiceover. A key saved for
  transcription never selects a voiceover provider. `DEFAULT_ORDER` stops
  being an order: what remains is the backend catalog tags resolve against.
- **Built-in voiceover profiles**, in this order: OpenAI (`tts-1`), then one
  entry per ElevenLabs model: ElevenLabs v4 (`eleven_v4`), ElevenLabs
  Multilingual v2 (`eleven_multilingual_v2`) and ElevenLabs Flash v2.5
  (`eleven_flash_v2_5`). The model is the user's choice, made by picking the
  entry; each entry names its model id statically, the host injects it as
  `voiceover_model`, and native keeps the table of models it accepts with
  their caps, refusing any other id naming Settings → Voiceover. OpenAI has
  one model and ignores the field. Verification synthesizes one short word
  with the entry's own model, and for ElevenLabs first lists the account's
  voices: the two are separate key permissions and the dialog needs both. A
  permission error names the missing permission; only `invalid_api_key` means
  the key is wrong.
- **Voiceover has no speed**, for any provider: no dialog field, no
  `synthesize_speech { speed }`, no `voice_settings` sent. `eleven_v4` has no
  speed control at all and `eleven_v3` ignored one, so a speed setting would
  work on some entries and silently do nothing on others. The editor already
  changes a clip's pace with its pitch kept (`retime_layers`, whose
  `preserve_pitch` defaults to true), on any provider's audio and after the
  fact, so pace is set on the placed layer. A `speed` from an agent is refused
  as an argument that no longer exists, pointing at `retime_layers`.
- **A provider declares its voiceover facts**: model, voices, per-request
  character cap and output format. OpenAI's voices are static; ElevenLabs
  lists the account's on request. The Voiceover dialog and the MCP tools read
  these facts; no layer above the provider keeps a voice list or a limit.
- **MCP**: `synthesize_speech { voice }` is a string the active provider
  validates, and `list_voices` returns the active provider, its model, limits
  and voices. Voice ids are kept as given, never case-folded.
- **The cache key covers provider, model, voice id, output format and
  text**, and the file extension comes from the provider's format. OpenAI
  entries written under the old key miss once and are re-synthesized.
- **One key per provider, shared by its features.** The `elevenlabs`
  safeStorage tag serves the Scribe transcription profile and the three
  ElevenLabs voiceover profiles, as `openai` already serves Whisper and
  `tts-1`. Each profile verifies on its own; re-keying through one profile
  does not re-verify the others, which report a bad key on their next call.
- **Migration, once**: settings saved before this change gain a voiceover
  selection of OpenAI when voiceover worked for them, that is, a key under the
  `openai` tag or under the active cloud transcription profile's tag. In the
  second case the key is copied to `openai`. The check reads which tags hold a
  key, without decrypting. Everyone else starts at None.
- **ElevenLabs Scribe** is a speech backend (`elevenlabs`, cloud, exact word
  timing) running `scribe_v3` with word timestamps and audio events off. The
  request carries the clip's language when Scribe knows it, otherwise none.
  Its parser drops `spacing` and `audio_event` entries and attaches
  punctuation to the word before it, so a mark never becomes a timed word
  spanning a pause.
- **The split is per backend.** A network piece is 10 minutes for OpenAI and
  endpoints (their upload caps) and 24 minutes for ElevenLabs: three of
  Scribe's 8-minute chunks, one parallel pass per request. Pieces still bound
  what one failed request loses and drive per-piece progress.

## Consequences

- Adding a voiceover provider is a backend, its facts and a profile; the
  dialog and MCP tools need no change.
- `synthesize_speech`'s `voice` is no longer an enum and its `speed` is gone,
  both published MCP contract changes; the six OpenAI names stay valid for
  the OpenAI profile.
- An agent must call `list_voices` before choosing an ElevenLabs voice.
- A voiceover profile's verification spends a few characters of the
  provider's quota.
- Adding an ElevenLabs model is a row in native's model table and a built-in
  profile naming it.

Rejected: keeping the default-order fallback (a key chose the engine); a
speed setting offered only where the model honours it (a control that
appears and disappears with the model, for what a retime already does on
every provider); a user-editable model field (each model has its own cap,
so native accepts only those in its table, and a free field would offer ids
that cannot run); a built-in default ElevenLabs voice (ids are
per-account and premade ones expire); validating every ElevenLabs voice id
against a fresh list per call (an unknown id comes back as the provider's own
`voice_not_found`); sending a whole long clip to Scribe in one request (one
timeout loses all of it and progress stops).
