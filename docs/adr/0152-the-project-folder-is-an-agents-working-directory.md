---
status: accepted
---

# The project folder is an agent's working directory

Date: 2026-10-28

## Context

Users start coding agents (Claude Code, Codex, Cursor, others) inside a project
folder and expect to mention a media file, edit TASTE.md and read the project
from there. The app serves any MCP client, and no mechanism for learning the
client's working directory is shared by all of them:

- MCP roots: few clients implement them; the draft spec deprecates them.
- `CLAUDE_PROJECT_DIR` is set by Claude Code alone.
- @-mentioning a resource is a client feature that tools-only clients lack.

Tools are the one surface every client has, and every agent hands the model a
path when a user mentions a file.

## Decision

- **A relative path is read from the open project's folder.** `import_media`
  takes an absolute path or one relative to the project open in the app
  (`importSource.absoluteSource`). The app never tries to learn the client's
  working directory. With no project open, or nothing at the path, the call is
  refused naming the folder and asking for an absolute path. A Windows drive
  path is absolute on every host.
- **The agent checks its folder is the open project.** `project://session`
  reports `project.dir`; the initialize instructions tell an agent whose folder
  holds `project.json` to compare and ask if they differ.
- **The folder's files change only through tools, TASTE.md aside.** The app's
  autosave would overwrite a hand edit of `project.json`; `Media/` files are
  recorded by path and bytes, so they are never renamed, moved or overwritten
  (ADR 0153); `Cache/` is derived. TASTE.md is the one hand-edited file
  (ADR 0126); `project://taste` reports its path before it exists. The
  initialize instructions carry the rule in one sentence.
- **A mentioned file is matched by importing it** (ADR 0151). No lookup tool.
- **Each pooled file is a resource, `media://{id}`**, listed by
  `resources/list` with `listChanged` notifications. Reading it returns a short
  card (record, `path_rel`, placing layers, sub-resources);
  `read_project { view: "media", id }` returns the same card for tools-only
  clients. Nothing depends on this enhancement.

## Consequences

- The same steps work in every client; resource-capable clients also let the
  user pick a media item by name.
- `resources/list` grows with the pool.
- The folder rule costs initialize-instruction characters; without it an agent
  in the folder edits `project.json` while the app autosaves.
