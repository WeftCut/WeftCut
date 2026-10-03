---
status: accepted
---

# Crop retains a source rectangle without changing transform

The first crop tool completes the reserved `VideoClipParams.crop` field. It is
a static retained rectangle `{ x, y, w, h }`, normalized against the original
source's untransformed display extent. `null` retains the entire source. Width
and height must be positive and the rectangle must stay inside `[0, 1]²`.
Authoritative writes quantize to nine decimal places and canonicalize full-frame
to null. This fills an existing field without changing the project format.

Crop controls visibility, not layout: it never changes the layer's source
window, position, scale, pivot or composition dimensions. Cropped pixels expose
the underlying composition. Auto-fill/reframe is a separate future operation.
The rectangle follows rotation, negative scale and flip about the existing pivot.
Normalized source coordinates keep quick proxies and export sources aligned.

Quick Panel and the VideoClip/preview context menus expose the same crop command.
The Quick Panel icon reports active crop editing; clicking it again or choosing
another tool exits. Entry pauses playback and seeks into the selected clip when
the playhead is outside it. Disabled, hidden or locked layers/tracks and a preview
target different from the focused composition cannot enter crop editing.
Context menus also offer reset, available only for a cropped clip.

The inspector has no crop section. There are no numeric fields, aspect presets,
settings dialog or temporary preview toolbar; the user chose direct manipulation
and reset as the entire UI. Only the retained rectangle is persisted. Normalized
storage at nine decimal places keeps subpixel precision independent of proxies.
Eight handles resize it, dragging the
interior translates it, and each completed drag is one recorded mutation.
Escape cancels the active drag; Enter or Escape outside a drag finishes editing.
The dedicated overlay replaces transform/path handles while editing and observes
the focused-composition, selection, track lock and visibility guards of ADR 0067.
Edge hit regions and handles use standard direction-aware resize cursors, including
rotated and flipped content.

Outside crop editing, the transform box encloses the retained visible rectangle.
Move/scale snapping, other-layer snap targets and centering use that same footprint.
The full source still defines the pivot and scale parameters: changing the crop
does not move the picture, rebase its anchor or rewrite transform keyframes.
Scale solves use each visible handle's offset from that original pivot. Media flip
flags remain separate from editable scale values and participate in all geometry.

The crop is the last filter on the video sprite, after its effect chain and
before the transition participant is captured. It still runs when preview effects
are bypassed. One cached filter per cropped layer instance uses Pixi's sprite
matrix to map filter samples back to normalized source coordinates, including
filter padding and nested render targets. Both shader backends multiply all
premultiplied RGBA channels by the same antialiased coverage; no CPU readback or
additional mask texture is needed. Antialias width is derived analytically from
the affine matrix and input pixel size, so GLSL 100 does not require derivatives.
Export uses the same filter and preserves the existing float16 filter pool.

This delivery is limited to static rectangular crops on video clips. Image and
Group crops, animated crops, feathering, arbitrary paths, effect masks and tracking
wait for concrete use cases. No general mask schema or path editor is introduced.

Validation covers the command/MCP surface, loaded project records, immutable
history, and source-space geometry. An Electron gate drags actual handles, checks
cancel/undo and transformed pixels, then decodes the exported video to verify the
retained centre and removed edges.
