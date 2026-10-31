# Features

The concrete behavior of each editor capability: what the user sees, the
rules, and the edge cases. Subsystem mechanics live in the linked docs; the
record shapes in [data-model.md](data-model.md); the agent surface in
[mcp.md](mcp.md).

## Undo-stack scope

A state mutation records a `HistoryEntry` iff it changes the timeline
structure of the loaded project — layers, tracks, markers, transitions, links,
Groups, role gains, or layers cascade-deleted by a media removal. Everything else
broadcasts a non-recorded `ChangeEvent`. Unrecorded patches are applied to
**every** stored snapshot, checkpoint and the review baseline, so no revert
path undoes them.
History lives in `apps/desktop/src/main/state/history.ts`; per-op routing in
`state/actor.ts`.

| Actor op | Recorded? |
|---|---|
| layer, track, marker, transition, link and Group edits; `rename_track`; `set_role_gain` | yes |
| `move_layers_to_new_track` | yes — **one** entry: the new track, every moved layer and every source track it emptied |
| `update_track_flags` (eye / M / S / lock), `update_role_flags` | no — undo never flips a track or role control |
| `add_media_item`, `set_media_workspace_paths`, `set_media_derivatives`, `set_media_hash` | no |
| `remove_media` with no referencing layers | no — mirror of an import |
| `remove_media { force: true }` with referencing layers | yes — the cascade is `delete_layers`' delete |
| `update_project_settings` (incl. `shot_review`, `pause_review`) | no |
| `set_composition` (any field, incl. `fps`, size, `duration_us`, `duration_pinned`), `fit_composition_to_layers` | **no** — project setup; the patch runs as a transform per snapshot (`History.replaceCompositionEverywhere`), so each snapshot refits/re-snaps against its own content |
| passive duration shrink on delete / inward trim (unpinned) | rides the edit that caused it |
| `replace_state` (open / new project) | no — resets history to one entry, drops checkpoints and the lock |
| `undo`, `redo`, `jump_to { index }` | cursor-only |
| `restore_checkpoint`, Revert all (review baseline) | yes |
| `create_checkpoint`, `delete_checkpoint` | no entry and no `project:changed` broadcast; a surface listing checkpoints refetches itself (the History panel does) |

Because canvas changes cannot be undone, Settings → Project → Canvas opens with
**Lock canvas settings** on; resolution and rate are inert until it is turned off,
and turning it back on abandons an in-progress size edit.

**The rate lock is history-scoped.** An `fps` change lands in every snapshot, so
it is refused (`FpsLockedByContent`, `locked_by: current | history`) if the live
timeline *or any snapshot or checkpoint* holds a layer
(`History.storedSnapshotsHoldLayer`); otherwise undo would bring back layers
authored on the old grid. The rate is settable only on a project whose timeline
has never held anything; the escape is to empty the timeline and reopen the
project. The settings panel disables the control from `composition.fps_locked`.

**User vs agent.** Both write one `History`; entries carry `Actor::User` /
`Actor::Agent { client }` for the History panel, and Ctrl-Z walks across both.
While `set_history_lock { locked: true, reason }` is held, every revert path —
`undo`, `redo`, `jump_to`, `restore_checkpoint`, Revert all — fails with
`HistoryLocked`; edits still record, and checkpoint create/delete is not gated.
The lock is released by `set_history_lock { locked: false }` (any connection),
the Agent panel's Unlock, the owning connection disconnecting or its work
session ending, or a project swap.

## Timeline selection

The clip selection is a set plus a **primary** — the clip the Attribute panel
and the gizmo follow (`renderer/state/selectionStore.ts`). Invariants:
`primary === null ⇔ set is empty`, and `set.has(primary)`. A layer selection and
a selected transition chip are mutually exclusive, so Delete and the Attribute
panel always have one kind of target.

**Clicks.** A plain click on an unselected clip replaces the selection
(taking its link, per [Links](#links)); pressing an already selected clip keeps
the whole selection for a group move and makes it primary. `Shift+click`
**toggles** the clip (and its link). `Alt+click` selects one member of a link.
Right-click on an unselected clip selects it; inside a multi-selection it keeps
the set and makes the clicked clip primary, so single-clip actions (describe,
shot review, pauses) target the clip under the cursor while batch actions keep
the set. A deselecting `Shift+click` never arms a drag. Every selected clip has a
1 px accent border; the primary a 2 px pale-blue border, painted above clip
previews.

**Locks protect edits, not inspection.** A locked clip (or one on a locked
track) can be selected under the same rules, to reach its lock toggle; it never
arms move, trim, duplicate, blade or sample-region gestures. An amber badge marks
it (tooltip: clip vs track lock); dragging it shows a forbidden cursor and pulses
the badge. The lock covers all clip content — name, visibility, timing, params,
effects, keyframes, deletion, link/transition changes; inspector controls go
read-only. Renderer and MCP share the actor, whose commit and dry-run boundaries
refuse indirect changes too; a failed batch changes nothing. Lock-only patches
work even on a locked track; unlocking and editing are separate operations.

**Select All / Deselect All** (`Mod+A` / `Mod+Shift+A`) are timeline-scoped
([ADR 0041](adr/0041-focus-regions-are-panels-and-scope-the-keyboard.md)) and stand
down inside text fields. They are not on the Edit menu (the handlers live in the
Timeline Panel, which alone knows which tracks are rendered); the search palette
lists them. Select All **respects the A/B Roll filter** and **excludes locked
clips** rather than refusing; a surviving primary is kept. Deselect All clears
clips, the transition chip and the keyframe selection.

**Delete** takes the clip selection verbatim as one undo entry; it never fans out
over a link (the selection already carries the link).

**Move** drags the whole selection plus active link partners as one undo entry,
keeping offsets on each clip's own grid; the earliest member stops the set at
zero. Vertical movement shifts visible members by the same number of displayed
lanes; hidden link partners keep their lanes. An occupied or locked destination,
a locked member, or a lane offset past the displayed lanes refuses the whole
drop. A transition authorizes only its own pair's exact overlap, so a pair moved
together keeps its transition. Onto the drop strip, all members must fit on one
new lane.

**Marquee.** Dragging from blank space draws a box; **the surface the press
started on decides what it selects**, fixed at pointer-down: a track lane or the
track viewport's background selects clips; a keyframe sub-lane row selects
keyframes; a ruler press is a scrub. The selection is recomputed from scratch
on every move (shrinking releases clips); Escape restores the press-time
selection; release keeps the last result. The box auto-scrolls horizontally
only. A clip box **intersects** (a clip longer than the viewport cannot be
enclosed) and is slice-aware on combined A/V rows. It respects the A/B Roll
filter and excludes locked clips like Select All, takes whole links (locked
members included, as a click would), and keeps a surviving primary.
Anchors are a whitelist: a surface opts in with `useMarqueeAnchor({ kind })`.
Clip x comes from `t_start_us`/`t_end_us × pxPerSec`; row y is measured from
the DOM per event, because a y-table from track heights drifts by a row per
expanded keyframe sub-lane. Rules: `renderer/timeline/marquee.ts`; gesture:
`timeline/hooks/useMarqueeAnchor.ts`.

**Additive gestures are deliberately asymmetric.** `Shift+click` toggles; a
marquee replaces. A `Shift`-marquee, if added, must **union** — two XOR boxes
would cancel. Until then, sweep then `Shift+click` to trim.

**Background clicks** clear per kind: blank lane space drops clips and the
transition chip; blank sub-lane space drops only keyframes. The band below the
last track is clip surface (clicking clears; a box can start there).

**Gaps.** The one blank space that *selects* is a gap — the empty span on a lane
between two clip boundaries. It highlights with the clip outline, and `Delete`
closes it ([Ripple delete](#ripple-delete)). A gap is read off every clip on the
lane regardless of class (on a combined A/V row, space under a picture whose
audio half is empty is not a gap). The space before the first clip is a gap from
composition time 0; the space after the last clip is not, nor is blank space on a
locked lane. A gap selection has no id: it is re-derived on every summary and
dropped as soon as the span stops being exactly that gap. Right-clicking a gap
offers only *Ripple delete*.

**Keyframe selection** is a set across layers and properties. A box tests each
diamond's drawn centre — both axes in an expanded row, x only in a collapsed row
(one glyph covers ~40 % of its axis). Sweeping clips drops the keyframe
selection. Every whole-selection operation — Delete, easing choice, retime drag,
nudge, paste — is one undo entry. With several keys selected the easing menu
shows no current value. Right-clicking a selected diamond acts on the whole
selection without moving the playhead; an unselected one is selected first.

- **Drag** moves the selection by one shared delta snapped once to the frame
  grid. The group stops at the tightest `[0, duration]` wall of any selected
  key (each in its own layer). Unselected neighbours are not walls; a moved key
  landing on a stationary key's frame replaces it.
- **`Alt`-drag on an end key** scales the selection in time about the opposite
  end (scale, then snap). The factor is floored so selected keys stay ≥ 1 frame
  apart and capped by the drag walls; it needs two distinct selected times.
- **`Alt+Arrow`** nudges one frame, `Alt+Shift+Arrow` ten. With no keyframe
  selected the same keys slip the selected audio ([Links](#links)). Delete, Copy
  and Paste dispatch the same way (keyframes when any are selected, clips
  otherwise); Settings → Keyboard prints that rule under each action.
- **Copy/paste** share one slot with the clip clipboard. A keyframe copy is a
  snapshot grouped by property, rebased so the earliest key is at zero. Paste
  puts it at the playhead on **every selected clip**, matching by property name;
  properties the target lacks are skipped and named on the status bar. A Static
  target becomes Keyframed with **only** the pasted keys; a Keyframed target
  keeps its keys and pasted ones replace what they land on. Keys past the
  target's end are kept.

Not implemented: anchor-to-click range selection and "select forward on track"
tools.

## Editing never moves the playhead

Editing gestures leave the playhead where it is parked. A keyframe diamond
selects and focuses on press but seeks only on a release that travelled less
than 3 px (`keyframe/useKeyframeDrag.ts`); crossing 3 px latches drag intent even
if the pointer returns, and a cancel neither seeks nor commits. Trim and
transition-edge resizes show their frame through `state/useEditPreview.ts`
(pause, preview-only seek without publishing time, restore on release, cancel or
unmount). Window-listener gestures — keyframe retime, transition resize, ruler
and mini-timeline scrubs, track-height drags — go through
`hooks/usePointerGesture.ts`, which removes listeners on release, pointercancel,
Escape, blur and unmount; only a release commits. Ruler and mini-timeline scrubs
are the gestures that navigate. New window-listener gestures use
`usePointerGesture`; new temporary frame previews use `useEditPreview`.

## Keyframe curves

Focusing a property expands its sub-lane into a value graph with one tangent
handle per side of every Spline key. Dragging a handle reshapes that side live
and commits one undo step on release. An Auto side (what Smooth asks for) draws
greyed; grabbing it takes it over. A Smooth key keeps both sides at one slope; a
Broken one lets them differ; right-clicking a handle switches.

Right-clicking a key or segment opens the easing menu — Linear, Hold, three
everyday eases, Smooth, and the preset library — applied to the whole keyframe
selection in one undo step, each row previewed while armed. Smooth is not baked:
an Auto key re-solves when a neighbour moves. On a track's first/last key the
menu adds Extrapolate before/after — Hold (default), Loop, Ping-pong, Offset,
Continue. The extrapolated stretch draws dashed to the clip's ends, with a mark
beside the end key (↻ ↔ ⤴ →). Glyphs: diamond = linear, square = hold,
circle = eased. Record: [data-model.md § Animated values](data-model.md#animated-values);
editor mechanics: [render.md § Keyframe easing authoring](render.md#keyframe-easing-authoring).

## Colour keyframing

A Text layer's glyph colour and a Color layer's fill are animatable. In the
inspector the colour row has a stopwatch: off, a swatch or eyedropper pick sets
the static value; on, it keys at the playhead, and the swatch shows the resolved
colour there. Turning it off freezes the colour on screen. Colours interpolate
in OkLab.

The sub-lane draws the track as a gradient strip (one sample per screen pixel
across the clip) with diamonds over it. Selection, marquee, retime, delete,
copy/paste, the easing menu, presets and extrapolation all apply; there is no
value graph or tangent handles (a colour has no single axis). The expanded row
header carries a compact swatch and keyframe navigator. Shadow and outline
colours are static.

## Links

A `Link` is a project-level set of member `LayerId`s — a layer is in at most one
link, no nesting. Moving, trimming, splitting or duplicating a member fans the
edit out to the others; everything else (keyframes, opacity, gain, delete) stays
local. A link has no rendering significance; it means "these travel together".
One mechanism serves auto-paired A/V and manual bundles. "This is one thing" is
a *Group*, not a link ([CONTEXT.md](../CONTEXT.md#links-and-groups),
[ADR 0052](adr/0052-link-propagates-group-composes.md)).

**Fan-out rules** — any single op can bypass them with `escape_link: true`:

- **Move** applies the time delta to every member; the track change applies only
  to the targeted layer. Refuses if any member would overlap or leave the
  composition. Toward the origin the link stops as a set (the earliest member
  lands on 0, spacing kept); each member then re-snaps on its own lattice, which
  preserves an A/V slip.
- **Trim** propagates only to members whose corresponding edge is at the same
  exact `t` (recomputed per op), with the delta clamped so no member crosses its
  source bounds or inverts.
- **Split** cuts every member spanning `T` (source windows follow) and
  **partitions the link at the cut**: left halves keep the link id, right halves
  get a new link, a non-spanning member joins its temporal side, and a side left
  with one member is unlinked. Under Link override (or `escape_link`) only the
  target splits; its left half stays linked and its right half is free.
  `split_layer` takes an `at_t_us` array and applies every cut in one commit. The
  shot-apply discard (§ Shot review) is the one place a delete travels a link.
- **Duplicate** (`paste_layers`) clones every member handed to it and links the
  clones to each other, never to their sources, as one undo step. Other clones
  keep their offset from the seed and snap on their own lattice; only the seed
  changes track. A locked or occupied destination for any member refuses the
  batch.
- **`enabled`** changes only the inspected clip (inspector) or the selected clips
  (`set_layers_enabled`); it never adds unselected members. A locked member or
  track refuses the whole set.
- **Raise to a new track** (`move_layers_to_new_track`) moves exactly the layers
  it is handed onto one fresh lane. *Move to a new track* (command) names the
  selection and no time — every clip keeps its time. A drag into the drop strip
  names the drag's subjects and the landing under the pointer; members hold
  their phase to the anchor and all change lane.
- **Locks refuse the whole op:** a fan-out touching a locked member or a member
  on a locked track fails with `LinkLockedMember` / `TrackLocked`.

**Invariants** (validated every commit): every member resolves to a layer; no
layer is in two links; a link dissolves below 2 members in the same commit;
`create_link` / `update_link` refuse an already-linked layer unless
`reassign: true`, which moves it.

**Import auto-pair.** With `auto_pair_audio_on_import` on (default), importing a
video source with audio creates a `VideoClip` plus a linked `Audio` layer over
the same span. `VideoClip` itself emits no audio; the paired `Audio` layer is the
audible one.

**UI.** Clicking a member selects the whole link; `Shift+click` toggles by link;
`Alt+click` selects only that layer and `Alt+trim` escapes that trim. Body
`Alt+drag` duplicates the **whole link** (one ghost per member, one
`paste_layers`, one undo); `Alt+click` a member first to copy it alone. A
collision on any member shows the drag invalid. *Enable / Disable N clips* in the
clip menu sends exactly the selection in one `set_layers_enabled` (mixed or all
disabled → Enable; all enabled → Disable); a locked clip or track disables the
row with a reason. The inspector's Enabled switch affects only the displayed
clip. Linked layers show a 2 px left accent in a hue derived from `link_id`.
`Mod+L` toggles link ↔ unlink: a selection inside one link unlinks it; two or more
unlinked layers link; anything else greys with the reason. It is also in the
Quick Actions `edit` section.

**Link override.** `Alt+Shift+G` (also a Quick Actions toggle and a palette
row) is a session switch standing in for a held `Alt`: every site that consults
links treats them as absent — click selects one member, drag moves or
duplicates one, blade and `Mod+B` split one, marquee takes what it touched. The
status bar shows `Links off` and link accents dim to 40 %. Nothing is written:
memberships stay, no history entry, not persisted. MCP is unaffected (agents
pass `escape_link`).

**A/V sync offset.** An audio member slipped off its video (audio is on the
48 kHz lattice — [audio.md](audio.md)) has an offset **derived from geometry,
never stored**: `audio.t_start_us − video.t_start_us`, measured in samples so the
~10 µs lattice residue at 29.97/59.94 does not read as a slip. A non-zero offset
shows as a badge on the audio clip (`+3 smp`, `−2.00 ms`). A whole-link move
preserves it; a video trim does not drag slipped audio (edges no longer
coincide). `Alt+←/→` slips the selected audio one sample, `Alt+Shift+←/→` one
millisecond (48 samples), `Alt+Shift+S` re-syncs it to its video — all commands
(palette, Settings → Keyboard, agent-callable). Pointer drags never reach sample
precision (one sample is 0.042 px at the 2000 px/s ceiling); the inspector's
audio fields switch units (timecode / ms / samples); the ruler stays frame-based.

Mutations: `apps/desktop/src/main/state/mutations/links.ts`, with fan-out in
`move.ts` / `trim.ts` / `split.ts`. Agents read links from `project://current`
(no list tool).

## Groups

A *Group* is a composition placed as one layer — a precomp / nest
([ADR 0052](adr/0052-link-propagates-group-composes.md)). Its params are a
`CompositionRef`: a source window `[src_in_us, src_out_us)` in the composition's
own time, plus transform, opacity and blend. At rate 1, parent time `t` maps to
`t − t_start_us + src_in_us` (a retimed Group scales it — [Retime](#retime));
nesting composes. Pre-compose, ungroup, add to
Group and move to another composition are each one history entry and are the
only ops that cross a composition boundary.

**Pre-compose** (`groups_create`; MCP `create_group`; `Mod+G`) turns one or more
layers of one composition into a Group in place. The set's earliest start `t0`
becomes the new composition's zero (members shift by `−t0` on their own
lattices; keyframes are layer-local). The composition copies the parent's
settings and has reserved A roll / B roll; source tracks map bottom-up onto A
roll, B roll, then fresh lanes, preserving z-order. Links fully inside move with
ids intact; a straddling link loses its inside members (dissolving below two).
Transitions between two members move; a straddling one is dropped by reconcile
and logged. Markers stay in the parent. The Group layer lands at `t0` on the
top-most former lane, windowed over the whole composition, or — if that span is
taken — the nearest free lane above, else a new top lane. Emptied lanes are
pruned. A locked member (`GroupLockedMember`) or track (`TrackLocked`) refuses
the whole set.

**Ungroup** (`groups_ungroup`; MCP `ungroup_layer`; `Mod+Shift+G`) puts members
back in the parent at the same on-screen time. Allowed only on a **plain** Group
layer — identity transform, static opacity 1, no effects, Normal blend —
otherwise `GroupNotPlain { reason }` names the field (those apply to the
composite and have no per-member equivalent) — and only at rate 1. Members intersecting the window
are copied in at `t + t_start_us − src_in_us`, trimmed to the window (source and
keyframes follow); members outside are dropped. Non-empty composition tracks
become fresh lanes at the Group layer's z position; inner links and transitions
carry over under fresh ids. The Group layer goes and the composition is removed
unless another Group layer references it.

**Add to Group** (`groups_add_members`; MCP `add_group_members`) moves timeline
layers into an existing Group clip that is their sibling in one composition.
Each member lands at `t − t_start_us + src_in_us`, re-snapped, so it keeps its
screen position; a member outside the window arrives as overhang. The Group clip
must be at rate 1. It delegates to Move to composition, below.

**Move to another composition** (`move_layers_to_composition`) moves a set into
a named destination at an absolute landing time on the destination's clock; the
root is an ordinary destination (taking clips out of a Group). The anchor member
lands at the time; others keep their phase to it, so a transition between moved
members survives. Each member re-snaps on its own lattice. The landing is
absolute because the renderer's mirror lags the actor: Add to Group computes it in
main from the live project, a drag in the renderer from the pointer; a
`base + delta` over the mirror would eat the previous commit. Links and transitions follow the set, markers
stay, emptied source lanes are pruned, both compositions autofit, and no Group
layer is retrimmed. Refusals, all before the first write: set spans two
compositions (`CrossCompositionSet`); locked member or lane (`GroupLockedMember`,
`TrackLocked`); a member whose composition already reaches the destination,
including the destination itself (`CompositionCycle`); landing before time 0
(`InvalidArgument`, naming the earliest landing the whole set clears — never
clamped); unknown destination or lane (`CompositionNotFound`, `TrackNotFound`);
destination = current composition (that is `move_layer`). Add to Group adds:
target not a Group layer (`WrongLayerKind`) or not a sibling of the set
(`CrossCompositionSet`).

**Lane assignment** is per *source track* (a whole track's members travel onto
one lane, keeping transitions alive), bottom-up onto existing lanes, spawning past
the end. When the preferred lane is locked or occupied, a caller that named no
lane **bounces** (nearest free lane, else a fresh one); a caller that named one is
**refused** (`TrackLocked`, `LayerOverlap`); naming the destination's drop strip
always takes a fresh top lane. Menus bounce (no ghost); drags refuse (a bounce
would make the ghost lie).

**Move to… ›** (clip context menu) lists the root first, then every Group by
name. Destinations that cannot take the selection stay listed but greyed with
the reason (already there; would contain itself). A row whose composition has no
reading of the current moment lands at its start. The trigger greys when nothing
is selected or a member or lane is locked. Each row's landing is that
composition's reading of the current moment through the visible placement,
resolved again at commit. The anchor is the earliest member. Afterwards the
selection clears and the view stays. The Edit menu, palette and keybinding form
(unbound by default) is **Move to timeline**: it means the root and greys when
the selection is already there.

**Dragging between timeline Panels** commits the same operation; the destination
Panel owns the drop (zoom, grid, snapping and lanes are per Panel). The clip
stays under the grab point; what travels is a duration. The destination draws
its own ghost (kind colour, name, footprint at its zoom; no filmstrip, waveform,
link chrome or transition chip), red over an overlap, amber over a locked lane,
where release sends nothing; over its drop strip it spawns a lane. A successful
drop takes focus and selection with it. **Alt+drag across Panels is refused**
with a status-bar reason (copying into another composition would be a second
mutation); the same drag without Alt moves.

**Overhang.** A Group window may extend past its composition's duration:
validation sets no upper bound on `src_out_us`, a trim gesture clamps to the
duration, and past the end the Group renders nothing. This keeps deletes inside a
Group from being refused by a parent's window. Autofit is per composition:
content growing inside (including via Add to Group) does not extend existing
Group windows.

**Single lattice.** Every composition's `fps`, `sample_rate` and `channels`
equal the root's (`CompositionLatticeMismatch`); width and height may differ.

**Naming and removal.** `groups_rename` (MCP `rename_composition`) sets or clears
a composition's label (the root has none). `compositions_delete` (MCP
`delete_composition`) removes an unreferenced composition, else
`CompositionInUse`. Orphans are legal: deleting a Group layer leaves its
composition.

**UI.** A Group clip has lucide's `Group` glyph, a neutral slate surface, and
the name: its own `label`, else the composition's label, else `Group N` (the
composition's stored `ordinal`, localized like `Track N`; naming one Group
renumbers none). Its thumbnail is the earliest video inside (searching nested
Groups); none → glyph only. It is otherwise an ordinary visual layer (overlap
classes, Playhead panel video bucket, effects, gizmo) and keyframes `transform`
and `opacity`. At its right edge a **hatched tail** marks the window past the
composition's end; a **2 px tick** marks a window shorter than the composition.

`Mod+G` pre-composes the selection and selects the new Group clip;
`Mod+Shift+G` ungroups the one selected Group layer (two commands: their
preconditions are not inverses). Each greys with its reason (nothing selected,
locked member, the field blocking ungroup). Both are in the Edit menu, Quick
Actions `edit` section and palette. `Open group` and `Add to Group` are commands
shipped unbound. Add to Group appears on the menu opened over the target Group
clip as `Add to “Name”`, and greys with its reason: no Group clip selected, two
of them, nothing to add, a locked member, or a clip starting before the Group
(nowhere to land).

**Entering.** Double-click a Group clip or use `Open group`. Renaming is in the
menu: `Rename` (clip label) and `Rename group…` (composition name). The
composition opens in its **own timeline Panel**, a tab beside the one it was
entered from; one Panel per composition, so reopening activates the existing tab
([ADR 0053](adr/0053-a-timeline-panel-is-one-composition.md)). The tab shows the
name, its tooltip the route (`‹project› › Group A › Group B`); drag it out for
side-by-side timelines. A Group placed more than once offers `Switch instance`
on the tab menu to choose the placement its times are read against. Empty
timeline space is tinted one step per nesting level. Switching tabs drops the
selection, marked range and inline reveal, but not the moment or display mode.
The inspector's Group section shows the composition's name, frame size,
duration and the same buttons.

**One moment.** There is one playhead, a time on the root's clock. A Group's
timeline draws that moment shifted by its clip's placement, so scrubbing inside
moves the film and vice versa. `Home`/`End` inside a Group go to the Group's
ends. A Group whose clip is not on screen now draws no playhead, but edits at the
playhead still work. An orphan composition has no reading of the moment and
scrubs on its own axis.

**Preview target.** The Preview Panel draws *Follow focus* (default — the
timeline holding the keyboard) or a fixed composition chosen from the root and
every Group, so the film can stay on screen while editing inside a Group. A
target the project loses releases back to Follow focus. Export always renders
the root.

Open timelines, each one's zoom, scroll and entry anchor, and the preview lock
persist **per project**; Dock geometry is app-wide.

A clip inside a Group is findable in the search palette; activating it opens
the Group first. Undoing a pre-compose while inside the new Group closes its tab,
returns focus to the parent timeline and reselects the layers.

**Reuse and orphans.** A composition is a card in the media pool (sorted with
the files by name), with the Group glyph, duration and reference count. Dragging
it places another instance (`add_group_layer`); two instances at different
offsets show different frames. A composition may be placed in another Group but
never inside itself or an ancestor (the drop target greys). An orphan keeps its
card, dimmed and tagged isolated — the only place to open, rename, or delete it;
selecting it shows the composition in the inspector.

Mutations: `apps/desktop/src/main/state/mutations/groups.ts` over the crossing
primitive `mutations/moveToComposition.ts`.

## Retime

Video, Audio, animated images, Motifs and Group clips take a constant playback
rate ([ADR 0092](adr/0092-constant-time-remapping-preserves-content-windows.md)).
The inspector's Timing group stacks Start, Duration and a read-only End
(exclusive, Start + Duration, in frame or audio units); Start moves the clip and
Duration trims its out edge. Beneath them one **Retime** row holds a target
duration, a speed multiplier (a text button until clicked, then an input with a
trailing ×; Enter or blur commits, Escape cancels), *Reset to 1×*, and, for Audio
and Group clips, *Preserve pitch*. Both retime directly, without preview or
confirmation.

The selection is the whole batch; links never expand it, and a Group and its own
children cannot be retimed together. In a batch, *Preserve pitch* addresses only
the Audio/Group clips (showing their count) and shows a mixed state that enables
it for all when clicked. A retime keeps the start and the selected content, snaps
the new end to the clip's grid, and scales the clip's own keys and fades;
neighbours never move. Refusals (the local preview and the commit alike) name the
colliding clips and, when known, the maximum duration and approximate minimum
speed; a transition refusal names the transition. Only frame sampling is
available. A retimed Group can be entered and edited, but ungrouping it or adding
members needs rate 1. Agents: `retime_layers`, `set_preserve_pitch`,
`set_frame_interpolation`, `get_frame_interpolation_capabilities`
([mcp.md](mcp.md)). Code: `renderer/properties/RetimeFields.tsx`,
`renderer/retimePlan.ts`, `main/state/mutations/retime.ts`.

## Split at the playhead

`Mod+B` cuts every clip the playhead is inside — the Blade's keyboard half,
through the same `split_layer_linked` channel with `escape_link: false`, so
linked A/V cuts together. Also in the Edit menu, Quick Actions, clip context
menu and palette. Resolution: `apps/desktop/src/renderer/commands/splitAtPlayhead.ts`.

- **Selection first.** If the selection holds clips straddling the playhead,
  only those are cut; otherwise every straddling clip.
- **One target per link** — the linked split already cuts spanning siblings.
- **The sweep respects the A/B Roll filter; the selection does not** (A/B Roll
  hides role-less tracks; a selected layer was reached on purpose).
- **Locks are filtered out, not refused.** The one surviving refusal is a link
  straddling a locked track (`TrackLocked`).
- **Never disabled** — gating would subscribe Quick Actions to the playhead and
  re-render per frame. Over a gap it no-ops.
- N straddling clips are N commits and N undo steps.

## Ripple delete

`Shift+Delete` / `Shift+Backspace` removes the selected clips **and closes the
span they vacated**: everything after it, on every track of the composition,
moves left. Bare `Delete` is the lift. Both are in the Edit menu, clip context
menu (*Ripple delete* under *Delete*) and palette; ripple also has a Quick
Actions button. With keyframes or a transition chip selected the key falls back
to plain delete (Delete's precedence).

**The hole** is the clip's footprint clipped to its remaining same-class
neighbours on its own track: `[max(start, prev.end), min(end, next.start))`. So a
transition participant can be rippled (the overlap belongs to the partner), and
an existing gap beside the clip is not closed — it moves left with everything
after it. With no neighbours overlapping, the shift is the clip's length.

**Several clips.** The selection is removed first; each hole is measured against
what remains; touching or overlapping holes across tracks merge; every remaining
layer starting at or after a hole shifts left by the total length of the holes
ahead of it — one snap of the summed delta per layer on its own lattice, so A/V
slips survive. One commit, one undo.

**Who moves, stays, blocks.** A layer starting at or after a hole's end moves;
one starting before it stays, even if it spans the cut. An unselected layer
*starting inside* a hole refuses (`RippleInsideHole`; remedy: select it too). A
landing on a non-moving layer refuses (`RippleCollision`); a transition keeps its
overlap only if both participants shift equally; the system never makes room.
Locks block only if the locked layer or lane would move (`RippleLockedLayer` /
`TrackLocked`). **Origin exception:** when a hole starts at 0, a layer also
starting at 0 stays and does not refuse (a title over the head of the film stays
while the leading silence closes beneath); a linked partner of a deleted layer
gets no such pass.

**Links.** A linked set may have members before the hole and after it; that is
allowed — bringing the later pieces up to the earlier ones is the point. A member
that *reaches across* a hole (starts before it, ends after its start) while
another member of that link would move refuses (`RippleLinkStraddles`) — a J-cut
would drift off its picture. To remove one member of a link, `Alt`-click it.

**Transitions, markers, time.** A transition with both participants downstream
travels; at fractional rates its `duration_us` and borrowed tail are re-derived
from the landed overlap in frames. A transition losing a participant is dropped
by reconcile. Anchored markers follow their clips (a deleted clip's markers go);
free markers, the playhead and in/out stay at absolute times. Duration follows
the autofit rule ([data-model.md § Composition](data-model.md#composition)):
unpinned shrinks, pinned keeps its length. Inside a Group the Group's timeline
shrinks and parent windows are kept (overhang); in a parent a Group clip is one
body that moves or stays.

**Predicted, then enforced.** One pure planner (`renderer/ripple/plan.ts`)
computes the plan or the refusal. The actor applies it; the renderer runs it on
its mirror to grey the menu row, strip button and menu entry *with the reason*,
using the same wording the status bar prints for a real refusal. The actor stays
authoritative: an unpredicted refusal lands on the status bar. No toast, no
dialog.

**A selected gap** ([Timeline selection](#timeline-selection)) closes under
`Delete`, `Backspace`, `Shift+Delete` or its menu row: the gap is the hole,
nothing is deleted, every layer at or after its end moves left on every track.
Refusals are the same four (a clip on another lane starting inside the gap — the
remedy is to remove it; a collision; a straddling link; a lock that would move);
a gap on a locked lane always refuses. The span is sent as **both edges**; if it
is no longer exactly a gap when it arrives, the actor refuses (`GapNotFound`)
rather than re-measuring. History row: *Closed gap*.

**Agents:** `delete_layers { layer_ids, ripple: true }` and
`ripple_delete_gap { track_id, start_us, end_us }`. The internal
`split_layer_multi` op carries a `ripple` flag so a split plus closing the
discarded spans is one undo — what [Remove pauses](#pauses) and the
`/cut-pauses` prompt use.

Deliberately unbuilt: ripple trim, insert edits, per-track Sync Lock, rippling
free markers, and a parent rippling when a Group shrinks. Rejected: bare `Delete`
rippling (it stays the lift), same-track ripple (desyncs linked A/V on two
tracks), and sliding a layer that starts inside the hole (a B-roll cut for the
deleted clip would land on the previous one).

Code: `renderer/ripple/plan.ts` (planner), `renderer/ripple/gap.ts` (what a gap
is, for click, selection store and planner), `main/state/mutations/ripple.ts`,
`renderer/timeline/rippleEligibility.ts`, `renderer/errors/formatCommandError.ts`.

## Track placement

**Tracks are created by placing content**: the drop strip and *Move to a new
track* are the creation paths. In **All Tracks** mode, whole tracks reorder by
dragging a header grip to an insertion line or via the header menu (up, down,
top, bottom); A/B tracks stay as reference rows that other tracks move around. A
locked track, or one holding a locked clip, cannot move. Reordering audio rows
does not change mixing. A drag highlights the row and its clip count, keeps row
geometry stable, auto-scrolls vertically, and is cancelled by Escape, pointer
cancel, mode/visibility changes or a change to the track order. One drop is one
undo entry, preserving track identity, attributes and every clip's timing. New
and menu-moved tracks scroll into view vertically without changing the time
window or selection. There are no clip drop targets between rows (move to a new
track, then reorder it). The header also offers *Delete track and clips*
(not on A/B tracks).

**A/B Roll** mode has no track reordering; the Playhead Panel's *Now playing*
stack arranges clips. It lists persistent reference rows for the reserved
A-roll, B-roll and caption tracks in track order, showing the current clip or an
empty placeholder (audio-role tracks excluded). References are read-only drop
targets, never drag sources, and survive gaps and category filters. Every listed
clip, linked or not, has its own row; restacking moves only the dragged clip,
above, between or below the references. A drag emits nothing until drop, then
one history entry; Escape/pointercancel cancel (`panels/playheadItems.ts`; wire
op `restack_layer` in [data-model.md](data-model.md#mutation-surface)).

**The drop strip** is a 14 px row above the topmost lane that turns a drag into a
new track at the top of the z-stack. Its space is reserved permanently (a row
appearing mid-drag would reflow under the pointer), and idle it is a dashed rule
with an insertion arrow in the header half — a seam, not an empty lane — lit only
during a drag. It accepts media-pool drags and clip drags (both e2e-gated:
`e2e/electron/timeline-drop-strip.spec.ts`, `timeline-raise-to-strip.spec.ts`). A
clip dropped on a lane with room lands there; spawning is the exception. The
strip draws a raise's preview (the only row without a lane to host it), and the
source lane lets go of the chip; the preview persists through the commit's round
trip so a released raise does not flash back.

The top is the **only** spawn point (a lane below A-roll is hidden unless A-roll
has a gap). A **raise** moves clips to the top; an emptied source track is
cleaned up. **Move to a new track** (palette, Edit menu, clip menu; unbound) is
the raise without a pointer, disabled when the selection would overlap itself
on one lane; it keeps every clip's time, while a drag lands where the ghost
showed.

**Automatically delete empty tracks** (Settings → General → Timeline, default on)
removes an ordinary unlocked track when its last clip leaves. Reserved and locked
tracks survive, a track born empty is never swept, and turning the setting on
does not sweep existing empty tracks.

**Track names** are automatic unless set: reserved tracks from their role, the
rest from a position that renumbers as tracks come and go. Double-click the
header name or use Rename; **clearing the field restores the automatic name**
(unlike a clip, where empty abandons the edit). A rename is undoable; eye and lock
are not. Raising a clip out of a renamed track that it empties discards the name
with the track; one undo restores all three.

Code: `apps/desktop/src/renderer/timeline/placement.ts`, `DropStrip.tsx`,
`hooks/useLayerDrag.ts`, `renderer/lib/trackName.ts`; mutations
`main/state/mutations/move.ts` (`applyMoveLayersToNewTrack`), `tracks.ts`
(`applyRenameTrack`), and the prune in `mutations/helpers.ts`. Cleanup predicate:
[data-model.md § Track](data-model.md#track).

## Timeline layout

The timeline stacks fixed rows (ruler, marker lane, review lane, add-track
strip — each a `TimelineFixedRow`) above one **track viewport**
(`timeline-track-viewport`), the only scroller, owning both scroll offsets. Fixed
rows follow horizontal scroll through `timelineScrollStore` with transforms,
without re-rendering tracks. Track decorations, cursors and height handles are
clipped inside the viewport so nothing can hit-test over the ruler (a shared
scroller once let a height handle steal ruler presses). One pointer-inert
playhead overlay (`TimelinePlayhead.tsx`) spans all rows. Drag destinations
resolve in `timeline/timelineDestination.ts`: the add-track strip owns only its
visible rect; track bands count only inside the viewport and outside the header
column.

## Timeline scrolling

The **bare wheel scrolls time**; **Shift+wheel scrolls tracks** (Premiere's and
Resolve's default). Settings → General → Timeline → *Mouse wheel scrolls* flips
the pair; *Across tracks* hands the unmodified wheel back to Chromium, keeping
platform smoothing. A trackpad's sideways swipe passes through untouched
(momentum intact). Ctrl/Alt+wheel is zoom. Pressing into an end stop does
nothing (no spill onto the other axis). Mapping: `renderer/timeline/wheelScroll.ts`
(pure); listener: `hooks/useWheelScroll.ts`. Nothing here writes
`timelineScrollStore`; the viewport's rAF-coalesced scroll publisher is its only
writer.

## Timeline zoom

**Ctrl+wheel** (or **Alt+wheel**) zooms continuously about the time under the
**cursor**. **`=` / `-`** step one doubling and hold the **playhead**; if the
playhead is off screen they hold the lane centre instead, and an on-screen
playhead stays on screen at every step. Range: ceiling 2000 px/s; floor =
**fit-to-project** (the project extent before post-roll padding exactly fills the
lane), recomputed per gesture. Pressing into a stop does nothing. Geometry:
`renderer/timeline/zoom.ts`; state and the `scrollLeft` write:
`hooks/useTimelineView.ts`.

The keys are bare `=`/`-`, not `Mod+=`/`Mod+-`: `hardenWindow`
(`src/main/windows.ts`) consumes Ctrl/Cmd +/−/0 at `before-input-event` to kill
Chromium page zoom, so a chorded binding would never reach the renderer. Both are
commands, **unscoped** (they zoom the timeline whatever has focus) and inert in
text fields.

## Preview zoom and pan

The wheel or a trackpad pinch over the preview zooms about the pointer;
two-finger scroll zooms like the wheel. Middle-drag pans under any tool. `Z`
(also View › *Fit preview to window*) returns to Fit, recentred.

The toolbar zoom readout is a menu: `Fit`, 25, 50, 75, 100, 150, 200, 300, 400 %.
A percentage is composition pixels per device pixel; `Fit` is a mode that
re-fits on resize. The wheel moves continuously beyond both ends, snapping to a
stop when close. *Zoom in/out preview* step the stops from the palette.

The Hand tool (`H`, beside Selection) pans by dragging for pointers without a
middle button; `Esc` or `V` returns to Selection. Both pan paths bound each axis
by the frame's edges (centred when it fits) and use pointer capture.

Zoom and pan are session view state: no clip, history or export change; changing
the preview's composition resets them.

## Follow playhead

The timeline **pages** to keep the playhead visible: when it comes within 12 px
of a viewport edge, the view jumps so it sits one lead (8 % of the viewport,
min 12 px) inside the edge it crossed. Paging writes `scrollLeft` once per
screenful instead of every frame. Forward pages leave a lead behind and a
near-full screen ahead; backward pages jump a full screen so the playhead lands
near the right edge (repeated step-backs don't re-page each press).

Playback and jumps (shortcut seeks, edit-point steps, timecode entry, palette
navigation) follow. A **ruler scrub** does not (the target would move under the
pointer), nor does **zoom**, which owns its anchor; the follow reacts only to the
playhead moving. App preference `timeline_follow_playhead` (default on; absent
reads as on): View → Timeline auto-scroll, `Shift+F`, Quick Actions, palette.
Code: `renderer/timeline/followPlayhead.ts`, `hooks/useFollowPlayhead.ts`.

## Markers

A marker names a moment: label, colour, note. It belongs to one composition and
is either **free** (its own time) or **follows a clip** — a field on the marker,
not a second entity: an anchored marker stores a layer of its composition plus a
time in that layer's *source*, and its `t_us` is re-derived from the clip every
commit. It travels with moves, trims, splits and crossings into a Group;
deleting the clip removes it (with a status-log row). `t_us` stays stored, so
every reader (lane, palette, export, MCP) reads one field. A separate clip-owned
marker kind was rejected: it would fork the lane, the palette, the summary,
serialization, MCP and validation. Record: [data-model.md § Marker](data-model.md#marker).

**The lane** is one 20 px row under the ruler, sharing its scroll quantization so
a glyph and its tick never drift. A point is an L (stem on the frame's left edge,
foot under the name); a region is a capsule across its range, degrading to an L
below `MARKER_MIN_REGION_PX` (tooltip keeps both ends). Anchored marks have a
tall stem / filled capsule; free ones a short stem / ringed capsule. Names print
beside a point or inside a capsule. `markers_visible` (`M`'s toggle in View
menu and Quick Actions) shows/hides the row; `M` force-shows it.

**Authoring.** `M` marks the playhead frame; pressing it on a marked frame opens
rename instead of stacking. No selection → a free marker; a selection → anchored
to the primary. A playhead outside the selected clip, or a kind with no source
window, falls back to free. Right-click a glyph for rename, delete, **Attach to
clip**, **Detach** (inapplicable rows grey). Dragging along the lane moves it
(one commit at release; snaps to clip edges and playhead; a no-op drag records
nothing). Dragging an anchored marker moves its anchor and clamps at its clip's
edges. Shot detection writes anchored markers.

**Hibernation.** Trimming a clip past an anchored marker *hibernates* it: kept,
not drawn, revived on exactly that frame when the window covers it again. It is
derived each commit, never stored, so undoing the trim wakes it. A region whose
clip ends inside it is drawn only to the clip's end; its stored span is kept.
Detach turns a mark into a free marker at its current time.

**Navigation.** `Shift+M` / `Mod+Shift+M` go to the next / previous mark start in
the focused timeline (a region merely spanning the playhead is not current);
neither wraps. Also palette commands and ruler menu rows. The palette searches
labels and notes and excludes hibernating marks.

**Marker Panel** (closed by default; View → Markers) lists every marker in the
project, grouped by composition, with label, colour and note editable in place;
activating a row opens that Group's timeline and seeks. Hibernating marks are a
separate last section, showing their footage position and offering Detach — the
only surface they appear on. A Group clip on the parent timeline shows a `⚑N`
badge counting marks inside it, nested ones included.

**Limits.** Time is read-only in the Panel (an anchored time is a cache the next
commit rewrites); the lane drag is the one way to move a marker. Regions drag
whole; their ends are not resizable. *Mark pauses* ([Pauses](#pauses)) is the
hand-reachable producer of regions. Child markers are never drawn on a parent's
lane.

## Shot review

The **Shots** Panel (View menu, or *Review shots…* on a `VideoClip` menu and in
the palette; closed by default) reviews shot detection before it lands.
Everything it shows is a pure reduce over ONE whole-source scan
([ADR 0057](adr/0057-shot-detection-is-one-floor-scan-and-a-pure-reduce.md)):
ffmpeg scores every frame once at a floor, and every later threshold is a cache
read.

**Subject:** the primary selected `VideoClip`. A cached scan renders instantly;
otherwise the Panel shows **Analyze** and never scans on selection alone (the
media pool's *Analyze shots* warms the same cache). The scan is one status-log
op; its failure stays inline.

**Rows**, one per shot: a cover frame, span and duration on the composition
clock, and — except the first — the candidate cut it opens on (score and the
frame pair either side). Clearing a candidate's checkbox merges the shot into
its predecessor (the boundary stays listed so it can be restored); merged rows
show no stats. Clicking a row seeks to the shot's start. A second checkbox,
**keep** (default on), marks a shot for discard.

**Measure shots** fills the stat cells (the floor scan is timing-only): three
sampled frames per unmeasured row for brightness, motion and a focus proxy, plus
black / freeze / fade flags — the same measurement `analyze_clip` reports. It
spawns an ffmpeg pass per shot, writes nothing to the project, and caches per
source span, so a re-press costs only reshaped spans. Merged rows are
measurable. It greys with a reason when nothing is left, while it runs, and
during an apply.

**The strip and the line.** A strip plots one tick per floor-scan candidate
(x = source time, y = score) with a draggable horizontal threshold; ticks above
it are the boundaries. Dragging re-runs the reduce live; the line cannot go below
the floor; it is also a keyboard slider. Nothing is labelled "sensitivity" (the
wire field reads backwards: higher = fewer cuts). **Minimum shot length** is a
separate ms field (output granularity, not accuracy). Both persist per project in
`settings.shot_review` (`null` = Rust's defaults) through the unrecorded settings
patch.

**Verbs**: *Split at cuts*, *Mark cuts* and *Split and discard unchecked* send
the same accepted-boundary list through one channel (the `apply_shot_cuts`
hybrid), so split, mark and discard land on identical frames. Each is one commit
and one undo. A greyed verb gives the reason (no interior boundary; nothing
unchecked; an apply running). Unchecking every shot is refused (that is a
delete). Two boundaries snapping to one frame are refused for discard, with the
remedy (raise the minimum shot length). No confirmation dialog; the status bar
reports Started → Ok/Err under one `op_id`. After a split the Panel reviews the
first segment (which keeps the clip's id); a discard that removes it selects the
first surviving segment (not its link partners). After a mark the review stays.
A discard also removes every other member of the clip's link overlapping a
rejected span (so paired audio goes with the picture); content wholly inside a
kept segment stays. The agent's `drop_short_us` has the same reach.

**Descriptions.** *Describe selected clip content* (VideoClip menu, Edit menu,
palette) runs `describe_clip` (purpose `clip`) over the whole clip. It does not
open the Shots Panel; progress and Cancel are on the clip's timeline job band and
the status surfaces. Clip content has its own section at the top of the Shots
Panel: it leads with the run's summary when one covers the clip's source range to
within 0.25 s at each edge (tightest first), then one *Details (N segments)*
disclosure — closed under a summary, open without one — whose list scrolls inside
`min(40vh, 18em)`; each line's timecode seeks through the source→timeline
projection, tags on hover. Optimistic segment updates withdraw overlapping
summaries until the read lands.

Shot rows show only shot descriptions. Per row, *Describe shot* (or *Describe
again*) runs a shot-sized window; the parameters row has *Describe N shots* for
undescribed rows. Shot runs write the `shot` description cache and whole-clip
runs the `clip` one; neither satisfies the other, so describing a clip does not
mark its shots described. The sweep is serial, becomes *Stop* (effective after the
shot in flight; cancelling that shot's job also stops it), and halts at the first
refusal. Only rows inside the running window say *Describing…*.

Undescribed rows read *Not described*. Each run is Started → Ok/Err under one
`op_id`, Ok naming engine, model and (per-shot) the shot. With no
video-understanding engine configured, the command opens Settings → Video
understanding; other refusals are the tool's sentence in the status log (and the
Panel's describe slot when pressed there). A run in flight greys every describe
control. Re-timed clips can be described.

Reading, displaying or indexing never starts inference: shot rows read
`media://{id}/shot-description`, the clip-content section
`media://{id}/description`. Both serve the engine, model file, sampling, focus and
**UI language** set in Settings → Video understanding (one value across
projects). All are cache-key inputs: changing one switches to another cached view
and keeps the old one (`descriptions/` is excluded from the disk-LRU sweep). Prose
is written in the UI language, so after a language switch everything reads *Not
described* until described again. Electron main injects `app_settings.language`
into both the tool and the resource read; the renderer pins the OS locale into it
on first launch. Descriptions are read-only here; the palette indexes clip-purpose
segments only.

Code: `renderer/shots/` (`shotsStore.ts`, `shotRows.ts`, `ScoreStrip.tsx`,
`ShotsPanel.tsx`); scan and reduce in `native/src/jobs/shot/` via
`analyzeShotsFloor` / `reduceShotReport`; verbs in `main/state/hybrids.ts` over
`split_layer_multi` (`discard_segments`) and `add_markers`. Descriptions:
`renderer/describe/`, `commands/describeCommands.ts`, `settings/VlmSection.tsx`
over `shared/vlm-config.ts`, `readMediaDescription` in `main/mcp/server.ts`;
output language in `native/src/vlm/sidecar.rs` and the cache key in
`native/src/vlm/description.rs`.

## Transcribe and voiceover

The speech operations the MCP prompts `/auto-caption` and `/voiceover` script
are reachable by hand through the same tools ([mcp.md](mcp.md)). Each hangs off
the object it acts on; there is no "AI" menu and no review gate.

**Transcribe selected clip** — `VideoClip` / `Audio` context menu, Edit menu,
palette; unbound by default. The clips are the selection and the engine detects
the language. Before the run, clips whose loudest peak is below −24 dBFS (or whose
levels cannot be checked yet) are logged and a *Check audio before
transcription* dialog offers Cancel, *Continue at original volume*, or *Normalize
and transcribe* (only this run's audio copies of the quiet clips, to a −3 dBFS
peak, at most +24 dB; media and timeline volume are unchanged). It acts on the WHOLE selection: every selected clip
with sound, in timeline order, one subject per source — a linked picture yields
to its selected same-media audio, and a source span selected twice is read once;
titles and captions are ignored. It runs `transcribe_clip` per subject, one at a
time, then one `apply_transcripts` (one commit, one undo; cues pack into existing
caption tracks where there is room — [captions.md](captions.md#ingestion)), and
reveals the Caption panel. Greyed with a reason: nothing selected, nothing with
sound, or a run already going. Re-timed clips are transcribed. On a failure it stops, lands the transcripts before it, and logs
the failing clip with the tool's sentence; when that sentence names Settings →
Transcription (no model, no API key) the command opens it. Cues are edited in
`CaptionsPanel`.

**Voiceover…** — Edit menu and palette only (it acts on no clip). The dialog
holds script, voice (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`), speed,
and where it lands: after everything (the tool's default) or at the playhead,
each shown as a timecode. The destination track is shown and sent explicitly.
The 4096-character cap is enforced in the field. `speed` is omitted at 1.0 (the
TTS cache keys absent and explicit speed apart, so sending it would re-bill an
agent's cached default). A cost line sits above the button (the one per-use paid
action); the content-addressed cache makes re-runs free. Tool refusals stay
inline with the dialog open.

Each run is two status-log rows under one `op_id`
([status-log.md](status-log.md)); rows carry script length, never the script.
Code: `renderer/speech/`, `renderer/commands/speechCommands.ts`;
`callClipComputeTool` in `main/mcp/server.ts`; the `clipCompute` route in
`main/state/router.ts`.

## Pauses

**Pauses** is an Attribute-panel section on any clip whose sound the
composition plays. It measures quiet stretches and offers two verbs — mark or
cut — with the timeline visible and playable.

**The subject is the layer that plays** ([audio.md](audio.md#pauses-read-what-plays)).
An `Audio` layer measures itself; a `VideoClip` delegates to the linked Audio
member sharing its media, else its link's only Audio member, and says so
(*Measured on the linked audio "…"*). A `VideoClip` with neither shows no section,
and *Detect pauses in selected clip…* greys with *This clip plays no sound*.

**Collapsed by default; expanding detects.** The body unmounts when collapsed
(no detection, no subscription). *Detect pauses in selected clip…* (clip menu,
Edit menu, palette; unbound) reveals the Attribute panel and expands the section.

**Parameters.** A preset dropdown: built-ins *Speech / podcast*, *Noisy room*,
*Music / ambience* (set threshold and minimum, keep the pad, clamped to fit) and
*My presets* (all three values). Manual edits show the source name with
*Modified*; an unmatched recipe reads *Custom*. **Threshold** is a dB slider
(−60…−20, 1 dB steps; amplitude is linear and unaimable). **Use suggested**
applies the clip's noise floor + 6 dB once and re-detects (tooltip previews the
value; disabled until measured); the line below the slider shows *Noise floor ≈
−48 dB* (`—` before measuring). **Minimum pause** is a ms field; **Keep per side**
is the pad *Remove* leaves, capped at `(minimum − 50 ms) / 2`, floored to the
50 ms step (the tools refuse `2 × pad ≥ minimum`). *Reset parameters to defaults*
restores detector values without touching presets. The detector's bridge (a
loud run under 80 ms does not end a pause — clicks, coughs) is a constant, not a
control.

**Personal presets** are app preferences across projects. *Save as preset…*
shows the three values; names are trimmed, case-insensitively unique, ≤ 80
characters. A changed recipe can be updated or saved under a new name; built-ins
cannot be overwritten. *Manage presets…* renames/deletes; deleting the selected
recipe keeps the values and shows *Custom*. Save failures keep the form. Main
applies each library edit atomically to the latest settings (concurrent windows
don't clobber). Projects keep copied values; library changes never propagate.
The working parameters persist per project in `settings.pause_review` (`null` =
detector defaults) through the unrecorded settings patch whenever a value
commits; measured floors, detections and audition state are not saved.

**Live re-detection** on a short debounce, latest run wins (a detection walks
pre-computed waveform peaks, no decode). It also re-runs on a new subject, when
the subject is trimmed, slipped or moved, and when an effect bake or waveform
lands. A missing waveform shows *Waiting for the waveform…* and retries. Peaks
come from the baked effect sibling when ready, else the raw media — so bands
match the drawn waveform, and a running bake falls back instead of refusing.

**Result.** *Found N pauses* and *Removes X · leaves Y* (seconds; exact times in
the tooltip). On the timeline, one band per pause on the subject's audio block:
faint amber for the whole pause, stronger amber for the core *Remove* cuts.
Nothing is drawn on the linked picture or the ruler. Nothing found → *No pauses
detected with the current settings*, both verbs grey.

**Audition result** stitches the surviving audio around the first three joins
from the playhead (or the clip start) out of the mixer's conform PCM, with ≥ 1 s
context each side, a 10 s cap and a 5 ms crossfade per join, and plays that one
buffer without touching the transport (seek-and-skip would depend on decode
timing). Pressing again, changing a parameter or subject, or collapsing stops it.

**Mark pauses** adds one region marker per pause (pad included) in the clip's
own composition, anchored to the subject ([Markers](#markers)) — trims hibernate
them, deleting the clip removes them. One commit, one undo. Pause marks are
amber, distinct from shot-cut blue.

**Remove pauses** cuts each pause's core out and closes the gap
([Ripple delete](#ripple-delete)). *Keep per side* stays at both ends; a pause at
the clip's head or tail keeps its pad only on the inner side. One commit, one
undo restoring the whole clip. A linked picture is cut with the sound; when a
frame-grid member shares the link, cuts are snapped to the composition's frame
grid first so both members cut at one instant (an unlinked audio clip keeps
sample precision). Touching cuts close as one hole. Refusals come before any
write: the ripple planner's four, each naming the blocking layer, and a clip that
is one pause end to end (a delete). They show in the section's error slot.

Both verbs re-detect at the current parameters inside their own call, grey
while a detection runs or the other verb commits, and log two rows under one
`op_id`; failures stay inline. Mark is the renderer-only `mark_pauses` hybrid (an
agent composes it from `detect_pauses` + `add_marker`); Remove is
`remove_pauses`, also an MCP tool.

Code: `renderer/properties/PausesSection.tsx`, `renderer/audition/`,
`renderer/state/pausePreviewStore.ts`, `renderer/timeline/PauseBands.tsx`; the
command and renderer subject rule in `renderer/commands/pauseCommands.ts`, the
main twin in `main/state/pauseSubject.ts`; hybrids in `main/state/hybrids.ts`;
presets in `shared/pause-presets.ts`.

## Global search palette

`Mod+K` (also a menu item) opens one search box over **commands**, **media**,
**Groups** (compositions), **tracks**, **clips** (by label), **captions / text**
(Text layer content — [ADR 0026](adr/0026-captions-as-text-layers.md)),
**markers** and **descriptions** (cached vision-model text and tags; § Shot
review). Commands execute; a Group opens its timeline; everything else navigates
(select, seek, scroll). A description row is one segment on one placement:
activating it selects the clip and seeks to the segment start; a source only in
the pool contributes none. The index holds only cached data — opening the
palette never runs a model. Navigating never changes play state. Chinese matches
by characters, full pinyin (`zimu` → 字幕) and initials (`zm`); commands also index
their en-US label. Not indexed: effect parameters, keyframe values,
project-settings values; no search history.

**Stale-but-instant index.** `project:changed` → 300 ms debounce → full rebuild
from `projectStore.summary` → atomic swap; queries always hit the last completed
index. Full rebuilds make sync bugs impossible; they cost single-digit ms on the
main thread (`buildEntries` is pure, so a Worker remains possible). Pinyin
haystacks are memoized per string.

**Ranking.** fuzzysort scores every haystack, keeping each entry's best, with a
floor against scatter matches and boosts for commands and exact prefixes.
Groups appear in fixed order — commands, media, Groups, tracks, clips, captions,
markers, descriptions — each capped with "show more". Pinyin matches are not
highlighted (indices don't map onto CJK chars). Media rows open a second level
(reveal in pool + one row per timeline usage); unused media and orphan
compositions are noted. Activation re-validates ids; a stale entry logs and
no-ops. Dependencies: `fuzzysort` + `pinyin-pro` (`cmdk` binds Radix; the app is
on Base UI).

Code: `renderer/search/`; commands from `renderer/commands/registry.ts` +
`appCommands.ts`; navigation in `renderer/state/navigation.ts`.

## Color picker (eyedropper)

One global pick session serves every colour field
(`renderer/colorpick/pickColor.ts`). At start it freezes the preview source
(composition, or a selected effect's input) and a `capturePage()` snapshot; hover
reads the frozen CPU buffers. `S` switches to desktop sampling: main captures
every display before showing any overlay, then shows one window per display with
the frozen screenshot, magnifier, centre marker and readout. Click/Enter
confirms, arrows move one physical pixel, Esc cancels. Hover applies a transient
override; only confirmation commits.

**Why frozen:** a chroma-key pick live-applies the key colour while hovering, so
sampling the live composite would read the keyed result. An effect pick
(`{ layerId, effectId }`) freezes that filter's actual input — upstream enabled
effects applied; the target, downstream effects and siblings excluded; a disabled
target uses the same chain position. Capture renders offscreen at composition
resolution with effects on, independent of preview LOD, and restores the chain
before async readback. `EffectInputCapture` uses a temporary pass-through filter
(WebGPU: copy into a staging buffer on the render's encoder before texture-pool
reuse; WebGL: read the input texture and restore the framebuffer); readback keeps
the shader's RGB (premultiplied, no Canvas conversion), mapped through Pixi's
filter rectangle, padding and resolution. Outside or fully transparent input has
no colour. If the target is unavailable, a localized explanation appears and
preview clicks do not fall back to the composited screenshot. Effect picks on a
Group sample the Group's composed input.

**Seams:** `previewSamplerRegistry` (PixiPreview registers capture/mapping; the
picker never imports Pixi); `effectOverrides` (transient per-effect overrides
read by `EffectChain.sync()`, never recorded or in React state; the preview
re-composites per change); `AppColorField` (eyedropper by default,
`withEyeDropper={false}` opts out). Effect descriptors declare `colorGroups` (RGB
scalar triplets) committed as one undo entry.

`main/screenPick.ts` owns the desktop windows, sender-bound IPC, cancellation
and focus restore; their sandbox preload exposes only sampling. Preemption, owner
close/navigation/crash, display changes, loss of focus or timeout end the whole
session. Capture/permission errors fall back to in-app picking with an
explanation. Captures stay in memory.

**Limits:** desktop content is frozen at entry. Verified only on Windows SDR at a
single 110 % screen; mixed-DPI multi-monitor, macOS permissions/Spaces and X11
are unverified. Native Wayland has no global overlays (reported; in-app picking
remains). Preview picks are 8-bit in the working space (no HDR/10-bit recovery)
and cannot recover detail lost to a Quick proxy.

## On-canvas transform (gizmo)

The primary selected layer shows its footprint as a box over the preview: drag
inside to move, corner/edge handles to resize, the knob above the top edge to
rotate, the reticle at the pivot to move the anchor. Only the five
transform-bearing kinds get one (`TRANSFORMABLE_KINDS`: VideoClip, ImageOverlay,
Text, Motif, Group) — Color fills the frame, Audio is not visual — and only while
the playhead is in the layer. A Path-position layer also shows its motion path. Resize writes `scale`, except on Text, where it writes the layout box.
Crop has its own overlay ([Rectangular video crop](#rectangular-video-crop)).

**Size presets.** The preview context menu offers **Fit to frame**, **Fill
frame** and **Restore original size** for the primary video, image, Motif or
Group. Fit shows the whole visible (post-crop) rectangle; Fill covers the frame,
including every corner when rotated; both centre and keep anchor, rotation and
mirrors. Restore sets scale magnitudes to 100 %, keeping mirrors and position.
Not for Text, locked or disabled layers or tracks. Each is one undo step under
the frame-snapped keyframe rules; a Path position is translated without
changing geometry or progress.

**Behaviour rules:**

- **Rotation** writes `rotation_deg` only (the engine rotates about the anchor and
  `x`/`y` are the unrotated top-left). Angles accumulate per-move increments in
  (−180°, 180°], so a drag across the ±180° seam and multi-turn drags behave.
  Shift snaps to an absolute 15° grid, keeping the true angle so releasing Shift
  resumes from the cursor.
- **Anchor drag** is pan-behind: it writes the anchor pair plus compensating
  `x`/`y`, so the picture stays put (zero compensation for an unrotated, unflipped
  media layer). The inspector's Anchor fields write the anchor alone and do move
  the picture (as in After Effects). The drag is converted into the layer's local
  frame, keeping the reticle under the cursor on rotated layers.
- **Resize** scales about the anchor and pins it with compensating `x`/`y`
  (`Δ = pivot·(|scale₀| − |scale₁|)`), solved directly so the handle tracks the
  cursor at any rotation, flip or non-uniform scale. A `scale_linked` layer shows
  **corners only** (an edge would break the twin invariant). Shift constrains
  proportions on an unlinked layer. A handle's driven axes come from its identity,
  never from its offset to the pivot.
- **Text** handles write `box_w`/`box_h` through `update_layer_params`, not
  `scale` ([ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md)),
  using the same solve read as a factor; all eight handles show regardless of
  `scale_linked`; no position compensation (Text's `x`/`y` is the anchor). Modes:
  `(null, null)` auto width, `(set, null)` auto height, `(set, set)` fixed;
  `(null, set)` is illegal, so a top/bottom drag backfills `box_w` from the
  measured width, while a side drag never invents a height. `box_w` floors at the
  8 px shrink floor (no flipping). Double-clicking a handle steps fixed → auto
  height → auto width. The box stroke turns `--warning` while shrink-to-fit is
  active and `--destructive` when text overflows at the floor
  (`GizmoProbe.textFitOf`). The sprite re-wraps live during the drag.
- Deltas below `1e-9` are dropped (trig residue would otherwise stamp invisible
  keyframes).
- **Snapping** pulls moves and resizes onto the composition's edges and centre
  lines and every other staged layer's bounds, **each axis independently**; ties
  go to composition lines. Radius is in screen px (`preview_snap_strength_px`,
  default 12; `preview_snap_enabled`), its own app setting, separate from the
  timeline's. Holding Ctrl suppresses snapping (not Alt, which opens the Windows
  menu bar). Guides are magenta, one per axis at most. A uniform resize solves
  the snap by ray/line intersection, ranked by displacement. Targets are frozen
  at pointer-down. Solver: `preview/previewSnap.ts`, run before the override is
  written.

**Implementation invariants** (each one looks fixable and is not):

- The box is an **SVG overlay, not Pixi children**: `app.stage` is read back by the
  eyedropper, the e2e `sampleComposite` hook and conformance `captureFrame`, and
  a screen-space overlay keeps handles in CSS pixels on any composition size.
- A drag writes a transient delta into `transformOverrides` (like
  `effectOverrides`) and **commits once on release** through
  `updateLayerParamTracks` (`update_layer_params` for a Text box) — one batch, one
  undo. The override holds until the new summary arrives, and the box reads the
  same override map, so outline and picture never drift. The Text box channel is
  the one **absolute** (not delta) override.
- A renderer-local **ledger** (`param key → track written`) is the base for the
  next commit and the rotation grid, because the mirror lags by two IPC round
  trips; the override carries `resolve(written) − resolve(mirror)` so it lifts
  itself when the summary lands. The ledger drops on the first summary with no
  commit in flight (handing authority back to undo, inspector or MCP). It also
  holds the Text box's nullability (the resize mode). It covers only this gizmo:
  a concurrent writer to the same tracks mid-burst would need the base resolved
  in main.
- Handles are **round** (no orientation to keep in sync on flipped or skewed
  quads).

**Seams:** `gizmoProbeRegistry` (PixiPreview registers `canvasRect`,
`naturalSizeOf`, `textFitOf`; the gizmo never imports Pixi); `gizmoGeometry.ts`
(pure quad, pivot, handles, `object-fit: contain` mapping; shares
`anchorPivot.ts` with the renderer); `centerInFrame.ts` (the layer-frame rule
shared with the centring commands); `autoKeyTrack` (Static → value; Keyframed →
key at the frame-snapped playhead, as in the inspector).

**Limits:** move, resize, rotate, anchor only — no corner-pin; single selection.
The box follows animation via rAF and hides while the preview tab is hidden. The
knob sits 26 px (UI-scaled) outside the box with `overflow: visible`, so a layer
flush with the top of a panel-filling frame has no room for it. Edge handles hide
on edges under 24 px (UI-scaled). A Text box drag re-rasterizes the glyph atlas
per gesture frame (bounded by Pixi's caches).

### Text tool

`T` arms the Text tool (beside Selection, Blade and Hand in the Quick Actions tool
row; also Edit menu and palette; display mode is `Shift+T`). While armed the
preview shows an I-beam: clicking a Text layer selects it and opens the inline
editor; clicking empty frame creates a Text layer anchored (centred) at the click,
with the Insert menu's **Text** defaults on its automatic overlay track at the
playhead, and opens the editor with the placeholder selected. Creation and the
first edit are two history entries. Locked or disabled layers/tracks are
transparent to the click (a click over a locked title creates a new one). Only
Text is hit-tested, and the gizmo takes no pointer input while armed. The tool
stays armed after a creation; Escape inside the editor finishes the edit, outside
it returns to Selection. A click that closes an open editor only closes it. A drag
does nothing. The tool is unavailable on an empty project (no canvas yet; the
tooltip points at Insert) and inert while the preview shows a composition other
than the focused one.

**Inline text editing.** On a selected Text layer, double-click the box or click
it with the Text tool. An empty Text layer keeps a one-em, one-line footprint.
Entry pauses playback and opens a native textarea over the transformed box at the
rendered font size. Enter inserts a line break; Ctrl/⌘+Enter, Escape, blur or an
outside click finish **and save** (no cancel key; undo reverts). IME composition
owns Enter/Escape. The draft saves only `content` in one history entry; text undo
stays inside the field while editing. A refused save is reported on the status
bar and keeps the draft (any finish retries; Escape then leaves without saving).
Locked or disabled layers/tracks cannot enter. The field uses theme colours,
grows along auto box axes and scrolls in fixed boxes; colour, effects and
shrink-to-fit apply on save. Changing project or unmounting discards an unsaved
draft.

**Default text font.** Settings → General → Default text font
(`default_text_font`) sets the family for newly authored Text layers (Insert
menu, Text tool, MCP creation); empty means the bundled `Liberation Sans, Noto
Sans SC` chain. Existing, pasted and imported layers keep their fonts. The picker
lists OS-installed families from one lazy main-process scan
(`main/fonts/resolveSystemFont.ts`; TTF/OTF and the first TTC face) exposed as
`font.listFamilies()`; the renderer never receives font paths. Install fonts
through the OS and restart to refresh. User-chosen fonts carry no cross-machine
guarantee.

## Rectangular video crop

Quick Actions and the VideoClip / preview context menus enter on-canvas
cropping; the context menus also offer reset. The Quick Actions icon stays lit
while cropping; clicking it again, choosing another tool, or Enter/Escape
finishes; Escape mid-drag cancels that drag. Entering pauses playback and seeks
into the clip if the playhead is outside it. Only an enabled, unlocked
`VideoClip` on an enabled, unlocked track, in the composition the preview is
showing, can enter (`commands/cropCommands.ts`).

Eight handles and the full edges resize the kept rectangle (direction-aware
cursors); dragging inside moves it; one drag is one undo entry. There is no
inspector section, temporary toolbar, numeric field or aspect preset. After
cropping, the transform box, centring and move/scale snapping (including other
clips snapping to it) use the visible rectangle; the original source still
defines pivot and scale. Crop follows flips and transforms without changing them,
stays active with preview effects bypassed, and applies identically in preview,
Groups, transitions and export. The rectangle is static and normalized to source
dimensions ([data-model.md § Layer](data-model.md#layer)).
Image and Group crops, animated crops, feathering and masks are not supported.

## Agent view and review

Agent view (preview, compact review timeline, Agent panel with Activity, Tacks and
Changes tabs), Tacks and the Timeline diff with *Approve all* / *Revert all* are
specified in [mcp.md § Review](mcp.md#review) and [§ Tacks](mcp.md#tacks).
Revert all is a recorded, lock-gated revert path ([Undo-stack scope](#undo-stack-scope)).

## Strip overflow

The dock tab strip and the Quick Actions strip never wrap. When they overflow,
each end still hiding content gets a floating gradient (the dock strip adds an
arrow button on it). The overlay never takes layout width (one that vanished at
the end stop would hand width back and could flip the strip in and out of
overflow). An arrow click scrolls item-aligned (the nearest partly hidden item
becomes fully visible); no press-and-hold. Tabs never truncate their title (it
is the Panel's only title); narrow groups scroll instead. There is no hidden-tabs
list (`disableTabsOverflowList`); the View menu and palette reach any Panel by
name. Arrows are pointer-only (out of tab order); the tablist's arrow keys reach
every tab. `scroll-padding` plus an explicit correction keep a newly active tab
out from under the leading overlay. Quick Actions draws the gradient only.
Geometry: `renderer/lib/edgeOverflow.ts` (with an end-stop tolerance for
fractional `scrollLeft`); DOM: `renderer/hooks/useEdgeOverflow.ts`. Rejected:
CSS `::scroll-button()` — it mounts inside the `role="tablist"` scroller and
steps by a viewport fraction.

## Performance settings

Settings → Performance sets intent — memory target, processing effort, temporary
cache space (automatic: 10 % of the Workspace disk) and whether background work
continues during playback — enforced by one cooperative resource authority on
all platforms. It also hosts the experimental Windows H.264 4K/60 computer test
and Linux hardware diagnostics. See [performance-settings.md](performance-settings.md).

## Window geometry memory

The main window reopens at the last position, size and maximize state, stored in
`<userData>/window_geometry.json` (`main/windowGeometry.ts`, wired in
`main/windows.ts`). Writes are debounced and flushed on close and before quit.
It is app state: never dirties the project or enters undo.

- **Restore is validated.** The window is frameless on Windows/Linux, so an
  off-screen restore would be unrecoverable. `sanitizeGeometry` requires a
  grabbable ≥ 120×48 px strip on some display's work area, clamps size to that
  display, else centres a default. A window straddling monitors or hanging past
  an edge survives (unlike `electron-window-state`'s full-containment rule).
- **Save/restore ratchet.** Electron bounds are not idempotent at fractional
  scale: at `scaleFactor` 1.1, feeding each read back into the constructor grows
  the window every launch (1182 → 1189 → 1196 …), for every accessor pair.
  `rememberGeometry` persists the rect it *requested* while the measured rect is
  within `BOUNDS_DEADBAND_PX` (16), dropping the deadband at the first real
  resize. `e2e/electron/window-geometry.spec.ts` asserts three untouched launches
  leave byte-identical geometry.
- Persist `getNormalBounds()`, not `getBounds()` (maximized rect would make
  restore-down a no-op). Minimized windows are skipped. Fullscreen is restored
  only on macOS (on Windows/Linux F11 is dev-gated, so a restored fullscreen
  would be inescapable).
- **Never pass `fullscreen: false` (or `undefined`) to the constructor**: Electron
  then disables fullscreen capability (`isFullScreenable()` false, the green
  button degrades to zoom, `setFullScreen(true)` no-ops). The key is spread in
  only when true. Guarded by `e2e/electron/window-chrome.spec.ts`.

## macOS window caption

The main window is frameless on Windows/Linux (renderer-drawn
`<WindowControls/>`); on macOS it uses `titleBarStyle: 'hidden'` with OS traffic
lights (native fullscreen, rounded frame, shadow) and `titleBarOverlay: true`
(macOS only — on Windows that flag paints native caption buttons over ours).

- **The inset comes from CSS.** Caption bars start content at
  `env(titlebar-area-x)` and are at least `env(titlebar-area-height)` tall; the
  `env()` fallbacks cover macOS fullscreen and Windows/Linux, so no platform or
  fullscreen selector is needed. The `enter-/leave-full-screen` events arrive
  ~500 ms after Chromium moves the buttons, so driving the inset from IPC
  overlaps the title during the animation.
- **Centring is derived.** The buttons are a 14 px band at
  `trafficLightPosition.y`, and `env(titlebar-area-height)` is `2y + 14`. The
  editor's caption bars (`.app-header`, `.startup-titlebar`, `.agent-titlebar`)
  share `--app-chrome-height: max(42.5px, env(titlebar-area-height))`, and
  `main/index.ts` sets `y = (42.5 − 14) / 2 = 14` (rounded). Change one, recompute
  the other; `window-chrome.spec.ts` fails if they drift. Secondary frameless
  windows (`main/windowConfig.ts`, e.g. `.perf-titlebar`) use `y = 10` and size
  their bar to the env value.
- **Declare the appearance.** Traffic lights follow the *window's* appearance;
  with `nativeTheme.themeSource` at `'system'`, a light-mode host draws inactive
  buttons invisible against the dark caption (`color-scheme: dark` does not reach
  them). `themeSource = 'dark'` is set before the first window, which also darkens
  native menus, sheets and the file picker.
