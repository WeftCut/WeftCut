---
status: accepted
---

# The preview hit-tests only under a tool, and only that tool's kind

The preview is not a selection surface. A click on the canvas selects nothing,
and the on-canvas gizmo takes gestures only for the layer the timeline has
already selected. This record keeps that rule and adds its one exception: while
a modal tool that needs a frame coordinate is armed, the preview answers "what
is under this point" for **that tool's layer kind alone**, and a miss is a
click on empty frame whatever else is drawn there. The Text tool is the first
such tool.

## Context

Every NLE with on-canvas text has a Type tool: click empty frame to place
text, click text to edit it. Both halves need a frame coordinate, which only a
preview click has, and the second half needs the preview to know which Text
layer is under the pointer — something it had never been asked.

The gizmo's own geometry already answered a nearby question: to snap a drag it
computes every other staged layer's quad from `layerFrameAt` and `layerQuad`,
the same two functions that draw the selected layer's box. So a hit test was
one point-in-quad away, and the decision was not whether it could be built but
what it would mean for the preview to have it.

Three shapes were on the table.

- **The preview becomes a selection surface.** Any click selects the topmost
  layer under it, under every tool. This is what image editors do and what
  every earlier note on the gizmo refused ("the preview is not a selection
  surface"): a video frame is mostly *footage*, and a click on footage that
  selected the clip would turn every stray click into a selection change the
  timeline did not ask for.
- **The Text tool edits only the selected layer.** Single click on the
  selected box enters editing; every other click creates. Cheapest, and wrong
  in the commonest case — clicking a title you meant to edit stacks a new
  placeholder on top of it.
- **Hit-test under the tool, for the tool's kind.** While the Text tool is
  armed, a click resolves against Text layers only; a miss creates. Under
  every other tool the canvas stays inert.

## Decision

- **The Text tool owns the click.** `toolStore` gains a third radio tool,
  `text`, beside `select` and `blade`. It changes what a *preview* click does
  and nothing about the timeline, which behaves as under Selection. Each tool
  names the surface it changes; the store is one radio group because a user
  holds one tool at a time.
- **The hit test is scoped by tool and kind.** `preview/textHitTest.ts`
  resolves a point against Text layers in span at the focused playhead,
  topmost first (the compositor's track order), through the gizmo's own
  geometry so a click lands in exactly the rectangle the gizmo would draw.
  Locked and disabled layers, and layers on locked or disabled tracks, are
  transparent to it — the tool cannot edit them, so reporting them would turn
  a click into a refusal. A miss is empty frame. No other kind is tested, and
  nothing is tested under any other tool: the preview is not a selection
  surface, it hit-tests for a tool that asked.
- **The gizmo goes display-only under the tool.** Its box and handles still
  draw, so the selection stays visible, but they take no pointer input
  (`data-inert`); every press on the frame reaches the one hit test. This is
  what makes "click text to edit it" true for the selected layer too.
- **Creation reuses the menu's path and differs in position alone.**
  `add_text_layer` gains optional `x`/`y`, the anchor point in composition
  pixels (ADR 0049 — a Text layer's position names its anchor), so the
  factory's centred anchor centres the text on the click. Both or neither:
  half a point is refused at the boundary, ADR 0049's `(null, set)` rule. The
  layer exists before the editor opens; a phantom editor that created on first
  commit was rejected because it needs a second copy of the text defaults in
  the renderer, which is the drift ADR 0049 removed. Two history entries,
  creation and first edit, exactly as menu → double-click → type.
- **The editor's open state is a store.** `textEditingStore` names the layer
  being edited, in `pathEditingStore`'s shape, because the request now comes
  from outside the gizmo and may name a layer whose gizmo has not mounted. The
  double-click and the Edit text button write the same store. The store also
  stamps the pointerdown that closes an editor from outside, so the tool —
  which sees the same event afterwards — can decline to create under it.
- **Exit follows the Blade.** The tool stays armed after a creation. Escape in
  the editor cancels the draft; Escape outside it returns to Selection, with
  the listener mounted by the preview overlay while the tool is armed, not by
  the timeline. `T` arms the tool (Premiere's Type key); the display-mode
  toggle that held `T` moves to `Shift+T`, because a tool switch is a reflex
  and a view toggle is not.

## Consequences

- A second frame-coordinate tool (a pen, a crop) follows the same shape: its
  own overlay, its own kind-scoped hit test, the gizmo inert under it. What it
  must not do is widen the hit test to every kind — that is the first shape
  above, refused for the same reason it always was.
- Drag-to-box is the reserved branch: creation happens on the *release* within
  a click's slop, so a drag past it can later draw a Fixed box (`box_w`/`box_h`)
  without changing the click's meaning.
- The tool is unavailable on a project with no layers, because the preview
  mounts no canvas until something is staged, and inert while the preview is
  pointed at a composition other than the focused one — the gizmo's guard, for
  the gizmo's reason.
