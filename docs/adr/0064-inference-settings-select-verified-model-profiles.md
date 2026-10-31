---
status: accepted
---

# Inference settings select verified model profiles

Date: 2026-09-09

## Context

Speech and video settings exposed engine internals (binary, model, tokens,
device) per engine, and a soft "preferred engine" fell back by availability.
A user who chose a model could silently be served by another one — a local
choice could become a cloud upload — and a half-configured engine looked
selected until a call failed. Managed downloads (ADR 0039) already own the
runtime and auxiliary files.

## Decision

- **Users choose a model, not an engine.** A built-in model names a fixed set
  of catalog artifacts. A custom profile carries runtime overrides or a custom
  model/endpoint (adapters: whisper.cpp, FunASR/sherpa-onnx, OpenAI
  `whisper-1`, an OpenAI-compatible transcription server, Qwen3-VL or
  MiniCPM-V on llama-mtmd, a compatible vision endpoint). Editing a built-in
  identity creates a named copy. Credentials stay in `safeStorage`.
- **Activation requires a verified inference.** Main owns preparation: missing
  content is installed, then a minimal inference must succeed against the
  candidate config before it becomes active. Failure never changes the active
  model; the picker keeps naming it. A newer request supersedes a pending one.
- **No fallback.** An explicit model never falls back to another model.
  Automatic device choice may retry the same weights and precision on CPU; a
  pinned device never falls back.
- **None is a real selection** and the fresh-install default. Startup never
  enqueues downloads (previously requested pending ones may resume). Unselect
  keeps files, profiles and keys.
- **Deletion respects ownership.** Clear downloads removes only catalog-owned
  directories and paused partials not shared with another profile; inference
  and verification hold file-use leases; the target is unselected before
  deletion. Removing an active custom profile clears the selection to None
  and deletes its own credential, never local files.
- **Windows VC++ prerequisite** is part of preparation: the Microsoft
  installer from Microsoft's serviced URL must carry a valid Microsoft
  Authenticode signature before launch (`main/model-components.ts`); it runs
  only from an explicit install action, with no forced restart.
- **Description cache identity** includes weights + projector paths with file
  metadata, or endpoint URL + model name, so two profiles with one model name
  never share descriptions.

## Consequences

- Legacy paths and automatic choices migrate once into concrete profiles;
  later availability changes never pick another model.
- Persistence failures on save or removal roll back selection and credentials.
- Full model downloads, GPU execution and the elevated VC++ installer are
  validated only on hardware; tests cover ordering, cancellation, superseding,
  rollback and a loopback endpoint.
