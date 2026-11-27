# WeftCut side preview for DeepSeek Harness

Shows WeftCut's side preview in a DeepSeek Harness right-sidebar tab: the
project's timeline, player controls, export progress and, on request, a live
picture of the edit. The page reads the project and drives the player; it
never edits.

## Use

1. In WeftCut, open Settings > Agent > DeepSeek Harness and add the entry it
   shows to `~/.dsh/cordis.patch.yml`. This bundle does not connect WeftCut; it
   expects the server under the name `weftcut`, as that entry writes it.
2. Install this bundle in DeepSeek Harness: Plugins > Add plugin, or
   `dsh plugin --profile <profile> add <spec>`.
3. Ask the agent to open the preview. When it calls `open_side_preview`, the
   tab opens beside the chat. The tool's row has an Open button that opens it
   again, and the sidebar's new-tab page lists it as WeftCut side preview.

WeftCut must be running for the page to show anything. After a WeftCut
restart the open tab finds the app again on the same port; if the port
changed, ask the agent to open the preview again.

## Limits

- Needs DeepSeek Harness 0.2.2-rc.5 or later in 0.2.x.
- The page is WeftCut's own and keeps its own dark look; it does not follow
  the Harness theme or language.
- A tab out of view unloads the page, which stops its picture; showing the tab
  loads it again.
- Loopback only: a Harness Web page opened from another device cannot reach
  the WeftCut on this machine.
