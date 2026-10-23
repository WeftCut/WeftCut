// apps/desktop/src/main/mcp/instructions.ts
// What `initialize` tells a client about using this server: the session
// etiquette in ten lines. Every MCP client reads `instructions` on connect,
// with or without the shipped skill installed, so this is the one message
// that reaches an agent before its first call.
//
// The SAME lines head the shipped skill (`skills/weftcut/SKILL.md`, "In ten
// lines"), pinned equal by `instructions.test.ts`, so a client that has the
// skill reads one etiquette, not two. Per-tool facts stay in the tool
// descriptions; the long form stays in the skill and docs/mcp.md. Kept under a
// size a session pays without noticing — the test caps it.

export const MCP_INSTRUCTION_LINES: ReadonlyArray<string> = [
  "WeftCut is a desktop video editor; the user watches the same project live, and every edit you commit lands in their undo history. A video the user asks you to edit is the project open in WeftCut, named or not.",
  "1. Read `project://tracks` (or `read_project` with view \"tracks\") before your first edit. Ids come from reads, never from memory.",
  "2. Every mutator answers with the committed record (minted ids, the span as it landed, `adjusted` for a grid snap); verify from it before reporting.",
  "3. A refusal (isError) names the cause and the fix: act on it, never retry the call verbatim.",
  "4. Times are microseconds on the frame grid: off-grid times are snapped and echoed, times outside their layer refused.",
  "5. Call `create_checkpoint` before your first edit. For a batch (rough cut, pause pass, captions): ask the user, then `begin_agent_session`, `set_history_lock` around the batch, `dry_run` where supported, and `end_agent_session` when done, on failure too.",
  "6. Others may edit concurrently; when a commit fails for that, re-read and reapply.",
  "7. Export: `start_export`; poll `get_export_status` for the completed output_path.",
  "8. Edit the project open in the app; never create one unless asked. With none open, project tools refuse: `open_project` or `create_project` the one the user named, else ask.",
  "The weftcut skill (Settings > Agent) carries the long form, common flows and the Motif contract.",
]

export const MCP_INSTRUCTIONS = MCP_INSTRUCTION_LINES.join('\n')
