---
status: accepted
---

# Shared "WYSIWYG math" lives in one wasm leaf crate

Date: 2026-06-20

## Context

Small deterministic functions decide what the user sees and hears, and each
runs on both sides of the renderer/Rust boundary: frame snap (actor commits vs
drag ghost/seek), keyframe eval (renderer composite vs Rust audio export),
dB-to-linear, pan law, fade ramp and the role mute/solo gate (export mix vs
preview gating). Hand-mirrored Rust + TS copies drifted on edits, silently
breaking the frame-grid storage invariant, preview/export parity or
audibility. Cross-language goldens only caught drift after the fact.

Measured before committing: a resident-ABI wasm `value_at` costs ~0.59x the JS
version, and per-frame impact is under 0.5% of the frame budget.

## Decision

- The math lives once in the Rust leaf crate **`weftcut-eval`**
  (`apps/desktop/native/eval/`): an `rlib` the napi crate delegates to
  (`state/time.rs`, `audio/envelope.rs`, `audio/mix.rs`, ...) and a `wasm32`
  `cdylib` that `scripts/build-eval-wasm.mjs` base64-embeds into a generated
  TS module, loaded once by `initEval()` before the first composite.
- **Resident scalar ABI.** Keyframes cross into wasm once (cached by handle);
  per call only scalars cross. Times are `f64` us, rates `i32` num/den, never
  `i64` (no BigInt marshaling); exact rationals cross as two `f64` safe
  integers.
- **Leaf dependency budget.** `core` + `libm` (+ optional `serde`); `no_std`
  on wasm32 only. Forbidden: `imbl`, `uuid`, `napi`, `tokio`, `ts-rs`,
  `schemars`. So `Rational` (a `JsonSchema` type) stays in the napi crate and
  the leaf takes `(num, den)` primitives.
- **Gains are `f32`** (`db_to_linear`), matching `Envelope::scale` and Web
  Audio; goldens assert at f32 width.

## Consequences

- Preview, export and committed state run the same compiled function; the
  goldens now prove the wasm reproduces the fixtures.
- Building or testing the renderer needs a Rust toolchain with
  `wasm32-unknown-unknown`: `dev`, `build`, `typecheck` and `test` run
  `npm run build:wasm` first. The per-build wasm compile enforces `no_std`.
- The wasm build has no heap, so each animated property holds at most
  `MAX_RESIDENT_KEYFRAMES` (4096) keyframes resident; beyond that the preview
  truncates (with a one-time warning in `loadTrack`) while native export
  evaluates all of them. Path progress enforces the cap at authoring.
- New shared math (exact time mapping, motion-path compile) goes into the leaf,
  not into a second TS copy.
