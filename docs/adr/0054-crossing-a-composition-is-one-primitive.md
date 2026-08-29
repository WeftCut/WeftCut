---
status: accepted
---

# Crossing a composition is one primitive; the caller names the landing

## Context

A layer belongs to the composition it was created in. Every layer-addressed
command derives its scope from the layer's own id, so a destination in another
composition is a refusal — `CrossCompositionMove` for a move's target track, a
restack's anchor or a paste's target lane, `CrossCompositionSet` for a set whose
members straddle two.

Against that, the ops that *do* cross were built one at a time, each around the
gesture that reached it. Pre-compose mints a composition around a set. Ungroup
dissolves one and CLONES every member, replacing every layer, link and
transition id. Add-to-Group moves layers DOWN into a composition the parent
already shows, and takes its landing from the Group clip's own placement. Three
ops, three shapes, and between them one direction is missing: **no path exists
that puts a layer into an arbitrary composition.** A clip cannot move UP out of a
Group except by dissolving it, and it cannot move SIDEWAYS at all.

Two compositions can be on screen at once (ADR 0053), which makes the gap a
gesture: carry a clip from one timeline Panel into the other. Every part of that
channel already existed — the drag knew which foreign composition was under the
pointer, froze its ghost there, sent nothing on release, and said why in the
status bar. All of it was wired to a `no`.

The observation that unlocks the rest is that **add-to-Group and the cross-Panel
drag are one operation seen twice.** Both take a set of layers, a destination
composition and a time. They differ only in who names the time.

## Decision

1. **One primitive, `applyMoveLayersToComposition`, addressed absolutely.** It
   takes the set, the destination composition, an ANCHOR member, that anchor's
   landing time on the destination's clock, and an optional destination lane.
   `applyGroupsAddMembers` keeps its command, its MCP tool and its history label,
   and shrinks to: validate the Group clip, compute the absolute landing,
   delegate.

2. **The landing is absolute, not an offset — and the reason is about who may
   compute it.** An absolute time is only safe to derive where the value it
   derives from is current. The pointer always is. A Group clip's `t_start_us`
   read from the renderer's project mirror is not: that mirror lags two round
   trips, and a relative `base + delta` computed against it eats the previous
   commit. So *Add to Group* computes its landing in the MAIN process from the
   authoritative project, and the drag computes its landing in the RENDERER from
   the pointer. Each hands the primitive one number. The signature is also
   homomorphic with `applyMoveLayer(p, id, newTrackId, newTStartUs, escapeLink)`,
   the in-composition move it stands beside, and it reads as the sentence the
   feature is.

3. **The anchor carries the set's geometry.** `anchorLayerId` is the member the
   landing positions; every other member keeps its phase relative to it. That is
   what preserves the set's mutual geometry, which is in turn what keeps a
   transition between two moved members alive. Destination lanes are assigned per
   SOURCE TRACK rather than per member for the same reason: members of one source
   track never overlap each other except by an authorized transition overlap, so
   moving a track's whole block onto one lane preserves their relationship
   exactly. Per-member placement could bounce one of a transition's two
   participants elsewhere, and the project-wide reconcile inside every commit
   would then silently drop it.

4. **`destTrackId` is three-valued, and the fork is refuse-versus-bounce.** A
   lane id means every block lands there and a locked or occupied lane is
   REFUSED. `'spawn'` mints one fresh lane. `null` means the caller has no
   opinion: prefer the destination's k-th lane, else bounce to a free one, else
   spawn. The rule behind the fork is the ghost. **A menu has no ghost, so
   bouncing is honest for it; a drag has one, so bouncing would make the ghost a
   lie.**

5. **Three refusals stay with the caller that holds a Group clip**, because they
   are about the clip and not about the crossing: `CrossCompositionSet` when the
   members are not the clip's siblings, `WrongLayerKind` when the named layer is
   not a `CompositionRef`, and `RootComposition`. **`RootComposition` is the
   trap.** It reads as "the root does not receive layers", and it is not — it
   guards against a `CompositionRef` pointing at the root. The root is an
   ordinary destination, and moving a clip out of a Group and back into the film
   IS a move to the root. It is one of the two directions this feature exists
   for.

6. **`GroupLockedMember` keeps its name.** It is Group-flavoured and the
   primitive is not, but renaming it is a breaking error code across the command
   errors, the MCP surface, the formatter and two locales, in exchange for
   nothing a reader gains. Its doc comment widens instead: one locked layer
   refuses the whole set, never its unlocked half.

7. **In the renderer, ownership follows the coordinate system.** Each timeline
   Panel owns its own zoom, scroll, frame grid, snapping targets and lane
   geometry, so **only the Panel under the pointer can turn that pointer into a
   landing.** The destination resolves the drop, draws the preview and commits
   it; the host stands down. A host that borrowed the destination's units would
   be re-implementing them at a distance, and the two copies would drift. The
   same routing question serves both parties: the host asks "is another Panel
   under the pointer" and withholds every destination of its own while the answer
   is yes; the destination asks "is it me" and claims.

8. **The gesture's state leaves React.** A drag lived in one Panel's React state,
   which no other Panel can read, and which re-rendered every lane, sub-lane and
   chip per pointermove. It moves to a module-level store holding only the ARMED
   half — the un-armed half stays in a ref, where it cannot render anything, so
   "a pending gesture draws nothing" is structural rather than a condition every
   reader has to remember.

9. **A module store has a blast radius that Panel state did not.** Every mounted
   timeline reads every gesture. Subscribers keyed on a layer or track id are
   safe, those ids being project-unique; a subscriber that asks "is a drag
   happening" is not, and must ask "is one of MINE happening" against the
   gesture's own composition. Without that gate a second timeline arms its drop
   strip, shows a grabbing cursor, and drives the monitor — on its own frame
   lattice — for a gesture in its neighbour.

10. **The preview may not promise what the commit refuses.** Two consequences
    fall out of that. A locked LINK MEMBER travels with the drag's description of
    its subjects, because the destination holds no summary to discover it in and
    the same set already refuses at home. And the set stops at composition zero
    as ONE body rather than each member clamping where it lands: the primitive
    refuses a member before zero outright and never clamps, on the grounds that
    sliding a set off the picture it was placed against is not a repair.

11. **Alt+drag across Panels is refused at the gesture.** A copy mints ids, and
    the paste it would lower to links clones to each other and never back to
    their sources. That is a second mutation, not a parameter of this one. The
    status log carries the refusal — this app prevents rather than interrupts —
    and names the same drag without Alt as the way through, because a refusal
    that only said no would send the user looking for a capability they have.

## Considered options

**An offset-valued primitive.** Rejected: the drag would have to reverse a
subtraction across two time bases. Its pointer names a position on the
destination's axis, and turning that into an offset means subtracting a source
time the destination does not hold — the very read that decision 2 exists to
avoid.

**Absorbing `groups_add_members` into one command.** Rejected: its landing
derives from the Group clip's placement, so a renderer-side caller would be a
read-modify-write against a mirror two round trips behind. The two callers differ
in *where their input is current*, which is exactly the thing a single command
could not express.

**Bouncing an explicit lane, as the lane-less case does.** Rejected: the drag
draws a ghost on the lane the pointer names. A bounce would land the clip
somewhere the user was never shown, which makes the ghost a lie — and the ghost
is the whole explanation for what release will do.

**A window-level floating ghost, drawn once and reparented.** Rejected: zoom is
per Panel, so the source's px/sec draws the same clip a different length in the
destination. Recomputing the width is not polish; it is the difference between
showing a duration and lying about one.

**Letting the drag reuse `groups_add_members` when the destination happens to be
referenced by a Group clip in the source.** Rejected: a gesture's promise is its
position, not the blood relation between two compositions. The user pointed at a
time; add-to-Group would land the clip at the one that preserves its screen
position instead.

**Per-lane claiming in the destination, mirroring the media-pool drop.** Rejected:
a media drop is HTML5 drag-and-drop, whose events land on the destination's own
elements, so a lane can claim one for itself. A clip drag is pointer-driven and
the host owns the window listeners, so a destination lane receives no events at
all and would have to subscribe to the pointer to notice anything — waking every
lane on every event, which is the cost decision 8 exists to remove. One leaf per
Panel claims instead.

## Consequences

- **Four ops cross compositions, not three**: pre-compose, ungroup, add-to-Group
  and `move_layers_to_composition`. That count is asserted in prose in several
  places and has to be maintained there.
- **`move_layer`, `duplicate_layer`, `paste_layers` and `restack_layer` keep
  refusing.** The discipline is intact and unchanged: a *move* never crosses.
  Crossing has a name, and it is not "move".
- **A landing is now computed in the renderer**, which is a new place for one to
  be computed and a new thing to be careful about. What makes it safe is that the
  value it derives from — the pointer — is current there and nowhere else, and
  that nothing in the path is a `base + delta` over a value the op itself writes.
- **Cross-fps round trips are not identity.** The landing re-snaps on the
  DESTINATION's grid, so A → B → A need not return a layer to the microsecond it
  left. This is the existing property of the frame grid (ADR 0037, ADR 0038)
  rather than a new defect, but it is now reachable by a gesture.
- **Markers stay in the source composition.** They belong to a composition, not
  to the layers under them.
- **No Group clip is retrimmed.** A destination that grew changes the overhang of
  every Group clip showing it (ADR 0052 §6); widening a window stays the user's
  own act.
- **Two entry points now disagree about the selection, deliberately.** The drag
  takes the selection and the keyboard to where the clips landed; the menu clears
  the selection and stays. The difference is the pointer: a gesture that named a
  place may move the view there, a menu item that never left its Panel may not.
