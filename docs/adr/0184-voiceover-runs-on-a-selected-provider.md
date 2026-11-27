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

Measured against the live API before deciding:

- Voices belong to the account (`GET /v2/voices`, paged): premade, cloned and
  library voices, identified by case-sensitive ids. Premade ids are being
  retired, so no voice id can be built in.
- Speed is a per-model fact. `eleven_multilingual_v2` and `eleven_flash_v2_5`
  apply `voice_settings.speed` and refuse values outside 0.7–1.2;
  `eleven_v3` and `eleven_v4` accept any value and ignore it.
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
- **Built-in voiceover profiles**: OpenAI (`tts-1`) and ElevenLabs
  (`eleven_multilingual_v2`, chosen because it honours speed; v4 is newer but
  ignores it). Verification synthesizes one short word, and for ElevenLabs
  first lists the account's voices: the two are separate key permissions and
  the dialog needs both. A permission error names the missing permission; only
  `invalid_api_key` means the key is wrong.
- **A provider declares its voiceover facts**: model, voices, per-request
  character cap, speed range (or none) and output format. OpenAI's voices are
  static; ElevenLabs lists the account's on request. The Voiceover dialog and
  the MCP tools read these facts; no layer above the provider keeps a voice
  list or a limit. A provider without a speed range shows no speed control and
  `synthesize_speech` refuses a `speed`.
- **MCP**: `synthesize_speech { voice }` is a string the active provider
  validates, and `list_voices` returns the active provider, its model, limits
  and voices. Voice ids are kept as given, never case-folded.
- **The cache key covers provider, model, voice id, speed, output format and
  text**, and the file extension comes from the provider's format. OpenAI
  entries written under the old key miss once and are re-synthesized.
- **One key per provider, shared by its features.** The `elevenlabs`
  safeStorage tag serves the Scribe transcription profile and the ElevenLabs
  voiceover profile, as `openai` already serves Whisper and `tts-1`. Each
  profile verifies on its own; re-keying through one profile does not
  re-verify the other, which reports a bad key on its next call.
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
- `synthesize_speech`'s `voice` is no longer an enum, a published MCP
  contract change; the six OpenAI names stay valid for the OpenAI profile.
- An agent must call `list_voices` before choosing an ElevenLabs voice.
- A voiceover profile's verification spends a few characters of the
  provider's quota.

Rejected: keeping the default-order fallback (a key chose the engine);
`eleven_v4` without speed; a built-in default ElevenLabs voice (ids are
per-account and premade ones expire); validating every ElevenLabs voice id
against a fresh list per call (an unknown id comes back as the provider's own
`voice_not_found`); sending a whole long clip to Scribe in one request (one
timeout loses all of it and progress stops).
