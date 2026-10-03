---
status: accepted
---

# Layer locks protect content at the commit boundary

A locked clip must remain selectable so the inspector can display it and release
its lock. Previously a layer lock mostly suppressed timeline gestures: ordinary
property, effect, visibility and delete commands could still change it. Track
locks and layer locks therefore gave different answers depending on the entry.

`layerEditLock` is the shared rule: a layer or its owning track being locked makes
its content read-only. Selection, inspection and lock controls remain available.
Names, visibility, parameters, effects, keyframes and structural edits require
unlocking. A lock-only patch can change the layer flag even on a locked track;
an unlock bundled with content changes is refused. Both locks must be clear for
content edits. This replaces the former exception for layer visibility.

Direct mutation helpers use `checkLayerEditable`. The actor also compares the
before/after state at both commit and dry-run boundaries, before history or
broadcast. Protected layers cannot change, disappear, change tracks or have
their links/transitions changed indirectly. Immer structural sharing skips
unchanged compositions and tracks. A mixed batch fails atomically. UI and MCP
therefore cannot disagree about whether the same write is allowed.

The inspector propagates a read-only context to edit controls, including custom
pointer controls, effect actions and Motif frames. Disclosure headers remain
usable. Keyframe drag, tangent and easing edits use the same eligibility rule.
The backend remains authoritative for delayed edits and stale UI state.

Locks protect placed layer content, not shared source files, composition settings
or history navigation. Undo/redo and project loading still restore snapshots;
copying a source without modifying it remains possible. Existing operation-specific
refusals (for linked moves, ripple, groups) retain their more precise messages.
