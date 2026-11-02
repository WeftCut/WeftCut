---
status: accepted
---

# A tack is outdated when its range plays differently

Date: 2026-10-17

## Context

Tacks first anchored each end to the clip under it and remembered the clips
on those two tracks that the range overlapped; a tack was outdated only when
a remembered clip changed in more than a move. That missed most of what
changes a range — a tack over gaps remembered nothing, so deleting the only
clip inside left it "current"; other tracks, content added into the range, a
clip moved out, transitions and Group contents were never compared — while
trimming a clip's far end, outside the range, outdated it. Three placement
states (`visible`, `hibernating`, `stale`), three range kinds and per-end
anchoring made tacks hard to reason about for user and agent alike, without
answering the one question a review comment needs: is what I commented on
still what plays here?

## Decision

- **A tack comments on what plays in a time range.** At creation the store
  records, across every track of its composition, each overlapping layer's
  part inside the range (offsets from the range start), the content time it
  starts on, the values that affect playback, track order, touching
  transitions, role gain, and — through a Group — what plays in the Group's
  shown stretch. Keyframe times are compared from the range start; only
  interpolation segments intersecting the range count; fades count by
  layer-local time, so a trim outside the range can still change a fade
  inside it. Markers, labels, locks and preference toggles are not playback.
  `main/agent/rangePlayback.ts` owns the comparison (with `playbackValues.ts`).
- **Two states**: *current* while the range, where it now sits, plays what it
  played at creation; otherwise *outdated*. Derived on read, never latched:
  undo that restores the content restores current.
- **The range keeps its length and moves with its content**: displaced by as
  far as the first covered layer (track order) that still shows its covered
  content moved — by source time for a layer with a source window, by offset
  for titles, colours and images; in µs, without frame snap, so audio on the
  sample grid stays put. A ripple upstream moves it and leaves it current. If
  no covered layer shows its content it stays put and is outdated; a tack whose
  composition is gone is listed, outdated, and cannot be located or converted.

## Consequences

- `TackView` has no `state` or range kind; `follows` names the layer the range
  moves with now (or null). `create_tacks` takes no `anchor_layer_id`.
  `affected_tacks` reports `moved` or `outdated`; `tacks_to_review` lists the
  client's open outdated tacks.
- A tack over pure gap follows nothing and is outdated as soon as anything
  plays there, including content carried in by an upstream ripple.
- An outdated tack becomes current again only by restoring the content; to
  comment on new content the agent deletes it and tacks again.

Rejected: extending the covered-clip list to every track (cannot see content
added or moved out); comparing whole layers (a far-end trim changes no frame
in range); tracking the range through edits without following content (every
upstream ripple would read as a change; timeline edits are entity operations,
not axis operations); keeping `anchor_layer_id` (it only changes where an
outdated tack is drawn); a placement rule for gap-only ranges.
