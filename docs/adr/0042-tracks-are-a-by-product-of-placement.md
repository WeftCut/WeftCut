---
status: accepted
---

# Tracks are a by-product of placement, not an object the user manages

## Context

Three mechanisms already decide track structure without the user asking. A fresh
project ships a non-removable A-roll / B-roll skeleton, so "no tracks exist" is
never a case the UI has to handle. Every `add_*_layer` command resolves its own
lane — `pickFreeOverlayTrack` reverse-scans the non-reserved tracks for a free
interval and appends a new one when nothing is free. And deleting the last layer
on a removable, role-less, unlocked track removes the track in the same history
entry, so one undo restores both.

The human surface stops at the eye and the lock. `add_track` / `remove_track` /
`move_track` are implemented, undoable and exposed over MCP, but the renderer
calls `add_track` only from its e2e hook, and the `"+ Track"` locale string has
no reader. The plan of record was to fill that gap in the obvious way: an
always-visible add affordance, insert-above / insert-below, move-up / move-down
or drag-reorder, and a confirmation for forced deletion of a non-empty track.

An audit of what a user actually cannot do found the gap somewhere else. Track
*management* is not missing — three specific inconsistencies are:

1. **The drop path never spawns a lane.** Placement validity is
   `valid | collision | locked`; there is no "make room" outcome. The same clip
   auto-spawns a track through the command path and is refused outright when
   dragged onto occupied timeline space, with no escape hatch.
2. **Auto-spawn manufactures duplicate names.** All five auto paths pass the
   literal `'Overlay'`, so three auto-spawned tracks read identically in the
   header. The reserved skeleton has the same shape one level worse: `'A roll'`
   and `'B roll'` are English literals written into the project file, so they
   cannot be localized — the Chinese copy has to quote the English name.
3. **Moving a layer off a track never cleans up.** The move path calls the prune
   that only sweeps `transient` tracks, and nothing in the codebase ever sets
   `transient`. It has always been a no-op. The prune that *can* remove a plain
   emptied track is wired to deletion only.

## Decision

### Amendment: whole-track ordering in All Tracks (2026-10-02)

All Tracks exposes a grip on each track header and four menu actions: move up,
down, to top and to bottom. Dragging inserts the whole track between existing
rows, including above, between and below A/B. A roll and B roll are reference
rows, not movable sources. Locked tracks and tracks containing a locked clip
cannot be moved. Audio tracks can be arranged too; order does not change mixing.

The operation is the existing `move_track`, now also wired as a renderer
command. Track identity, name, flags, view height, every clip's timing and
content, links and transitions survive; there is one history entry. The actor
rejects a locked track or locked member before changing anything. The drag
highlights the entire row, including expanded keyframe lanes, identifies its
clip count, and draws a destination line without reflow. Edge scrolling runs
while the pointer rests at the viewport edge. Escape, pointer cancellation,
leaving All Tracks, hiding the timeline or a changed row-id list cancels it.

These ordering controls are absent in A/B Roll; the existing Playhead Panel
continues to restack clips. Both views show the same persisted z order.

Creation still happens through placement at the top strip or Move to a new
track. To place a single clip between tracks, move it to a new track, then
reorder that track. No clip drop targets are added between existing lanes and
no empty-track creation step is required. All Tracks reveals the created row
vertically, preserving the horizontal time window and selection. Menu sorting
also reveals the moved row. This supersedes the original no-reorder surface
and repeated-raise-only statements below.

### Amendment: explicit deletion and clearer drop affordance (2026-10-02)

User feedback revises the original restriction on human track removal: the
header's context menu now offers **Delete track and clips** for every lane except
A roll and B roll, identified by role rather than by its displayed name. The
renderer issues one `delete_track` command with `force: true`; track removal,
clip removal, link cleanup and duration autofit share one history entry. One undo
restores them together. Legacy audio/caption roles are also deletable.

Creation still happens through placement. The idle drop-strip landmark is an
insertion arrow rather than a plus, with the localized hint **Drag a clip here to
create a track** on both halves of the strip. Release feedback and geometry stay
the same. This amendment supersedes the no-human-removal statements below;
the original rationale is retained as historical context.

### Amendment: optional cleanup (2026-10-02)

General settings → Timeline now offers **Automatically delete empty tracks**,
persisted as `auto_delete_empty_tracks` in app_settings.json and defaulting to
true, including for older files without the field. This supersedes item 6 below:
users can preserve emptied tracks across projects. The explicit track-deletion
surface added above gives them a way to remove those tracks themselves.

The preference gates the shared cleanup predicate for all editing paths and
dry-runs. Reserved and locked tracks retain their protections. Changing the
preference does not sweep existing empty tracks or enter project history; an
edit and any cleanup it performs still undo together.

### Original decision

The user places media; tracks appear and disappear around that. There is no
human entry point for adding, removing or reordering a track.

1. **One placement policy, inherited by the drop path.** "No free lane, so make
   one" stops being an internal detail of the command path and becomes the
   placement policy itself. A permanently reserved 12–16 px strip sits above the
   topmost lane — no header, no content, lit only during a drag — and accepts
   both a media-pool drop and an existing-layer drag, spawning one new track at
   the top of the z-stack. The space is reserved in flow rather than overlaid, so
   a drag never reflows the timeline under the pointer.

2. **Z-order is rearranged by repeatedly raising to the top.** The top is the
   only spawn point: a lane below A-roll composites underneath it and is
   invisible unless A-roll has a gap, which makes a bottom entry point a lie.
   Any permutation composes from a sequence of raises, and each raise leaves its
   source track empty, which now prunes it. A registry command,
   *Move to a new track*, is the non-drag equivalent — palette and menu, no
   default binding — so the operation is reachable from the keyboard, which a
   drag gesture alone is not.

3. **`label === null` means the name is derived.** One rule for every track.
   Non-reserved tracks derive a positional number; reserved tracks derive from
   their `role`, which is what makes them localizable. A rename writes `label`;
   clearing the rename field writes `null` and restores the derived name. The one
   exception is the track that `separate_audio` creates, which keeps a stored
   `"<source> (audio)"` — that records which source it was lifted from, and the
   display layer cannot recompute it once the layer has moved on. The exception is
   earned only when the source *has* a stored name to quote: once the reserved
   lanes derive theirs, the common case has nothing to record, and quoting main's
   idea of a derived name would write back the untranslatable literal this rule
   removes. A nameless source yields a lifted lane that derives its own name.

4. **Every non-reserved track is `transient`,** including one an agent creates
   explicitly. The field's meaning widens from "import-created holding track" to
   "not part of the reserved skeleton".

5. **One prune, one sentence.** The two prune functions with divergent
   predicates collapse into a single `empty && transient && !locked`, wired to
   both deletion and movement, and the project-wide sweep is deleted. The
   semantics are exactly: *a track disappears when its last layer leaves it.* A
   track that was born empty was never emptied, so an agent's explicitly created
   lane is never swept out from under it.

6. **`auto_delete_empty_tracks` is removed.** Its only purpose was keeping an
   emptied lane around to drop something else into, and an empty lane has no
   function in this model — the strip is always there, and a lane with room
   still accepts a direct drop. Left in, it is a switch that walks the UI into a
   corner: turned off, empty tracks accumulate and nothing can remove them.

## Considered options

**Build the add / remove / reorder surface.** Rejected on model, not cost: it
teaches a second mental model — declare a container, then put something in it —
when placement already decides containers. An add button is a thing the user
would have to learn and never needs.

**Let the drop path keep refusing.** Leaves dragging permanently weaker than
the command path, and dragging is the human route while commands are mostly the
agent's.

**Keep drag-reorder on the track header.** Ordering moves to the Nearby panel
instead, which already lists non-reserved layers by proximity to the playhead
and renames them in place; adding a z-ordered mode there fits "operate on the
media" better than dragging lanes. It needs one thing this decision does not
provide: Nearby currently sorts by playhead span and start time, not by z-order.

**Keep the project-wide sweep and warn agents in the tool description.** A rule
an agent must stay vigilant about is worse than a stated fact. Narrowing the
prune removes the failure mode, so the description states what happens
(*a lane disappears when it empties; place a layer rather than reserving one*)
instead of what to watch out for.

## Consequences

- Creating a track from the keyboard goes through *Move to a new track*, not a
  focusable add button.
- Ordering n overlapping overlays costs n−1 operations rather than one drag. It
  is a low-frequency operation.
- A lane an agent creates and never fills persists, and no human surface removes
  it — the agent's own `remove_track` does. This narrows unbounded accumulation
  from "every non-reserved track" to one class of agent-side bug.
- Derived positional names renumber: adding or pruning a lane turns the old V2
  into V3. Premiere and Resolve behave the same way.
- The empty-value semantics of rename differ between a track and a layer — a
  track reverts to its derived name, a layer abandons the edit. Deliberate: a
  track's derived name is a meaningful default, so the user needs a way back to
  it, and a layer has no equivalent.
- **A raise discards a name the user set on the lane it emptied.** Renaming a lane
  and then raising its last clip out of it deletes that lane, so the name goes
  with it and the clip lands on a freshly derived positional name, silently. This
  is accepted, not overlooked: under this model a lane name is a label on a
  by-product, and one undo restores clip, lane and name together. Premiere and
  Resolve never hit it only because they never delete a lane.

  Two repairs were weighed. Carrying the name onto the new lane is cheap but
  states that a label describing the old lane now describes a different one, and
  goes ambiguous the moment a multi-clip raise empties two named lanes. Exempting
  named lanes from cleanup is worse and is **rejected outright**: it makes a name
  a second pinning mechanism beside the lock, and since no human surface deletes
  a lane, named empty lanes would accumulate with nothing able to remove them —
  exactly the corner removing `auto_delete_empty_tracks` was meant to close.
- `remove_media --force` removes layers inline and deliberately calls no prune,
  so it can still strand an empty lane. Unchanged behaviour.

## Where this lives

The seams this landed on:

- Placement policy and the drop strip — `renderer/timeline/placement.ts` owns
  the `spawn` verdict and the `SPAWN_TRACK_ID` target that carries it;
  `DropStrip.tsx` is the row. The two event models reach it separately:
  HTML5 drag-and-drop through the strip's own drop handler, pointer drag
  through `hooks/useLayerDrag.ts`, which folds the strip into the same
  measured row list rather than the track-keyed lane registry.
- Pruning — `main/state/mutations/helpers.ts`, called from `delete.ts`,
  `move.ts` (both `applyMoveLayer` and `applyMoveLayersToNewTrack`) and
  `media.ts`.
- Derived names — `renderer/lib/trackName.ts`, the twin of `lib/layerName.ts`.
  **Renderer-side**, not beside `deriveTrackKindLabel` in main as first
  sketched: main holds no locale bundle, so a name computed there could never
  be localized, which is the point of deriving at all. Main emits an i18n key
  plus its interpolation values for history rows (`history-labels.ts`) so the
  two cannot disagree. Seven surfaces call it, not the three the audit found.
- *Move to a new track* — `commands/appCommands.ts` (a menu-only command id,
  since it has no binding) and one entry in `menu/menuSpec.ts`, over the
  `move_layers_to_new_track` op in `mutations/move.ts`.
- Renaming — `rename_track` in `mutations/tracks.ts`, driven from
  `timeline/TrackHeader.tsx` and `timeline/TrackContextMenu.tsx` through the
  one rename slot in `timeline/renameStore.ts`.

## Industry baseline

Premiere, Resolve and Final Cut all ship explicit track add / delete, and
Premiere and Resolve also ship drag-reorder. This decision deliberately does
not, because none of them has an equivalent of the reserved A/B-roll skeleton
plus kind-agnostic lanes: their tracks are typed containers a user must provision
before use, so provisioning has to be a user-facing operation. Where the
convention does carry over it is followed — positional lane names that renumber,
the top of the stack as the spawn point, and a spawn-on-drop gesture rather than
a mode.
