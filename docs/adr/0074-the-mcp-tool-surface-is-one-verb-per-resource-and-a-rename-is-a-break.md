---
status: accepted
---

# The MCP tool surface is one verb per resource, and a rename is a break

The tool surface had grown to 95 tools by adding one tool per gesture: a
keyframe had `retime_keyframe`, `set_keyframe_easing` and
`set_keyframe_tangents`, each addressing the same key by the same three ids and
each changing one aspect of it; a link had `links_add_members`,
`links_remove_members` and `links_rename`; unpinning a composition's duration
was a tool of its own beside the `update_composition` that pins it. Removals
were spelled `remove_*` on six tools and `delete_*` on four, and the link and
group families were noun-first (`links_create`, `groups_ungroup`) against the
`<verb>_<resource>` rule the design doc states. Every one of these is a name an
agent has to guess before it can search, and every one is a description the
catalog carries on every session.

## Decision

**One tool per resource per verb.** A resource that can be changed in more
than one way gets one `update_*` tool with optional fields, applied in a
documented order inside one commit: `update_keyframe { t_us?, easing?, in?,
out?, continuity? }`, `update_link { add_layer_ids?, remove_layer_ids?, label?,
reassign? }`. Where a field's set and clear are the two halves of one control,
the tool takes `null`: `update_composition { patch: { duration_us: null } }`
unpins, and `fit_composition_to_layers` is gone.

**The verb is first, and a removal is `delete`.** `delete_track`,
`delete_media`, `delete_effect`, `delete_transition`, `delete_marker`,
`delete_keyframe`, `delete_link`; `create_link`, `create_group`,
`add_group_members`, `ungroup_layer`, `rename_composition`. The internal actor
op names behind them (`remove_media`, `links_create`, `groups_ungroup`, …) do
not move: the tool table maps one to the other, and the production IPC keeps
its vocabulary.

**A rename is a break.** None of the twelve renamed or seven merged names keeps
dispatching under its old spelling. The retired-name table
(`RETIRED_MCP_TOOL_NAMES`) was built for the earlier premise that an agent may
hold a stale catalog indefinitely; it stays for the four names it already
carries and takes no new entries. The catalog a client re-reads on connect is
the whole contract, and a `unknown tool` on a dropped name is a cheaper failure
than two names for one tool in every agent's context for the life of the
product.

**The wire is snake_case, all the way down.** A motion path's nodes were the
one camelCase island — `inHandle`, `outHandle`, `tangentMode` — because the
renderer authored them first and the model kept its spelling. They are
`in_handle`, `out_handle`, `tangent_mode` now, in the model, the Rust mirror,
the `set_position` argument and the `project://layers/{id}` read alike, with
no schema-upgrade step: a project saved with Path-mode positions before this
change fails validation on load and is re-authored, which is the cost accepted
over carrying two spellings of one field through the upgrade chain.

**Reads have a tool-shaped fallback.** Every read is a `project://*` resource,
and a client that cannot read MCP resources could not read the project at all.
`read_project { view, id?, composition_id? }` serves the same views through the
same function the resource read uses, so the two cannot disagree; the
resources stay the primary path.

## Consequences

- 95 tools become 91; the merged tools' contracts move into one description
  each, and `docs/mcp.md`, the shipped skill, the agent-panel labels and the
  tests follow the new names in the same commit. The catalog budget gate
  (`mcp.description-budget.test.ts`) keeps the surface from growing back by
  gesture.
- A client holding a prompt written against the old names fails loudly on its
  first call and re-reads the catalog. That is the trade: an `unknown tool` per
  stale client once, against a longer catalog for every client always.
- The order inside `update_keyframe` — retime, easing, sides with `out` last,
  continuity — is part of the contract, because a Smooth request re-derives
  `in` from the `out` just written.
