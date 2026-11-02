// apps/desktop/src/main/mcp/instructions.ts
// What `initialize` tells a client about using this server: the session
// etiquette in ten lines. Every MCP client reads `instructions` on connect,
// with or without the shipped skill installed, so this is the one message
// that reaches an agent before its first call. Both transports send it: the
// app's HTTP server (`server.ts`) and the stdio shim (`src/cli/shim.ts`), which
// bundles this file, so the text is one source at one version.
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

export const MCP_INSTRUCTION_LINES: ReadonlyArray<string> = [
  "WeftCut is a desktop video editor; the user watches the same project live, and every edit you commit lands in their undo history. A video the user asks you to edit is the project open in WeftCut, named or not.",
  "1. Read `project://tracks` (or `read_project` view \"tracks\") before your first edit; ids come from reads, never memory.",
  "2. Every mutator answers with the committed record (minted ids, the span as it landed, `adjusted` for a grid snap); verify from it before reporting.",
  "3. A refusal (isError) names the cause and the fix: act on it, never retry the call verbatim.",
  "4. Times are microseconds on the frame grid: off-grid times are snapped and echoed, times outside their layer refused.",
  "5. For a batch (rough cut, pause pass, captions): ask the user, then `begin_agent_session` (it checkpoints and locks the user's undo; `lock: false` opts out) and `end_agent_session` when done, on failure too.",
  "6. Others may edit concurrently; when a commit fails for that, re-read and reapply.",
  "7. Export: `start_export`; `get_export_status { wait_s }` for the completed output_path.",
  "8. Edit the project open in the app; never create one unless asked. With none open, `open_project` or `create_project` the one the user named, else ask. A folder with project.json is a project; if it is not the open one (`project.dir` in `project://session`), ask. Its files change only through tools, TASTE.md aside.",
]

/// The `initialize` instructions of a server at `version`: the etiquette, then
/// the line that makes a stale skill copy detectable.
export function mcpInstructions(version: string): string {
  return [
    ...MCP_INSTRUCTION_LINES,
    `Skill (long form, Motif rules): \`skill://weftcut/SKILL.md\` or \`read_project\` view "skill"; a copy whose \`metadata.version\` is not ${version} is stale.`,
  ].join('\n')
}
