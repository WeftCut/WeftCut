---
status: accepted
---

# A focus region is a Panel, DOM focus always lands on one, and that is what scopes the keyboard

Date: 2026-08-05

## Context

No main surface was focusable, so focus was either parked on a text field the
user had visually left or dropped on `<body>`, where nothing owned the keyboard.
Gesture handlers (gizmo, curve graph, transition chip, splitters, layer block)
correctly call `preventDefault()` on `pointerdown`; a cancelled `pointerdown`
suppresses the compatibility `mousedown` whose default moves focus, so clicking a
gizmo never blurred — and never committed — the field being typed in. Four ad-hoc
mechanisms (`captureGlobal`/`fireWhenEditing`, racing capture-phase Delete
listeners, selection mutual exclusion, blur-to-body) answered "who owns this
key", and the Delete listeners had drifted (one ignored text fields and ate the
keystroke).

## Decision

- **A region is a dock Panel root**: `tabIndex={-1}` + `data-focus-region={kind}`
  in `WeftCutPanelRenderer` (`workspace/DockWorkspace.tsx`). Separate from
  `data-panel-kind`, which tabs also carry. `-1` keeps regions out of the Tab
  order; their focus ring is suppressed (Dockview's active-group tab already
  shows ownership).
- **Release = a capture-phase `pointerdown` on `window`** (`useFocusRegions`,
  mounted once in `main.tsx`) that focuses the region when the press lands on
  non-focusable Panel content. Only window capture runs before the gesture
  handlers' `preventDefault()` (React's root listeners are later). Focusing the
  region, not `blur()`, gives the keyboard a real owner; the field's blur-commit
  follows from the native focus transfer.
- **`data-focus-group`** marks a composite field (`AppInput`'s clear button,
  `AppTimecodeField` segments, number steppers) so a press inside it is not
  "outside the field" — otherwise every timecode segment click would commit.
- **Escape in a field** reverts (widget-owned: `AppNumberField` restores
  `lastCommitted`; `AppInput`/`AppTimecodeField` take `onCancel`) and releases
  (always). The release is deferred with `setTimeout(0)`: a blur landing before
  the field's own Escape handler would commit the discarded value, and a
  microtask is too early because Chromium can checkpoint microtasks between the
  window capture listener and React's root listener. Inside a dialog, menu or
  listbox Escape closes the widget instead.
- **`ActionDef.scope?: readonly PanelKind[]`** gates dispatch on `activeRegion`,
  **strictly**: a scoped action yields (without `preventDefault`) whenever the
  region is not listed, `null` included. `activeRegion` is the last `focusin`
  region and does not reset on `focusout`; `null` means focus left every Panel.
  Unscoped = global (transport, seeking, marks, tools, save/export).
  `TIMELINE_SELECTION` (`["timeline"]`) scopes the selection edits, grouping,
  link toggles and the `Alt+Arrow` nudges (one key moves keyframes or slips
  audio, and the keyframe subject is a timeline sub-selection);
  `resyncAudioToVideo` stays global.
- The remaining capture-phase Delete preemptor (the selected transition chip)
  must reproduce the dispatcher's stand-down rules; it shares
  `subSelectionDeleteYields` (`timeline/subSelectionDelete.ts`). Keyframe
  precedence lives inside `deleteSelected`.
- `focus/focusRegion.ts` must not import `panelRegistry` (it pulls in i18n and
  breaks suites that partially mock `react-i18next`).

## Consequences

- No gesture handler participates in releasing focus, so new ones cannot
  reintroduce the parked-field bug.
- Tests rendering a Panel component in isolation must declare the region before
  driving a scoped shortcut; a lenient gate would be untestable there.
- Delete with the Attribute/Effect panel focused does nothing (Premiere/Resolve
  are strict too); widening `TIMELINE_SELECTION` is a one-line change.
- Dockview's `activePanel` (tab activation) and `activeRegion` (keyboard owner)
  stay independent; coupling them would let a tab click steal a field mid-edit.
- Dragging a native scrollbar releases (and commits) a field; wheel does not.
- Gates: `focus/useFocusRegions.test.tsx`, `timeline/subSelectionDelete.test.ts`,
  `shortcuts/useShortcuts.test.tsx`, `e2e/electron/focus-regions.spec.ts` (real
  click and cancelled `pointerdown`, which jsdom cannot model).
