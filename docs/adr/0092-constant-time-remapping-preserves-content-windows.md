---
status: accepted
---

# Constant time remapping preserves content windows

Video, Audio, animated images, Motifs and Group instances support a positive
constant rational playback rate. The inspector's Timing group offers Playback
rate, Retimed duration, Reset to 1× and the Audio/Group Preserve pitch policy.
The existing Duration field still trims. Explicit target IDs are the complete
batch; links never expand a retime request.

A retime keeps starts and selected content endpoints. It snaps the new end to
that clip's frame/sample grid, derives the actual rate from the snapped duration,
and scales its own animation keys and fades by the actual duration ratio. Keys
keep their IDs, normalized curves and exact time remainders, including keys
outside the visible span. Child animation records remain unchanged. The pure
planner is shared by inspector and actor; commit recomputes from live state and
rejects the complete batch on collisions, locks, illegal transitions, nested
selected targets or unrepresentable rational arithmetic. Transitions retain
their duration and provenance, and neighbours stay fixed.

Schema 3 persists an Affine time_map and fractional remainders next to integral
source/key/fade coordinates. Images and Motifs have an unwrapped content_window;
image looping happens only at frame sampling. Rust i128 arithmetic is shared
with TypeScript through Wasm. Nested composition clocks compose rational maps
before a final decoder/frame/sample boundary. Trim keeps the rate; split retains
the mapping and re-bases the right side without discarding fractional keys.

The schema 2 migration discards VideoClip.speed and installs rate 1. The old
field never affected playback, so promoting it to an active rate would change
old projects. Timeline geometry and Motif props.speed are untouched. No legacy
speed report or compatibility UI is exposed.

Audio uses immutable 48 kHz PCM stems shared by preview and export. Each Audio
scope stretches its selected effect-processed source once, applies its own
envelope, then mixes into child role stems. Each enclosing Group stretches
those stems once with its own pitch policy; role routing is preserved and role
gain is applied once outside. Pitch is preserved by default. Unavailable media
or preparation failures hold playback/export rather than substituting raw audio.

FrameSampling is the implemented preview/export mode. FrameBlending and
OpticalFlow are reserved and explicitly unavailable. Retimed Groups can be
entered and edited, but ungrouping and membership changes require rate 1.
This extends ADR 0052's original offset-only composition clock.
