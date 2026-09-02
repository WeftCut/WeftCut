# Features

Behavior contracts for small, self-contained editor features — pieces too
small for a subsystem doc but with rules worth writing down. Subsystem
context lives in the linked docs.

## Undo-stack scope

What records into the editing undo stack and what doesn't, so non-editing
operations (project load, media library, canvas setup) never pollute the
history Ctrl-Z walks. Implemented in the TS state layer: the history stack
and out-of-band snapshot patching in `apps/desktop/src/main/state/history.ts`;
per-op record vs unrecorded routing in `state/actor.ts` (tests:
`history.test.ts`, `actor.test.ts`).

**Recording rule.** A state mutation records a `HistoryEntry` iff it changes
the timeline structure of the currently-loaded project — layers, tracks,
markers, transitions, or layers cascade-deleted by a media removal.
Everything else broadcasts a non-recorded `ChangeEvent`. The **whole
composition envelope** is on the non-recording side: size, rate, colour and
audio-target fields *and* `duration_us` / `duration_pinned`. It is project
setup, not editing — `set_composition` and `fit_composition_to_layers` never
add an entry, and Ctrl-Z walks straight past them.

| Op | Recorded? |
|---|---|
| `add_track`, `delete_track`, `move_track` | yes |
| `rename_track` | yes — a name is content, and the layer label already records; the two rename surfaces cannot disagree about undo |
| `update_track_flags` (eye/M/S/lock toggles) | no — patched into every history snapshot; undo never flips a track control |
| `add_layer`, `update_layer`, `update_layer_params`, `set_layers_enabled`, `move_layer`, `duplicate_layer`, `paste_layers`, `split_layer`, `delete_layer` | yes |
| `move_layers_to_new_track` | yes — **one** entry for the whole raise: the new track, every layer moved onto it, and every source track the raise emptied. Two entries would let one undo return the clips while leaving them on a track that no longer belongs to them |
| `add_marker`, `update_marker`, `remove_marker` | yes |
| `add_transition`, `update_transition`, `remove_transition` | yes |
| `add_media_item` | no |
| `set_media_workspace_paths`, `set_media_derivatives` | no |
| `remove_media`, no references / `force=false` | no — mirror import |
| `remove_media`, `force=true` cascade-delete | yes (layers actually got deleted) |
| `set_composition`, any field or mix of fields | **no** — setup, not editing. One patch, applied to every snapshot + checkpoint |
| `fit_composition_to_layers` | no — same fan-out; each snapshot unpins and refits to **its own** high-water mark |
| Passive duration shrink on layer delete / inward trim (unpinned) | **no separate entry** — rides the layer-edit commit that triggered it |
| `replace_state` (open / new project) | **no** — resets `History` to a fresh one-entry stack and clears checkpoints |
| `undo`, `redo` | cursor-only, no new entry |
| `jump_to { index }` (history panel: click a row) | cursor-only, no new entry — `undo`/`redo` generalized to an arbitrary stack index, so it records nothing for the same reason and rejects under `lock_history` for the same reason |
| `restore_checkpoint` | yes (deliberate user/agent action) |
| `create_checkpoint { label }`, `delete_checkpoint { checkpoint_id }` | **no entry and no `project:changed` broadcast** — neither changes project state, so waking autosave would rewrite `project.json` for nothing. Neither is gated on `lock_history` either: the lock rejects revert paths, and creating or dropping a checkpoint reverts nothing. A surface showing the checkpoint list must refetch it itself after either — the History panel does |

**Why the snags.** Imports are additive — no reference in any older snapshot
can break, so `add_media_item` patches every snapshot in place. `remove_media`
lacks that property when layers reference the media, hence the split: the
no-reference branch behaves like an import; the cascade branch records
because deleting layers is a real edit. `replace_state` is a wholesale
project swap — the old history is incoherent against the new `project_id`,
so the stack and checkpoints reset instead of carrying forward.

**Why the composition envelope stopped recording.** `duration_us` and `fps`
used to record, for two reasons that both turn out to be arguments about the
*shape of the fan-out*, not about whether it belongs in history:

- a shrinking `duration_us` could strand layers past the end in an older
  snapshot that held longer content;
- an `fps` change re-snaps layer geometry and markers.

Both dissolve once the patch is applied as a **transform run per snapshot**
rather than a value copied across them (`History.replaceCompositionEverywhere`).
Ctrl-Z is therefore not the safety net for these fields, and the UI carries the
guard instead: Settings → Canvas mounts with its "Lock canvas settings" switch
engaged, so the resolution and rate are inert until the user turns it off, and
re-engaging it abandons any in-progress size edit. Widen the undo scope again and
that guard becomes redundant — it exists to price in the missing undo, not for
its own sake.
`applyDurationAutofit` already floors a pinned duration at the *live* content
high-water mark, so running it inside each snapshot makes the overflow guard
per-snapshot for free: the snapshot with the 10 s layer keeps a 10 s duration
while the head sits at 3 s, and nothing is ever stranded. The fps re-snap
likewise runs against each snapshot's own markers.

**The rate lock is history-scoped, and has to be.** An unrecorded `fps` change
lands in *every* stored snapshot, so judging `FpsLockedByContent` on the
current state alone would leave `undo` (and `restore_checkpoint`) as a
backdoor: empty the timeline, change the rate, undo the deletion, and layers
authored on the old grid reappear at the new rate — a state neither revert
path re-validates. So the rule is **judgement scope == write scope**: the rate
is refused if the live timeline holds a layer *or* any snapshot or checkpoint
does (`History.storedSnapshotsHoldLayer`). `locked_by` on the error names
which. Practically the rate is settable only on a project whose timeline has
never held anything, and the escape hatch is the one Premiere and Resolve both
prescribe — empty the timeline, then reopen the project, since `replace_state`
resets the stack and checkpoints. The settings panel reads this off
`composition.fps_locked` to disable the control rather than offer a click that
always errors.

**User vs agent.** Both surfaces write the same `History`; entries carry an
`Actor::User` / `Actor::Agent { client }` tag so the history panel can
distinguish them, but Ctrl-Z walks back across both — selective undo on a
shared mutable state graph is the "history as DAG" problem and out of scope.
While an agent holds `lock_history(reason)`, every revert path (`undo`,
`redo`, `jump_to`, `restore_checkpoint`) rejects with `HistoryLocked`; the lock is
ephemeral (released via `unlock_history` or workspace swap) and never
affects what records. Deferred: `begin_transaction`/`commit_transaction`
bracketing to collapse an agent batch into one undoable entry — revisit
when stack-flooding actually hurts.

## Timeline selection

The timeline's clip selection is a set plus a **primary** — the one the
Attribute panel and the on-canvas gizmo follow. The set is renderer-global
(`state/selectionStore.ts`) and always satisfies `primary === null ⇔ set is
empty` and `set.has(primary)`, so no surface has to handle a primary that is not
selected. A layer selection and a selected transition chip are mutually
exclusive: choosing either drops the other, which is what lets Delete and the
Attribute panel always have exactly one kind of target.

**Click semantics.** Plain click replaces the selection; a click on blank lane
space clears it, per *Background clicks* below. `Shift+click` **toggles** — the
clicked clip (and its link) goes in if it was out and out if it was in. Toggle
rather than union because that is the additive modifier in Resolve, FCP and
Premiere alike, and a union-only gesture leaves no way back from an over-wide
selection except starting over. `Alt+click` selects one member out of a link.
Right-click also selects, but only when the clip is *outside* the current
selection, so right-clicking inside a multi-selection keeps it.

**A deselecting click never becomes a drag.** Selection and drag arming share one
pointerdown, and a selected clip has no drag-arm delay — so a `Shift+click` that
removes a clip returns early instead of seeding the gesture. Otherwise the
smallest pointer wobble would move the clip the user had just dropped from the
selection.

**Select All / Deselect All.** `Mod+A` and `Mod+Shift+A`, timeline-scoped
(ADR 0041) like Delete: with the media pool focused, `Mod+A` is not "select every
clip in the timeline". Inside a text field both stand down so the platform's
select-all-text survives (on macOS the chord then falls through to the native
Edit menu's own item). Neither sits on the Edit menu, because the handlers live
in the Timeline Panel — the only place that knows which tracks are *rendered* —
and a menu-bar row backed by a panel provider would vanish when that panel
closes. The search palette carries discoverability instead.

Select All follows the same two rules the playhead split does, for the same
reasons: it **respects the A/B Roll filter**, so it cannot arm a Delete for clips
that are off screen, and it **excludes locks rather than refusing them** — a
locked clip cannot be clicked at all, so including one would build a selection
the pointer could not and turn the next Delete into N `TrackLocked` refusals for
clips the user never chose. A surviving primary is kept, so Select All does not
move the Attribute panel off the clip being inspected. Deselect All clears all
three selections that arm Delete: clips, the transition chip, and the keyframe
selection.

**Delete takes the whole clip selection, as one undo entry** however many clips
and lanes it spans — so one undo brings a swept block back in one step. It takes
the selection verbatim and never fans out over a link: selection is what carries
a link, so a clicked or swept member has already brought its siblings along.

**Marquee.** Dragging from blank timeline space draws a box, and **the surface
the drag started on decides what the box selects** (ADR 0051) — a track lane, the
drop strip and the scroll body select clips; a keyframe sub-lane row selects
keyframes. The kind is fixed when the pointer goes down and never reconsidered,
so the box's extent decides only which members it takes. A press on the ruler is
a scrub and nothing else. The selection updates live during the drag and is
recomputed from scratch on every move, so shrinking the box back releases a clip
that was over-reached; Escape restores what the press found, a release keeps what
the last move computed. The box auto-scrolls horizontally at the edges and not
vertically — the vertical extent is a handful of lanes while the horizontal one
is unbounded.

A clip box **intersects** rather than encloses, since a clip longer than the
viewport can never be enclosed, and it is slice-aware, so grazing the top half of
a combined A/V row takes the visual layer and not the audio one. It shares Select
All's two rules for Select All's reasons: it **respects the A/B Roll filter**
(only rendered lanes can be swept) and it **excludes locks rather than refusing
them**. Touching one member of a link takes the whole link, exactly as a click
does — locked members included, so a box can never build a selection a click
could not. A surviving primary is kept, so a sweep does not move the Attribute
panel off the clip being inspected.

**The additive gestures are deliberately asymmetric.** `Shift+click` **toggles**,
per the click semantics above; a marquee **replaces**, with no modifier of its
own; and a `Shift`-marquee, if one is ever added, must **union**. This is not an
oversight in either direction — those three are different operations. Toggle is
the additive *click* in Resolve, FCP and Premiere, while their marquees add, and
a toggling box is worse than either: two overlapping XOR boxes cancel each other
out, and accumulating across boxes is the only thing a Shift-marquee is for. Until
one exists, "sweep a block, then `Shift+click` to trim it" is the accumulation
path.

**Background clicks clear per kind.** A press that never travels far enough to
become a box *is* the background click, and what it drops depends on the same
surface the box's kind comes from: blank lane space drops the clips and the
transition chip, blank sub-lane space drops only the keyframes — so clicking
beside a diamond leaves the Attribute panel on the clip being keyframed. The band
below the last track is part of the timeline's clip surface: clicking it clears,
and a box can start there and drag up over the tracks.

**Keyframe selection is a set**, spanning layers and properties, because one
sub-lane row draws the curves of every layer on its track. A box tests each
diamond's drawn centre — both axes in an expanded row, where the value axis is
tall enough to aim in, and x alone in a collapsed one, where one glyph already
covers some 40% of the axis (ADR 0051). Sweeping clips drops the keyframe
selection, since a keyframe selection claims Delete ahead of the clips. Two
operations act on the whole keyframe selection: Delete, and any easing choice
from a diamond's context menu. Each is **one undo entry per gesture**, however
many layers and properties the selection spans. The easing menu reports no
current interpolation while several keys are selected — claiming the
right-clicked key's easing for the rest would be unverifiable from the screen. Right-clicking a diamond already in the selection leaves the
selection and the playhead alone and acts on all of it; right-clicking one
outside selects it first, the way the clip menu behaves.

**Still missing** (the conventions a traditional NLE also has): contiguous range
selection between an anchor and a click, and the directional "select every clip
forward on this track" tools.

## Links

A `Link` is a project-level entity owning a flat set of member `LayerId`s —
a layer is in at most one link, no nesting. Moving, trimming, splitting,
duplicating, or toggling `enabled` on a member fans the edit out to the other
members under the rules below; everything else (keyframes, opacity, gain,
delete) stays local. A link has
no rendering significance — the renderer composes every member
independently — and no identity beyond its accent: it says "these travel
together", which is Premiere's Link with any number of members. One
mechanism serves both auto-paired AV from a single source and manual scene
bundles (B-roll + voiceover + lower-third that travel together). "This is
one thing" is a different intent and a different word: a *Group* is a
composition placed as one layer ([CONTEXT.md](../CONTEXT.md#links-and-groups),
ADR 0052), never a link.

**Fan-out rules** — any single op can bypass them with `escape_link: true`:

- **Move** propagates the time delta to every member's `t_start_us`/`t_end_us`;
  the track change applies only to the targeted layer. Rejects if any
  member's new range would overlap its track or leave the composition.
  Dragged toward the origin the link **stops as a set**: the clamp applies to
  the shared delta, so the earliest member lands on 0 and everyone keeps their
  spacing — no member is shortened in place. Each member then re-snaps on *its
  own* lattice, which is what preserves a slipped A/V sync offset.
- **Trim** propagates only to members whose corresponding edge sits at the
  same exact `t` (alignment is recomputed per op — there is no stored
  "aligned" state), with the delta clamped so no member crosses its source
  bounds (`src_in_us`/`src_out_us`) or inverts.
- **Split** cuts every member spanning `T`, distributing source in/out
  proportionally for media-bearing kinds; all pieces stay in the link. The
  shot-apply's rejecting verbs (§ Shot review) are the one place a *delete*
  travels a link too: they remove every member piece lying under a rejected
  span and nothing under a kept one. `delete_layer` stays local.
- **Duplicate** (`paste_layers`) clones every member and links the clones to
  each other — never to their sources — as **one** undo step. The first id is
  the seed the drop position refers to; every other clone shifts by the same
  delta and snaps on its own lattice, and only the seed's clone changes track
  (the Move rule). A locked or occupied destination for any member rejects the
  whole batch; nothing is created.
- **`enabled`** (`set_layers_enabled`) toggles every member unless escaped. A
  member's own `locked` does not block it — the eye is visibility, not content
  — but a locked track rejects the whole set.
- Both batch ops take the **set they are handed** and expand nothing: the UI
  supplies the link's members (or the clicked layer alone when escaped), and an
  agent names the layers it means.
- **Raise to a new track** is not a fan-out: `move_layers_to_new_track` moves
  exactly the layers it is handed, onto one fresh lane. Its two entry points
  differ in which layers they name *and* in whether they name a time. The
  **Move to a new track** command names the selection and no time, so every clip
  keeps the moment it was already at — a menu shows no ghost, and may not move a
  clip somewhere the editor never saw. A clip dragged into the **drop strip**
  names the drag's subject set and the landing under the pointer: the clip stays
  under the hand that carried it there, exactly as it does on any other lane. One
  member is the anchor and the rest hold their phase to it, so a linked clip takes
  its link up with it and every member changes lane — unlike a plain Move (above),
  where only the targeted layer does.
- **Locks reject the whole op:** if a fan-out would touch a member with
  `locked == true` — or any layer on a `Track.locked` track — the op fails
  with `LinkLockedMember` / `TrackLocked` rather than partially applying.

**Invariants** (validated on every commit): every member resolves to a real
layer; no layer appears in two links; a link auto-dissolves below 2
members *in the same commit* (delete is always local — `delete_layer` never
fans out); `links_create`/`links_add_members` reject already-linked
layers unless `reassign: true`, which moves the layer over.

**Import auto-pair.** When `auto_pair_audio_on_import` is on (default) and
an imported video source has an audio stream, import creates a `VideoClip`
plus an `Audio` layer (same media, same span) and links them atomically.
`VideoClip` lowering does not emit audio — the paired `Audio` layer is the
audible one.

**UI.** Click a member → select the whole link; `Shift+click` toggles by
link (a second one takes it back out — a deselecting click never starts a
drag); `Alt+click` selects only the clicked layer, and `Alt+trim` escapes
that one trim. Body `Alt+drag` duplicates the **whole link**: one ghost per
member during the drag, one `paste_layers` on release, the clones linked to
each other and never to their sources, one undo. The escape is the
selection — `Alt+click` a member first and the copy is that member alone,
unlinked — because `Alt` on the body already means duplicate. A collision on
any member's destination shows the drag invalid and creates nothing.
**Enable / Disable** in a clip's context menu and the inspector's Enabled
switch send the link's members in one `set_layers_enabled` (the menu row
reads `Disable 2 linked layers`); `Alt`+right-click narrows the row to the
clicked layer. Linked layers show a 2 px left accent in a hue derived
deterministically from `link_id`. `Ctrl+L` **toggles** link ↔ unlink, as in
Premiere: a selection inside one link unlinks it, two or more unlinked layers
link, and anything else greys out with the reason in the tooltip. It is one
command, rebindable via the TS keybindings store, and the same toggle sits in
the Quick Actions strip's `edit` section as Link / Unlink.

**Link override.** `Alt+Shift+G` (Reaper's *Grouping enabled* key; also a
toggle in the Quick Actions strip and a row in the search palette) flips a
session switch that stands in for a held `Alt`. While it is on, every site
that consults link membership treats the link as absent: a plain click
selects one member, a drag moves or duplicates one, the blade and `Mod+B`
split one, the marquee takes exactly what it touched, and Enable / Disable
toggles one. The status bar shows a `Links off` chip and the timeline's link
accents dim to 40 % for as long as it is on, so the mode is stated on screen
rather than remembered. Nothing is written: links keep every membership, the
toggle records no history entry, and it is not persisted. MCP is unaffected
— an agent passes `escape_link` explicitly.

**A/V sync offset.** An audio member can be slipped off its video partner
(audio lives on the 48 kHz sample lattice — see [audio.md](audio.md)), and the
resulting offset is **derived from the geometry, never stored**: it is
`audio.t_start_us − video.t_start_us`, measured in sample indices so the
~10 µs residue between the two lattices at 29.97 / 59.94 does not read as a
slip. With no field, nothing can disagree with where the clips actually are.

A non-zero offset shows as a badge on the audio clip (`+3 smp`, `−2.00 ms`).
The two existing fan-out rules already behave correctly for it, and this is
worth stating because it looks like an inconsistency and is not: a
**whole-link move preserves the offset** (every member shifts by the same
delta, then lands on its own lattice), while a **video trim does not drag
slipped audio** (the aligned set requires coinciding edges — which is the
right outcome for a deliberately slipped track).

`Alt+←/→` nudges a selected audio layer one sample, `Alt+Shift+←/→` one
millisecond (48 samples), and `Alt+Shift+S` re-syncs it to its video. All five
are real commands, so the search palette lists them, Settings → Keyboard
rebinds them, and an agent can call them. **Pointer drags never reach sample
precision** and are not meant to: one sample is 0.042 px at the 2000 px/s zoom
ceiling, so dragging keeps snapping to the visible quantum. Sample precision
arrives through the nudges and through the inspector's numeric fields, whose
unit (timecode / milliseconds / samples) is switchable per the audio-units
selector — audio readouts only; the ruler and playhead stay frame-based.

Mutations live in `apps/desktop/src/main/state/mutations/links.ts`, with
fan-out enforcement in `move.ts` / `trim.ts` / `split.ts`. MCP tools
(`links_create` … `links_rename`, plus `escape_link` on the structural
ops) and the read surface (`links` on `project://current`; there is no
`links_list` tool): [mcp.md](mcp.md). Wire shape: [data-model.md](data-model.md).

## Groups

A *Group* is a composition placed as one layer — After Effects' precomp,
Premiere's nest ([CONTEXT.md](../CONTEXT.md#links-and-groups), ADR 0052). The
Group layer's params are a `CompositionRef`: a source window
`[src_in_us, src_out_us)` into the composition's own time, plus the transform,
opacity and blend mode every visual layer carries. Parent time `t` is
composition time `t − t_start_us + src_in_us`; nested Groups compose the
mapping. Four structural operations make one, move more layers into one,
dissolve one, and carry layers into any composition by name; each is a single
history entry, and those four are the only ops that cross a composition
boundary at all.

**Pre-compose** (`groups_create`) turns a set of layers — one or more, all in
one composition — into a Group in place. The set's earliest start `t0` becomes
the new composition's zero: every member shifts by `−t0` on its own lattice,
and its keyframes, being layer-local, do not move. The composition copies the
parent's settings and carries the reserved A roll / B roll, so "no tracks" is
never a state; the parent tracks that held members map bottom-up onto A roll,
B roll, then fresh transient lanes, which preserves relative z-order. Links
fully inside the set move with it, ids intact; a link straddling the boundary
loses its inside members and dissolves below two. Transitions between two
members move; a straddling one is dropped by reconcile and logged. Markers
stay in the parent. The Group layer lands at `t0` on the top-most former lane,
windowed over the whole composition; if that span is now taken it takes the
drop strip's route — the nearest free lane above, else a lane spawned on top.
Emptied transient lanes are pruned. The operation is all-or-nothing: a locked
member (`GroupLockedMember`) or a locked track (`TrackLocked`) refuses the
whole set before anything moves, so a Group never holds half a selection.

**Ungroup** (`groups_ungroup`) is Resolve's *Decompose in Place*: the members
come back into the parent at the same on-screen time. It is allowed only when
the Group layer is **plain** — identity transform (including the linked-scale
default), static opacity 1, no effects, Normal blend. A transform, an opacity,
an effect chain or a blend mode on the Group applies to the composite and has
no per-member equivalent,
so expanding would discard it silently — the outcome ADR 0048 and the
prevent-at-the-gesture rule for refusals both forbid — and the refusal names
the field instead (`GroupNotPlain { reason }`). Every member intersecting the
window is copied in at `t + t_start_us − src_in_us`, trimmed to the window with
its source window and keyframes following (trim's content-glue rule); members
wholly outside are dropped. The composition's tracks become fresh transient
lanes at the Group layer's z position — empty ones are not created — and links
and transitions inside carry over under fresh ids. The Group layer goes, its
lane is pruned, and the composition is removed when nothing else references
it; a second Group layer pointing at it keeps it.

**Add to Group** (`groups_add_members`) moves layers that are already on a
timeline into a Group that is already there. The set and the Group clip must be
siblings in one composition: the clip is what the user pointed at, and its
placement is what the arrival time is measured from. Each member lands at
`t − t_start_us + src_in_us`, re-snapped on its own lattice, so it keeps the
screen position it had; a member outside the Group clip's window arrives outside
it and shows as overhang — preferred to landing the set at the destination's
playhead, because this is a structural regrouping rather than a paste, and a
regrouping that moves pictures is a surprise. Source tracks map bottom-up onto
the destination's existing lanes, spawning one past the end, exactly as
pre-compose maps onto A roll / B roll / fresh; a whole source track's members
travel together onto one lane — which is what keeps a transition between two of
them alive — and bounce as a block when that lane is locked or already occupied
at those times. Links, transitions and markers follow pre-compose's rules. Both
compositions autofit and no Group layer is retrimmed. All-or-nothing before
anything moves: a set spanning two compositions or a Group clip outside it
(`CrossCompositionSet`), a target that is not a Group layer (`WrongLayerKind`),
a locked member (`GroupLockedMember`) or lane (`TrackLocked`), a member whose own
composition already reaches the destination — the destination included, which is
moving a Group clip into itself (`CompositionCycle`) — and a member that would
land before composition time 0 (`InvalidArgument`, naming the earliest landing
the whole set clears — the bound belongs to the earliest member, not to
whichever one the refusal happens to report, so retrying at it is not refused
again).

**Moving to another composition** (`move_layers_to_composition`) is the same crossing
addressed by NAMING a destination instead of by pointing at a Group clip: a set
of layers, one destination composition, and an ABSOLUTE landing time on that
composition's clock. Add to Group is one of its callers — it reads the landing
off the Group clip's placement and delegates — so everything below governs both,
and the ROOT is an ordinary destination here rather than a special case: taking
a clip out of a Group and back into the film *is* this operation, and it is one
of the two directions it exists for. An anchor member is the one the landing
time positions; every other member keeps its phase relative to it, which is what
preserves the set's mutual geometry and keeps a transition between two moved
members alive. Both endpoints re-snap on each member's own lattice at the
DESTINATION's rate, so a landing is quantized where it arrives and two
compositions on different rates do not round trip — A → B → A need not return a
layer to the microsecond it left. Links and transitions follow the set, markers
stay behind, emptied source lanes are pruned, both compositions autofit and no
Group layer is retrimmed. It refuses whole before the first write, and the
refusals are Add to Group's: a set spanning two compositions
(`CrossCompositionSet`), a locked member (`GroupLockedMember`) or lane
(`TrackLocked`), a member whose composition already reaches the destination —
the destination included (`CompositionCycle`) — and a landing before composition
time 0 (`InvalidArgument`, never a clamp: composition time has no negative half,
and sliding the set onto zero would move it off the picture it was placed
against), plus an unknown destination or lane (`CompositionNotFound`,
`TrackNotFound`) and a destination that is the composition the set is already
in, which is `move_layer`'s work rather than a crossing. Add to Group's other
three are about the Group CLIP and stay with it: that it is a sibling of the
set, that it is a Group at all, and that no Group clip may point at the root.
The last of those reads like a rule against the root *receiving* layers and is
not one — nothing may be placed as a Group of the film, and the film takes
layers back like any other destination.

**Which lane it lands on.** Destination lanes are assigned per SOURCE track,
never per member — a whole source track's members travel together onto one lane,
exactly as pre-compose and Add to Group map bottom-up — and what forks is the
answer when the preferred lane is locked or already occupied at those times.
A caller with no opinion **bounces**: the nearest free lane, else a fresh one.
A caller that NAMES a lane is **refused** instead (`TrackLocked`,
`LayerOverlap`), and one that names the destination's drop strip always takes a
fresh lane at the top of its z-stack. The fork is about what the user was shown:
a menu has no ghost, so bouncing is honest for it; a drag has one, and bouncing
would make the ghost a lie.

**Move to… ›** on a clip's context menu is the submenu form. The trigger
names no destination because the rows under it each name one. The
film's own timeline sorts first — it is the answer to "get this back out of the
Group", which is the commonest reason to open the row — then every Group by
name. A destination that cannot take the selection is listed and greyed rather
than dropped, because a missing row is a question and a greyed one is an answer:
the composition the clips are already in says so, and one a selected Group clip
already reaches says it cannot also sit inside itself. A live row whose
composition has no reading of the current moment says that too — the clips land
at its start. The trigger itself greys, falling back to a flat row that has
somewhere to put the reason, when there is nothing selected or a member or its
lane is locked; a project offering nowhere to go greys every row instead, which
is the same information with the destination named. Each row's landing is that
composition's own reading of the one moment, projected through the placement the
user is looking at, and it is resolved again at the commit rather than read off
the row — an open popup does not re-render while the film plays under it. A
composition with no projection at this moment falls back to its own `t = 0`
rather than refusing: the gesture named a composition, not a moment. The anchor
is the earliest-starting member, so the set *starts* at that time and the
negative-landing refusal is unreachable from here. Afterwards the selection
clears and the view stays where it was: the menu never left the Panel it was
opened in. The same command sits in the Edit menu, in the search palette and on
any key someone binds it to — surfaces with no room for a list, so there it
means the root, and greys once the selection is already in it rather than taking
whichever Group happens to sort first. Carrying no list, it can say where it
goes, and does: those surfaces label it **Move to timeline**.

**Carrying a clip into another timeline Panel.** With two compositions open side
by side, dragging a clip out of one timeline and into the other commits the same
operation. The destination Panel owns the drop, because ownership follows the
coordinate system: zoom, scroll, the frame grid, the snapping targets and the
lane geometry are all per Panel, so only the composition under the pointer can
turn that pointer into a lane and a time, and it is the Panel that sends the
command. **The clip stays under the grab point** the way it does at home: the
pointer names where inside the clip the editor took hold, not the clip's head, so
crossing the seam does not shift it. What travels is a duration rather than a
distance in pixels, which is why the source Panel's zoom does not distort it. It
draws its own ghost for a clip it holds no data for — the kind's
colour, the clip's name, and the footprint recomputed at THIS Panel's zoom,
since the source's width would be a lie about the duration here; no filmstrip,
waveform, link chrome or transition chip, because none of them answers what the
drop asks. The ghost refuses in place in the vocabulary the in-composition drag
already uses: red over an overlap, amber over a locked lane, and a release there
sends nothing. Over the destination's drop strip it spawns a lane. A drop that
lands takes the keyboard and the selection with it, where the menu clears the
selection and stays put — the difference is the pointer, which named a place the
clips are now visible at. **Alt+drag across Panels is refused**, with the reason
in the status bar rather than a dialog: a copy mints ids, and a paste links its
clones to each other and never back to their sources, so copying into another
composition is a second mutation and not a parameter of this one. The refusal
names the way in as well as the wall — the same drag without Alt moves the clips
there.

**Overhang.** A Group layer's window may extend past its composition's
duration: validation puts no upper bound on `src_out_us`, a trim gesture clamps
to the duration, and past the end the Group renders nothing (ADR 0052 §6). The
rule exists so that a delete *inside* a Group — which shrinks the composition —
is never refused on account of a parent's window. Duration autofit is per
composition: a composition growing inside does not extend the Group layers
that show it. Add to Group is the operation that grows one UNDER existing
placements — the members it moves in can push the destination's duration out,
and every Group clip showing that composition, the one they were added through
included, keeps the window it had, so the new content reads as room to trim out
to rather than as a silent retrim.

**Single lattice.** Every composition's `fps`, `sample_rate` and `channels`
equal the root's — a Group on another rate would put its window on a different
grid from the parent's timeline, which is time-remapping. Width and height may
differ per composition.

Naming and removal: `groups_rename` sets or clears a composition's label (the
root has none — it is the timeline); `compositions_delete` removes a
composition nothing references (`CompositionInUse` otherwise). Orphans are
legal: deleting a Group layer leaves its composition behind.

**UI.** A Group clip wears lucide's `Group` glyph and a neutral slate surface —
the one kind with no medium of its own, since it holds every other kind — and
names itself after its composition: its stored label, else `Group N`, where `N`
is the composition's stored `ordinal` (docs/data-model.md) — localised in the
renderer, as `Track N` is. Naming one Group renumbers no other, and clearing a
name gives back the number that Group always had. The clip's own `label` still
outranks that, as a renamed video clip's does over its file name. Its thumbnail
is a still of the earliest video inside the composition, or inside a Group
nested in it; with no video at all the glyph stands alone. It is an ordinary
picture layer everywhere else — the overlap classes, the Playhead panel's video
bucket, the effect chain, the transform gizmo — and it keyframes `transform` and
`opacity`, the media-bearing set minus what ADR 0052 leaves out of v1.

The two source-window affordances live at its right edge. A **hatched tail**
covers the part of the clip past the composition's duration: source ran out,
nothing renders there. A **2 px tick** appears when the window is shorter than
the composition: there is content to trim out to. A trim drag clamps `src_out_us`
to the duration, so the out edge stops there rather than being refused.

`Ctrl+G` pre-composes the selection and selects the Group clip it makes;
`Ctrl+Shift+G` ungroups the one selected Group layer. Two commands rather than
one toggle — unlike `Ctrl+L`, their preconditions are not inverses: one takes
any number of layers, the other exactly one Group. Each greys out with the reason
in its tooltip: nothing selected, a locked member, or the field that blocks the
expansion (`Reset the group's opacity to 1 first…`). Both sit in the Edit menu,
in the Quick Actions strip's `edit` section as Group / Ungroup, and in the
search palette; `Open group` and `Add to Group` are commands too, both shipped
UNBOUND — their home is the pointer, and no shipping NLE has a key for either to
copy. `Add to Group` needs the Group clip its members are going into, so the
row that carries it is the one opened over that clip, and only there does it
name the destination: `Add to “Lower third”`, against the plain label the
once-built menus keep. It greys with its own reason — no group clip selected,
two of them, nothing to put in, a locked member, or a clip that starts before
the group does and so has nowhere in composition time to land. There is no
leaving half: under a tab strip, leaving is closing a tab or activating another.

**Entering.** Double-click a Group clip to open its composition, or use
`Open group` from its context menu — the same kind-gated block that carries
`Ungroup` and `Add to “…”`; that gesture is spent on navigation, so
renaming happens through the menu's two rows instead — `Rename` for the clip's
own label, `Rename group…` for the composition's name (which every clip placing
it then shows). The composition opens in a **timeline Panel of its own**, as a
tab beside the timeline it was entered from: one Panel per composition, so
opening the same Group twice activates the tab it already has (ADR 0053). The
tab prints the composition's name and its tooltip the route to it —
`‹project› › Group A › Group B`; drag the tab out and the two timelines stand
side by side, each scrolling and zooming on its own. Where a Group is placed
more than once, the tab's context menu offers `Switch anchor` to say which
placement its times are read against. The timeline's empty space is tinted one
step per level so depth reads without looking at the tab — Resolve does the
same for a compound clip. Moving between tabs drops the selection, the marked
range and any inline reveal; the moment is not touched, because every tab reads
the same one in its own coordinates, and the display mode is not touched
either. The inspector's Group section
carries the composition's name, its frame size, its duration and the same two
buttons.

**One moment.** There is a single playhead in the editor and it is a time on the
FILM's clock. A Group's timeline draws its own reading of that same moment,
shifted by where its clip sits, so scrubbing inside a Group moves the film and
stepping the film moves the Group's line — one number, read twice. `Home` and
`End` inside a Group therefore go to the ends of the *Group*, which are moments
of the film. A Group whose clip is not on screen at the current moment draws no
playhead at all, because it has no position then; an edit *at* the playhead
still works there, since a composition's clock runs whether or not its placement
shows it. A composition nothing places — an orphan — has no reading of the
film's moment at all, so its timeline scrubs on an axis of its own and leaves
the film where it is.

**Watching the film while editing a Group.** The Preview Panel names what it
draws: *Follow focus* — the default, the timeline holding the keyboard — or a
fixed composition, chosen from the film and every Group. Locked to the film,
entering a Group stops taking the picture off screen: the timeline shows the
Group, the canvas shows what the film looks like at the moment being scrubbed,
and a lower third can be built against the shot under it without leaving once
per adjustment. The target can be a composition with no timeline open at all,
which is what makes it a lock rather than a property of a tab; a target the
project loses — ungrouped, or its composition deleted — releases back to
following focus. Export is never affected: it renders the root, whatever the
preview was pointed at.

Which timelines are open, each one's zoom and scroll, the anchor each was
entered through, and the preview's lock are remembered **per project** and come
back when it is reopened. The Dock's own geometry is remembered app-wide
instead, so a reopened project comes back with its tabs but in whatever
arrangement the workspace is currently in.

A clip inside a Group is findable in the search palette like any other, and
activating it opens that Group first, then selects. Undoing a pre-compose while
standing inside the Group it created closes that tab — the composition no
longer exists — and hands the keyboard back to the timeline it came from, with
the grouped layers selected again.

**Reuse, and where an orphan lives.** A composition is a card in the media pool
beside the imported files — one list, both kinds, sorted by name — carrying a
Group glyph where a thumbnail would be, its duration and its reference count.
Dragging one places another instance (`add_group_layer`) — the second way a
Group reaches a timeline, and the reason a composition is an entity at all. Two
placements of one composition are two instances at their own offsets, so at one
playhead they show different frames of the same content. A composition may be
placed inside another Group, but never inside itself or one of its ancestors:
the drop target greys out rather than letting the release be refused. A
composition nothing references any more — an orphan — keeps its card, dimmed and
tagged isolated, where it can be opened, renamed, or deleted; that card is the
only surface able to remove it. Selecting it puts the composition in the
inspector, so an orphan can be read and named with no clip anywhere.

Mutations live in `apps/desktop/src/main/state/mutations/groups.ts`, over the
crossing primitive in `mutations/moveToComposition.ts` (ADR 0054); tools and
wire shapes: [mcp.md](mcp.md), [data-model.md](data-model.md).

## Split at the playhead

`Mod+B` cuts every clip the playhead is inside. It is the Blade tool's
keyboard half — the tool can only ever cut where the pointer is — and reaches
the same `split_layer_linked` channel a blade click does, `escape_link: false`
included, so a linked A/V pair cuts in lockstep. Also on the Edit menu, in the
Quick Actions strip, in a clip's context menu and in the search palette.
Resolution lives in `apps/desktop/src/renderer/commands/splitAtPlayhead.ts`.

**Targets resolve selection-first.** A non-empty selection with anything
straddling the playhead narrows the cut to those clips; otherwise every
straddling clip is cut. That is Premiere's contract, and it is also what keeps
the common case — one clip, or one auto-paired couple — to a single history
entry, because each clip is its own commit.

**One target per link, not one per member.** A linked split already fans out
to every spanning sibling inside one commit, so sending the partner as well
would ask for a cut in an interval that commit had just closed.

**The sweep respects the A/B Roll filter; the selection does not.** In A/B Roll
the timeline hides every role-less track, which is exactly where
auto-spawned overlays and titles land, so cutting one there would be an edit the
user cannot see. A *selected* layer is one they reached on purpose — the inline
reveal is already showing it — so the selection path ignores the filter.

**Locks are prevented, not refused.** Locked layers and locked tracks are
filtered out before dispatch: a lock is the user's own standing instruction, not
an error to report back at them. The one refusal that survives is a link
straddling a locked track, where the actor's `TrackLocked` is the useful answer
— half the pair is pinned, and a partial split of a link is not a thing
`escape_link: false` can express.

**No disabled state, on purpose.** Whether a clip straddles the playhead
changes as the playhead moves, so gating the command would mean subscribing the
Quick Actions strip to the playhead — a re-render per frame, which the playhead
budget forbids. Over a gap the command no-ops, exactly as `Ctrl+K` does in
Premiere.

**Undo granularity is the known limit.** N straddling clips are N commits and
therefore N undo steps. Collapsing them would need a new actor op;
`split_layer_multi` is the other axis (one layer, many times — the shot-split
path).

## Track placement

**There is no add, remove or reorder surface for a track**, and that is the whole
design rather than a gap: the editor places media and tracks appear and disappear
around it (ADR 0042). A user who goes looking for a "+ Track" button is looking
for a second mental model — declare a container, then put something in it — that
placement already decides for them.

A **drop strip** sits above the topmost lane: a 12–16 px row that turns a drag
into a new track at the top of the z-stack. Two of its properties look like
oversights and are neither. Its space is reserved **permanently**, because a row
that appeared on drag would reflow the timeline under the pointer mid-gesture. And
idle it is a **dashed rule** along the bottom of that row, with a plus in the
header half — a seam, not a lane — lighting up only while a drag is live,
because anything that looks like an empty lane when nothing is happening
reads as a lane the editor is supposed to manage. It accepts
a media-pool drag and an existing-clip drag identically — two different event
models, one target, which is why both are end-to-end gated
(`e2e/electron/timeline-drop-strip.spec.ts`, `timeline-raise-to-strip.spec.ts`).
A clip dropped on a lane that has room still lands there; spawning is the
exception.

The strip is also where a raise's **preview** is drawn, and it is the only row
that can be: every other destination is a lane that can host the chip itself,
while this one has no lane until the commit returns. So the bars sit in the strip
and the lane the clip is leaving lets go of it — a chip left behind there would
say the clip is staying. The preview outlasts the release too, holding its place
for the round trip in which the destination still has no id, which is what keeps
a released raise from flashing back to where it started.

The top is the **only** spawn point. A lane below A-roll composites underneath it
and is invisible unless A-roll has a gap, so a bottom entry point would lie about
what it does. Z-order is therefore rearranged by **raising to the top, repeatedly**
— any order composes from a sequence of raises, and each one empties its source
lane, which cleanup then removes, so restacking leaves no residue. Ordering n
overlapping overlays costs n−1 operations rather than one drag; it is a
low-frequency operation. **Move to a new track** is the same operation without a
pointer (search palette, Edit menu, and a clip's own context menu; no default
binding, disabled when the selection would overlap itself on one lane). A drag
gesture is unreachable from the keyboard, so the command is not a convenience.
The one thing it does not carry is a time: a raise **may** name where the set
lands, and the drag does because its ghost showed the editor that landing, while
the command leaves every clip where it was.

**Cleanup is one sentence: a track disappears when its last layer leaves it.** A
track that was *born* empty was never emptied, so one an agent creates on purpose
survives until the agent removes it — and no edit in one part of the timeline can
make a track vanish in another. A locked track survives regardless: locking is the
editor pinning a row, and cleanup does not out-rank that. There is no preference
governing any of this, deliberately — one that turned cleanup off would let tracks
accumulate with no surface able to remove them.

Every track is **named automatically unless the editor names it**: the reserved
A/B-roll tracks from their role, the rest from a position that renumbers as tracks
come and go, exactly as Premiere and Resolve renumber. Double-click a track
header's name to rename it, or use Rename in its context menu; **clearing the field
gives the automatic name back**, which is the opposite of renaming a clip, where an
empty value abandons the edit. A track's automatic name is a meaningful default the
editor needs a route back to, and a clip has no equivalent. A rename is undoable —
it is content, not a control — while the eye and the lock are not, so undo never
reveals a track the editor hid.

One consequence worth knowing: **raising a clip out of a track you renamed
discards that name**, because the track goes with it. One undo restores clip,
track and name together.

Placement policy and the strip live in
`apps/desktop/src/renderer/timeline/placement.ts` and `DropStrip.tsx`; the pointer
drag's hit-test in `hooks/useLayerDrag.ts`; naming in `renderer/lib/trackName.ts`.
Mutations: `main/state/mutations/move.ts` (`applyMoveLayersToNewTrack`),
`tracks.ts` (`applyRenameTrack`) and the single prune in `mutations/helpers.ts`.
Wire shape and the cleanup predicate: [data-model.md](data-model.md).

## Timeline scrolling

The **bare wheel walks time** and **Shift+wheel walks the track stack** — the
mapping Premiere carries as its `Timeline Mouse Scrolling` default and Resolve's
Edit page uses. On a clip-along-time timeline the horizontal axis is the one that
always overflows, so it gets the unmodified gesture; the browser's own convention
(bare wheel vertical, Shift horizontal) is the opposite, and it is invisible — a
lane that only moves under a modifier reads as jammed.

`Settings → Timeline → Mouse wheel scrolls` flips the pair for the
track-count-first habit After Effects and Media Composer teach. `Across tracks`
is not a reimplementation: it hands every unmodified gesture back to Chromium, so
that mode keeps the platform's scroll smoothing.

Two gestures are never remapped. A **trackpad's sideways swipe** already carries
a horizontal delta, so it passes straight through with its momentum intact — the
handler would otherwise double its travel. And a wheel with **Ctrl or Alt** held
belongs to zoom below; the two listeners on the timeline's scroll root divide the
wheel by modifier, never by which one registered first.

Pressing into an end stop does nothing rather than spilling onto the other axis —
the same rule zoom follows. The mapping table is
`apps/desktop/src/renderer/timeline/wheelScroll.ts` (pure, so the axis rules are
testable without a layout); the listener is `hooks/useWheelScroll.ts`. Nothing
here writes `timelineScrollStore` — moving `scrollLeft` fires a `scroll` event,
and `Timeline`'s rAF-coalesced publisher stays the store's one writer.

## Timeline zoom

Two gestures scale the timeline, differing in one thing — what they hold still.
**Ctrl+wheel** (and **Alt+wheel**, Premiere's modifier for the same gesture) is
continuous and holds the time under the **cursor**. **`=` / `-`** step one
doubling per press and hold the **playhead**, because a key press has no pointer
to hold. Geometry in
`apps/desktop/src/renderer/timeline/zoom.ts`; the state, the bounds and the one
`scrollLeft` write in `hooks/useTimelineView.ts`.

Both share the same range. The ceiling is a flat 2000 px/s. The floor is
computed per gesture: **fit-to-project** — the scale at which the project extent
(before the post-roll padding) exactly fills the lane — so zooming out always
stops at the whole timeline and never past it, and the stop widens as the
project grows or the panel resizes. Pressing into a stop is a no-op, not a
nudge: the view doesn't move.

**When the playhead is off screen**, a keyboard zoom anchors the lane's centre
instead. A zoom is a magnification, not a seek — a user who scrolled to a
distant region and pressed `-` to widen it wants *that* region to widen. The
complement is the property the anchoring exists for: a playhead that is on
screen **stays** on screen, at every rung, because holding its offset from the
lane's left edge survives both end-stop clamps.

`=` / `-` rather than the `Mod+=` / `Mod+-` half of the convention, and this is a
hard constraint rather than a preference: `hardenWindow`
(`src/main/windows.ts`) consumes every Ctrl/Cmd +/−/0 at `before-input-event` to
kill Chromium's page zoom, which would otherwise shrink the whole application —
and that `preventDefault()` stops the keydown from reaching the renderer at all.
A chorded binding would look right in Settings → Keyboard and never fire. Bare
keys also stay dead inside text fields, so a minus still types into a numeric
inspector field.

Both are real commands (search palette, Settings → Keyboard, agent-callable) and
are **unscoped** — the timeline is the only zoomable surface in the app, so `=`
means the same thing whichever panel holds focus.

## Follow playhead

The timeline keeps the playhead on screen by **paging** its view: when the
playhead crosses to within 12 px of a viewport edge, the view jumps so the
playhead sits one lead (8 % of the viewport, min 12 px) inside the edge it
crossed. Geometry in
`apps/desktop/src/renderer/timeline/followPlayhead.ts`; the DOM side —
transient playhead subscription, one `scrollLeft` write per page — in
`hooks/useFollowPlayhead.ts`.

**Paging, not tracking.** Pinning the playhead to a fixed column and sliding
content under it would rewrite `scrollLeft` on every composition frame, and
each write publishes to `timelineScrollStore` and re-renders the ruler. A page
touches the view once per screenful.

**Forward vs backward are asymmetric.** Forward pages leave a lead behind the
playhead and a near-full screen of lookahead. Backward pages jump a full screen
so the playhead lands near the *right* edge — the gesture that ran it off the
left edge (stepping back a frame, seeking to the previous edit) is one the user
repeats, and a lead-sized jump would re-page on the next press.

**What moves the view and what doesn't.** Playback and jumps (shortcut seeks,
edit-point steps, timecode entry, palette navigation) follow. Two things
deliberately don't: a **ruler scrub drag**, because the user is aiming at a
point they can see and paging would move the target out from under the pointer;
and **zoom**, which owns its own anchor ([Timeline zoom](#timeline-zoom)) — the
follow only ever reacts to the playhead moving, never to the view changing
shape around a stationary one. That split is why a wheel tick cannot silently
re-anchor on the playhead, and why the keyboard zoom's playhead anchor is the
zoom's decision rather than the follow reaching in.

App-level pref `timeline_follow_playhead` (default on), so it is one answer per
machine rather than per project: View → Timeline auto-scroll, `Shift+F`, the
Quick Actions strip, or the search palette. Absent from an older
`app_settings.json` reads as **on**.

## Markers

A marker names a moment: a label, a colour, and a longer note. It belongs to
one composition, and it either sits at a time of its own — a **free marker** —
or **follows a clip**. Following is a field on the marker, not a second kind of
entity (ADR 0056): an anchored marker carries a layer of its own composition
plus a time in that layer's *source* window, and its `t_us` is re-derived from
the clip on every commit. So it travels with the clip through moves, trims,
splits and a crossing into a Group, and deleting the clip takes the marker with
it. `t_us` stays stored, which is why every reader of a marker — the lane,
`Ctrl+K`, export, MCP — is unchanged by any of this.

**The lane.** Markers live in one row directly under the ruler, never on the
ruler itself. That row belongs to the ruler family — it measures time, where a
track's lane holds layers — and it shares the ruler's quantised scroll window,
so a glyph and the tick under it are the same x forever. A point is an L on
its frame — stem on the left edge, foot running right under the name — so the
position is the painted edge rather than a diamond's centre; a region is a
capsule across its range, degrading to the same L below `MARKER_MIN_REGION_PX`
so a two-frame region does not vanish at fit zoom (the tooltip still carries
both ends). **An anchored L grows its stem; an anchored capsule fills** (a free
one rings), and names print beside a point or inside a capsule, so a mark is
readable without a hover. `markers_visible` (`M`'s own toggle, the View menu,
the Quick Actions strip) owns the whole row: off, the 20 px go back to the
tracks. `M` force-enables it, so authoring a mark brings the row back with it.

**Authoring.** `M` marks the playhead's frame; pressing it again on a marked
frame opens rename rather than stacking a duplicate (the FCP/Resolve
double-tap). An empty selection marks the *timeline*; a selection marks the
*clip*, on the primary — one instant is one mark. A playhead outside the
selected clip, or a clip whose kind carries no source window, falls back to a
free marker. Right-click a glyph for rename, delete, **Attach to clip** and
**Detach**; rows that do not apply are greyed, not hidden. Drag a glyph along
the lane to move it — one commit at release, snapping to clip edges and the
playhead, and a drag that lands where it started records nothing. Dragging an
anchored marker moves its *anchor*, so the mark keeps following from the new
offset; it clamps at its clip's edges rather than being allowed to hibernate
out from under the cursor. Shot detection writes anchored markers directly, so
a clip can carry its own cuts instead of being split by them.

**Hibernation.** Trim a clip past one of its anchored markers and the marker
*hibernates*: the clip no longer shows the frame the mark names, so it is kept,
painted nowhere, and revived on exactly that frame the moment the window covers
it again. It is a derived condition recomputed every commit, never a stored
flag, which is what makes undoing the trim enough to wake it. A *region* whose
clip is trimmed to end inside it is drawn only as far as the clip still runs;
the span it was given stays in the model, so re-extending the clip shows the
whole region again. Deleting the clip is the other case and behaves differently
— the marker is dropped, with a status-log row saying so. Detach is the
deliberate exit: it turns the mark back into an ordinary free marker at the time
it currently sits on, for when the note is worth keeping but the following is
not.

**Finding them.** `Shift+M` and `Mod+Shift+M` walk to the next and previous mark
of the timeline holding the keyboard, matching on where a mark *begins* — a
region merely spanning the playhead is not the current marker. Neither wraps:
the dead key at the end of the list is the signal that the list has an end. Both
are also `Ctrl+K` commands and rows on the ruler's right-click menu. `Ctrl+K`
searches marker labels and notes; hibernating marks are excluded there, having
no position to seek to.

**The Marker Panel** (closed by default; View → Marker) holds what marks *say*,
where the lane holds where they *are*: every marker in the project, grouped by
the composition that owns it, with label, colour and note editable in place.
Scope is project-wide on purpose — a mark inside a Group is otherwise invisible
from the root, which is the blindness the feature exists to close — and
activating a row opens that Group's timeline before seeking. Hibernating marks
get their own section, last and outside the time ordering, each showing where it
sits in the *footage* and offering Detach; this is the only surface one appears
on at all. On the parent timeline a Group clip carries a `⚑N` badge counting the
marks reachable inside it, nesting included.

**Limits.** Time is read-only in the Panel, free markers included: an anchored
marker's time is a cache the next commit rewrites, so a typed value would revert
under the cursor. Position is the lane's drag, and that is the one rule. A
region marker drags whole — its ends are not resizable by a gesture yet; the
only hand-reachable producer of one is *Detect silences…* (§ below), which
writes a region per silent range. Child markers are never projected onto a parent's
lane; the badge asserts a count and no position, because drawing a child
composition's contents on the parent would erase, visually, the boundary
ADR 0052 and ADR 0053 pay for.

## Shot review

Shot detection is the one analysis a person reviews before it lands, because
one candidate cut is verifiable at a glance — a frame pair either changes or it
does not — which is cheaper than undoing a whole split and starting over. The
review lives in the **Shots** Panel (View menu, or *Review shots…* on a
`VideoClip`'s context menu and in the palette; closed by default). Everything
it shows is a pure `reduce` over ONE whole-source scan
([ADR 0057](adr/0057-shot-detection-is-one-floor-scan-and-a-pure-reduce.md)):
ffmpeg scores every frame once at a fixed floor, and every threshold the
reviewer tries afterwards is a cache read, never a decode.

**The subject** is the primary selected `VideoClip`. A source whose scan is
cached renders its shots the instant the clip is selected; one that is not
shows an **Analyze** button and nothing else — clicking clips is the
highest-frequency gesture in the editor, so the Panel never scans on
selection. (The media pool's *Analyze shots* is the same scan as a warm-up.)
The scan is one status-log op, Started → Ok, and its failure sentence stays
inline.

**One row per shot**: a cover frame at the shot's own keyframe, its span and
duration on the composition clock, and — on every row but the first — the
candidate cut it opens on: the detector's score for that frame and the frame
pair either side of it, the one look that answers "is this a real cut".
Clearing a candidate's checkbox merges its shot into the predecessor; the
cleared boundary stays listed on the merged row so the merge is reversible.
A merged row shows no stats or flags, for the reduce's own reason: it is a
different shot from any the scan measured. (The floor scan is timing-only, so
in the current build every row's brightness / motion / sharpness cells read
as absent; a stats pass over the reduced spans is a separate, opt-in step.)
Clicking a row seeks the playhead to the shot's start. A second checkbox per
row, **keep**, defaults on: unchecking marks a shot for discard.

**The strip and the line.** Above the rows, a strip plots one tick per
candidate the floor scan emitted (x = source time, y = frame-change score)
and a horizontal, draggable threshold across it. Ticks above the line are the
boundaries the rows are built from; ticks below are what is being thrown
away — so the strip answers how many candidates are still outside the line,
and whether the source has any score separation at all. Dragging re-runs the
reduce and relays the rows live; the line cannot go below the floor, and a
window with no candidate says so instead of drawing a line over an empty
plot. The line is a keyboard slider too (arrows, Page, Home/End). No control
is labelled "sensitivity": the wire field of that name reads backwards
(higher = fewer cuts), so the axis is named by what it measures and the
control's meaning is its position. **Minimum shot length** is a separate
millisecond field, deliberately unlike the line: it fixes output granularity
(boundaries closer than it are dropped), not accuracy, and two look-alike
sliders would invite using one to fix the other's problem. Both persist per
project (`settings.shot_review`, `null` = the detector's defaults so no
threshold literal lives outside Rust) through the unrecorded settings patch,
so tuning never enters the undo stack.

**Three verbs**, one canonical list: *Split at cuts*, *Mark cuts* and *Split
and discard unchecked* all send the accepted boundaries — every row's opening
candidate, kept or not — through one channel, so a split and a mark of the
same review land on identical frames and a discard's survivors sit exactly
where a plain split would have cut. Each is one commit and one undo, the
discard included: undo restores the single pre-apply layer. A greyed verb
carries its reason in the tooltip (no interior boundary; nothing unchecked;
an apply already running). Unchecking every shot is refused by the channel —
erasing the clip is a delete, not an apply — and the refusal lands inline.
Two reviewed boundaries that snap onto the same composition frame are refused
for a discard, with the remedy (raise the minimum shot length), because the
row numbering the reviewer saw no longer matches the segments a split would
make. No confirmation dialog on discard: destructive-but-undoable is house
style, and the status bar reports what happened (Started → Ok/Err under one
`op_id`, the Started row carrying how much went out). The Panel keeps
following the selection afterwards: a split leaves the clip's identity on its
first segment, so that segment is what the Panel reviews next — one shot,
with no candidate inside its window — and the other segments are a click
away; a discard that removes the first segment leaves nothing selected and
the Panel returns to its empty state; after a mark the review stands. A
discarded take takes its link partners with it — every other member of the
clip's link overlapping the rejected span goes in the same commit, so a
rejected shot's paired audio leaves with the picture rather than staying behind
as a sliver. The same reach covers the agent's `drop_short_us`. What sits wholly
inside a kept segment — a lower-third over the surviving middle of a manual
bundle — stays.

**What is in each shot.** *Describe content…* — on a `VideoClip`'s context
menu beside *Review shots…*, in the Edit menu and the palette — runs
`describe_clip` over the clip with the tool's own two parameters (frames
sampled per second, default 1.0; focus, *general* or *shot type and camera*)
and lands the result as a column on the shot rows: each row shows the model's
prose for the stretch of source it covers, tags after it, and a segment that
straddles a detected boundary appears on both rows — the model and the
detector disagreeing about where the content changes is exactly the
correlation the column is for. Shots with no description read *Not described*
at the same row height; that is the ordinary state, not a failure. The
dialog says up front that this is a local model run of around twenty seconds,
and its run is Started → Ok/Err under one `op_id`, the Ok row naming the
engine and model that answered. The one failure with a remedy inside the app —
no video-understanding engine configured — grows a button to Settings → Video
understanding; every other refusal is the tool's own sentence. Selecting a
clip never describes it: the rows read the cached view through
`media://{id}/description`, which serves the default sampling and focus, so a
run at other settings is readable for the session and the dialog says so.
Descriptions are read-only here, and searchable from the palette (§ Global
search palette).

Code: `renderer/shots/` (`shotsStore.ts` owns the subject, the reduce, the
review decisions and the verbs; `shotRows.ts` projects spans into rows;
`ScoreStrip.tsx`; `ShotsPanel.tsx`), `styles/shots.css`; the reduce and the
floor scan are `native/src/jobs/shot/`, read through `analyzeShotsFloor` /
`reduceShotReport`; the verbs are the `apply_shot_cuts` hybrid in
`main/state/hybrids.ts` over `split_layer_multi` (with `discard_segments`) and
`add_markers`. Descriptions: `renderer/describe/` (dialog, eligibility, the
per-source store and the time-intersection join), `commands/describeCommands.ts`,
and `readMediaDescription` in `main/mcp/server.ts` behind the
`get_media_description` channel.

## Auto-caption and voiceover

Two speech operations the MCP prompts `/auto-caption` and `/voiceover`
already script for an agent are reachable by hand, through the same tools
([mcp.md](mcp.md) § Speech). Neither gets a review gate, and neither gets an
aggregate "AI" menu: each capability hangs off the object it acts on, which
is how every comparable NLE places them.

**Auto-caption clip…** sits on a `VideoClip` or `Audio` layer's context menu
(the two kinds whose media carries an audio stream — offering it over a
Color layer would be a row that can only refuse), in the Edit menu, and in
the palette. It is an `ACTION_DEFS` entry scoped to the timeline selection
with no default key, so a user who captions every clip can bind one in
Settings → Keyboard. The dialog has one optional field, the language hint
(blank = detect). Confirming runs `transcribe_clip` on the primary selected
layer's whole span, applies the returned `srt` as one caption-role track
(`add_caption_track`, so one undo removes every cue), and reveals the Caption
panel — a landed transcript is invisible until its editor is open. A greyed
row says why: nothing selected, wrong kind, a re-timed clip (`speed != 1`,
refused at the gesture before any audio is extracted), or a transcription
already running (a second concurrent run would bill a second request). The
transcript is edited in `CaptionsPanel`, per cue, which is strictly more than
a review list could offer ([captions.md](captions.md)).

**Voiceover…** is menu-only (Edit menu + palette): it acts on no clip, it
needs a script, so it must be reachable with nothing selected and a
rebindable key would bind to no object. The dialog carries the prompt's
parameters — script, voice (tts-1's six), speed — plus one addition, *where
it lands*: after everything else (the tool's own default, what an agent
gets) or at the playhead (what a person usually means), each printed as the
timecode it resolves to. The destination track is stated and then sent
explicitly even when it equals the hybrid's own default, so the track shown
is the track written. The 4096-character cap is enforced in the field with a
live counter, before any request. `speed` is omitted at 1.0 rather than sent
as `1`: the TTS cache keys an absent speed apart from an explicit one, and
sending it would bill a fresh request for a script an agent's default-speed
call already produced. A cost sentence sits above the button — this is the
one per-use paid action in the editor, and the content-addressed cache is
what makes a re-run of the same script free.

Both dialogs keep the tool's own refusal inline ("no transcription backend
available; configure one in Settings → Transcription", the payload cap, the
missing key) and stay open, so what was typed survives a fix in Settings;
each run is also two status-log rows under one `op_id`
([status-log.md](status-log.md)). Log rows carry the script's length, never
the script.

Code: `renderer/speech/` (eligibility, placement arithmetic, the two
dialogs), `renderer/commands/speechCommands.ts`; the main-process bridge is
`callClipComputeTool` in `main/mcp/server.ts` and the `clipCompute` route in
`main/state/router.ts`.

## Detect silences

The third authored prompt, `/cut-silences`, reaches a person as **Detect
silences…** — on the same audio-bearing clips as auto-caption (context menu,
Edit menu, palette; an `ACTION_DEFS` entry scoped to the timeline selection
with no default key), and it does exactly what the prompt now does: measure
and mark, never cut. Cutting needs a ripple delete this editor does not have,
and split → split → delete leaves a gap exactly as long as what it removed,
which is audibly identical to doing nothing.

The dialog carries the recipe's two parameters — the peak amplitude a sample
must stay under (shown with its dBFS equivalent, since that is the unit an
audio person reasons in) and the shortest gap worth marking, in
milliseconds. Every change re-detects, live: `detect_silences` walks the
pre-computed waveform peaks and decodes nothing, so a control that re-runs
per keystroke costs a cache read. The preview is a list, not a review Panel,
on purpose — verifying a silent range means listening to it, which costs more
than marking the set and deleting the marks you disagree with; what the list
answers is how much of the clip is silence and where (a count, a total, the
ranges as wall-clock times). A clip with nothing under the threshold says so
and the button greys; nothing is written.

**Mark silences** lands one region marker per range, in the clip's own
composition (a clip inside a Group marks the Group's timeline), anchored to
the clip at the source instant its range begins ([ADR 0056](adr/0056-following-a-clip-is-a-marker-field.md)):
a trim past a range hibernates its mark and re-extending revives it, and
deleting the clip takes them all. One commit, one undo for the whole set.
Silence marks are amber, a class apart from the shot-cut blue, because the two
producers routinely sit on the same clip and hue is the only channel left to
tell "the picture changes here" from "nobody is speaking through here". The
detection re-runs inside the same call at the dialog's parameters, so what
lands is the set the preview showed.

A fresh import's waveform may still be generating. That is a state, not a
failure: the dialog shows *Waiting for the waveform…*, listens for the
`media:job_complete` event with kind `waveform` for its own source, and
retries when it fires — the same instruction the authored recipe gives an
agent. Every run is two status-log rows under one `op_id`; a failure closes
the op and stays inline, so the parameters tuned survive a fix.

Code: `renderer/silence/` (the dialog and its prompt store),
`renderer/commands/silenceCommands.ts`; the shared audio-clip gate lives in
`renderer/speech/autoCaptionEligibility.ts`; the write is the `mark_silences`
hybrid in `main/state/hybrids.ts`, renderer-only because an agent already
has `detect_silences` and `add_markers`.

## Global search palette

`Mod+K` (also a menu item) opens a Spotlight-style overlay that searches,
in one box: **commands** (every user-invocable app action), **media-pool
items**, **tracks**, **clips** (timeline layers by label), **captions /
text** (`Text` layer content — captions are Text layers, ADR 0026),
**markers**, and **descriptions** (what a vision model said about a stretch
of a clip, text and tags alike — § Shot review). Selecting a result either
executes (commands) or navigates (everything else: select the item, move the
playhead, scroll the timeline). A description row is one described segment on
one placement of its source: activating it selects that clip and parks the
playhead where the described stretch begins; a described source that sits only
in the pool contributes no row, since there is no clip to select. The index
carries only what is already cached — opening the palette never runs a model.
Navigating never changes play state — seek-while-playing keeps playing, the
Premiere/Resolve convention. Chinese text matches three ways: original
characters, full pinyin ("zimu" → 字幕), and pinyin initials ("zm");
command entries index their en-US label as an extra haystack, so "export"
matches 导出 on a Chinese locale. Out of scope: effect parameters, keyframe
values, project-settings values, persistent search history.

**Stale-but-instant index.** Palette queries never block on indexing; they
always hit the last completed index (like an IDE search during re-indexing):

```
project:changed ─▶ debounce 300 ms ─▶ async full rebuild ─▶ atomic swap
palette open / keystroke ───────────▶ query the last completed index
```

Every rebuild is a full rebuild from the canonical `projectStore.summary`
snapshot, so ghost-entry / missed-update sync bugs are impossible by
construction. The corpus is one project's summary — single-digit
milliseconds on the main thread, cheaper than structured-cloning the
summary into a Worker (`buildEntries` is pure, so the Worker escalation
seam stays open). Pinyin haystacks are memoized per source string, which
makes full rebuilds behave like increments.

**Ranking & activation.** fuzzysort scores every haystack and keeps the
best per entry, with a floor that drops scatter matches and small boosts
for commands and exact prefixes; results group in fixed order (commands →
media → tracks → clips → captions → markers → descriptions, the last because
those are the only rows nobody wrote), capped per group with a
"show more" expander. Pinyin-matched results skip highlighting — fuzzysort
indexes don't map 1:1 onto CJK label chars, so no highlight beats a wrong
one. Media rows open a second level (reveal in pool + one row per timeline
usage). Activation re-validates ids against the live project; an entry
deleted since the last index build logs via LogBus and no-ops. `cmdk` was
rejected — its dialog binds Radix while the app is on Base UI, and
multi-haystack pinyin matching needs a custom filter anyway; the deps are
`fuzzysort` + `pinyin-pro`.

Code: `renderer/search/` (index store, matcher, pinyin, palette UI). The
command registry the palette executes from is
`renderer/commands/registry.ts` + `appCommands.ts`; navigation verbs live
in `renderer/state/navigation.ts`.

## Color picker (eyedropper)

One global pick session serves every color surface
(`renderer/colorpick/pickColor.ts`). At session start it freezes two
buffers — the composited preview via `extract.pixels` (working-space-true,
composition resolution) and a `capturePage()` window snapshot — then every
hover sample is a CPU read. The native `EyeDropper` API handles
whole-screen picks (`S` during a session); it returns only a color — no
coordinates, no hover — which is why it cannot carry the in-app session.

**Why the sample source is frozen:** chromakey hover live-applies the key
color while you move; sampling the live composite would read the keyed
result (the background), not the source pixel — a feedback loop. The
session freezes a pre-key frame (`excludeEffectId` disables that filter for
the freeze) and sampling never touches the live pipeline.

**Seams:** `previewSamplerRegistry` — PixiPreview registers capture/mapping
on mount; the picker never imports Pixi. `effectOverrides` — transient
per-effect param overrides + disable flags consulted by
`EffectChain.sync()`; never recorded, never in React state; PixiPreview
re-composites on every change so hover edits render while paused.
`AppColorField` — eyedropper button by default (`withEyeDropper={false}` to
opt out). Effect descriptors declare `colorGroups` (RGB scalar triplets);
the inspector commits all three tracks as one undo entry.

**Limits:** screen picks have no hover preview or custom magnifier
(platform API limit; `screenPick.ts` is the seam to replace with a
full-screen custom overlay). Under Electron the native dropper's magnifier
clips at the app window's edge and the pick click activates the clicked
foreign window (electron#27980; sampling itself is screen-wide and
correct) — `screenPick` snaps focus back after every pick as mitigation;
see `docs/notes/electron-chromium-behavior.md` § EyeDropper. The
composition buffer is an 8-bit extract — HDR/10-bit picks read the
tone-mapped value. The window snapshot is frozen at session start; UI
changes mid-session are not reflected.

## On-canvas transform (gizmo)

The primary selected layer shows its footprint as a box over the preview:
dragging inside the box moves it, handles on its corners and edges resize it, a
knob on a stalk above its top edge rotates it, and a target reticle at the pivot
moves its anchor. Only the four transform-bearing visual kinds get one (Color
fills the composition, Audio is not visual), and only while the playhead is
inside the layer's span. Resize means `scale` on three of those kinds and the
layout **box** on Text — see below.

**Why the box is an SVG overlay and not Pixi children:** `app.stage` is a
read-back surface — the eyedropper's `extract.pixels`, the e2e
`sampleComposite` hook and the conformance `captureFrame` PNG all read it, so
anything staged would land in those buffers. And the canvas is contain-fitted:
a box drawn in composition space would be sub-pixel on a 4K composition shown
in a small panel, while a screen-space overlay has handles in CSS pixels by
construction. (The ecosystem's Pixi gizmo, `@pixi-essentials/transformer`, is
also v7-only — it peer-depends on the `@pixi/*` sub-packages v8 removed.)

**Why the drag doesn't write per pointermove:** one write per move event is a
full renderer→main→`project:changed`→refetch round trip and would pile up undo
steps. The gesture instead sets a transient delta in `transformOverrides` (same
idiom as `effectOverrides`: consulted after `resolveView`, never recorded, never
in React state), and commits once on release through `updateLayerParamTracks`
(`update_layer_params` for a text box, which is a scalar and not a track) — one
batch, one undo. The override is held until the new summary arrives, so the
layer never snaps back for a frame between commit and refetch. The box itself
reads that same override map rather than the in-flight gesture's own state, so
the outline and the footprint it outlines cannot drift apart mid-drag whichever
handle is moving — and an anchor gesture, which moves four fields at once, lands
all of them on one frame.

**Why rotation writes one track and nothing else:** the engine rotates about the
anchor and `x`/`y` mean the *unrotated* top-left, so turning a layer about its
anchor moves neither — the commit is `rotation_deg` alone. A handle that rotated
about the box's visual centre instead would need compensating `x`/`y` in the same
batch, time-dependent on a keyframed layer.
The gesture accumulates per-move angle increments folded into (−180, 180°]
rather than diffing against its start angle: `atan2`'s ±180° branch cut would
otherwise read a +20° drag across the seam as −340°, and accumulating is also
what makes a multi-turn drag mean multiple turns. Shift snaps the resulting angle
to an absolute 15° grid while the true angle is kept alongside, so releasing
Shift resumes from the cursor rather than from the grid.

**Why the anchor target writes four tracks and the inspector field writes one:**
moving the anchor moves the pivot, and the pivot enters the composed position, so
an anchor change generally moves the picture. The canvas gesture is *pan-behind*
— it commits the anchor pair plus compensating `x`/`y` together, so the picture
stays exactly where it was and only the reticle moves. The inspector's `Anchor
X`/`Anchor Y` fields write the anchor alone, which does move a rotated or Text
layer; the split is deliberate and matches After Effects, and nothing else is
available to the panel, which has no natural size to compute a compensation with.
The compensation is zero for an unrotated, unflipped media layer, so the common
gesture writes two tracks and never stamps a redundant key on position. A drag is
converted client → composition → the layer's own *local* frame before it becomes
an anchor delta (the anchor is stored unrotated and unscaled), which is what keeps
the reticle under the cursor on a rotated layer. Both surfaces keyframe: the
anchor pair is `Animated` like the rest of the transform.

**Why a resize handle pins the anchor:** the handles scale the layer about its
anchor, matching After Effects and Premiere and matching what the reticle already
shows — the engine's own rotation and scale origin. That needs compensating
`x`/`y`, because the composed position is `(x, y) + |scale|·pivot`, so scale alone
would walk the pivot; pinning it is `Δ = pivot·(|scale₀| − |scale₁|)` per axis,
with no rotation term at all. It is the exact mirror of the anchor gesture: there
a media layer usually needs no compensation and Text always does, here Text needs
none (its position *is* the pivot) and a media layer always does. With the pivot
pinned the solve is direct rather than iterative — `scale·offset = R⁻¹·(cursor −
pivot)` — so the grabbed handle tracks the cursor exactly however the layer is
rotated, flipped or non-uniformly scaled.

A `scale_linked` layer shows its **corners only**. An edge handle there has no
honest behaviour: a single-axis write is what the twin invariant reads as
divergence, and it would silently clear the flag. Shift constrains proportions on
an unlinked layer by fitting one factor to the handle's own axes — the diagonal
projection on a corner, the plain axis ratio on an edge. Which axes a handle
drives comes from its identity and never from "its offset from the pivot is
zero": an off-centre anchor puts the top edge's midpoint off the pivot's column,
and inferring the mask there would let a horizontal drag scale it sideways.

**Why a Text layer's handles write a box instead of a scale:** a box lays glyphs
out, while `scale` magnifies an already-rasterized atlas — so a handle writing
`scale` would enlarge a title's *letters* and leave the inspector's font size
advisory (ADR 0049). The eight handles write `box_w`/`box_h` for Text instead, and
the font size stays what reaches the frame at any box size. It is the *same* solve
— the one that puts the handle under the cursor through rotation, the corner's
proportional constraint and the snap pull — read as a **factor** rather than
written as a scale:
`naturalSizeOf` reports a Text layer's box when one is set, so
`natural × solved/base` is exactly "resize the box by what the drag implies".
Box edges consequently snap with no extra machinery, since the box *is* the frame
the solve runs in. `scale_x`/`scale_y` keep their meaning and stay reachable from
the inspector and the keyframe lanes, so all eight handles are offered regardless
of `scale_linked` — a box's two axes are independent by construction, and the flag
keeps only its other job (one Scale lane vs two).

Three differences follow from the box being a plain params scalar rather than an
`Animated` track. It commits through `update_layer_params`, not
`updateLayerParamTracks` — there is no track to auto-key. It writes **no position
compensation**: `scaleCompensation` is zero whenever the origin is the anchor, and
Text's `x`/`y` *is* the anchor, so a box resize cannot walk the pivot the way a
media resize does. And its `transformOverrides` channel is **absolute**, the only
one in that map that is not a delta: every other channel adds to a track so a
keyframed layer keeps animating mid-drag, and with no track to add to the only
thing an override can carry is the value itself. That channel is what makes the
gesture legible — the sprite re-wraps, re-runs its shrink search and re-reports
its fit on every pointermove, so the wrap, the compression and the box stroke's
shrink/overflow colours all move under the cursor instead of arriving after the
commit. The cost is a glyph-atlas re-raster per gesture frame, deliberately
accepted and bounded on both sides (Pixi's measurement cache is capped;
`TextureGCSystem` reclaims the atlases).

Because the fold happens in the Compositor, the gizmo's outline and the picture
come from one source again — `naturalSizeOf` measures the *overridden* sprite —
so the box the handles sit on is the box being rendered, mid-drag included. The
gizmo still keeps a **box ledger** beside the track one, retired by the same rule,
for the thing a measured size can never report: the box's **nullability**, which
is the resize mode. A measured 640 px and a `box_w` of 640 are the same number and
different modes, so which axis a drag may leave alone, which rung a double-click
steps down, and which axes a patch may omit all read the ledger. Its second job is
to keep publishing the override until the summary lands, so the glyphs do not
reflow back to the pre-commit box in between.

The three resize modes are read off which box fields are set — `(null, null)` auto
width, `(set, null)` auto height, `(set, set)` fixed — so `(null, set)` is no mode
at all, and the gesture is one of the three places that prevents it: a top or
bottom edge drag **backfills `box_w`** from the width it measured in the same
commit (MCP refuses the pair, `TextSprite` coalesces it). A horizontal edge, by
contrast, never invents a height — that would drag an auto-height layer into fixed
and switch shrink-to-fit on. `box_w` floors at the 8 px shrink floor, which also
stops a drag past the pivot from flipping the box; flipping is what `scale` is
for. Double-clicking a handle steps back down the ladder — fixed → auto height →
auto width — which is why a *horizontal* edge double-click on a fixed layer drops
the height: releasing its own axis there would leave the illegal pair, so it takes
the rung above and a second double-click releases the width. The box stroke turns
`--warning` while shrink-to-fit is active and `--destructive` once the text
overflows at the floor, read back through `GizmoProbe.textFitOf`.

The handles are **round** so they carry no orientation to keep in sync with the
box: a square would have to be re-rotated every frame to match it, and on a
flipped or non-uniformly scaled layer — where the quad's winding reverses and its
edges stop being perpendicular — no single angle for it is correct. The direction
that matters is carried by the cursor instead.

Deltas below `1e-9` are dropped rather than committed. `Math.cos(±π/2)` is `6e-17`,
so anything downstream of the inverse rotation — a resize solve, an anchor drag —
leaves `~1e-16` on the axis the cursor did not move, and against exact zero that
reads as an edit and stamps a keyframe with an invisible value change.

**Why snapping decides the two axes independently:** a move or a resize pulls onto
the composition's four edges and two centre lines and onto every other staged
layer's screen-space bounding box, with each axis decided on its own. A single
global best — the right rule for the timeline, where time is one-dimensional —
would make "flush against the left edge *and* vertically centred" unreachable.
Ties go to a composition line, so a layer line has to be strictly nearer to win;
in the timeline an implicit tie-break is safe only because its boundary set has a
stable track order. Strength is a **screen**-pixel radius
(`preview_snap_strength_px`, default 12, with `preview_snap_enabled` beside it),
converted to composition pixels per move through the contain fit so the pull feels
the same at any composition resolution. It is deliberately its own app-level pair
rather than a reuse of the timeline's, whose target density differs by an order of
magnitude. Holding Ctrl suppresses the snap while it is down — not Alt, which
opens the self-drawn menu bar on Windows. Guides are magenta (the palette is
achromatic by design, and magenta's low green keeps it legible over skin, sky,
foliage and water alike), at most one per axis, painted under the box and the
handles with a dark under-stroke.

The solver is pure (`preview/previewSnap.ts`) and runs *before* the override is
written, against the gesture's raw un-snapped box: the box depends on the
override, the override on the snap result, and the snap result on the box, so
measuring after the write is the one ordering of those three that fails to
terminate. A free resize snaps the handle's **target point**, which is exact at
any rotation because the solve lands the handle on the point it was given
identically — masked to the axes the handle drives, since a scale the solve would
discard must not draw a guide first. A uniform resize (a linked layer, or Shift)
has one degree of freedom — `scale = t · scale₀`, so the handle travels a fixed
ray — which makes a snapped point generally unreachable; it solves `t` by
ray/line intersection instead, and at most one axis can be hit. That branch ranks
by the resulting **displacement**, not by perpendicular distance to the line: a
near-parallel ray needs an enormous `t` to reach a line a few pixels away, so a
nudge would become a 500× scale-up. The target set is frozen at pointerdown, so
guides do not follow layers that animate mid-gesture.

**Why a commit's base comes from a ledger:** every gesture commits an absolute
track built from `base + delta`, and the project mirror is two IPC round trips
behind — commit → `project:changed` → refetch → re-render. A second gesture
released inside that window would read the pre-commit base and *replace* the first
gesture's track instead of stacking on it. The gizmo therefore keeps a
renderer-local ledger of `param key → the track it wrote`, entered before the round
trip starts and read ahead of the mirror by every commit and by the rotation grid
(which would otherwise quantize a Shift-rotate against an angle no longer on
screen). The override carries the matching gap as a per-channel **carry**,
`resolve(written) − resolve(mirror)`, because `setTransformOverride` replaces
rather than merges: without it the next gesture's first pointermove drops the held
override and the layer visibly snaps back by the previous displacement. The carry
is self-cancelling — once the summary carrying the write lands, both tracks
resolve to the same value and every channel goes to zero — so the override lifts
itself, nothing has to decide when the round trip finished, and a summary arriving
mid-gesture just moves the carry into the base. The ledger is dropped on the first
summary that arrives with no commit still in flight, which is how undo, the
inspector or an MCP agent takes the authority back.

**Seams:** `gizmoProbeRegistry` — PixiPreview registers `canvasRect`,
`naturalSizeOf` and `textFitOf`; the gizmo never imports Pixi. `gizmoGeometry.ts`
— pure composition-space quad, pivot, handle placement and the
`object-fit: contain` mapping, so the geometry is unit-tested without a renderer
(and shares `anchorPivot.ts` with the renderer, which is what keeps box and
picture aligned). `centerInFrame.ts` — the layer-frame rule itself, shared with
the centering commands so the rectangle the gizmo outlines and the one "Center
horizontally" centres cannot be derived differently. `autoKeyTrack` — the shared
commit rule: a Static track takes a value, a Keyframed one gets a key at the
frame-snapped playhead, exactly like the inspector.

**Limits:** move, resize, rotate and anchor — no crop, no corner-pin. Single
selection only. The box follows animated values during playback via rAF; it is
hidden while the preview dock tab is not visible. The rotation knob sits a fixed
26 CSS px outside the box (screen space, so the affordance is
resolution-independent), so the overlay runs `overflow: visible` and the panel is
the real clip bound — a layer flush against the top of a panel-filling
composition has no room for its knob. An edge handle whose edge is under 24
screen px is hidden, since it would sit under the two corners it lives between; a
box small enough for its corners to overlap keeps them all, and the interior left
for the move drag shrinks with it. A Text box drag re-lays the glyphs out on every
pointermove that moves the box, which is a re-measure and a glyph-atlas re-raster
per gesture frame. The commit ledger is renderer-local, so it
composes a burst of gestures from this gizmo and nothing else: a *concurrent*
writer editing the same tracks mid-burst — an MCP agent, say — would need the
base resolved on the main side instead.

## Window geometry memory

The main window reopens at last session's position, size, and maximize
state, persisted to `<userData>/window_geometry.json` (`main/windowGeometry.ts`,
wired in `main/windows.ts`). Writes are debounced through drags and flushed
on window close and before quit. A move never dirties the Project or enters
undo — it is app-level state, like the Workspace layout.

**Restore is validated, never trusted.** A saved rect may name a monitor
that has been unplugged or a resolution that has shrunk, and this window is
frameless on Windows/Linux — no OS titlebar, no system Move menu — so an
off-screen restore would be unrecoverable without deleting the file.
`sanitizeGeometry` requires the rect to present a grabbable strip
(≥120×48px) on some display's work area, clamps the size to the host
display, and otherwise falls back to a centered default. A window
deliberately straddling two monitors or hanging past an edge survives;
that is a deliberate divergence from `electron-window-state`, whose
full-containment rule discards both.

**Landmine — the save/restore ratchet.** Electron's bounds API is not
idempotent on a fractionally-scaled display: hand a rect to the
`BrowserWindow` constructor and the value read back differs, because the
DIP↔physical conversion rounds in both directions. Measured at
`scaleFactor` 1.1, feeding each accessor's own output back into the
constructor grows the window monotonically — `ctor → getBounds` runs
1182 → 1189 → 1196 → 1202 → 1209, and `getContentBounds` /
`useContentSize` / `setBounds` all ratchet too, so no accessor pair fixes
it. Persisting what you measure therefore inflates the window every launch
until it hits the screen edge. The fix breaks the feedback loop instead:
`rememberGeometry` keeps persisting the rect it *requested* while the
measurement stays within `BOUNDS_DEADBAND_PX`, and abandons the deadband
permanently at the first genuine resize. `e2e/electron/window-geometry.spec.ts`
gates it by asserting three untouched launches leave byte-identical
geometry on disk.

**Also load-bearing:** capture `getNormalBounds()`, not `getBounds()` —
the latter reports the *maximized* rect, so persisting it makes "restore
down" a no-op next launch. Minimized windows are skipped (unreliable
bounds; `isMaximized()` reads false). Fullscreen is restored only on
macOS, where the green traffic light can also leave it; on Windows/Linux
F11 is dev-gated, so a restored fullscreen would be inescapable in a
release build.

**Landmine — restoring fullscreen must not pass `false`.** Electron reads an
explicit `fullscreen: false` in the constructor as "disable this window's
fullscreen capability": `isFullScreenable()` goes false, the macOS green
stoplight degrades to a plain zoom, and `setFullScreen(true)` becomes a
silent no-op. Since the saved flag is false on every normal launch, feeding
it straight to the constructor turned native fullscreen off for everyone.
The key is spread in only when actually true. Passing `undefined` disables
it just the same — only omitting the key works. Guarded by
`e2e/electron/window-chrome.spec.ts`.

## macOS window caption

The main window is frameless on Windows/Linux (the renderer draws
`<WindowControls/>`), but on macOS it uses `titleBarStyle: 'hidden'` and keeps
the OS-drawn traffic lights — so the green button gives real native fullscreen
and the window keeps its native rounded frame and shadow. Two things that
follow from that, both of which were wrong once:

**The inset comes from CSS, not IPC.** Each self-drawn bar
(`.app-header`, `.startup-titlebar`, `.perf-titlebar`, the agent-mode
titlebar row) starts its content at `env(titlebar-area-x)` and is at least
`env(titlebar-area-height)` tall — the real button geometry, published by
`titleBarOverlay: true`. The fallback in each `env()` covers every
no-overlay case (macOS fullscreen, and Win/Linux where there are no traffic
lights), so none of these rules needs a platform or fullscreen selector.
Driving the inset off the `enter-/leave-full-screen` IPC events instead is
what produced the visible bug: those land only *after* the fullscreen
animation, ~500ms after Chromium has already moved the buttons, so the title
overlapped them for the whole exit animation. `titleBarOverlay` is macOS-only
— on Windows the same flag has the OS paint native caption buttons over ours.

**Centring is one number, and it is derived.** The buttons occupy a 14px-tall
band whose top is `trafficLightPosition.y` (fractional values round to whole
points), and Chromium reports `env(titlebar-area-height)` as `2y + 14` — so the
band's centre is always exactly half that env value. The invariant that follows:
**a bar is vertically centred if and only if its own height equals
`env(titlebar-area-height)`**. Bars that size themselves to the env value
satisfy it for free; `.app-header` is the only one with a height of its own
(42.5px, content-driven), so `y = (42.5 - 14) / 2 = 14`. Getting this wrong is
not subtle — at the previous `y = 11` the buttons sat 3px high in the editor.

**The window's appearance must be declared.** macOS draws the traffic lights
through the *window's* appearance, so with `nativeTheme.themeSource` left at
`'system'` a light-mode host drew the INACTIVE buttons in light-chrome grey —
invisible against the `#0a0a0a` caption, making an unfocused window look like
it had no buttons at all. `color-scheme: dark` cannot reach them; it governs
only what Chromium paints. `themeSource = 'dark'` is set before the first
window, which also carries the dark appearance into native menus, sheets, and
the file picker.
