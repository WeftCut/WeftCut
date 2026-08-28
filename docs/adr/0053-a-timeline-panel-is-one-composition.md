---
status: accepted
---

# A timeline Panel is one composition

## Context

The editor looks at one composition at a time. `compositionScopeStore` names it,
a breadcrumb says how you got there, and entering a Group swaps the timeline,
the inspector, the Playhead Panel and the preview together. That model has one
shape of failure, and it is the one editors hit first: **you edit inside a Group
and cannot see what it does to the film.** The preview follows the open
composition, so the moment you enter a Group the film is off screen. Checking a
lower-third build against the shot under it means leaving, looking, and going
back — once per adjustment.

Three facts make a larger answer available than "add a second preview".

**The Compositor already recurses.** `CompositionRefSprite` renders a Group's
composition into its own texture and the parent stages it as one flat image, so
rendering the root *while* editing inside a Group needs no rendering work at
all. What stops it is only that the preview reads the open composition.

**The time mapping already exists.** `compositionWalk.ts` carries `offsetUs` —
"where the composition's own `t = 0` sits in root time" — and a `refPath` naming
the `CompositionRef` layers walked through. The export Worker and the Compositor
both run on it. The arithmetic for "scrub inside a Group, watch the film" is
written and tested.

**The Dock already tabs.** A Dockview group holding N Panels *is* a tab strip,
and dragging a tab out of it *is* a side-by-side split. A composition tab bar
built inside the Timeline Panel would be a second tabbing mechanism standing
next to the one the Dock already runs, and would put a title row inside a Panel
whose title is its dock tab.

What blocks all three is one line of the Panel catalogue: *"Panel identity is
the semantic kind: no second instance id exists anywhere above the Dockview
adapter boundary."*

## Decision

1. **A timeline Panel is one composition.** Its Dockview id is
   `timeline:<compositionId>`; `timeline` alone stays the kind, which still
   carries the title, the size minimums and the placement rules. At most one
   Panel per composition — a second would show byte-identical tracks, since a
   composition has one set of them. Every other Panel keeps kind-as-identity;
   `timeline` is the only kind that instantiates.

2. **One moment, many coordinate systems.** `playheadStore` holds a single time
   expressed in ROOT time, and each timeline Panel projects it into its own
   composition through that Panel's entry path. Dragging any Panel's playhead
   reverse-projects and writes the same store. There is no second playhead: a
   Group's read-out is a projection of the one moment, which is why scrubbing
   inside a Group moves the film, and why a Group not on screen at the current
   moment simply draws no playhead. The playback engine is untouched — it still
   reads one number, and only that number's unit changed.

3. **The preview names its own render target.** The Preview Panel carries the
   choice: *follow focus* (the default) or a fixed composition. Fixed is not a
   property of a timeline tab, so the target may be a composition with no
   timeline open at all — the screen can hold one Group's timeline and the whole
   film's picture. After Effects' locked viewer, minus the second viewer.

4. **The editing target is a Panel, and it is passed, not read.** A creation op
   takes its `compositionId` from the Panel that caused it: a drop from the Panel
   it landed on, a shortcut or menu item from the focused Panel. The wrappers in
   `ipc/compositionScoped.ts` that read a module-level store today stop reading
   it and require the argument. The ops already carrying a `trackId` need
   nothing — a track id names its composition, so those were never ambiguous.

5. **Each tab anchors one `CompositionRef` instance.** Root-to-local projection
   is unambiguous — two placements of one Group are rarely on screen at the same
   moment — but local-to-root is not, and that is the direction a scrub inside a
   Group travels. The tab remembers the Group clip it was entered through;
   opened by id (a search hit, the media pool) it takes the shortest path from
   the root. Where a composition is placed more than once the anchor is
   switchable from the tab's context menu.

6. **Layout geometry and composition intent persist in different documents.**
   `workspaces.json` is one document across every project and holds reusable
   profiles, so a project's composition uuids may never enter it: on
   serialization every `timeline:*` Panel folds back to the single `timeline`
   slot, which records where the timeline row sits and how large it is. Which
   compositions are open, which is the render target, and each tab's zoom,
   scroll and anchor live in the project's own `view.json`. Restore runs in that
   order — geometry first, the root timeline in the slot, then the remaining
   tabs from `view.json`.

7. **Open tabs are derived, not stored.** `view.json` records an *intent*; the
   Panels that exist are that intent intersected with the compositions the
   summary carries. Undoing the pre-compose that made a Group closes its tab;
   redoing brings the same uuid back, and with it the tab, its zoom and its
   anchor. `reconcileCompositionScope`'s fallback walk is replaced by this
   intersection.

8. **A layer still never changes composition by moving.** `CrossCompositionMove`
   stands. Two timelines side by side make the gap visible, so the drop is
   refused where the user can see it — no landing highlight, the reason in the
   status bar — and the gap itself is filled by a mutation of its own, whose
   first entry point ("add the selection to this Group") needs no second
   timeline.

## Considered options

**A composition tab bar inside the Timeline Panel.** Rejected in the context: it
duplicates the Dock's own tabbing, cannot produce a side-by-side split, and puts
a title row inside a Panel whose title is its dock tab.

**Multiple preview Panels — After Effects' comp viewers.** Each viewer costs a
decode session, a GPU texture budget and a share of the playback lease budget,
which is already the binding constraint on preview performance. One preview that
can name any composition covers the workflow that motivated this.

**Focus drives the preview, with no lock.** Rejected: the request is to edit one
composition while watching another, which focus-follows cannot express.

**A playhead per composition.** Rejected: under (2) the second read-out is
derived, and two authoritative times would need a rule for which wins when a
scrub in either moves the other.

**Frozen-frame context — the locked viewer taken literally.** The preview holds
the root's own moment and re-renders on each commit. Rejected: what is edited
inside a Group is usually an animation, and one frame does not show one.

**`timeline:<compositionId>` written into `workspaces.json`.** Rejected in (6):
that document spans every project and holds saved profiles, so a preset would
carry another project's uuids and "reset to my layout" would mean different
things in different projects.

**A layout snapshot version bump.** Unnecessary once (6) folds `timeline:*` back
to one slot: the persisted shape does not change, so existing snapshots stay
valid and nothing has to be read twice.

## Consequences

- The breadcrumb goes. `leaveComposition` / `leaveToCrumb` retire with it —
  under a tab strip, leaving is closing a tab or activating another — and
  `openGroup` becomes "ensure the tab exists, activate it", which is the
  adapter's `openPanel` contract already.
- `playheadStore`'s value changes unit. Every reader — the ruler, the timecode,
  snapping, keyframe placement, the range, follow-playhead — is either read in
  root time or projected, and each one has to say which.
- Focus regions multiply: `scope: "timeline"` resolves to the last focused
  timeline Panel rather than to the one timeline.
- The word *workspace* now spans both halves of one feature — the Dock Workspace
  holds the geometry, the project workspace directory holds `view.json`.
- The cross-composition gap stops being invisible. Two timelines side by side
  invite the drag `CrossCompositionMove` refuses, which is what makes filling it
  worth doing.
