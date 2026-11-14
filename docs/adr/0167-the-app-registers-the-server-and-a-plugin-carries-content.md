---
status: accepted
---

# The app registers the server, and a plugin carries content only

Date: 2026-11-15

## Context

A host's config starts WeftCut's MCP server by naming `<userData>/cli/weftcut`
(ADR 0165), a path that differs per user and per OS. A package handed to many
machines, an agent plugin, has no way to name it:

- The Agent Plugins spec allows `command` to be a bare name or a `./` path
  inside the plugin, expands nothing in it, and has no per-OS field. Codex
  enforces this.
- A bare `weftcut` on `PATH` fails where it matters: a program started from
  the macOS Dock gets `/usr/bin:/bin:/usr/sbin:/sbin`.

The one static option left is a launcher inside the plugin, a shell script
plus a Windows exe that finds the profile copy. Measured, it starts in Codex
CLI 0.167 (Windows, macOS) and Claude Code 2.1.325. It costs:

- an unsigned exe distributed through a git repository;
- a lookup path frozen in installed copies that never update;
- two connected `weftcut` servers in Claude Code 2.1.325 as soon as the user
  has also added the server by hand;
- review: the hosts' official directories hold a plugin's compiled executables
  for review, and Claude's chat and Cowork refuse a plugin with a top-level
  `bin/`.

Hosts also differ in config format, config file and what they can show beside
the chat. The Connect agent panel knew four clients, written into the
component.

A marketplace is a repository. Measured with Claude Code 2.1.325 and Codex CLI
0.163: installing a plugin from a `git-subdir` source fetches only that
subdirectory, but adding the marketplace clones its whole repository, Codex
with full history. This repository is too large to be one.

## Decision

- **The app registers the server.** Settings → Agent shows each host the
  entry for its own config, the profile copy's absolute path and `mcp`, and
  the host's command that writes it where there is one.
- **Host differences are data.** One table (`shared/agentHosts.ts`) holds per
  host its config format and file, whether that file takes an HTTP entry, and
  its preview surface: a view in its side panel, a page in its side browser, or
  none. The surface is what the host's desktop app offers; a terminal session
  of the same host has none. The panel's tabs and the host block of
  `docs/mcp.md` come from the table, and no other code names a host.
- **A plugin carries content only.** `plugins/weftcut/` holds a Claude
  manifest, an Agent Plugins manifest and one small skill with no version in
  it: read the served skill (`skill://weftcut/SKILL.md`) before the first tool
  call, and when the `weftcut` tools are missing, send the user to Settings →
  Agent. No MCP server, hook or executable, so it installs where local servers
  and bundled binaries are refused.
- **Its version pins its content.** The two manifests agree on name, version
  and description, and `content.lock.json` records a hash of the files per
  version; `npm run check` fails on a difference.
- **The catalog is a separate, very small repository** whose `marketplace.json`
  has one entry: a `git-subdir` source naming this repository and
  `plugins/weftcut`.

Rejected:

- **A launcher inside the plugin**, for the costs above.
- **`weftcut` on `PATH`**: hosts started from the macOS Dock do not see it.
- **The full skill inside the plugin**: it is tied to the app version and would
  need a plugin release for every app release; the app already serves the
  running version's copy.
- **The catalog in this repository**: every user adding it would clone it.

## Consequences

- Installing the plugin does not connect anything: the user still adds one
  entry from Settings → Agent, and the plugin's skill says so when the tools
  are missing. A session then has exactly one `weftcut` server.
- The plugin changes only when its own files do, not per app release. The
  catalog needs no edit either: a host moves to a new plugin version when the
  manifests' `version` changes.
- Rewriting a recorded hash for an unchanged version passes the check; only
  review catches it.
- A new host is a table row and a regenerated doc block.
- No code reads the surface yet; the preview stages will.
- This replaces ADR 0165's consequence that a package naming the command
  without a path had to wait for `weftcut` on `PATH`.
