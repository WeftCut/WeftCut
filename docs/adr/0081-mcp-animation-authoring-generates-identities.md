---
status: accepted
---

# MCP animation authoring generates identities

Bulk animation tools exposed the persisted keyframe record, including its ID.
The TypeScript writer accepted arbitrary strings while native export deserialized
keyframe IDs as UUIDs. A project could therefore preview, save and reopen but
fail at export preflight. Clients also had to supply tangent boilerplate for
an ordinary two-key linear animation.

## Decision

MCP authoring inputs describe time, values and optional curves. WeftCut owns
identity allocation, using the actor's injected UUID generator. `set_param_track`
and the temporal tracks inside `set_position` accept keys with only `t_us` and
`value`. Defaults are Linear segments, identity Free tangents, Broken continuity
and Hold/Hold extrapolation. Optional tangent/segment/continuity records retain
precise authoring and use the existing solver. Times retain their current contract:
timeline-absolute in `set_param_track`, layer-local in `set_position`.

`set_position` also allocates spatial node IDs. A node needs only its point;
handles default to zero, segment to Line and tangent mode to Corner. Path node
IDs remain strings in storage; generating them is an authoring simplification,
not a new native UUID requirement for spatial geometry.

Caller-supplied IDs, including valid UUIDs copied from a read result, are refused
on these bulk authoring inputs. Every full replacement generates fresh identities,
so these tools are not advertised as idempotent. Their results expose the committed
keys/position, including generated IDs and snapped times. Undo/redo restores the
committed identity records rather than generating them again.

Read records retain IDs. `set_keyframe` already owns insertion IDs and updates an
existing key at the same time; `update_keyframe`, `delete_keyframe` and targeted
`smooth_keyframes` still address identities learned from reads. Bulk callers copying
read results must omit `id`, `t_local_us` and `preset_id` while retaining the authored
time/value/curve fields they need.

`update_effect` accepts static parameter values or removal, matching its advertised
purpose. Effect animation uses the same keyframe tools as other parameters; the
unadvertised second bulk-animation entry through effect patches is refused.

The stored project format and internal editor operations keep full records and IDs.
Project loading rejects a non-UUID keyframe ID with its layer/parameter location,
before the native export boundary. It does not silently regenerate IDs or alter
animation values. Existing affected projects require a deliberate data repair.

## Compatibility and verification

This is an intentional MCP input-contract break under ADR 0074, not a stored-schema
change. Reconnecting clients receive the new schemas; stale calls fail explicitly.
The packaged skill and MCP documentation teach the smaller authoring inputs.

Regression coverage crosses the public MCP dispatcher, committed readback,
undo/redo, project loading, schema discovery and native export preflight. The
native-gated test uses synthetic content: generated keys pass the real preflight,
while the same project with a malformed key ID reproduces the original error.
