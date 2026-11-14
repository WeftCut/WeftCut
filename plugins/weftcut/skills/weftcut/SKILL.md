---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools. Use BEFORE calling any weftcut MCP tool, and whenever the weftcut MCP server is connected and the user wants a video or clip edited — cut, trim, tighten, remove pauses, add captions, titles, lower thirds or callouts, cut a social version — even if they do not name WeftCut; also to author or update a Motif (animated overlay). Also when the user asks for WeftCut and its tools are missing.
---

# WeftCut

WeftCut is a desktop video editor. You edit the project open in the app over
its `weftcut` MCP tools while the user watches it live. The full guidance
comes from the running app, so it always matches the installed version; this
page only gets you there.

## Before your first tool call

Read the full skill and follow it for the rest of the session:

- the MCP resource `skill://weftcut/SKILL.md`, or
- where your client cannot read resources, the tool call
  `read_project { view: "skill" }`.

It names the files beside it (`skill://weftcut/<path>`, or `read_project`
with `view: "skill"` and that `path`) when a task needs them. If you also have
a copy of the full skill installed, the app's served copy wins.

## When the weftcut tools are missing

If none of the `weftcut` MCP tools are available, this host is not connected
to WeftCut. Do not look for another way in. Tell the user:

> Open WeftCut, go to Settings → Agent, pick this app's tab and add the
> configuration it shows. Then start a new session here.

If the only `weftcut` tools are `weftcut_status` and `launch_weftcut`, the
host is connected but the app is closed: call `launch_weftcut`, then read the
skill as above.
