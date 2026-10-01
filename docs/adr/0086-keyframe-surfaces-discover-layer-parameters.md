# Keyframe editing surfaces discover parameters through one layer interface

The expanded timeline used a layer-kind descriptor list, a second ordering
whitelist, and direct reads of `layer.params`. Visual effects already supported
keyframes in their inspector, but stored their tracks in `layer.effects`.
Consequently their keys were invisible to the timeline; `path_progress` was
also omitted by the ordering whitelist. Fixing only the row renderer would
leave navigation, selection, dragging, easing, deletion and clipboard broken.

## Decision

`renderer/keyframe/channels.ts` owns parameter discovery and reads for editing
surfaces. `layerParams(layer)` returns descriptors including instance-owned
visual effect parameters. `readLayerParamTrack(layer, keyOrDescriptor)` resolves
the existing mutation address, including a catalog default for an absent
effect slot. `keyframedParams(layers)` derives visible rows from those same
definitions and the current snapshot, with no timeline whitelist or mounting
registration. A closed inspector cannot make an animated parameter disappear.

Descriptors carry the value kind, default, editing bounds/step, translated label
and optional owner context. Number and Rgba remain distinct types. Numeric
inspector fields share `InspectorAnimField`; timeline fields, navigation,
collapsed diamonds, marquee, batch edits and clipboard share the layer read
interface. Existing mutation sinks continue to own undo and linked-scale
fan-out; storage, the time domain and IPC addresses do not change.

Visual effect defaults, ranges and steps have one GPU-free home in
`shared/effects/params.ts`. Both filter descriptors and editing descriptors
derive from it. Adding a parameter to an existing effect requires its catalog
metadata, renderer behavior and translations, but no additional keyframe UI
registration. A new storage family needs discovery/read support in the layer
module; a new value kind needs its editor and evaluation semantics. This is not
automatic animation support for arbitrary static fields.

## Identity and presentation

- Effect addresses retain the effect instance ID. Reordering changes the row's
  ordinal label, never its address. Different instances of the same kind remain
  independent rows; the header tooltip identifies the owning layer.
- Row order follows parameter definitions. The first actually keyed layer
  supplies metadata for shared built-in rows, preserving linked Scale labels.
- Only Keyframed parameters produce timeline rows. Disabled visual effects keep
  editable animation. Removed effects resolve to no track, so stale selections
  are ignored. Unknown effects remain stored but have no editor in this build.
- Clipboard paste requires the target to carry the same address. It does not
  guess an equivalent effect by kind or chain position on another layer.
- Audio effects remain static whole-clip bakes (ADR 0063). Path mode hides X/Y
  and exposes progress (ADR 0060). Linked scale retains its twin-write behavior.
- Colour rows use centre-line diamonds and generic easing operations; scalar
  curve geometry is used only for number values.

## Verification

Channel tests exercise discovery, lazy defaults, identity across reorder and
removal, path mode, shared navigation/batch/clipboard behavior, and effect/colour
marquee hits. A timeline field test edits a discovered effect through its
instance address. Existing keyframe, inspector and effect-registry suites cover
the preserved behavior.

`e2e/electron/keyframe-effects.spec.ts` exercises the real Electron UI over
CDP: enabling animation in the effect inspector, timeline value edits,
navigation, undo/redo, easing, dragging, duplicate-effect reorder/removal,
editing with the inspector hidden, and path-progress percentage editing.
It captures CDP screenshots for visual acceptance.
