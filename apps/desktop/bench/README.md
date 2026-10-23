# Agent bench

Measures how far apart models land on the same WeftCut task: the **model gap**
of [ADR 0123](../../../docs/adr/0123-the-app-holds-the-evidence-the-client-runs-the-loop.md).
It launches the built app, sets a project up, hands it to an agent client
(Claude Code first) with the WeftCut skill and MCP server, and records what the
agent did from the app's side: before/after snapshots, the entity-level review
diff (ADR 0116), the task's checklist, cost and turns.

Local only. Nothing here runs in CI, and results are never committed. The app
may run on another machine of yours ([Remote app host](#remote-app-host)); the
agent client always runs here.

## Running

With the app on this machine (the default), needs the e2e build (`npm run build:e2e`), a display (`DISPLAY` on Linux, or
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
| `--media-timeout-min` | `30` | Bound on the wait for imported media before the baseline. |
| `--app-memory-mib` | app default | Pins the app's resource-policy memory (Settings → Resources). The default is 35% of host RAM. |
| `--budget-usd` | none | Spend cap per session, for clients that enforce one. |
| `--host` | `local` | `local`, or `remote`: the app runs on another machine ([Remote app host](#remote-app-host)). `--remote <alias>` alone implies `remote`. |
| `--remote` | `$WEFTCUT_BENCH_REMOTE` | ssh alias of the remote app host (`~/.ssh/config`). |
| `--remote-repo` | `$WEFTCUT_BENCH_REMOTE_REPO` | The built WeftCut checkout on that host, e.g. `C:\Users\me\src\WeftCut`. |
| `--remote-node` | `$WEFTCUT_BENCH_REMOTE_NODE` | `node.exe` on the host for fixture fetching, when the default (fnm's v24.20.0, then `PATH`) is wrong. |
| `--keep-remote` | off | Keep the run's directory on the host (profile, project, mirror) after teardown. |
| `--rebuild-templates` | off | Set every project up from scratch and replace its template ([Project templates](#project-templates)). |
| `--probe` | none | After the evidence, model-free, recorded as `probes`: `transcribe` times one `transcribe_clip` on the A-roll clip from the runner's own client; `motif-dir` goes through the endpoint the agent is given (remote: the path proxy), writes a Motif folder in the workdir, opens it as a directory draft, previews it, edits and deletes files locally and previews again (the second frame must differ); `motif-edits` writes the same package into an empty draft with `update_motif_files`, changes one colour with an exact-match `edits` entry and previews again (the frame must differ), then checks that an ambiguous edit is refused without a new revision and that the 320×180 preview of the 640×360 canvas is the whole frame scaled (the PNG is saved as `probe-motif-edits-preview.png`). |

Runs go one at a time. Each prints one summary line: verdict, cost, turns,
review-diff size and the result folder. Playwright exits non-zero only when a
run produced no evidence (launch, setup or driver crash). An agent that edits
badly still counts as a completed run. When a run fails on the client's
account limit (a subscription's session or weekly limit, a rate limit), the
rest of the plan is skipped rather than run into the same error; re-run the
skipped cells once the limit resets. The client shares that limit with any
interactive session on the same account.

## Tasks

`tasks/<id>.json`:

```jsonc
{
  "id": "kebab-id",
  "fixtures": ["fixture-id"],           // resolveFixture(id) in fixtures/fixtures.mjs → the MP4's path on the app's host
  "project": { "width": 1920, "height": 1080, "fps": { "num": 30, "den": 1 } },
  "setup": [
    { "tool": "import_media", "args": { "path": "{fixture:fixture-id}" }, "as": "media1" },
    { "tool": "read_project", "args": { "view": "tracks" }, "as": "tracks" },
    { "tool": "add_video_layer", "args": { "media_id": "{ref:media1.media_id}", "track_id": "{ref:tracks[role=ARoll].id}" } }
  ],
  "prompt": "what the user would type",
  "taste": "---\nextends: clipping\n---\n",   // optional: the project's TASTE.md
  "checklist": [{ "id": "…", "description": "…", "check": {} }]
}
```

The runner calls `create_project` in a temp folder and then makes each `setup`
call over its own MCP client, in order. The project is named after the task's
first fixture, its footage (`explainer-memory`), or after the task when it has
none, so tasks with the same setup build the same project and the agent does
not read its task's id off it. `{fixture:<id>}` becomes the fixture's MP4 on
the app's host (below), or a picture fixture's image. `{ref:<as>.<path>}` becomes part of an earlier call's result: its
`structuredContent`, or its text parsed as JSON when the tool answers in text
(`read_project` does). A path is dotted fields plus `[key=value]`, which picks
the first array element whose `key` equals `value`. That is how footage goes
onto the A roll, where a user would hand it over: `{ref:tracks[role=ARoll].id}`.
A string that is exactly one placeholder keeps the value's type, so numbers
stay numbers. `fixtures/fixtures.mjs` and
`checklist.mjs` are optional. A task with no fixtures needs neither, and a
missing checklist evaluator records `checklist: null`.

`taste` is written as the project's `TASTE.md` after setup (and after the
template is saved, so it never enters one), before the agent starts. The
run records what the app made of it in `run.json` `taste`: the style it
resolved to, any diagnostics, and the font slots (`project://taste`).

### Fixtures

A fixture with `media.type: "image"` is a still picture: fetch downloads it,
checks its pinned sha256 and probes its size, and the bench imports it as
downloaded, under the fixture's id as its file name. The
`explainer-clipping-pictures` task imports seven of them as the user's own
pictures (credits in `fixtures/ATTRIBUTION.md`).

`fixtures/fixtures.json` lists public / CC footage (credits in
`fixtures/ATTRIBUTION.md`); `node bench/fixtures/fetch.mjs --all` fetches it,
and the runner does on first use (on a remote host, there). Per fixture:

1. the source download, checked against its pinned sha256;
2. the trim, when the fixture names a window: a stream copy, checked against
   its pinned sha256 or, from another ffmpeg build, its per-stream packet
   hashes;
3. a transcode to the file the bench imports: H.264 (libx264, `yuv420p`,
   the source's own constant frame rate, a closed GOP every 2 s, no scene-cut
   keyframes, fixed preset and CRF) + AAC 48 kHz stereo, `+faststart`, no
   metadata (`transcode` in `fixtures.json`).

Commons serves only VP9/AV1 WebM, which the app routes through a full proxy:
unlike users' footage, and slow for every preview and export in a run. As
H.264 MP4 both fixtures take the `direct-export` route with d3d11va decode on
the Windows host.

The transcode cannot be pinned (x264/aac output differs across ffmpeg builds),
so it is recorded instead: `<cache>/<id>/fixture.json` holds the parameters,
the ffmpeg version and the MP4's sha256, and the MP4 is rebuilt whenever the
source, trim, recipe or ffmpeg build changes. Each run copies that record
into `run.json` `fixtures`, and template keys use the MP4's sha256. On the
Windows host (ffmpeg 8.1.1, i5-13400) the transcode took 47 s for the interview
(34.6 MB) and 141 s for the explainer (79.5 MB); a cached fetch re-hashes in
about 4 s, and a rebuild with the same ffmpeg produced the same bytes.

### Media readiness

After setup, the runner waits for the background jobs of every imported item
before it takes the baseline (`mediaReady.ts`). Otherwise the agent would get
media that is still being processed, and the run would measure the machine.
For each pool item it waits on:

- the hash (`file_hash_blake3` no longer `pending-…`);
- thumbnails (`thumbnails_dir`, video only);
- conform and waveform (`conform_path`, `waveform_path`, when the item has audio);
- the proxies the decided `decode_route` calls for (`quick_proxy` unless
  `bypass`, plus `full_proxy` for `proxied` / `native-sw`).

A derivative counts as finished when its field is set, or when the app's
`media:job_complete` / `media:job_error` event for that job arrives. A job the
app reported as started and has not ended holds the wait, unless its kind has
already landed: the timeline re-requests waveforms many times and the event
counts do not always balance. Such jobs are listed in `media_wait.open_jobs`,
and the raw event log is saved as `media-jobs.json`. A job that fails does not
fail the run, because it is part of what the agent is handed; it is recorded.
If nothing settles within `--media-timeout-min`, the run fails and the error
names what was still pending. The governor's ledger is saved as
`media-wait-diagnostics.json`.

On a small host the jobs may never be admitted at all. The app's process tree
(a GPU-less Linux renderer alone is close to 1 GB) can exceed the default
allocation, and under memory pressure the resource governor holds every new
job. When this happens, the timeout error says so; pass `--app-memory-mib`
(e.g. 3072). The policy each run used is recorded as `app_resources` in
`run.json`, so runs under different allocations are not mistaken for
comparable ones.

On a remote host there is no renderer to listen on, so the wait reads the
pool alone (`media_wait.source` is `pool`): every derivative must land, and a
failed job holds the wait until the timeout, whose error says so. The
diagnostics file then holds the host's process and GPU status instead of the
ledger, and `app.log` plus `project-logs/` hold the failure.

A derivative only counts as landed when its path is inside the open project's
folder. A project opened from a template carries the paths of the folder it
was built in until the app re-adopts its own cached copies; those must not
read as ready.

`smoke-*` tasks use synthetic layers only and exist to check the plumbing. They
measure nothing.

## Project templates

Setting a fixture task up means importing the footage and waiting for its
proxies, waveform, thumbnails and conformed audio (on the Windows host: 16 s
for the interview MP4, 19 s for the explainer MP4; minutes on a two-core
Linux host). That is the same work every run,
so after the first fresh setup the runner saves the settled project folder
(its `Cache/` holds every derivative; `Backups/` and `Logs/` are left out) as a
template, and later runs copy the template and `open_project` it instead. The
app re-adopts the cached derivatives by content hash on open, so the media wait
drops to well under a second (0.06 s on the Windows host).

The key (`templates.mjs`) is the setup's content, not the task: the project
settings, the setup calls, the project name (from the fixtures) and each
fixture's MP4 sha256, plus the app build (`git describe` plus a fingerprint of
`out/` and the native addons) and the host. Tasks with identical setups share
one template: the three explainer tasks share `explainer-memory-<hash>`, the
three interview tasks `talking-head-interview-<hash>`. Prompt and checklist
edits never invalidate one. Templates live on the host that built them:
`bench/.cache/templates/<key>/` locally, `<bench root>\templates\<key>\` on a
remote host. Each holds `project/`, `template.json`, the fresh build's
`baseline.json` and `tasks.txt`, the label listing every task that used it.

After a copy is opened, its baseline is compared with the fresh build's,
modulo the project folder's location and `modified_at`. `run.json` `template`
records `key`, `fresh_build`, `tasks`, the copy time and size, and
`baseline_equivalent` (with `differences` when it is not). `--rebuild-templates`
forces fresh setups and replaces the templates. Tasks without fixtures always
set up fresh (`template.key: null`). Delete a template folder to drop it.

## Remote app host

On a small machine the app is the bottleneck. `--host remote` keeps the agent
client and the runner here and runs the app on another machine, a Windows PC
reached as an ssh alias:

```bash
npm run bench -- --task explainer-tighten --model claude-haiku-5-5 \
  --remote weftcut-pc --remote-repo 'C:\Users\me\src\WeftCut'
```

Needs, on the host: OpenSSH server with sftp and **TCP forwarding allowed**
(`AllowTcpForwarding local` or `yes` in `C:\ProgramData\ssh\sshd_config`;
`PermitOpen 127.0.0.1:*` in a `Match User` block narrows it to loopback), the
checkout built (`out\main\index.js`, native addons, `node_modules\electron`),
`node` (fixtures), ffmpeg with libx264 and ffprobe on `PATH` (fixture trims and transcodes), and the user
logged on at the console. Here: `ssh`/`sftp`. No `DISPLAY` and no local build
are needed.

Everything the bench creates on the host is under `%USERPROFILE%\weftcut-bench\`
(`bin\pc.ps1` is the host-side helper, refreshed each invocation; `fixtures\`,
`cache\`, `templates\`, `runs\<slug>\`). Per run:

1. **Profile.** A fresh userData at `runs\<slug>\profile`, seeded from the
   user's own profile (`%APPDATA%\WeftCut`), which is only read:
   `speech_config.json`, `vlm_config.json` and `model_settings.json` are
   copied with every path naming that profile re-pointed at the run's; the
   model downloads (`data\downloads\…`) are hard-linked, never copied (same
   volume, no bytes moved, and deleting the run removes only the links).
   `--app-memory-mib` becomes the profile's `app_settings.json`
   `resource_policy`. The active models, their artifact versions and weight
   hashes (sha256, cached by path, size and mtime in `cache\model-hashes.json`)
   go to `run.json` `models`.
2. **Launch in the console session.** An ssh logon lands in session 0, which
   has no desktop and no GPU for GUI processes. The helper registers a
   scheduled task (`\WeftCutBench\WeftCutBench-<slug>`) with an
   *Interactive* principal for the ssh user (what `schtasks /IT` does, without
   a stored password), so it runs in the user's logged-on session. The task
   runs `runs\<slug>\launch.ps1`, which sets launchApp's environment
   (`LANG`/`LC_ALL`, `WEFTCUT_SUPPRESS_ELEVATION_NOTICE`, the checkout's own
   ffmpeg when fetched), starts `electron.exe --lang=en-US
   --user-data-dir=<profile> out\main\index.js` with stdout/stderr redirected,
   writes the pid and exits; the task is deleted as soon as it has. The app
   window appears on the user's desktop. `run.json` `host.launch` has the pid
   and its session; `host.gpu` the session of the whole process tree, its rows
   in `nvidia-smi`'s process table (the GPU process shows as `C+G`) and the
   decode capabilities the app probed.
3. **MCP.** The helper waits for the profile's `mcp_auth.json` and returns
   port and token over the ssh channel; the token is kept in memory and
   redacted from the copied `app.log`. `ssh -L` forwards a free local port to
   the app's loopback port; the app accepts only its own `Host` header, so the
   runner's client (and the proxy's) send it explicitly. A host that refuses
   forwarding fails here with that reason.
4. **Fixtures** are fetched and verified on the host by the shipped
   `fetch.mjs` into `cache\fixtures\` (sources, verified, and the MP4s);
   `{fixture:id}` resolves to the MP4's Windows path.
5. **The agent** gets a local MCP proxy, not the tunnel (below).
6. **Teardown.** Close MCP and the proxy, stop the app (graceful, then forced)
   — only the recorded pid, only if its command line names the run's profile,
   then its process tree and any straggler naming the run directory — delete
   the task if still there, copy `app.out.log`/`app.err.log` back as
   `app.log` and the project's `Logs\` as `project-logs/`, and delete the run
   directory unless `--keep-remote`. `host.teardown.after` lists every bench
   process, task and run directory still on the host.

Nothing touches the user's own profile beyond reading it, and no process the
bench did not start is stopped.

### The path proxy

The agent writes Motif working folders in its local working directory and
passes their paths to tools such as `open_motif_draft`; the app can only open
paths on its own disk. `proxy/proxy.ts` sits between them: an MCP SDK server
facing the agent and an SDK client facing the app, both streamable HTTP, one
upstream session per agent session, opened with the agent's own `clientInfo`
and capabilities (the app attributes work to the agent's client as usual).

- Before every `tools/call` it mirrors the workdir to `runs\<slug>\work` over
  sftp, synchronously: additions, changes (by content hash) and deletions,
  one-way (`proxy/mirror.mjs`; `.claude/`, where the skill is installed, is
  not mirrored). Files the app itself writes into the mirror (a linked draft
  written through by `update_motif_files`) are not pulled back.
- In `tools/call` arguments, a string that is a path inside the workdir becomes
  the mirror's Windows path; in `tools/call` and `resources/read` results,
  every occurrence of the mirror root (raw, JSON-escaped, either separator, any
  case) goes back to the local path (`proxy/pathmap.mjs`). Absolute paths
  outside the workdir pass through and are logged as `outside`. A path ends at
  whitespace on the way back: keep folder names free of spaces.
- Everything else (lists, other resources, prompts, notifications, progress,
  errors) is forwarded unchanged through the SDK's fallback handlers.

Every sync and rewrite is a line in the run's `proxy.log`; `run.json`
`host.proxy` counts them. Project and media paths in results stay Windows paths:
they are the app's, and the agent has no local copy of them anyway.

## Output

One folder per run, `<out>/<timestamp>/<task>__<driver>-<model>__r<n>/`:

| File | |
|---|---|
| `run.json` | The result record (`drivers/types.ts` `RunResult`). Written even when the run fails, with `error` set. |
| `transcript.jsonl` | The client's own event stream, as emitted (Claude: `stream-json`). |
| `driver-stderr.log` | The client's stderr. |
| `app.log` | The app's main-process stdout/stderr (job and admission messages). |
| `media-jobs.json` | The `media:job_*` events recorded from setup to the baseline. |
| `baseline.json` | `project://current` after setup, before the agent. |
| `final.json` | `project://current` after the agent exits. |
| `review-diff.json` | `diffProjects(baseline, final)`: what the agent changed, independent of what it says it changed (`final_message` in `run.json`). |
| `workdir/` | Whatever the agent wrote in its working directory (a Motif package, for example), if anything. |
| `proxy.log` | Remote host: the proxy's syncs and path rewrites, one JSON line each. |
| `project-logs/` | Remote host: the project's own `Logs/`. |

`run.json` also carries `media_wait`: the wait in ms, how each item's
derivatives ended (`landed` / `complete` / `failed`), and any job errors. It
also carries `motifs`: catalog entries (`motifs://current`) the run
added or changed, read from the app; `host` (where the app ran, and for a
remote host its launch, GPU status and teardown), `models`, `fixtures` (each
MP4's sha256, transcode parameters and ffmpeg version), `template`,
`setup_check` (A-roll clips in the baseline, setup time) and `probes`.
`audit` is the app's own `check_composition` of the final root composition — `{ counts, by_rule, file }`, with every finding in `audit.json` — whatever the agent checked or reported; null on an app without the tool. `frames` and `rounds` stay `null` until H3.

## The stand-in user

The skill tells an agent to plan a batch job and wait for the user's go-ahead;
a headless run has no user, so such an agent stops having changed nothing.
The runner answers in the user's place, once: when the agent ends its first
turn and the project still matches the baseline, it sends the task's
`go_ahead` text (a default "yes, go ahead, don't ask again" otherwise) into the
same session. `go_ahead: false` in a task disables it. What was said is
`user_replies` in `run.json`; a second stop is the result. The Claude driver
keeps the session open with `--input-format stream-json`.

## Drivers

`drivers/types.ts` is the whole contract. A driver gets the task, the skill
directory, the MCP endpoint (`url`, `bearer_token`), the model, an empty
working directory and an artifacts directory. It returns the transcript path,
plus cost and turns when the client reports them. Snapshots, the diff and the
checklist are taken by the runner, so a new client never re-implements them.
Nothing in the interface is Claude-specific; `drivers/codex.ts` compiles against
it. Until it is real, `codex` is a null agent: it changes nothing and reports a
failed session, so `--driver codex --model stub` runs the whole pipeline
(launch, setup or template, media wait, baseline, an empty diff) for free.

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
