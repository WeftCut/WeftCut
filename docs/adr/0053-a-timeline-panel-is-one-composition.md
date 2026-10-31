---
status: accepted
---

# A timeline Panel is one composition

Date: 2026-09-17

## Context

Entering a Group swapped the timeline, inspector and preview together, so the
film left the screen exactly when an editor needed to see what the Group did to
it. The pieces for a better answer existed: the Compositor already renders a
Group into its own texture inside the root, `renderer/render/compositionWalk.ts`
already maps a composition's `t = 0` into root time, and a Dockview group of N
Panels already is a tab strip that splits side by side. The blocker was the
Panel catalogue's rule that Panel identity is its kind. A second constraint
bounds the design: each preview costs a decode session, a GPU texture budget
and a share of the playback lease budget, already the binding limit on preview
performance.

## Decision

1. **A timeline Panel is one composition**: Dockview id
   `timeline:<compositionId>`, at most one per composition. `timeline` is the
   only kind that instantiates; every other Panel keeps kind-as-identity.
2. **One playhead, in root time.** `playheadStore` holds one moment on the
   root's clock; each timeline Panel projects it through its entry path, and a
   scrub in any Panel reverse-projects into the same store. A Group not on
   screen at that moment draws no playhead. The playback engine still reads one
   number.
3. **One preview that names its target**: follow focus (default) or a fixed
   composition, which need not have a timeline open. Export always renders the
   root.
4. **The editing target is passed, not read.** A creation op takes its
   composition from the Panel that caused it; the `ipc/compositionScoped.ts`
   wrappers require the argument.
5. **Each tab anchors one `CompositionRef` instance**, because local-to-root
   projection is ambiguous when a composition is placed more than once. Opened
   by id, a tab takes the shortest path from the root; the anchor is
   switchable from the tab menu.
6. **Geometry and intent persist apart.** `workspaces.json` spans every project
   and holds reusable profiles, so composition ids never enter it: every
   `timeline:*` Panel folds back to the single `timeline` slot. Open tabs, the
   preview target and each tab's zoom, scroll and anchor live in the project's
   `view.json`. Restore runs geometry first, then tabs.
7. **Open tabs are derived**: `view.json`'s intent intersected with the
   compositions the summary carries. Undoing a pre-compose closes its tab; redo
   brings it back with its zoom and anchor.

## Consequences

- No breadcrumb: leaving a Group is closing or switching a tab.
- Every playhead reader (ruler, timecode, snapping, keyframe placement, range,
  follow-playhead) states whether it reads root time or a projection.
- `scope: "timeline"` resolves to the last focused timeline Panel.
- Two timelines side by side make cross-composition drags possible; that
  crossing is `move_layers_to_composition` (features.md § Groups).

Rejected: a composition tab bar inside the Timeline Panel (duplicates Dock
tabbing, cannot split); multiple preview Panels (decode/GPU/lease budget);
focus-only preview (cannot watch the film while editing a Group); a playhead
per composition (two authoritative times need a tie-break); a frozen root frame
as context (a Group edit is usually an animation); composition ids in
`workspaces.json` (profiles would carry another project's ids).
