---
status: accepted
---

# Inference settings select verified model profiles

The speech and video settings expose engine internals despite already providing
managed downloads. Users choose a model; the app owns its runtime and auxiliary
files. This decision supersedes ADR 0036's soft preferred-engine fallback and
ADR 0055's always-visible per-engine editors for these settings.

Each built-in model names a fixed set of existing content-catalog artifacts.
Independent model profiles carry runtime overrides or a custom model/endpoint;
credentials remain in safeStorage. Replacing model identity creates a named
custom profile, preserving the built-in. Opening advanced settings is only a
presentation change. Reset removes overrides, not model downloads.

The main process owns preparation and activation. A model is activated only
after its missing content is installed and a minimal inference succeeds against
the candidate configuration. Failed validation never mutates the active profile.
New use requests supersede old pending activation requests. Closing Settings
does not cancel downloads. A fresh page previews Whisper Base or Qwen3-VL-4B
without installing or activating it, and carries no recommendation labels.

An explicit model never falls back to another model. Automatic device choice
may retry the same weights and precision on CPU. A pinned device never falls
back. Legacy automatic choices are resolved once during migration and persisted
as a concrete profile; subsequent availability changes do not select another.

Windows runtime prerequisites join preparation. Official Microsoft VC++
redistributables require a valid Microsoft Authenticode signature before launch;
the OS installer is launched only from the installation action, with no forced
restart. This prerequisite uses Microsoft's serviced download location rather
than the immutable model-artifact catalog; it is verified by publisher signature.

Existing local paths migrate to matching managed models or independent custom
profiles; existing online credentials are retained. The model list initially
contains only the already integrated models and endpoint adapter.

Description cache identity includes the weights and projector paths with file
metadata, or the endpoint URL and model name. Two profiles with identical model
names cannot read one another's descriptions. Existing descriptions under the
old name-only key remain on disk but require regeneration under the new key.

Validation covers preparation ordering, cancellation, superseding requests,
credential/config rollback, migration, and compact UI behavior. Electron tests
exercise the native validation path against a loopback compatible endpoint with
synthetic media. Full local-model downloads, GPU execution and the elevated
Windows prerequisite installer still require hardware integration validation.
