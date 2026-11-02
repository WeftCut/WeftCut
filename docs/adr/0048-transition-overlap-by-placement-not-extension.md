---
status: accepted
---

# Transitions open their overlap by placement, not extension, and the record remembers what was borrowed

Date: 2026-09-07

## Context

A transition needs its two participants to overlap for its duration. The
overlap can come from only two places: extra source material past the outgoing
clip's out point (extension), or moving the incoming clip left by the duration
(placement — FCP's "Full Overlap"). Extension plays material outside the range
the user cut, overwrites the outgoing clip's exit frame to `out + duration`, and
makes hitting a target frame a reverse calculation. Both arrangements render
identically, but their inverses differ, and the state did not record which one
had been made: removal always shrank the outgoing clip, trimming real content
whenever the overlap was not born from extension.

## Decision

- **Placement is the default.** `add_transition` moves the incoming layer (and
  its link siblings, each on its own lattice) left by the frame-rounded
  duration, measured backward from the cut. A shifted sibling that collides on
  its lane bounces to a free lane, spawning one if needed. The vacated span
  stays a gap; nothing ripples implicitly. Extension exists only behind an
  explicit `placement: 'extend'` and the chip's right edge — never a default or
  a fallback.
- **`extended_us` records the borrow.** The transition stores how many µs of
  the outgoing tail it borrowed (0 for placement and pre-positioned adds, the
  full duration for an extend add), so the outgoing clip's cut end is always
  `end − extended_us`. Removal shrinks the outgoing clip by `extended_us`,
  moves the incoming clip right by the remainder, and refuses
  (`TransitionRestoreCollision`) when that destination is occupied.
- **Implicit duration changes prefer the cut.** Presets, the inspector and
  patches omitting `extended_us` never grow the borrow; a shrink returns
  borrowed material before moving the incoming clip. Only the chip's right-edge
  drag and an explicit `extended_us` grow it. A negative `extended_us` patch
  returns the whole borrow and then trims the tail, in one commit (the stored
  value stays `0 ≤ extended_us ≤ duration_us`).
- **The chip owns the window's edges.** Its left edge moves the incoming clip;
  its right edge is the outgoing clip's actual end. Bare participant edges are
  not grabbable inside the window; reconcile-on-commit stays the backstop.
- **Refusals before any id is minted:** participants sharing a link
  (`TransitionParticipantsShareLink`), a moved member crossing t = 0
  (`NegativeLayerStart`), duration over `min(len_A, len_B)`
  (`TransitionDurationOutOfRange`). `TransitionInsufficientHandle` applies to
  extend paths only.

## Consequences

- Removal can refuse where it used to silently trim content.
- `(duration_us, extended_us)` fully determine both window edges; every mix of
  edge drags is reachable and invertible with two numbers.
- Ripple and gap closing move transitions by re-deriving both values from the
  landed overlap (features.md § Ripple delete).

Rejected: extension as default with a handle-consumption display (the range
violation, not the display, was the problem); closing the vacated span
implicitly (moves layers the user never touched); a placement enum instead of a
counter (two-edge drags produce mixed provenance); a second add gesture for
extend (the right edge is that path).
