# ADR 0117: A tack is outdated when its range plays differently

Status: Accepted

Supersedes the Tack placement and lifecycle of
[ADR 0115](0115-agent-review-lives-beside-the-project-not-in-it.md): its edge
anchoring, its pinning to one clip (`anchor_layer_id`), its `stale` and
`hibernating` states and its shrinking ranges.
That a tack is runtime review state beside the project, its verbs, its panel,
its Review lane and its conversion into a marker remain in force.

## Context

ADR 0115 tied each end of a tack to the clip under it and remembered the
clips on those two tracks that its range overlapped. A tack was `outdated` only
when one of those remembered clips changed in more than a move. Anything else
in the range went unseen: a tack whose ends both sat over gaps remembered no
clip at all, so deleting the only clip inside it left it reading as current;
the other tracks, content added into the range, a clip moved out of it,
transitions and a Group's contents were never compared. The other way round,
trimming a clip's far end, outside the range, outdated it.

Three placement states (`visible`, `hibernating`, `stale`) on top of
`outdated`, three range kinds and an end that kept or lost its own clip made
the tack hard to reason about, for the user and for the agent, while still
not answering the one question a review comment needs answered: is what I
commented on still what plays here?

## Decision

**A tack is a comment on what plays in a time range.** At creation the store
records what plays in the range across every track of its composition: each
layer the range overlaps, the part of it inside the range (as offsets from
the range's start), the source instant that part starts at, every other value
of the layer, the tracks' order, the transitions touching those layers, and
— through a Group — what plays in the stretch of its composition the Group
shows. Markers are notes, not playback, and are not part of it; neither are
the preference-shaped track toggles review already excludes.

**Two states.** A tack is *current* while its range, where it now sits, plays
what it played at creation, and *outdated* (内容已修改) otherwise. Nothing else:
there is no stale, no hibernating, no shrinking. A deleted clip, a trim into
the range, an insert into a gap inside it, a clip moved out of it, a change on
another track, a retimed Group's contents — each outdates it. A trim, a move
or any edit wholly outside the range does not.

**The range keeps its length and moves with its content.** Its position is
its created position moved by as far as its content moved, read from the
first covered layer, in track order, that still shows the content its covered
part started on — by source time for a layer with a source window, as an
anchored marker follows, and by its offset into the layer for a title, colour
or image. A ripple upstream moves the whole range and leaves it current. There
is no choosing which layer: content that moved together moved every covered
layer alike, and content that did not is outdated whichever layer placed it —
the choice could only change where an outdated tack is drawn. When no covered
layer still shows its content the range stays at its created position, and is
outdated, since what it covered is gone. Only a tack whose composition no
longer exists has no place: it is listed, outdated, and cannot be located or
converted.

Undo that restores the content restores the tack to current: the state is
derived on read, never latched.

## Considered options

**Keep ADR 0115's covered-clip list, extended to every track.** Rejected: a
list fixed at creation cannot see content added into the range or moved out
of it, which is half of what changes a range.

**Compare whole layers.** Rejected: a trim of a clip's far end changes the
layer but not one frame inside the range.

**Track the range through every edit without following content.** Rejected
for the reason ADR 0115 gave against mapping positions through edits; and a
range fixed on the clock would read every upstream ripple as a change.

**Keep `anchor_layer_id` to choose the followed clip.** Rejected: under the
rule above the choice never decides whether a tack is current, only where an
outdated one is drawn — a parameter whose effect an agent cannot see.

**Let a range over nothing but gap follow its neighbours.** Rejected: it would
add back a placement rule for the one case with no content to follow.

## Consequences

- `TackView` loses `state` and `range.kind`; a tack's place is null only when
  its composition is gone. `follows` names the layer the range moves with now
  (with its source instant when it has a source window), or null — used to
  locate, outline and convert a tack, not shown as a field of its own.
- `create_tacks` takes no `anchor_layer_id` and returns no `follows`.
- `affected_tacks` reports `moved` or `outdated`; `tacks_to_review` lists the
  client's open outdated tacks.
- A tack made over nothing but gap follows nothing and keeps its timeline
  time. It is outdated as soon as anything plays there — whether put there,
  which is what such a tack is about, or carried in by a ripple upstream,
  which is the cost of not giving gaps a placement rule.
- An outdated tack cannot be made current again except by restoring the
  content; to comment on the new content, the agent deletes it and tacks
  again.
