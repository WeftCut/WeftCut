// apps/desktop/src/main/mcp/toolAliases.ts
// Inbound-only compatibility for MCP tool names that have been renamed.
// Owns the retired→advertised table and the request rewrite; owns nothing about
// what the catalog says — an alias is never advertised, which is the whole point
// (see `mcp.tool-aliases.test.ts` for the pin).

/** Tool names a previous release advertised, mapped to the name the catalog
 *  advertises now. An agent that cached the old catalog, or a prompt written
 *  against an earlier release, keeps working; the catalog still teaches exactly
 *  one name per tool, so nothing new learns the retired spelling.
 *
 *  An entry is permanent. Removing one turns a working call into `unknown tool`
 *  for every agent that never re-read the catalog, which is the failure this
 *  table exists to prevent — the cost of keeping one is a single map lookup.
 *
 *  The table is CLOSED to new entries (ADR 0074): since the one-verb-per-resource
 *  pass, a rename is a break like a merge — the old name is dropped and the
 *  catalog the client re-reads is the whole contract. The four below predate
 *  that decision and stay for the clients that learned them. */
export const RETIRED_MCP_TOOL_NAMES: Readonly<Record<string, string>> = {
  // `add_motif` read as a sibling of `install_motif` (which adds a motif to the
  // app) when it is in fact a sibling of `add_video_layer` (which adds a clip to
  // the timeline).
  add_motif: 'add_motif_layer',
  // A bare noun in a family whose other three members are verb-first
  // (`list_checkpoints`, `restore_checkpoint`, `delete_checkpoint`), and the
  // name the production op already carried.
  checkpoint: 'create_checkpoint',
  // Partial-patch semantics, which `update_*` names on this surface and `set_*`
  // does not — `set_*` replaces one named value.
  set_composition: 'update_composition',
  compositions_delete: 'delete_composition',
}

/** The advertised name for `name`, which is `name` itself unless it is retired. */
export function resolveMcpToolName(name: string): string {
  return RETIRED_MCP_TOOL_NAMES[name] ?? name
}

/** Canonicalize a `tools/call` request's tool name in place of the caller's.
 *
 *  Applied at the request boundary, AHEAD of the log/activity wrapper rather
 *  than inside the dispatcher: the row that wrapper writes is filtered and
 *  labelled by tool name (`agent_panel.tools.<name>`, keyed by the advertised
 *  set), so a retired name reaching it would log a tool the catalog denies
 *  exists. Downstream — routing, the actor arms, the label — only ever sees the
 *  advertised name. The request is copied, never mutated: it is the SDK's. */
export function withCanonicalToolName<T extends { params?: { name?: string } }>(req: T): T {
  const name = req.params?.name
  if (name === undefined) return req
  const canonical = resolveMcpToolName(name)
  return canonical === name ? req : { ...req, params: { ...req.params, name: canonical } }
}
