// apps/desktop/src/main/mcp/instructions.ts
// What `initialize` tells a client about using this server: the session
// etiquette in ten lines. Every MCP client reads `instructions` on connect,
// with or without the shipped skill installed, so this is the one message
// that reaches an agent before its first call. Both transports send it: the
// app's HTTP server (`server.ts`) and the `weftcut` binary on stdio, which
// embeds the data file below, so the text is one source at one version.
//
// The etiquette lines head the shipped skill (`skills/weftcut/SKILL.md`, "In
// ten lines"), pinned equal by `instructions.test.ts`, so a client that has the
// skill reads one etiquette, not two. The closing line is the server's alone:
// it names the version, which a skill copy carries as `metadata.version`
// (stamped by `scripts/build-skills.mjs`), so an agent holding a copy from
// another release can tell, and points at the served skill (`skillResources.ts`),
// which needs no copy and cannot be stale. Per-tool facts stay in
// the tool descriptions; the long form stays in the skill and docs/mcp.md.
// Kept under a size a session pays without noticing — the test caps it.

import text from '../../../cli/instructions.json'

/// The etiquette lines. The text is data in the `weftcut` binary's module
/// (`apps/desktop/cli/`), which embeds the same file instead of keeping a copy;
/// LANDMINE: it must stay in that directory, the only place `go:embed` reads.
export const MCP_INSTRUCTION_LINES: ReadonlyArray<string> = text.etiquette

/// The `initialize` instructions of a server at `version`: the etiquette, then
/// the line that makes a stale skill copy detectable (`closing` in the data
/// file, its `{version}` filled in).
export function mcpInstructions(version: string): string {
  return [...MCP_INSTRUCTION_LINES, text.closing.split('{version}').join(version)].join('\n')
}
