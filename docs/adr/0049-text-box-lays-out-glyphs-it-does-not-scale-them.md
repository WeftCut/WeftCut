---
status: accepted
---

# A text layer's box lays out glyphs, it does not scale them

Date: 2026-08-21

## Context

Text is the only visual kind with no intrinsic size. Its gizmo box was the
measured glyph bounds, so resize handles could only write `scale_x/y`, and
Pixi scaled the rasterized glyph atlas: enlarging a title enlarged its
letters, and the inspector's font size was advisory. Lines never wrapped
except at explicit `\n`, which machine transcription does not produce. Pixi's
wrap unit is a space-delimited token, so an unspaced CJK sentence never wraps
at all, and `breakWords: true` splits Latin words.

## Decision

- `TextParams` has a layout box `box_w`, `box_h` (composition px, before
  `scale`). Handles write the box; `scale` stays whole-layer scaling (After
  Effects' division). The font size reaches the frame as authored.
- **Mode is read from nullability, no enum:** `(null, null)` Auto width (no
  wrap), `(set, null)` Auto height (wraps), `(set, set)` Fixed (wraps,
  shrinks). `(null, set)` is refused at the state boundary
  (`mutations/params.ts`) and coalesced to Auto width by `TextSprite`.
  Neither field is animatable — a keyframed box would rebuild the glyph atlas
  every frame; `scale` animates.
- **Shrink-to-fit is derived in the renderer, never stored.** Fixed shrinks
  the glyphs to the largest whole-pixel size that fits (canvas measurement
  only), floored at an absolute 8 px (`TEXT_BOX_MIN_PX`), below which the
  text overflows and is flagged. The factor also scales outline width, shadow
  offset/blur, leading and tracking. State keeps only the user's size: an MCP
  `content` edit never passes through the renderer, so a stored shrunk size
  would be stale on the next word.
- The position stays the **anchor point** for Text (top-left for other
  kinds): in Auto width the box is still the measured bounds and moves with
  the content.
- **CJK breaking** overrides the realm-global static
  `CanvasTextMetrics.canBreakWords` (breakable if the style says so or the
  token contains CJK), installed unconditionally in the `Compositor`
  constructor — every realm that rasterizes text, the export Worker included,
  builds one. Gating it on the preview-only font branch is the defect
  `e2e/electron/text-box-cjk-export.spec.ts` catches.
- One default factory, `textParamsDefault` (`mutations/add.ts`): centred,
  Auto width, `"Liberation Sans, Noto Sans SC"` (bundled). Imported captions
  get `box_w = comp_w × 0.84` (the 8 % safe-area margin of
  `subtitles/layout.rs`) and `box_h = null`.

## Consequences

- Fixed means the text fits; overflow is shown only at the 8 px floor. Auto
  height narrower than a glyph overflows horizontally instead of shrinking.
- `anchor_y` places the box against the position; `valign` places the text
  inside the box.
- The inspector reads the derived size through `GizmoProbe.textFitOf`.
- Absent fields deserialize as Auto width, so old projects render unchanged.

Rejected: handles writing `scale` (the defect); removing `scale` from Text
(breaks keyframes and every transform path); an explicit mode enum (can
contradict the numbers); storing `effective_size_px`; overflow-and-mark for
Fixed; unifying Text's position onto top-left (centred Auto-width text would
drift as typed); `breakWords: true` (splits Latin).
