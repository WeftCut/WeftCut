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
credentials remain in safeStorage. Replacing a built-in model identity creates a
named custom profile, preserving the built-in. Opening model settings is only a
presentation change. Reset removes overrides, not model downloads.

The main process owns preparation and activation. A model is activated only
after its missing content is installed and a minimal inference succeeds against
the candidate configuration. Failed validation never mutates the active profile.
New use requests supersede old pending activation requests. Closing Settings
does not cancel downloads. The settings picker always shows the active model,
or an explicit empty state. Choosing an installed local model or a previously
verified service requests activation immediately; first downloads and service
configuration open an explicit preparation step. Until activation succeeds,
the picker and its check mark continue to name the previous active model.
Failures retain that selection and show retry on the candidate. Selecting a
different candidate supersedes preparation; merely browsing configuration does
not activate it. The current-model card owns inline editing, download storage,
clear downloads and custom-entry removal. An unready candidate opens an inline
setup card while the existing selection remains unchanged. There is no separate
configuration page or model-library entry. Video sampling and focus remain
independent analysis options.

Only Add opens a dialog. Nested app dialogs render their own backdrop above the
parent popup, with explicit depth-based stacking and modal focus containment.
The Add dialog ignores outside pointer dismissal; Close and Escape dismiss only
the top dialog, leaving Settings open.

Add starts with a supported adapter: whisper.cpp, FunASR/sherpa-onnx, the fixed
OpenAI whisper-1 service, Qwen3-VL or MiniCPM-V through llama-mtmd, or a compatible
vision endpoint. The fields follow the actual adapter contract. Editing a custom
profile updates it in place; replacing a built-in identity creates a named copy.
Save verifies without changing the selection. Add offers both Add and use and
Add without selecting; first-use preparation explicitly downloads and activates.

None is a persistent selection, including on a fresh installation. No model
setup card is shown until a user chooses a candidate, and startup never enqueues
model downloads automatically (previously requested pending downloads may resume).
Unselect keeps files, profiles and keys and cancels pending activation. Removing
an active custom entry clears its selection to None and removes its independent
credential, without deleting local files. Built-in entries cannot be removed.

Clear downloads is a separate, confirmed model-card action. It removes only known
catalog-owned directories and paused partials, retaining other profiles' shared
artifacts and local-path references. Inference and verification hold file-use
leases; deletion also refuses a running or stopping download. The target is
unselected before deletion, so a partial failure cannot leave it active or cause
an automatic replacement/download. Legacy content removal cannot bypass these
ownership checks. Runtime/configuration save and custom-entry removal roll back
the model selection and credentials on persistence failure.

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
