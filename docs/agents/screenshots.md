# PR screenshots

`npm run shots` (in `apps/desktop`) turns a small **shot file** into before/after
PNGs and the PR-body section that shows them side by side. A shot file says
three things: the data, the steps to reach each state, and what to frame. The
tool handles the rest: loading the data, settling the page, cropping to the
elements, naming the files, writing the markdown. It is a reporting aid, not a
test: nothing is compared, the reviewer looks.

## Shot file

Keep it beside the feature's notes (`.scratch/<feature>/name.shots.mjs`); paths in
it are relative to the file.

```js
export default {
  app: { language: 'zh-CN', size: [1440, 900] },     // language may be a list
  data: { setup: './scene.mjs' },
  shots: [
    {
      name: 'group-range-bar', caption: 'Editor in Group G1, Changes tab',
      target: ['.agent-activity-toolbar', '.agent-range-bar'], pad: 12,
      steps: async ({ ui }) => {
        await ui.dbl('.media-item:has-text("G1")')
        await ui.menu('menu.view', 'dock_workspace.panels.agent')
        await ui.tab('agent_panel.tab_changes')
      },
    },
    { name: 'whole-window', caption: 'Agent view' },  // no target: the whole window
  ],
}
```

- **data**
  - `{ project: dir }` opens a copy of an existing project folder; the original is never touched.
  - `{ setup }` creates a fresh project, then runs `setup(ctx)`: a function or a module whose default export is one.
  - `{ project, setup }` runs `setup` on the copy.
  - With no `data`, the tool uses whatever the app has open.

  `ctx` carries `mcp` (`call`, `read`, `endSession`), `fixture(name)` (a file in `e2e/fixtures/media`), `dir`, and `reopen()`, which resets the review baseline to what is on disk.
- **steps** run in order on one loaded state, each shot continuing from the last; `fresh: true` reloads the data first. `ui.menu / tab / button / text` take an i18n key or literal text, so one file serves every language. `ui.click / dbl / hover` take Playwright selectors; `ui.key`, `ui.type`, `ui.wait` round it out.
- **target** is a selector or a list of them. The crop frames whichever ones exist, so a before side that lacks a new element still frames the rest. Captures are in CSS pixels; `app.scale: 2` gives sharper crops.
- **app**: `language` and `settings` (an `app_settings` patch) are applied live and restored afterwards. `theme` (layout theme) only takes effect at launch: with `--cdp` the app must already run it; a launched app gets it written before launch.

## Commands

```sh
npm run shots -- run <file> --cdp <port> --side before --label main   # the base build
npm run shots -- run <file> --cdp <port>                              # the branch build (side: after)
npm run shots -- pick --cdp <port> [--within .agent-panel] [--filter text] [--at x,y]
npm run shots -- keys 复看                                          # i18n keys for a UI text
```

- `--cdp <port>` attaches to an app started with `--remote-debugging-port`. Without it the tool launches this checkout's built `out/` with a scratch profile; `--app <apps/desktop dir>` launches another checkout's build (a base worktree).
- `--only <name>` runs only that shot.
- `--no-data` keeps the current app state.
- `--watch` reruns when the file is saved.

Each run writes its PNGs and `<side>.json` to `shots-out/<file>/`, and regenerates `pr.md` and `attach.txt`. To publish, run `gh pr edit <n> --body-file <body.md> $(cat attach.txt)` from that directory, with `pr.md` pasted into `body.md`: `gh` rewrites each `./file.png` that the body references into an uploaded asset.

## Where it runs

Run the tool on the machine that runs the app. Project copies, fixtures and the
app's loopback MCP endpoint are all local paths there. On a remote host, run it
over ssh and copy the shot file over and the output back. Drive the UI through
`steps`; OS-level input on a remote desktop is swallowed by focus rules.

When a step fails on the after side, the tool saves `failed-<lang>-<id>.png`
showing the whole window at that moment. Use `pick` to find a selector instead
of reading the DOM.
