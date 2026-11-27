---
status: accepted
---

# DeepSeek Harness gets a plugin the app writes

Date: 2026-11-27

## Context

ADR 0167 has the app register the server: Settings → Agent shows each host the
entry for its own config. For DeepSeek Harness that entry was a
`cordis.patch.yml` row the user pasted. ADR 0168 puts the preview in a page
the host's side browser shows.

A Harness plugin can do more than a config entry. Read from the Harness
0.2.2-rc.5 source and then run there:

- A browser half can add a right-sidebar tab type, a card on the sidebar's
  new-tab page, and a row for one tool's calls (`tool.call.toolview`).
- A Host half can register a slash command whose handler calls any
  registered tool through the tool registry, with no model turn and no
  approval: `open_side_preview` answers in milliseconds, and with the app
  closed `launch_weftcut` starts it.
- A plugin added by path is linked, not copied. When its files change, the
  running Harness serves the new browser half at the page's next load and
  runs the new Host half from its next start; it does not restart the
  plugin's server.
- With the plugin's `weftcut` row and the pasted one in the home patch, the
  plugin's takes the name; the pasted one fails with "already in use", which
  the Harness logs and boots past.

A plugin has to reach the user somehow, and ADR 0167 names the costs of a
package handed to many machines: it cannot name the per-profile binary
without a lookup frozen into installed copies, and its version drifts from
the app's.

## Decision

- **The app writes the plugin.** At every start, beside `<userData>/cli/`, it
  writes `<userData>/dsh-plugin/`: a generated `package.json` at the app's
  version, a generated `cordis.patch.yml`, and plain JS from
  `apps/desktop/dsh-plugin/` bundled into main. Files whose content is
  already right are left alone.
- **The plugin carries the entry.** Its patch inserts the stdio row
  (`serverName: weftcut`, the profile's binary, `mcp`), so 0167 holds: the app
  registers the server. The Harness tab in Settings → Agent shows the folder
  and `dsh plugin --profile web add <folder>` in place of the pasted row.
- **For the Harness, this amends 0167's "a plugin carries content only".**
  That rule is about a package handed to many machines; this one is written
  per machine by the app, so its entry and code name this profile and match
  this version.
- **The preview is a sidebar tab** framing the companion page (0168),
  present only while the tab is in view.
- **`/weftcut` opens it**, from the tab's Open WeftCut button or the
  composer: `open_side_preview`, or `launch_weftcut` first when the app is
  closed. The plugin calls the server's own tools, so what "closed" and "start"
  mean stays the binary's.

Rejected:

- **An npm package.** It would need a lookup of the profile inside the
  plugin, duplicating the binary's, a publishing step, and a plugin version
  apart from the app's, which 0167 already rejects for a launcher.
- **The plugin registering the server at run time** (`mcpManager.register`
  with a found path): the same lookup, for nothing the written patch lacks.
- **Keeping the pasted row beside the plugin**: two ways to one server, and
  a second `weftcut` server whenever both are present.

## Consequences

- One step connects the Harness and gives it the preview; the plugin then
  follows the app's updates without the user: its page half at the Harness
  page's next load, its Host half at the Harness's next start.
- The plugin is not listed in any plugin market, and is added per machine.
- A profile with the older pasted row logs a failed second `weftcut` server
  at every start until the user removes it; the panel and the plugin's page
  say so.
- It needs Harness 0.2.2-rc.5 or later in 0.2.x, the version its seams were
  run against.
