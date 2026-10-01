---
status: accepted
---

# Editing gestures do not navigate the playhead

## Context

Three different paths let editing move the editor's moment:

- Every keyframe diamond called its focus/seek callback at pointerdown, before
  the gesture could be distinguished from a click. With the real transport,
  pressing a key at 1 s immediately moved a playhead parked at 0.5 s.
- Transition edge resizing copied the earlier trim pause/seek/restore pattern.
  Ordinary seek published the preview time through the engine's time callback;
  restoring on release hid the final displacement but not the movement during
  editing. Both edges reproduced this. Clip trim already used preview seeks.
- Ruler and mini-timeline scrubs removed window listeners only on pointerup.
  Cancellation, Escape or window blur could leave seeking active during later
  pointer movement. Ruler regressions reproduced all three interruptions.

Stopping event propagation does not address these paths: the seek is either
intentional code in the edit handler or a previously registered window listener.

## Decision

1. **Resolve click intent before navigation.** `useKeyframeDrag` owns selection,
   focus and click/drag arbitration for all diamonds. Selection and focus happen
   on press. Navigation is an `onClick` callback, invoked only on release while
   travel remains below 3 px. Crossing the threshold latches drag intent even
   when the pointer comes back, moves only vertically, or the edit is clamped.
   Cancellation never navigates or commits. Alt retiming uses the same path.
   This changes left-press timing only; ADR 0051's right-click behavior stands.

2. **An edit preview is a lifecycle, not a seek helper.** `useEditPreview` owns
   capture of the parked root moment, pause, preview-only seek, and restoration.
   Clip trim and transition resizing both use `show`/`end`. Callers pass times
   on the active preview's clock, as before. Engine preview mode suppresses time
   publication, including delayed notifications. Release, cancellation and
   unmount restore the monitor; cleanup from a replaced transport cannot seek
   the new transport. The old one-shot `transportPreviewSeek` is removed.

3. **Pointer listeners have an owner and an end.** `usePointerGesture` owns the
   window listeners for keyframe retiming, transition resizing, ruler scrubbing
   and mini-timeline scrubbing. It filters by pointer id and separates release
   from cancellation. Pointercancel, Escape, blur, replacement and unmount all
   remove listeners. Only release may commit an edit; cancelled scrubs leave
   the last intentionally sought position and stop following the pointer.

4. **Keep edit logic separate from navigation.** Drag arithmetic and preview
   state do not call ordinary seek. Ruler and mini-timeline scrubs intentionally
   navigate. New gestures with window listeners should use the shared lifecycle;
   new temporary frame previews should use the edit-preview interface.

## Audit and evidence

The renderer's pointer/drag entry points were cross-checked against playhead
store writes, transport seeks and navigation callbacks. This is an audit of
unintended playhead movement, not a claim that every drag lifecycle is migrated.

| Surface | Finding / verification |
| --- | --- |
| In-clip numeric and colour diamonds; numeric graph and colour sub-lane diamonds | Same eager navigation defect; now share click arbitration. Real-engine integration tests cover all four surfaces. |
| Keyframe Alt time scaling | Same gesture path; covered with a two-key selection. |
| Transition left/right resize | Preview feedback defect reproduced on both edges. Real-engine tests cover release, pointercancel, Escape, blur and unmount. |
| Clip head/tail trim | Previous fix remains valid; existing real-engine tests pass through the shared edit-preview lifecycle. |
| Ruler / mini-timeline | Seeking is intentional, but abandoned listeners leaked. Interrupted-scrub tests and pointer-ownership tests cover cleanup. |
| Clip move/copy, cross-panel/media drops, marquee, marker drag, audio sample-region selection/resize | No edit-time seek path found. Existing interaction/gesture tests retained. |
| Curve tangent handles, inspector number/slider edits, transform/path handles, preview pan, ordering and panel/track size drags | No navigation or playhead-write path found in the drag handlers. They edit values, previews, ordering or layout. |

Real-engine tests assert the parked time during the gesture, not merely after
release. A seek-only mock would miss the engine-to-store feedback that caused
the trim and transition failures. Tests also preserve click-to-key navigation,
no-op edits, dragging back to the origin and normal ruler scrubbing.

## Limits

These interfaces centralize the rules at the affected call sites; TypeScript
does not prohibit an unrelated module from importing the navigation transport.
Future gesture changes still need behavior tests at the transport seam.
This audit used automated DOM integration and source inspection, without a
manual Electron interaction pass. Other gesture-specific cancellation rules
and composition/preview clock mapping remain separate concerns.
