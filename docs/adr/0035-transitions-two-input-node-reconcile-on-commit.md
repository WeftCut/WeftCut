---
status: accepted
---

# Every transition kind renders through one two-input compositor node, and ordinary edits reconcile transitions on commit

Date: 2026-07-24

## Context

A transition authorizes an overlap between two same-track visual layers that
the no-overlap invariant would otherwise reject; the overlap must equal the
transition's duration. Kinds: Crossfade, Wipe and Slide (Wipe/Slide carry a
motion direction; see CONTEXT.md § Transitions).

Wipe and Slide are two-input operations — each output pixel depends on both
clips — so they cannot ride the per-layer opacity path. A crossfade done as an
opacity ramp on the incoming layer would be a second evaluation semantics and
darkens alpha content mid-window (both layers below unity let the background
through). Separately, a trim, move, split or delete that breaks the
authorized overlap would fail validation with an invariant the user never
touched, deadlocking the timeline around every transition.

## Decision

**One node.** During a transition window the Compositor diverts both
participants into `TransitionNodeManager` (`render/transitions/`). Each side
renders, with its own transform, opacity and effect chain, into a
composition-sized render texture; one full-frame quad mixes the two
premultiplied captures with the kind's shader (GLSL + WGSL) at the first
participant's stage slot. Progress is linear `(t − overlapStart) / duration`.
Side RTs come from a pool sized by concurrent transitions × 2 and are never
allocated per frame (memory-ratchet `transitions` scenario). Preview and
export share the node.

**Reconcile on commit (Policy B).** The per-transition invariant
(participants exist, same track, visual only, overlap = duration, duration
within both layers) is one predicate with two callers in
`main/state/validate.ts`: `validateTransitions` fails on it,
`reconcileTransitions` drops on it. Reconcile runs inside every commit (and
`dryRun`) after the mutation and before validate; each drop emits a status
row and lands in the same history entry as the edit. A drop never shrinks the
outgoing layer back. Layer mutations stay transition-blind. Structural
corruption (duplicate id, self-reference, a layer in two transitions) stays
validate-only.

Placement of the overlap is ADR 0048's.

## Consequences

- Adding a kind is an enum variant plus a shader.
- Side RTs are 8-bit (`rgba8unorm` on WebGL, `bgra8unorm` on WebGPU, whose
  Pixi pipelines hard-code bgra8 targets), so the 10-bit export lane
  quantizes inside a transition window. Float RTs would need
  `EXT_color_buffer_float`, which preview's WebGL fallback cannot assume.
- A split inside the overlap leaves it covered by a non-participant; after the
  drop, validate's `LayerOverlap` rejects the whole commit. That is
  geometrically necessary; the generic error message is known debt. A group
  move containing both participants keeps the transition. Truth table:
  `main/state/reconcile.test.ts`.
- Reconcile silently mutates state on every commit, so the PBT invariant
  suite includes the transition ops.

Rejected: opacity-ramp crossfade (above); blocking edits that break a
transition (Policy A — deadlock); shrink-back on drop (fights the user's
gesture).
