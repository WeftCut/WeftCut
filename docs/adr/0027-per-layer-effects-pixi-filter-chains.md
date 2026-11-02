---
status: accepted
---

# Per-layer effects are Pixi filter chains: project state owns instances, the renderer owns the catalog

Date: 2026-06-21

## Context

pixi.js and pixi-filters are a large maintained body of GPU filters; we want
to consume them, not reimplement them. Effects must also reuse the existing
keyframe engine (`Animated<T>` + the shared eval leaf), undo and the MCP
surface, and must not quantize the 10-bit export composite (`rgba16float`).

Measured: PixiJS's `pixi.js/unsafe-eval` no-eval polyfill renders every
*filtered* object empty on the WebGPU backend, and both preview and the 8-bit
export prefer WebGPU. Without real `new Function()` shader codegen the effects
subsystem is dead.

## Decision

- **Instances live in project state.** `Layer.effects: Effect[]` (order =
  chain order), `Effect { id, kind, enabled, params: Record<string,
  Animated<number>> }`, written by the TS actor (`add_effect` /
  `update_effect` / `move_effect` / `remove_effect`, recorded) and mirrored by
  a Rust serde twin (`native/src/state/effect.rs`). Params are scalar
  `Animated<f64>`; a keyframe addresses `effects[<id>].params[<key>]`.
- **The catalog lives in the renderer.** `render/effects/effectRegistry.ts`
  maps `kind` → descriptor (filter factory, per-param apply, fidelity tier
  `f16-verified` | `precision-reduced`). State does not interpret `kind`; an
  unknown kind is stored and skipped with a warning by the renderer. Adding a
  filter is one registry entry — no state, IPC or undo change.
- The one kind rule state enforces is the `audio.*` namespace: audio kinds
  only on Audio layers, other kinds never on them (`EffectKindNotApplicable`),
  and audio params are static (`AudioEffectParamStatic`) — audio effects are
  offline bakes (ADR 0063), not filters.
- **10-bit:** the export Worker sets Pixi's global `TexturePool` format to
  `rgba16float` once at init, so stock filters run unmodified at full
  precision. Never `TexturePool.clear(true)` on a live `FilterSystem`.
- **CSP:** the packaged renderer CSP grants `'unsafe-eval'` and the polyfill
  is not imported (`renderer/main.tsx`). See [`security.md`](../security.md).
- `preview_effects_enabled` (AppSetting, default on) lets preview skip
  filters; export ignores it. It has no UI: each effect's own `enabled`
  toggle already serves A/B comparison.

## Consequences

- Filters work on WebGPU and WebGL alike; the eval surface widens, but the
  renderer still loads no remote or inline script.
- Working space stays display-gamma BT.709 (descriptor `colorspace:
  "display-gamma"`); a linear/HDR bracket would be a new descriptor value.
- `Speed` is time remapping, not a filter, and is not in `layer.effects`.

Rejected: keeping the no-eval polyfill (no filters on WebGPU); a Rust-side
catalog (every new filter would touch state, IPC and undo).
