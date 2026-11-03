---
status: accepted
---

# Audio mixes by role, not by track

Date: 2026-06-17

## Context

Tracks are kind-agnostic and a combined row holds a camera's picture and its
dialogue together. Per-track Mute/Solo (Premiere's control model) only ever
gated audio, yet sat on rows that read as video, so on a combined row a user
could not tell what M/S acted on. Per-track controls also cannot express the
operations editors reach for — "duck all dialogue", "solo the music" — which
cut across tracks. A Premiere-style separate audio track stack would double
the lane count (a 2-camera interview: 2 rows → 4) and undo the kind-agnostic
track model.

## Decision

- Each Audio layer carries an `AudioRole` (Dialogue — default — Music, SFX,
  Voiceover). `Project.audio_roles` holds one `RoleMixSettings { gain_db,
  muted, solo }` per role; an absent entry is unity, unmuted, unsoloed. A role
  is the mix bus; the Role Mixer owns M/S/gain.
- The bus is realized by **folding**: role gain multiplies into each member
  layer's gain envelope; role mute and the solo set (mute wins over solo)
  filter which layers are mixed. No per-role summing stage or DSP exists.
- `Track.muted` / `Track.solo` are not audio gates. They still serialize and
  accept patches (back-compat); `Track.enabled` (picture and audio) is the only
  whole-track gate.
- Role gain is a recorded edit (`set_role_gain`); role mute/solo
  (`update_role_flags`) are unrecorded, applied to every history snapshot, so
  undo never flips a mixer toggle.

## Consequences

- The track header has only eye and lock.
- Export planner and preview gate share one role predicate (`role_audible` in
  the eval leaf) and one gain fold, under a cross-language golden.
- A real processing bus (`RoleMixSettings.effects`) would need role gain moved
  off the layer envelopes, a per-role summing stage in export, and non-skip
  gating for effect tails; none exists.

Rejected: per-clip-only gain (no handle for a category); separate audio track
stack with bus assignment (doubles lanes); audio-only M/S shown on rows that
carry audio (still per-row, still no cross-track grouping).
