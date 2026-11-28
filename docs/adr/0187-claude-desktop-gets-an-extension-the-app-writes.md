---
status: accepted
---

# Claude Desktop gets an extension the app writes

Date: 2026-11-28

## Context

ADR 0167 has the app register the server: Settings → Agent shows each host the
entry for its own config. For Claude Desktop that entry was an `mcpServers`
block the user pasted into `claude_desktop_config.json` by hand, followed by a
restart of Claude: it has no command that writes the entry.

Claude Desktop installs extensions (`.mcpb`, a zip with a `manifest.json`).
Measured with Claude Desktop 6.28899.6 (Linux), with a bundle holding only a
manifest and an icon, whose `server.type` is `binary` and whose
`mcp_config.command` is the absolute path of the profile's `weftcut` binary
with `mcp`:

- Claude registers itself for `*.mcpb`. Opening the file with the OS starts
  Claude's install preview, then a native confirm. The extension installs, enables itself and connects with no
  restart. A path with a space works. Unsigned, it gets only the generic
  warning every local extension gets.
- Installing unzips a copy into Claude's own folder, under the id
  `local.mcpb.<author.name>.<name>`, slugged, with no version in it. The copy
  does not change until the user opens a bundle again. Same id with another
  `version` offers Update, replaces the copy and keeps its settings; the same
  version offers only Uninstall.
- Claude keys the server by `display_name`, else `name`, case-sensitive. A
  config entry under another key runs as a second server. With a pasted
  `weftcut` entry loaded, installing an extension keyed `weftcut` left one
  server, the pasted one, both at once and after a restart.

The MCPB 0.3 schema requires `manifest_version`, `name`, a semver `version`,
`description`, `author.name` and `server` with `type`, `entry_point` and
`mcp_config`. A semver prerelease made only of digits may not start with 0.

## Decision

- **The app writes the extension.** At every start, beside `<userData>/cli/`,
  it writes `<userData>/claude-desktop/weftcut.mcpb`: a generated manifest and
  the icon from `apps/desktop/claude-extension/`, nothing executable. The zip
  has fixed timestamps and order, and the file is replaced only when its bytes
  differ.
- **The manifest carries the entry.** `server.mcp_config` is the stdio entry
  (the profile's binary, `mcp`), and `entry_point` names the same binary, so
  0167 holds: the app registers the server.
- **Its key is the server name.** `name` is `weftcut` and there is no
  `display_name`, so the extension and a pasted entry share one slot and never
  run as two servers. `name` and `author.name` (`WeftCut`) are fixed: they make
  the id.
- **Its version follows its content.** `1.0.0-c` and the first 12 hex digits
  of a SHA-256 over the manifest without its version and the icon. An app
  release that leaves the bundle unchanged offers no Update.
- **The Claude Desktop tab hands over the file.** It shows the path, with
  Open in Claude Desktop, which opens the file with the OS, in place of the
  pasted JSON. It says that a `weftcut` entry pasted before takes the
  extension's place until removed.
- **For Claude Desktop, this amends 0167's "a plugin carries content only"**,
  as 0183 did for the Harness: the rule is about a package handed to many
  machines, and this one is written per machine by the app.

Rejected:

- **A published bundle carrying the binary.** A second copy of the binary per
  Claude install, updated only through Claude's Update, apart from the
  profile copy every other host runs; and a lookup of the profile, frozen
  into installed copies, for everything that copy does not carry.
- **Keeping the pasted JSON beside the extension.** Two ways to one server,
  and the pasted entry silently wins wherever both are present.

## Consequences

- One click and Claude's confirm connect Claude Desktop, with no restart and
  no file to edit.
- Claude runs its installed copy. A rewritten bundle, from a changed profile
  path or a release that changes the manifest or the icon, reaches Claude only
  when the user opens the file again and accepts Update; the binary the copy
  names is refreshed by the app as before.
- A profile with a pasted `weftcut` entry keeps running that entry, which may
  name another binary, until the user removes it; the tab says so.
- Where Claude Desktop is not installed, Open in Claude Desktop leaves the file
  to whatever else the OS opens it with, or to nothing; a failure is only
  logged, and the path stays on screen.
- Measured on Linux only. macOS and Windows, removing the extension in Claude,
  and Claude's organisation allowlist and signature policy have not been run.
