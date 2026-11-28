# WeftCut for DeepSeek Harness

Connects WeftCut's MCP server and shows WeftCut's side preview in a right-sidebar
tab: the project's timeline, player controls, export progress and, on request,
a live picture of the edit. The page reads the project and drives the player;
it never edits.

WeftCut writes this plugin into its own profile folder every time it starts,
so it always matches the WeftCut you have installed.

## Use

1. In WeftCut, open Settings > Agent > DeepSeek Harness. It shows this
   plugin's folder and the command that adds it:
   `dsh plugin --profile <profile> add <folder>`, or Plugins > Add plugin with
   that folder.
2. Open the WeftCut tab from the sidebar's new-tab page and press Open WeftCut,
   type `/weftcut`, or ask the agent to open the preview. If WeftCut is closed,
   it is started first.

If you added a `weftcut` entry to a `cordis.patch.yml` by hand before, remove
it: this plugin carries that entry, and the old one only logs an error at
every start.

After WeftCut updates, reload the Harness page; restart the Harness to pick up
the `/weftcut` command's changes.

## Limits

- Needs DeepSeek Harness 0.2.2-rc.5 or later in 0.2.x.
- The page is WeftCut's own and keeps its own dark look; it does not follow
  the Harness theme or language.
- A tab out of view unloads the page, which stops its picture; showing the tab
  loads it again.
- Loopback only: a Harness Web page opened from another device cannot reach
  the WeftCut on this machine.
