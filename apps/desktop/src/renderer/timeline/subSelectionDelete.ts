// Shared stand-down rule for the timeline's capture-phase Delete preemptors.
//
// Two listeners claim Delete/Backspace for a timeline SUB-selection before the
// app-level delete-selected-layer shortcut can see it, both on the `Timeline`:
// the keyframe selection and the transition chip. Winning that race is why they
// exist, and why they are raw capture-phase `window` listeners with
// `stopImmediatePropagation()` instead of entries in `ACTION_DEFS`.
//
// Both live on the Timeline because a keyframe selection can span layers and
// tracks: per-component listeners would arm several at once, and the one that
// registered first would delete its own subset and stop the rest.
//
// The cost of bypassing the dispatcher is that they must reproduce its
// stand-down rules by hand — and every rule any one of them forgets becomes
// "Delete does something different depending on which selection happens to be
// armed". Hence one predicate, two call sites.

import { isEditableTarget } from "../shortcuts/match";
import { activeRegion } from "../focus/focusRegionStore";

/// True when a sub-selection must NOT claim this Delete. Mirrors the two rules
/// `deleteSelected` carries in `ACTION_DEFS`:
///
///   * a bare key is dead while a text field is focused — otherwise Delete
///     aimed at a character in the Attribute panel silently removes a keyframe
///     and eats the keystroke;
///   * `scope: ["timeline"]` is dead unless the timeline region owns the
///     keyboard (ADR 0041).
export function subSelectionDeleteYields(target: EventTarget | null): boolean {
  return isEditableTarget(target) || activeRegion() !== "timeline";
}
