// apps/desktop/src/main/mcp/instructions.ts
// What `initialize` tells a client about using this server: the session
// etiquette in ten lines. Every MCP client reads `instructions` on connect,
// with or without the shipped skill installed, so this is the one message
// that reaches an agent before its first call (audit S13 found it empty).
//
// The SAME lines head the shipped skill (`skills/weftcut/SKILL.md`, "In ten
// lines"), pinned equal by `mcp.instructions.test.ts`, so a client that has the
// skill reads one etiquette, not two. Per-tool facts stay in the tool
// descriptions; the long form stays in the skill and docs/mcp.md. Kept under a
// size a session pays without noticing — the test caps it.

export const MCP_INSTRUCTION_LINES: ReadonlyArray<string> = [
  "WeftCut is a desktop video editor; the user watches the same project live, and every edit you commit lands in their undo history.",
  "1. Read `project://tracks` (or `read_project` with view \"tracks\") before your first edit. Ids come from reads, never from memory.",
  "2. Every mutator answers with the committed record: the ids it minted, the span as it landed, `adjusted` for any grid snap. Verify from that answer before reporting.",
  "3. A refusal is an isError result whose text names the cause and the fix. Act on it; never retry a rejected call verbatim.",
  "4. Times are microseconds on the composition's frame grid: an off-grid time is snapped and echoed, a time outside its layer is refused.",
  "5. Call `create_checkpoint` before your first edit. For a batch (a rough cut, a pause pass, a caption track): ask the user, then `begin_agent_session`, `set_history_lock` around the batch, `dry_run` where supported, and `end_agent_session` when done, on failure too.",
  "6. The user or another agent may edit concurrently; when a commit fails for that reason, re-read and reapply.",
  "7. Export is not a tool: point the user to the app's Export UI.",
  "The weftcut skill (Settings > Agent) carries the longer etiquette, the common flows and the Motif authoring contract.",
]

export const MCP_INSTRUCTIONS = MCP_INSTRUCTION_LINES.join('\n')
