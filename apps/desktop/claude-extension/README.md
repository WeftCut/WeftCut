# WeftCut for Claude Desktop

The icon of the Claude Desktop extension WeftCut writes. The extension itself
is not in this folder: every time WeftCut starts, it writes
`claude-desktop/weftcut.mcpb` into its profile folder. That file holds a
manifest whose server runs the `weftcut` program WeftCut installed on this
computer, and this icon. Nothing executable is inside.

## Use

1. In WeftCut, open Settings > Agent > Claude Desktop and press Open in Claude
   Desktop.
2. Claude Desktop shows the extension; press Install. Its tools are available
   at once, with no restart. If WeftCut is closed, the agent can start it.

If you added a `weftcut` entry to `claude_desktop_config.json` by hand before,
remove it: Claude runs that entry in place of the extension.

Claude Desktop keeps its own copy of what you install. When WeftCut changes
the extension, opening the file again offers Update.

The manifest and the bundle are built by
`apps/desktop/src/main/mcp/claudeExtensionInstall.ts` (ADR 0187).
