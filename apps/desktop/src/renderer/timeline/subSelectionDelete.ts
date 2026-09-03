// The stand-down rule for the timeline's capture-phase Delete preemptor.
//
// The selected transition chip claims Delete/Backspace before the app-level
// `deleteSelected` shortcut can see it, from a raw capture-phase `window`
// listener on the `Timeline` with `stopImmediatePropagation()` rather than an
// entry in `ACTION_DEFS`. Winning that race is what it exists for: a chip and a
// clip selection are mutually exclusive, so there is exactly one target, and
// the chip's is not the one `deleteSelected` would reach.
//
// The keyframe selection is NOT here. Its precedence over the clip delete lives
// inside `deleteSelected` itself, so that Settings → Keyboard can state the
// rule on the Delete row instead of one action's behaviour being decided by a
// listener the catalogue cannot see.
//
// The cost of bypassing the dispatcher is having to reproduce its stand-down
// rules by hand — and every rule this forgets becomes "Delete does something
// different depending on which selection happens to be armed".

import { isEditableTarget } from "../shortcuts/match";
import { activeRegion } from "../focus/focusRegionStore";

/// True when a sub-selection must NOT claim this Delete. Mirrors the two rules
/// `deleteSelected` carries in `ACTION_DEFS`:
///
///   * a bare key is dead while a text field is focused — otherwise Delete
///     aimed at a character in the Attribute panel silently removes a
///     transition and eats the keystroke;
///   * `scope: ["timeline"]` is dead unless the timeline region owns the
///     keyboard (ADR 0041).
export function subSelectionDeleteYields(target: EventTarget | null): boolean {
  return isEditableTarget(target) || activeRegion() !== "timeline";
}
