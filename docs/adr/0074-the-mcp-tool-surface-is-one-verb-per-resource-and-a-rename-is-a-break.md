---
status: accepted
---

# The MCP tool surface is one verb per resource, and a rename is a break

Date: 2026-09-17

## Context

Every client reads the whole tool catalog into context on every session, so
each tool and description is a standing cost for every agent. The surface had
grown to 95 tools by adding one tool per gesture (`retime_keyframe`,
`set_keyframe_easing`, `set_keyframe_tangents` all addressing one key), with
mixed `remove_*`/`delete_*` and noun-first names (`links_create`) an agent had
to guess. A retired-name alias table had been started on the premise that
agents hold stale catalogs indefinitely, but every alias keeps two names for
one tool in context for the life of the product.

## Decision

- **One tool per resource per verb.** A resource changed in several ways gets
  one `update_*` with optional fields applied in a documented order inside one
  commit (`update_keyframe`: retime, easing, sides with `out` last,
  continuity). A field's set and clear are one tool taking `null`
  (`update_composition { patch: { duration_us: null } }` unpins).
- **`<verb>_<resource>`, removals are `delete_*`.** Internal actor op names
  (`remove_media`, `links_create`) do not move; the tool table maps them.
- **A rename is a break.** A renamed or merged tool does not dispatch under
  its old name; the client gets `unknown tool` and re-reads the catalog.
  `RETIRED_MCP_TOOL_NAMES` keeps its four pre-existing entries and takes no
  new ones.
- **The wire is snake_case throughout**, including motion-path nodes
  (`in_handle`, `out_handle`, `tangent_mode`), with no schema-upgrade step for
  the old camelCase spelling.
- **Reads have a tool fallback**: `read_project { view }` serves the
  `project://*` views through the same function as the resource, for clients
  that cannot read resources.

## Consequences

- `mcp.description-budget.test.ts` caps descriptions and the catalog byte size,
  so the surface cannot grow back by gesture; a new tool is first checked
  against an existing tool's arguments.
- A stale client fails once per dropped name, instead of every client paying
  for aliases always.
- Projects saved with camelCase Path-mode positions before the change fail
  validation on load and must be re-authored.
