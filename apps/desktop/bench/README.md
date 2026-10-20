# Agent bench

Measures how far apart models land on the same WeftCut task: the **model gap**
of [ADR 0123](../../../docs/adr/0123-the-app-holds-the-evidence-the-client-runs-the-loop.md).
It launches the built app, sets a project up, hands it to an agent client
(Claude Code first) with the WeftCut skill and MCP server, and records what the
agent did from the app's side: before/after snapshots, the entity-level review
diff (ADR 0116), the task's checklist, cost and turns.

Local only. Nothing here runs in CI, and results are never committed.

## Running

Needs the e2e build (`npm run build:e2e`), a display (`DISPLAY` on Linux, or
`xvfb-run -a`), and an authenticated `claude` CLI on `PATH`. From `apps/desktop`:

```bash
npm run bench -- --task smoke-title-card --model claude-haiku-5-5
npm run bench -- --task 'smoke-*' --model claude-opus-5-5,claude-haiku-5-5 --repeat 3
```

| Flag | Default | |
|---|---|---|
| `--task` | required | Task ids or globs (`*`, `?`), comma-separated or repeated. |
| `--model` | required | Model ids, comma-separated; passed to the client verbatim. |
| `--skill` | `<repo>/skills/weftcut` | Skill directory (holds `SKILL.md`). Its content hash is recorded per run. |
| `--driver` | `claude` | `claude`; `codex` is a stub that proves the interface. |
| `--repeat` | `1` | Runs per (task, model). |
| `--out` | `bench/results/` | Results root; each invocation gets a timestamped folder. |
| `--timeout-min` | `20` | Wall clock per agent session. |
| `--budget-usd` | none | Spend cap per session, for clients that enforce one. |

Runs go one at a time. Each prints one summary line: verdict, cost, turns,
review-diff size and the result folder. Playwright exits non-zero only when a
run produced no evidence (launch, setup or driver crash). An agent that edits
badly still counts as a completed run.

## Tasks

`tasks/<id>.json`:

```jsonc
{
  "id": "kebab-id",
  "fixtures": ["fixture-id"],           // resolveFixture(id) in fixtures/fixtures.mjs → absolute path
  "project": { "width": 1920, "height": 1080, "fps": { "num": 30, "den": 1 } },
  "setup": [
    { "tool": "import_media", "args": { "path": "{fixture:fixture-id}" }, "as": "media1" },
    { "tool": "add_video_layer", "args": { "media_id": "{ref:media1.media_id}" } }
  ],
  "prompt": "what the user would type",
  "checklist": [{ "id": "…", "description": "…", "check": {} }]
}
```

The runner calls `create_project` in a temp folder and then makes each `setup`
call over its own MCP client, in order. `{fixture:<id>}` becomes the resolved
path. `{ref:<as>.<field>}` becomes a field of an earlier call's structured
result (dotted paths work). A string that is exactly one placeholder keeps the
value's type, so numbers stay numbers. `fixtures/fixtures.mjs` and
`checklist.mjs` are optional. A task with no fixtures needs neither, and a
missing checklist evaluator records `checklist: null`.

`smoke-*` tasks use synthetic layers only and exist to check the plumbing. They
measure nothing.

## Output

One folder per run, `<out>/<timestamp>/<task>__<driver>-<model>__r<n>/`:

| File | |
|---|---|
| `run.json` | The result record (`drivers/types.ts` `RunResult`). Written even when the run fails, with `error` set. |
| `transcript.jsonl` | The client's own event stream, as emitted (Claude: `stream-json`). |
| `driver-stderr.log` | The client's stderr. |
| `baseline.json` | `project://current` after setup, before the agent. |
| `final.json` | `project://current` after the agent exits. |
| `review-diff.json` | `diffProjects(baseline, final)`: what the agent changed, independent of what it says it changed (`final_message` in `run.json`). |
| `workdir/` | Whatever the agent wrote in its working directory (a Motif package, for example), if anything. |

`run.json` also carries `motifs`: catalog entries (`motifs://current`) the run
added or changed, read from the app. `audit`, `frames` and `rounds` stay `null`
until H1/H3.

## Drivers

`drivers/types.ts` is the whole contract. A driver gets the task, the skill
directory, the MCP endpoint (`url`, `bearer_token`), the model, an empty
working directory and an artifacts directory. It returns the transcript path,
plus cost and turns when the client reports them. Snapshots, the diff and the
checklist are taken by the runner, so a new client never re-implements them.
Nothing in the interface is Claude-specific; `drivers/codex.ts` compiles against
it.

## Claude isolation

`drivers/claude.ts` runs `claude -p` in a fresh temp directory that holds only
the skill, copied to `.claude/skills/weftcut/`. Flags:

- `--setting-sources project`: user and local settings are not loaded, and
  neither are the user's plugins, hooks, skills, permissions or `CLAUDE.md`.
  The "project" is the temp directory.
- `--settings '{"autoMemoryEnabled":false}'`: auto-memory is not read or written.
- `--strict-mcp-config --mcp-config <json>`: the only MCP server is the app,
  named `weftcut`, so its tools are `mcp__weftcut__*`. The token is passed on
  the command line, not written to disk.
- `--tools Read,Write,Edit,Glob,Grep,Skill,ToolSearch,ListMcpResourcesTool,ReadMcpResourceTool`:
  no Bash, web or subagent tools.
- `--permission-mode dontAsk --allowedTools mcp__weftcut,Skill(weftcut),…,Read(./**),Edit(./**)`:
  anything not listed is refused without a prompt. File reads and writes are
  confined to the working directory.
- `--no-session-persistence`. The prompt goes in on stdin.
- The parent session's `CLAUDECODE` / `CLAUDE_CODE_*` variables are removed
  from the child's environment. Auth and provider variables are kept.

What cannot be isolated:

- **Bundled skills.** Skills that ship inside the CLI (`dataviz`, `debug`,
  `code-review`, …) are still *listed* to the model. Only `--disable-slash-commands`
  hides them, and that also hides the skill under test. `Skill(weftcut)` stops
  them from being invoked, but their descriptions still take up context.
- **Built-in plugins** (`cc-plugin-*@builtin`) still load.
- **Account and managed policy.** The run uses the machine's logged-in account,
  and admin-managed settings apply. `--bare` would drop OAuth and keychain
  reads, but then auth must come from `ANTHROPIC_API_KEY`. It is not used.
- **CLI version and system prompt.** Both come from whatever `claude` is
  installed. The transcript's first `system/init` event records the version,
  tools, skills and MCP status, so each run can be audited after the fact.
