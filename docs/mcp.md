# MCP Server & Agent UX

WeftCut exposes itself as an MCP server. External agents (Claude Desktop, Cursor, Cline, custom Python clients) connect over a localhost server and edit the project through a structured tool surface. Clients connect one of two ways: through the **`weftcut-mcp` stdio shim** (recommended — the config survives app restarts, port changes, and token rotations, and keeps working while the app is closed) or **HTTP-direct** to the in-app endpoint (for clients that cannot spawn stdio servers).

## Transport & deployment

- **Streamable-HTTP on `127.0.0.1:<auto-port>/mcp`**, hosted in the Electron
  main process: an `express` app fronts the `@modelcontextprotocol/sdk`
  `StreamableHTTPServerTransport`. The app isn't a child process of
  the agent. Each `initialize` request mints a session (UUID in the
  `Mcp-Session-Id` header); subsequent requests on that session route back to
  the same transport. In-protocol notifications (the change feed below) ride the
  same connection, so there is no separate event endpoint.
- **The stdio shim (`weftcut-mcp`)** wraps that endpoint for clients: a single
  self-contained bundle (`src/cli/`, built by `scripts/build-cli.mjs`) that
  runs under `ELECTRON_RUN_AS_NODE` — the WeftCut binary doubles as its Node
  runtime, so user machines need no Node install. It ships as an extraResource
  and the app copies it to `<userData>/cli/weftcut-mcp.cjs` at every startup;
  client configs reference THAT copy, the only path stable across upgrades on
  all three OSes (an AppImage mounts at a random point per run). `<userData>`
  is `<appData>/WeftCut` — Electron names it from package.json's `productName`,
  which is why that key must stay set: electron-builder's own `productName` is
  never written into the packaged package.json, and without it both dev and
  packaged builds fall back to the scoped package name. The shim
  re-reads `mcp_auth.json` on every bridge (re)connect, so port re-picks and
  token rotations self-heal, and the config fragment carries no URL and no
  token.
- **Shim catalog = synthetic ∪ (app reachable ? real catalog : ∅).** Two
  synthetic tools are always present: `weftcut_status` (endpoint state + next
  steps) and `launch_weftcut` (detached GUI spawn, then waits for the endpoint,
  bounded). `tools/list_changed` fires on every bridge transition, so one agent
  session upgrades to the full catalog the moment the app comes up — including
  when `launch_weftcut` itself brought it up — and degrades back to the
  synthetic surface when the app closes. Down-state calls fail with the remedy
  in the error **message** (see the error model below). While bridged, the
  change feed is forwarded verbatim, so a shim-connected agent sees exactly
  what an HTTP-direct one does.
- **Shim subcommands** (the terminal-facing connection helpers): `info`
  (endpoint, token, reachability; exit 3 when the app is down), `print-config`
  (the machine-specific `mcpServers` fragment), `list-tools` (dump the running
  app's advertised catalog), `help`.
- The Rust core is **transport-free**: it provides the tool catalog, resource
  readers, prompts, and wire types, and the main process bridges to it over
  dedicated napi methods (`mcpCatalog`, `mcpCallTool`, `mcpReadResource`,
  `mcpListPrompts`, `mcpGetPrompt`). The Rust wire types serialize to exactly
  the JSON shapes the SDK's low-level `Server` expects, so the main process
  forwards Rust output verbatim.
- Bearer token + auto-picked port are persisted to `<userData>/mcp_auth.json`
  on first launch and reused on every subsequent start so the Claude Desktop /
  Cursor snippet stays valid across restarts. If the saved port is occupied at
  bind time, the server falls back to a fresh OS-picked port and rewrites the
  file.
- One server per running WeftCut instance. Multi-instance = multi-port;
  surfaced in the connection UI.
- For remote access (Tailscale, ngrok, codespace): out of scope. Localhost only.

## Authentication

- Random 32-byte hex token generated on first launch, stored in
  `<userData>/mcp_auth.json` alongside the auto-picked port. The file is written
  `0600`: it cannot be encrypted, because the stdio shim is a plain Node process
  that re-reads it on every connect. Windows maps the mode to the read-only bit,
  so the restriction is POSIX-only.
- The token is **enforced** on every `/mcp` request: the main process owns the
  express middleware, so each request must carry `Authorization: Bearer <token>`
  or it's rejected with `401`. The compare is constant-time (`timingSafeEqual`)
  — not a meaningful attack surface for a 256-bit localhost token, but the
  correct form.
- **DNS-rebinding protection** is on: the transport rejects requests whose
  `Host` header isn't the loopback bind (`allowedHosts` = `127.0.0.1:<port>` /
  `localhost:<port>`), so a malicious web page the user visits can't POST to the
  loopback port and drive the editor. The bearer is the primary gate; `Origin`
  is left unrestricted so non-browser MCP clients still work.
- No token visible in UI until the user opens the **Connect agent** panel —
  defends against video tutorials accidentally leaking it on stream.
- A **Refresh** button rotates the bearer in place: the server stays bound on
  the same port and `mcp_auth.json` is rewritten with the new token. It sits at
  the top of the Connect-agent panel, in the callout that says when to reach for
  it — rotation never puts the secret on screen, so unlike Reveal and Copy it
  has no reason to sit behind the HTTP-direct disclosure.

## Connection UX

The app's **Connect agent** panel (Settings → Agent):
- **Primary: the stdio shim config**, one copyable snippet per client
  (Codex TOML, Claude and Cursor JSON) plus a self-configuration prompt the
  user can paste into any MCP-capable agent. No token rides in these — the
  shim resolves it at connect time.
- **The `Generic` tab is not a fourth format.** MCP standardises the protocol
  and never the config file — `mcpServers` is a Claude Desktop convention the
  JSON clients copied, not a spec artifact — so the tab for "some other
  client" prints the connection facts unwrapped (`transport` / `command` /
  `arg` / `env`, or `transport` / `url` / `header`) and points clients that do
  take the `mcpServers` shape at the Cursor tab.
- **A `mcp add` one-liner accompanies the snippet** wherever the client's CLI
  can express the whole entry: Codex and Claude Code for stdio, Claude Code
  alone for HTTP — `codex mcp add --url` takes only `--bearer-token-env-var`
  (an env var *name*), never a literal header. Cursor ships no MCP CLI. Both
  CLIs write exactly the JSON/TOML the adjacent snippet shows, so the two
  paths are interchangeable. Windows paths are double-quoted so the command
  survives Git Bash as well as PowerShell.
- **Advanced (collapsed): HTTP-direct** — the server URL
  (`http://127.0.0.1:<port>/mcp`), the bearer token (masked until revealed),
  and the same per-client snippets in URL + header form.
  For clients that cannot spawn stdio servers; breaks whenever the app is
  closed and goes stale when the port or token changes.
- **`initialize` carries `instructions`** — ten lines of session etiquette
  (read first, verify from the returned record, a refusal names the fix, µs on
  the frame grid, checkpoint then work session for a batch, export is the UI),
  identical to the "In ten lines" head of the shipped skill and pinned equal by
  a test, so a client that never installs the skill still starts with the
  etiquette. `serverInfo` is `weftcut` at the app's version in a packaged
  build; a bare `electron.exe out/main/index.js` dev launch reports Electron's,
  because `app.getVersion()` has no package.json to read there.
- **The agent skill** — the app ships a Claude-format skill that teaches a
  connected agent session etiquette, the orchestration patterns, and the Motif
  authoring contract (the things no single tool description can carry; per-tool
  facts stay in the tool descriptions). Sources are repo-root `skills/weftcut/`
  plus a verbatim copy of [`motif-authoring.md`](motif-authoring.md), staged to
  `out/skills` by `scripts/build-skills.mjs` (a `build` step), shipped as an
  extraResource, and refreshed to `<userData>/skills/` at every startup — the
  shim's stable-path pattern. The panel shows a copyable install prompt that
  points the user's agent at that copy (for Claude Code:
  `~/.claude/skills/weftcut`); the manual section prints that folder's path
  verbatim and opens it in the OS file manager, for a user doing the copy by
  hand. Every tool / resource / prompt name the skill sources reference is
  pinned to the advertised catalog by `mcp.skill-conformance.test.ts`, so a
  rename fails CI until the prose is updated.
- **A build without the skill cannot ship, and a launch without it says so.**
  Two gates assert the bundle's shape (the `weftcut` folder, its `SKILL.md`,
  the copied contract) and its version stamp: `build:skills` over `out/skills`
  and an electron-builder `afterPack` hook over the packed copy. Past those,
  the startup refresh reports a *state* rather than a path —
  `installed`, `stale` (this launch could not refresh, so the folder on offer
  is an earlier version's) or `unavailable`, each with the fault that caused
  it. The panel always renders both skill surfaces and shows the fault in place
  of the buttons; a packaged build that is not `installed` also raises a
  startup notice, since it means both gates failed on the way to the user. Only
  a dev tree before `build:skills` is a benign fault, and it names the command
  to run.
- **The fault carries its own recovery.** Every fault that can reach a user is
  cleared by something outside WeftCut — a full disk emptied, an antivirus
  quarantine undone, a locked file released, a repaired install, or a
  `build:skills` that has now run — so the fault block offers a "try again"
  that re-runs the install and takes up whatever it finds. It is the only way
  to learn that the cause is gone, and it costs no app restart. On success the
  main process also re-broadcasts the notice list (`app:notices`), which is how
  the System-status card stops reporting a fault the user has just fixed.
- Renders "starting…" while the server is still binding its port; polls
  `get_mcp_info` until the bind completes. Until the shim bundle exists (dev
  before `build:cli`), the HTTP path renders as primary.

Shim snippet example (paths are machine-specific, generated at runtime from
`process.execPath` and `app.getPath("userData")`):
```json
{
  "mcpServers": {
    "weftcut": {
      "command": "C:\\Users\\u\\AppData\\Local\\Programs\\WeftCut\\WeftCut.exe",
      "args": ["C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "WEFTCUT_USERDATA": "C:\\Users\\u\\AppData\\Roaming\\WeftCut" }
    }
  }
}
```

The same entry from the `Generic` tab, and as the Codex one-liner beside it:
```
transport: stdio
command:   C:\Users\u\AppData\Local\Programs\WeftCut\WeftCut.exe
arg:       C:\Users\u\AppData\Roaming\WeftCut\cli\weftcut-mcp.cjs
env:       ELECTRON_RUN_AS_NODE=1
env:       WEFTCUT_USERDATA=C:\Users\u\AppData\Roaming\WeftCut
```
```sh
codex mcp add weftcut --env ELECTRON_RUN_AS_NODE=1 --env "WEFTCUT_USERDATA=C:\Users\u\AppData\Roaming\WeftCut" -- "C:\Users\u\AppData\Local\Programs\WeftCut\WeftCut.exe" "C:\Users\u\AppData\Roaming\WeftCut\cli\weftcut-mcp.cjs"
```

HTTP-direct snippet example (the advanced path, in Cursor's shape):
```json
{
  "mcpServers": {
    "weftcut": {
      "url": "http://127.0.0.1:50831/mcp",
      "headers": { "Authorization": "Bearer 8f3a..." }
    }
  }
}
```

## Multi-agent semantics

Multiple agents may connect simultaneously. The single-writer actor (see [data-model.md](data-model.md)) serializes all mutations regardless of source.

Rules:
- Tool calls are atomic: each call either commits or rejects; no half-applied edits.
- Operations carry an `Actor` tag (`User` or `Agent { client }`) — surfaced in change events and the status-log console.
- Connected agents receive change notifications in-protocol (see the change feed below) to see edits from other agents and the user.
- No edit-locks, no per-agent state. If two agents step on each other, the second to commit may fail invariants — expected, agents should retry or back off.
- `set_history_lock { locked: true, reason }` is the explicit cooperative pen: one client holds the undo pen during a batch, and every REVERT path (`undo`, `redo`, `jump_to`, `restore_checkpoint`) — from the UI or another agent — fails with `HistoryLocked` until the lock releases. It gates reverting only: edits still commit, and the lock never affects what records (`docs/features.md#undo-stack-scope` is authoritative).
- A work session belongs to a CONNECTION, and a connection can vanish without saying so — streamable HTTP ends a session only on the client's `DELETE`, which a client that exits, crashes or calls plain `close()` never sends. Three things keep that from disabling the batch flow app-wide: the host **closes a session whose client is gone** (its standalone SSE stream has been closed for 90 s, or, for a client that never opened one, no request for 30 min — a live client keeps the stream open however long it thinks, so it is never cut mid-thought), the stdio shim **terminates its app session** when stdin closes or it is signalled, and `end_agent_session { force: true }` is the **takeover** for whoever arrives while the holder is still being judged. `AgentSessionBusy` and `AgentSessionOwnerMismatch` name the holder — client, connection, reason, age — and `project://session` / `read_project { view: "session" }` show it.

## Tool surface

The MCP tool surface is the same set of actor commands the UI calls.
Two declarative tables single-source the advertised schemas and the
name→handler dispatch, so a tool can never appear in one without the
other: `MCP_TOOL_DEFS` in the TS actor host for every mutation tool, and
the `tool_table!` macro in the Rust core for the native compute tools.
Every advertised schema property carries an explicit `type` — MCP
clients coerce untyped fields to `type: string`, which forces agents to
send nested payloads as JSON-encoded strings (a catalog-wide test gates
this). Every tool carries `annotations` — `readOnlyHint` on the reads,
`destructiveHint` on every write (true for the removals and reverts:
`delete_*`, `ripple_delete_gap`, `remove_pauses`, `clear_keyframes`,
`auto_split_by_shot`, `undo` / `redo` / `jump_to` / `restore_checkpoint`,
`install_motif`), `idempotentHint` on a set — and they are the one statement
of that split: the agent panel's read rows come from the same `readOnlyHint`
(`mcp.annotations` pins every tool to one). Don't expose 100 tools; agents get confused. The current set is 91,
organised below — near enough that ceiling that a new tool is first checked
against an existing one's arguments: two verbs that differ by one boolean are
one tool with a flag, and a field's set and clear are one tool taking `null`.

Names follow `<verb>_<resource>`: `create_link`, `delete_track`, `update_keyframe`,
`rename_composition` — the verb first, `delete` for every removal, and one
tool per resource that can be changed in more than one way (`update_*` with
optional fields, where the set and the clear of a field are one tool taking
`null`). A tool that changes name or shape is a **break**: the old name is
dropped, a client calling it gets `unknown tool`, and the catalog it re-reads
is the whole contract ([ADR 0074](adr/0074-the-mcp-tool-surface-is-one-verb-per-resource-and-a-rename-is-a-break.md)).
`RETIRED_MCP_TOOL_NAMES` in `main/mcp/toolAliases.ts` still resolves the four
names retired before that decision (`add_motif`, `checkpoint`,
`set_composition`, `compositions_delete`) and takes no new entries.

### Read (resources, not tools)

| URI | Returns |
|---|---|
| `project://current` | full Project JSON (with `schema_version`) |
| `project://composition` | a composition's settings — id, label, canvas, fps, duration (+ `duration_pinned`), sample rate, channels, colour space, background; no tracks. The root's, or `project://composition?composition=<id>` for a Group's (`not_found` for an unknown id — never the root under the wrong name) |
| `project://compositions` | every composition — `{ id, label, duration_us, ref_count }`. `ref_count` is how many `CompositionRef` (Group) layers point at it: 0 for the root and for an orphan. The ids are what a creation tool's `composition_id` takes |
| `project://media` | media pool listing |
| `project://tracks` | a composition's tracks, each with its flags (`enabled`, `locked`, `role`; mute and solo are per **role** — `set_role_flags` — so a track carries none) and its layers as **envelopes** — `{ id, label, kind, t_start_us, t_end_us, src_in_us?, src_out_us?, enabled, locked, link_id, effects: [{ id, kind }], keyframed: [param_key] }` — the root's, or `project://tracks?composition=<id>` for a Group's. What an agent plans a timeline edit against; the params, keys and effect values are `project://layers/{id}` |
| `project://layers/{id}` | one layer in detail, from whichever composition holds it |
| `project://markers` | a composition's markers — the root's, or `project://markers?composition=<id>`. Each carries `anchor_layer` and `anchor_src_us` (both null on a free marker) and `hibernating` — see *Markers follow clips* below |
| `project://links` | a composition's links — `{ id, members }` — the root's, or `project://links?composition=<id>` |
| `project://transitions` | a composition's transitions — the root's, or `project://transitions?composition=<id>` |
| `project://settings` | the editing preferences `set_project_settings` writes (`auto_pair_audio_on_import`, `prefer_proxies`, `proxy_overrides`, `shot_review`, `pause_review`, `correction_script`) plus `metadata` (`name`, `created_at`, `modified_at`, `description`). `modified_at` moves on every recorded edit — the dirty signal; an unrecorded write leaves it, and undo, redo and a checkpoint restore put back the stamp of the state they return to, so compare it for change, not for order |
| `project://session` | the active agent work session (or `null`), recent sessions and the history lock — read after `AgentSessionBusy` |
| `project://history` | recent ops + checkpoints (snapshot-free). Each op carries `summary` (English prose), `label_key` + optional `label_args` (its i18n key and interpolation values — `history.*`, see `main/state/history-labels.ts`), `affected` (Track/Layer/Marker refs) and `entity_labels` (names for `affected`, same length and order, resolved against whichever stored snapshot still **holds** each ref — the op's own for an add/update/move, its predecessor's for a delete — so a deleted entity still has a name). An `entity_labels` element is `{"text": "…"}` for a stored name, or `{"label_key": "…", "label_args": {…}}` for a derived one — a clip's kind (`kinds.color`), a track's role (`tracks.roles.a-roll`) or a track's position (`tracks.positional` with `{"n": 3}`) — which the UI translates. The envelope carries `window_start` and `evicted` — see below |
| `project://compiled` | compiled audio IRGraph (JSON) |
| `composition://meter` | latest PREVIEW master-bus level — `{ live: true, rms_db, peak_db }` while something is playing, `{ live: false }` once nothing has for 2 seconds. The preview UI pushes this reading at about 2 Hz, so the liveness window is a few pushes wide and polling faster than that returns the same numbers. A tap on the preview mixer, so it answers "how loud is what the user is hearing right now" and nothing about a render; a stopped transport reports `live: false` rather than a stale reading. Master bus only — the per-role levels the Role Mixer draws are a renderer-side tap and reach no MCP surface ([ADR 0066](adr/0066-a-role-meter-is-a-tap-not-a-bus.md)) |
| `media://{id}/thumbnail` | middle thumbnail as JPG (base64) |
| `media://{id}/frame/{t_us}` | on-demand frame at the given microsecond, lazy-cached (multimodal-friendly) |
| `media://{id}/waveform` | audio peaks file (binary, base64) |
| `media://{id}/analysis` | deterministic shot report (`{ shots, cut_scores }`, source-absolute) for the default detection params, content-addressed per source; computed on demand on a miss (no `404`) and shared with `analyze_clip` |
| `media://{id}/description` | cached scene descriptions under the view the app's settings name — the preferred engine, sampling, focus and UI language, all injected by the host (`{ covered_ranges, segments }`); `404` until `describe_clip` has populated it at that key (unlike the always-computable resources above) — the refusal names the whole view, since changing any axis reads as "not described" until the shots are described again under the new one |
| `effects://catalog` | every effect kind `add_effect` takes — visual and `audio.*` — with each param's `default` and `range` (plus `unit` / a sample `region` where an audio kind has one), and the `effects[<id>].params[<key>]` keyframe path. A catalog, not project state; the same record as `read_project { view: "effects" }` |
| `motifs://current` | full motif catalog (built-ins, installed, drafts) — same payload as `list_motifs`; `html` stripped |

The parameterised families are advertised by `resources/templates/list`
(RFC 6570; `{?composition}` is the optional query): `project://layers/{id}`,
`project://composition{?composition}`, `project://tracks{?composition}`,
`project://markers{?composition}`, `project://links{?composition}`,
`project://transitions{?composition}`, `media://{id}/thumbnail`,
`media://{id}/frame/{t_us}`, `media://{id}/waveform`, `media://{id}/analysis`,
`media://{id}/description`. `?composition=` is the ONE query a `project://`
read takes: an unknown key, or a scope on a project-wide read, is refused rather
than answered with the root under the URI the caller wrote.

A client that cannot read MCP resources has the same views as a tool:
`read_project { view, id?, t_us?, composition_id? }` with `view` one of
`current`, `composition`, `compositions`, `media`, `tracks`, `layer` (needs
`id`), `markers`, `links`, `transitions`, `settings`, `history`, `session`,
`effects` (the effects catalog), and the two picture views `media_thumbnail` / `media_frame` (`id` is the media
id, `media_frame` also takes `t_us`; both answer an image content block from
the same reader the `media://` resources use). The JSON views are served by the
same function as the resource, so the two never disagree; `composition`,
`tracks`, `markers`, `links` and `transitions` take `composition_id` for a
Group's. Prefer the resources when the client supports them.

`media://*` reads return `404` with a hint pointing at the
`media:job_complete` event when derivatives haven't been generated
yet, so agents know to wait + retry rather than give up.

#### Reading `project://history` positions

`ops` is a **window** — the last N entries of the stack, currently N = 100 against
a cap of 200 — and `cursor` is an **absolute stack index**, not an offset into
`ops`. Two envelope fields place the window, and they answer different questions:

- **`window_start`** — the absolute stack index of `ops[0]`, i.e. `len -
  ops.length`. `ops[i]`'s absolute index is `window_start + i`, and that is the
  only index space `jump_to` accepts. On a 150-entry stack the resource returns
  ops 50..149 with `window_start: 50` and `cursor: 149`; reading `cursor` as an
  index into the 100-element array lands 50 entries off, or off the end entirely.
- **`evicted`** — how many entries `record()` has dropped off the FRONT of the
  stack at capacity. The eviction does not spare the `Initial` entry, and `len`
  (the live stack length) cannot tell you.

So `window_start === 0 && evicted === 0` is the **only** combination meaning
"`ops[0]` is the start of the project". `window_start > 0` means the window is
narrower than the stack (re-read for more); `evicted > 0` means the stack itself
is narrower than the project, and those states are gone — nothing can jump back
to them.

### Analysis tools

- `detect_pauses { layer_id, threshold_amp?, min_pause_us?, bridge_us? }` → `{ pauses: [{ t_start_us, t_end_us }, ...], noise_floor_amp, peaks_source }`. Reads pre-computed peaks and decodes nothing — the peaks of what actually plays: the layer's baked effect-chain sibling's when they are ready, the media's otherwise, which `peaks_source` reports as `"fx"` or `"raw"`. A pause is a run in which the peak of EVERY channel stays under `threshold_amp` for at least `min_pause_us`; a loud run shorter than `bridge_us` inside one (a click, a cough, lip noise) does not end it. `noise_floor_amp` is the 10th percentile of the peaks inside the layer's source window — the number to derive a threshold from rather than guessing one. `layer_id` may name an `Audio` layer or a `VideoClip`: a pause is a fact about the audio that plays, so a VideoClip resolves to the Audio member of its link that shares its media, else to its link's only Audio member, and is refused with that rule named when it has neither ([ADR 0068](adr/0068-a-pause-is-a-fact-about-the-audio-that-plays.md)). Defaults `threshold_amp=0.02` (≈ -34 dBFS), `min_pause_us=500000`, `bridge_us=80000`.
- `remove_pauses { layer_id, threshold_amp?, min_pause_us?, pad_us? }` → `{ surviving_layer_ids, removed, removed_us }` — the write beside that read: detect at the same parameters (same subject resolution, same peaks), then cut every pause out and **close** the gaps, as ONE recorded edit (a single undo restores the whole clip). What is cut is the pause's core, `[t_start_us + pad_us, t_end_us - pad_us)`: `pad_us` (default `100000`, the same on both sides) stays at each end, because erasing a pause outright makes speech breathless and clips the soft onset of a word that the peak window read as quiet. `2 * pad_us < min_pause_us` or `InvalidArgument`. A pause touching the clip's head or tail keeps its pad on the inner side only and is trimmed off to the clip's edge on the outer one; a linked audio/video partner goes with each removed slice — when the link holds a frame-grid member the cut list is landed on the composition's frame grid first, so both members are cut at one instant (an unlinked Audio subject keeps sample precision); everything downstream shifts left on every track of the composition, so touching cuts close as the one hole they are. Refuses whole, before any write, with `delete_layers { ripple: true }`'s refusals by name — `RippleInsideHole`, `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked`, each naming the layer that blocked (a layer starting exactly at time 0 does not block a leading pause: anchored at the origin, it stays while the material behind the cut closes up beneath it — ADR 0062's origin refinement) — plus `InvalidArgument` when the clip is one pause end to end, since removing every segment is a delete (`delete_layers`) rather than an edit. To review the pauses before any of them goes, use `detect_pauses` and one region `add_marker` per range instead. A hybrid: Rust reads the peaks, the TS actor commits ([ADR 0062](adr/0062-ripple-is-an-explicit-command-over-placement.md)).
- `analyze_clip { layer_id, sensitivity?, min_shot_us?, passes? }` → `{ shots: [{ index, t_start_us, t_end_us, keyframe_t_us, brightness, motion, sharpness, flags: [...] }], cut_scores: [{ t_us, score }] }`. Deterministic shot boundaries + per-shot brightness / motion / sharpness (0..1, sharpness = variance-of-Laplacian) and `black` / `freeze` / `fade` flags for a VideoClip layer. Runs over the source (preferring the 720p proxy); source-absolute times clipped to the layer's source window. `cut_scores` is the raw cut signal, `shots` the cleaned segmentation. Defaults `sensitivity=0.4`, `min_shot_us=500000`, `passes=["shots","stats","events"]` (drop `stats`/`events` for timing only). Per-shot stat values are advisory (proxy-decode-derived, not bit-identical across machines); the flags are the deterministic signal.
- `compare_frames { a: { layer_id, t_us }, b: { layer_id, t_us } }` → `{ phash_hamming, ssim, similar }`. Pairwise perceptual similarity of two video frames — dedup shots, match a cutaway. Each side names a VideoClip layer and a source-absolute `t_us` (same coordinate space as `media://{id}/frame/{t_us}` and `analyze_clip`'s `keyframe_t_us`); the two sides may be the same clip or different clips. `phash_hamming` is the 0..64 Hamming distance between the frames' DCT perceptual hashes (0 = identical, small = same frame re-encoded / rescaled); `ssim` is MSSIM in 0..1; `similar` is `phash_hamming <= 10 && ssim >= 0.5` (both must agree; the pHash is the strong signal and the loose SSIM floor keeps a source frame vs its lossy downscaled proxy similar while rejecting unrelated frames). Cross-aspect-ratio pairs are approximate (the MSSIM path squares both frames, so differing aspect ratios misalign) and lean on the aspect-independent pHash; same-clip dedup (one aspect ratio) is exact. Read-only, no cache; VideoClip layers only.
- `describe_clip { layer_id, t_start_us?, t_end_us?, fps?, focus?, language?, backend? }` → `{ backend, model, segments: [{ t_start_us, t_end_us, text, tags: [...] }] }` — see "Video understanding" below.
- `extract_clip_audio { layer_id, t_start_us?, t_end_us? }` → a JSON metadata block plus an MCP `audio` block (base64 mono 16 kHz WAV, 60 s per call) — a clip's ORIGINAL source audio, for an agent running its own speech model; add the reported `t_start_us` to the offsets it gets back. See "Speech" below.

### Edit tools

Each maps 1:1 to a project actor command (see
[data-model.md](data-model.md) "Mutation surface").

**Every edit tool answers with the committed record**, read back from the
snapshot the commit produced, as `structuredContent` and as the same JSON in the
text block — never a bare id, never an empty result. A layer-shaped answer is
the layer's envelope (`layer_id`, `track_id`, `composition_id`, `kind`, `label`,
the span, `src_in_us`/`src_out_us` where the kind has a source window,
`enabled`, `locked`, `link_id`), plus what the edit did beyond the layer named:
`siblings` (link members a move or trim carried along), `moved` (everything a
ripple or a transition placement shifted), `adjusted` (each numeric field whose
applied value differs from the requested one — today the frame/sample-grid
snap — as `{ field, requested, applied, reason: 'grid' }`). An agent reads the
answer instead of re-reading `project://tracks`; the shapes below name the
fields beyond the envelope. `main/state/mcp-results.ts` is the one home of every
reader.

**Snap and echo, clamp and refuse.** A time an agent sends is changed by a tool
in exactly one way: it lands on the layer's own lattice (the composition frame
grid, or the 48 kHz sample lattice for Audio), at most half a quantum away, and
the answer's `adjusted` says so. Every other adjustment the renderer's drag
would make for a user who can see the ghost — a start floored at 0, a trim
clamped at the other edge or at the source's end, a link set stopped as a body
at 0 — is a REFUSAL over MCP, before any write: `NegativeLayerStart` names the
member that would have crossed 0 (`move_layer`), `TrimEdgeOutOfRange` names the
window the edge may land in (`trim_layer`), a negative marker time is
`InvalidArgument`. The mutations take a `strict` flag the MCP parsers set and
the renderer commands do not, so the two surfaces share one implementation and
differ only in who is watching. `update_layer`'s `t_start_us`/`t_end_us` snap
like every other placing tool's rather than being refused with `snap_to`.

The one adjustment that is neither a landing nor a refusal is a Motif whose new
props shorten its content: the layer's end (and its source offset) follow the
content in, and the answer's `adjusted` says so with `reason: "content"` — the
geometry is the props' consequence, not a time the caller sent.

Media + tracks:
- `import_media { path }` → `{ media_id, kind, label, path, duration_us, width, height, has_audio }`; a subtitle document (`.srt`/`.vtt`/`.ass`) is consumed into a caption track instead and answers `{ caption_track_id, cues }`. The path is stat'd first: a directory, a missing path or an unreadable file is refused by name before anything is written, and a read that fails after the pool row landed rolls that row back; if a layer already references the row it stays with a pending hash, and the refusal says which happened
- `delete_media { media_id, force? }` — with `force`, the referencing layers go through the same cascade `delete_layers` runs (links dissolve below two, an emptied transient lane is pruned, a locked lane refuses), so a forced removal of an auto-paired video+audio pair is one clean commit
- `add_track { label? }` → `{ track_id, composition_id, label, role, index, enabled, locked, layers }` (tracks are kind-agnostic — any layer kind can be placed on any track)
- `delete_track { track_id, force? }` — with `force`, the layers go too; a Group layer among them leaves its composition orphaned (`ref_count 0` in `project://compositions`) for `delete_composition`
- `rename_track { track_id, label? }` — any track, reserved ones included; `label: null` (or blank) clears it back to the derived name
- `move_track { track_id, new_position }`
- `set_track_flags { track_id, enabled?, locked? }` — the writer behind every `TrackLocked` refusal. `locked` makes the track reject edits to the layers on it; `enabled` is its output, in preview and in export alike, with the layers left in place. Omit a flag (or send null) to leave it alone; a call naming neither is refused rather than reported as a successful no-op. **Unrecorded** (not undoable), like `set_role_flags`. A layer's own `locked` is separate (`update_layer { patch: { locked } }`) and an edit needs both cleared. No mute/solo arm: the mix folds by role, not by track ([ADR 0023](adr/0023-audio-mixes-by-role-not-track.md)) — `set_role_flags` is what silences audio.

Layers:
- `add_color_layer { track_id, t_start_us, t_end_us, color, width?, height?, composition_id? }` → the layer record + `adjusted`
- `add_video_layer { track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us, composition_id? }` → the layer record + `{ video_layer_id, audio_layer_id, link_id, audio, adjusted }` — ONE shape, the three pair fields `null` and `audio: null` when nothing was paired. When the source carries audio and `auto_pair_audio_on_import` is on: the paired dialogue Audio layer lands on the SAME track's audio lane (a track holds one visual + one audio lane) and the two are linked. The triple commits atomically — if the audio lane is occupied, the call rejects naming the blocking layer and nothing lands on the timeline. The media must be a `Video` or an `Image`: an audio-only item is refused and pointed at `add_audio_layer` (a VideoClip over an audio file draws nothing, and the mixer folds Audio layers only, so it would be silent too), a subtitle document at `apply_subtitles`.
- `add_audio_layer { track_id, media_id, t_start_us, t_end_us, src_in_us, src_out_us, role?, composition_id? }` → the layer record + `adjusted` — the only way audio-only media reaches the timeline, and the audio-lane twin of `add_video_layer`. The layer lands on the track's audio lane (a track holds one visual + one audio lane, so a track already carrying a video clip still takes it) and stands **alone**: no auto-pair, no link. Both endpoints snap to the 48 kHz sample lattice rather than the composition frame grid. `media_id` may be an `Audio` item or a `Video` item carrying an audio stream — a video's audio on its own is a legitimate thing to place; anything with no audio to read is refused naming its kind. `role` (default `music`) picks the mixing bus, which is a property of the clip and not of its track ([ADR 0023](adr/0023-audio-mixes-by-role-not-track.md)).
- `add_text_layer { track_id, t_start_us, t_end_us, content, x?, y?, composition_id? }` → the layer record + `adjusted` — a title, a lower third, a credit: typography authored here rather than imported. Born at the caption font, 72 px, opaque white, centre-aligned and centred in frame. `x`/`y` override the placement and are the layer's **anchor** point ([ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md)), travel together (half a point is refused, never paired with a guessed axis) and are not clamped to frame. Everything else — font, size, colour, outline, the layout box and its alignment — is `update_layer_params { kind: 'Text' }`. Subtitles from a document are `apply_subtitles`, which times cues onto the caption tracks; this is the one-off.
- `add_motif_layer { motif_id, t_start_us, t_end_us?, track_id?, props?, composition_id? }` → the layer record + `adjusted` — `t_end_us` defaults to `default_duration_s`; `track_id` auto-creates a fresh track when absent, which derives its own name; `props` validates against the motif's `props_schema`. Frame capture is lazy at next render; the tool returns synchronously.

**Where a layer is created, and how it is addressed afterwards.** A track
belongs to exactly one composition, so a tool that names a `track_id` has
already named the composition; `composition_id` on those tools is a cross-check
(a track in another composition is refused with the mismatch spelled out). Tools
that *pick or spawn* a lane — `add_track`, `add_motif_layer` without `track_id`,
`add_marker`, `update_composition` — take
`composition_id` to say which composition, the root when omitted; an unknown id
is `CompositionNotFound`. Every layer-addressed tool (`move_layer`,
`trim_layer`, `split_layer`, `update_layer_params`, keyframes, effects, links,
transitions, …) takes **no** scope: layer ids are unique across the project, so
the id alone says which composition the layer lives in, and a layer inside a
Group is edited exactly like one in the root. A destination that names another
composition — `move_layer`'s `new_track_id`, `restack_layer`'s anchor,
`paste_layers`' `target_track_id` — is refused with `CrossCompositionMove
{ layer, from, to }`; a set (`delete_layers`, `set_layers_enabled`,
`paste_layers`, `create_link`, `update_link`) whose
members straddle two compositions is refused with `CrossCompositionSet
{ layer, composition, expected }`. A layer changes composition only through the
four ops that name a destination composition rather than inherit one — pre-compose, adding it to an
existing Group, ungroup, and `move_layers_to_composition`. A *move* never
crosses; crossing has its own op.
- `apply_transcripts { transcripts, source_layer_ids?, composition_id? }` → `{ caption_track_id, cues }` — the caption import that **keeps word timing**. Takes `transcribe_clip`'s envelope as it comes (`segments` and `word_timing` passed straight through) and packs the cues onto the caption tracks the same way `apply_subtitles` does (ADR 0070). Prefer it whenever the transcript came from `transcribe_clip`: an SRT has no room for word offsets, so routing through one discards the timing `correct_caption_text` needs to re-segment a corrected cue. `source_layer_ids` is parallel to `transcripts` and tags each cue with the clip it was read from, which is what lets a correction group cues by take. Max 1000 transcripts. One recorded edit.
- `correct_caption_text { layer_ids?, composition_id? }` → `{ changed }` — correct the captions against `set_project_settings { correction_script }` and re-segment what changed, counting a re-segmented group whole. Refused while the script is blank (`InvalidArgument`, field `correction_script`): there is nothing to correct against. Every caption in the composition by default; `layer_ids` narrows it, and an id that is not a Text layer on one of its caption tracks refuses the call. A cue carrying word timing can be **split or merged** to match the corrected wording, each new cue timed from the words it holds; a cue without it is corrected in place and keeps its bounds. Refuses whole, before any write, if a target caption or its track is locked — so the count it reports is the count it made.
- `restyle_captions { font_family?, font_size_px?, color?, outline_width?, layer_ids? }` — restyle **every** caption in the project (or only `layer_ids`, each of which must be a caption) in one recorded edit: every Text layer on every Caption-role track, in every composition, because caption lanes multiply as cues collide and a per-lane restyle would leave the film styled two ways mid-batch. Omitted or `null` leaves that aspect alone, and a patch that names no aspect at all is refused rather than reported as a successful no-op; `outline_width: 0` removes the outline, a positive width adds or resizes one (keeping its colour, black if it had none). Answers `{ captions, restyled }` — how many cues the project holds, and how many this call wrote. A Text layer from `add_text_layer` is not on a caption track and is untouched — style that with `update_layer_params`.
- `merge_captions { layer_ids }` → the merged caption's record + `removed` — fold two or more cues of ONE caption lane into the earliest: span = the union, text = the texts joined by a line break in time order, style kept, the others deleted; a union overlapping another cue of the lane is refused (`LayerOverlap`).
- `export_captions { format, track_id?, composition_id? }` → `{ format, cues, body }` — a composition's captions (every caption lane, or one `track_id`) as an SRT or WebVTT body in time order; a read, write the body to a file yourself.
- `apply_subtitles { body, format? }` — SRT/VTT/ASS body inline; format sniffed when omitted. Lands the cues as editable `Text` layers (one per cue) on the composition's caption-role tracks: each cue goes to the first unlocked caption track with room for its span, and a new caption track opens only for a cue that collides with all of them (ADR 0070). An older client may still send `track_id`, `t_start_us` or `t_end_us`; they are accepted and ignored (cue timings come from the body, and the lane is the packing's to pick) and not advertised. Returns `{ caption_track_id, cues, simplified }`.
- `update_layer { layer_id, patch }` — envelope-only: `label`, `t_start_us`, `t_end_us`, `locked`. Any other key is refused naming that set — `enabled` is pointed at `set_layers_enabled`, a param key at `update_layer_params` — so a typo can never commit nothing and report success.
- `update_layer_params { layer_id, patch }` — kind-specific params; the schema advertises one `oneOf` variant per kind, each closed to that kind's fields. Every visual kind takes the static transform whole — `x`, `y`, `scale_x`, `scale_y` (not Text), `rotation_deg`, `anchor_x`, `anchor_y` (the pivot, as a fraction of the layer's box) — each written as a Static value that replaces any keyframes on that param. A Text layer's face is `font_family`, `font_size_px`, `font_weight` (100..900) and `italic`; its `shadow` is a whole `{ color, offset_x, offset_y, blur }` record or `null` for none (captions keep to an outline — ADR 0026). `patch.kind` is one of `Text | VideoClip | ImageOverlay | Motif | Color | Audio | CompositionRef` and must match the layer; every other key must be in that kind's set (the parser names it on refusal, and says which kind a stray key belongs to), and every value is type-gated at the boundary — enums for `align`/`valign`/`role`/`blend_mode`, `{r,g,b,a}` for colours, integers for the µs fields. `null` is a value only for `box_w`/`box_h` (back to auto); elsewhere it is refused, since an omitted field is how a field is left alone. Text also takes `outline_width` (0 removes) and `outline_color`. On a scale-linked layer, a patch that leaves `scale_x ≠ scale_y` auto-clears the link in the same commit; patch both axes to the same value to keep it.
  - Text: `{ content?, font_family?, font_size_px?, font_weight?, italic?, shadow?, color?, x?, y?, opacity?, rotation_deg?, anchor_x?, anchor_y?, align?, valign?, box_w?, box_h?, line_height?, letter_spacing?, outline_width?, outline_color? }`. `outline_width` 0 removes the outline (stored as `null`, the absent style a Text layer is born with); a positive width adds or resizes it, black until coloured. `outline_color` needs an outline to colour — with none stored, send `outline_width > 0` in the same patch, or it is refused (`InvalidArgument`, field `outline_color`) rather than answered with a guessed width. `box_w`/`box_h` are the layout box in composition pixels, local (before `scale`), and which of the two are set **is** the resize mode: `(null, null)` auto width (never wraps), `(set, null)` auto height (wraps), `(set, set)` fixed (wraps and shrinks to fit). Send an explicit `null` to put an axis back to auto; omit the field to leave it alone. A `box_h` with no `box_w` — neither stored nor in the same patch — is refused (`InvalidArgument`, field `box_h`) rather than measured by guess: this surface has no canvas, and no default may silently invent a width. A box axis is either `null` or a positive extent — `0` and negative are refused, because the renderer reads a non-positive width as "no box" and would draw auto width while state claimed fixed. `align` places the text block horizontally inside the box, `valign` (`Top | Middle | Bottom`) vertically; both are checked against their enums here rather than trusted, since an unrecognized `valign` would reach the sprite as a `NaN` anchor. There are deliberately **no scale fields** on a Text patch — a bigger title is a bigger box, and `font_size_px` is what reaches the frame at any box size; animate a text layer's size with `scale_x`/`scale_y` through the keyframe tools instead. See [ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md).
- `set_scale_linked { layer_id, linked }` — toggle a layer's uniform-scale link (visual kinds only). `linked=true` snaps `scale_y` to a whole-track copy of `scale_x` (keyframes included, fresh key ids) in the same commit — one undo restores both. `linked=false` clears only the flag. While linked, the two scale tracks are structural twins and the human UI edits them as one collapsed "Scale"; any write that diverges them (single-axis `update_layer_params` / `set_keyframe` / `set_param_track`) auto-clears the flag in that write's commit.
- `shift_layers { layer_ids? | from_t_us?, track_ids?, delta_us, escape_link?, composition_id? }` → `{ moved: [layer records], delta_us, requested_delta_us }` — the multi-layer move: shift a named set (link partners ride along unless `escape_link`) or every layer starting at or after `from_t_us` (on `track_ids`, else every track) by one `delta_us`, as one recorded edit. A positive delta at `from_t_us` is the ripple **insert** — open the gap, then place into it; a negative one closes a gap. Each layer snaps on its own grid (each record's `adjusted` shows where it landed, since one delta lands differently on a frame grid and a sample grid); a sweep from `from_t_us` that would move one member of a link and not another is refused (`ShiftLinkStraddles`) — name the set with `layer_ids` to move the link whole; a start that would cross 0 is refused (`NegativeLayerStart`), a landing on an occupied span is refused (`LayerOverlap`, naming the pair), a locked lane refuses (`TrackLocked`); nothing moves on a refusal.
- `move_layer { layer_id, new_track_id, new_t_start_us, escape_link? }`
- `move_layers_to_composition { layer_ids, to_composition_id, anchor_layer_id, anchor_t_start_us, to_track_id? }` — the same move, across compositions: the set (at least one, all in one composition) leaves the composition it is in and lands in `to_composition_id` at an ABSOLUTE time on that composition's clock. The ROOT is an ordinary destination — moving a clip out of a Group and back into the film IS this op. `anchor_layer_id` names the member `anchor_t_start_us` positions; every other member keeps its offset from the anchor. Lanes are assigned per SOURCE TRACK, and `to_track_id` decides how: omitted bounces to the nearest free lane, `"spawn"` takes one fresh lane, a lane id is refused rather than bounced when it is locked or occupied. Full contract, including every refusal, on the tool's own description.
- `restack_layer { layer_id, anchor_layer_id, position }` — anchored z-reorder: `position` ∈ `"above" | "below"` places the layer directly above/below the ANCHOR layer's track, resolved at apply time (anchors are layers, not indices — an index drifts between your read and your write). Degrades smartly: a mover that is its track's sole occupant moves the whole track (id, label, lock and height survive); a mover sharing its track (an off-screen neighbour or a co-resident audio layer) splits onto a new track at the target position, and the source is pruned only if that emptied it. A role-stamped (A/B-roll skeleton) source track never moves — the mover always splits off it and the skeleton stays put. The anchor may sit on a reserved track ("put this above the A-roll clip"). Restacking a layer to where it already sits is a no-op that burns no op id (the `move_track` contract). Audio never stacks: an Audio mover or Audio anchor rejects (`WrongLayerKind`), as does `layer_id == anchor_layer_id`. Front/back are not variants — derive them as above-the-top / below-the-bottom of the visual stack you are looking at. One recorded commit: a single undo restores the layer, its track and any pruned track together.
- `split_layer { layer_id, at_t_us, escape_link? }` → `{ left, right, layers, siblings: [{ source, left, right }], adjusted }` — `siblings` names every link member's halves, so a pair split by sound needs no re-link by hand
- `auto_split_by_shot { layer_id, min_shot_us?, drop_short? }` → `{ layer_ids }` — detect the VideoClip's shot cuts and split it at every in-window cut in ONE undoable step; returns the new segment layer ids in timeline order (or the single unchanged id when there is no interior cut). `min_shot_us` (default `500000`) is the detection minimum-shot length (closer cuts merge); `drop_short=true` also deletes any resulting segment shorter than `min_shot_us`. Pure convenience — reproducible with `analyze_clip` + `split_layer`. It reads the source's one cached floor scan (the report the Shots review Panel and "Mark shot cuts" read too) and reduces it at `analyze_clip`'s defaults, so its boundaries agree with `analyze_clip`'s; the two hold separate cache entries, because `analyze_clip` also samples per-shot stats (ADR 0057). Link-aware: an auto-paired audio partner splits in lockstep, and with `drop_short=true` a dropped segment takes its partners with it — every other member of the layer's link overlapping the dropped span is deleted in the same commit, so no orphaned audio sliver is left at that cut. A member sitting wholly inside a surviving segment stays; `delete_layers` remains local.
- `trim_layer { layer_id, edge, new_t_us, escape_link? }` — `edge` ∈ `"in" | "out"`.
- `separate_audio_to_new_track { layer_id }` → the new track's record + `layer` — lift an Audio layer onto a lane of its own, in the source lane's slot. The layer is untouched (same id, span, gain, role, links); only its lane changes, so this is how an auto-paired dialogue clip gets room without breaking the pair — the link survives, and `delete_link` is what makes the two independent. `WrongLayerKind` on anything but an Audio layer. The new lane is the one track in the model that stores a name (`'<source> (audio)'`, when the source had one); a source lane the lift emptied is pruned in the same edit.
- `delete_layers { layer_ids, ripple? }` — delete a SET as one recorded edit, one undo for all of them. **`ripple` decides what happens to the span they vacated**, and is the whole difference between the two deletes an editor has. Default (`false`) is the **lift**: the spans stay empty and nothing downstream moves. `true` **closes** each span, so the film gets shorter: the span closed for a layer is its own footprint clipped to its remaining same-class neighbours on its track (a transition's authorized overlap is therefore not part of it), touching holes merge, and every remaining layer starting at or after a hole shifts left by its length on **every** track of the composition, each on its own lattice, with anchored markers riding along. A gap that already sat beside the layer, a layer that starts before the hole, free markers and the playhead all stay put. Either way: duplicate ids collapse; the set is one composition's (`CrossCompositionSet` otherwise); a member on a **locked track** refuses the whole batch (`TrackLocked`) rather than deleting the unlocked half; a layer's own `locked` does not block a delete, because it gates the pointer, and the selection tools skip such a layer rather than refusing; tracks the batch emptied are pruned with it. A ripple refuses whole, before any write: `RippleInsideHole` (a remaining layer starts inside the span — add it to `layer_ids`, or delete without `ripple`), `RippleCollision` (a mover would land on a layer that is not moving), `RippleLinkStraddles` (a link with members on both sides), `RippleLockedLayer` / `TrackLocked` (only a layer that actually shifts blocks). An empty `layer_ids` records nothing as a lift, and is refused as a ripple — there is no hole to close.
- `ripple_delete_gap { track_id, start_us, end_us }` — close a **gap**: the empty span `[start_us, end_us)` on one track between two layer boundaries, so everything after it moves left and nothing is deleted ([ADR 0069](adr/0069-a-gap-is-a-selectable-span-whose-delete-closes-it.md)). `end_us` must be exactly where a layer on that track starts and `start_us` exactly where one ends (or `0` — the space before the first clip is a gap); the space after the last layer is not a gap, and a piece of a gap is not the gap. The closing is `delete_layers { ripple: true }`'s closing with the gap as the one hole, so the same refusals apply by name (`RippleInsideHole` for a layer on another track starting inside the gap, `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked` — a gap on a locked lane always refuses, since its own downstream clip would have to move), plus `GapNotFound { track, s, e }` when the span is not a gap as the actor sees it: re-read `project://compositions` and send the gap as it is now. One recorded edit, one undo.
- `paste_layers { layer_ids, t_start_us? | t_offset_us?, target_track_id? }` → `{ clones: [{ source, clone }], layers, adjusted }` — the whole-link duplicate, one recorded edit, and the only copy tool. `layer_ids[0]` is the **seed**, and where its clone starts is named either absolutely (`t_start_us`) or relative to the seed's own start (`t_offset_us`, the same-place copy that needs no prior read) — send exactly one. Every other clone shifts by that same delta, each snapped on its own lattice (an audio member keeps a slipped A/V offset). `target_track_id` moves only the seed's clone; every other clone lands on its source's track. **All-or-nothing:** a locked or occupied destination for any member rejects the batch (`TrackLocked`, or `ValidationFailed`/`LayerOverlap` whose `b` names the source whose clone would collide) and nothing is created. Two or more clones are linked to each other, never to their sources. Pass a single id to copy one linked layer without its partners.
- `set_layers_enabled { layer_ids, enabled }` — set `enabled` on exactly these layers in one recorded edit. Nothing is expanded here: to disable a linked pair together, pass both members. A layer's own `locked` does not block the toggle (visibility is not content); a layer on a locked track rejects the whole batch. This is the only tool that writes `enabled`, for one layer as for many — `update_layer`'s patch deliberately does not carry it.

Position and motion paths:

VideoClip, ImageOverlay, Text, Motif and CompositionRef (Group) layers have a
`Transform.position` with exactly one active representation. `XY` keeps
independent scalar `x`/`y` animation; `Path` stores timestamp-free geometry and
a separate scalar `progress` animation. Text's evaluated position is its
transform pivot (the text box's anchor); the other kinds use the unrotated
top-left. Switching representations does not change that reference point.
See [ADR 0060](adr/0060-position-has-xy-and-path-modes.md).

- `set_position { layer_id, position }` — atomically replace the **complete**
  position record in one undo entry. `position` is either
  `{ mode: "XY", x: Animated<number>, y: Animated<number> }` or
  `{ mode: "Path", path: { nodes: [...] }, progress: Animated<number> }`.
  Keyframe `t_us` inside this record is **layer-local microseconds**, snapped
  to the owning composition's frame grid, unlike the timeline-absolute times
  on `set_keyframe` / `set_param_track`. Temporal Auto / Smooth tangents are
  resolved on write. This tool replaces existing motion; it does **not** fit
  or bake it automatically. For geometry edits, read and retain the current
  progress record; there is no MCP `geometry_only` argument.
- Each spatial node requires `{ id, point: {x,y}, in_handle: {x,y},
  out_handle: {x,y}, segment: "Line" | "Cubic",
  tangent_mode: "Corner" | "Smooth" | "Auto" }`. Points are in composition
  pixels; handles are relative pixel vectors, not temporal easing controls.
  `segment` describes the span leaving the node. Corner handles are
  independent; Smooth aligns their directions while retaining separate
  lengths; Auto resolves handles from neighboring points on write. Use Cubic
  spans where spatial handles should affect the route. Bounds: 1–128 nodes,
  unique nonempty node ids, finite coordinates within ±10 million pixels.
- `progress` uses fractions, **not percentages**: `0` is the start and `1` is
  the end, traversed by distance rather than by node index. Values outside
  that range extend the endpoint direction; zero-length geometry stays put.
  At most 4096 progress keys; only `Hold`, `Loop` and `PingPong` extrapolation
  are supported (`Offset` / `Continue` are refused).
- `translate_path { layer_id, dx, dy }` — Path mode only. Move all nodes by
  the finite relative displacement in composition pixels, retaining handles,
  shape and the progress animation. One undo entry; no replacement XY track
  is created. Use this for moving an existing route as a whole.
- In Path mode, independent `x`/`y` writes through `update_layer_params` or
  keyframe tools are **rejected**. Animate `param_key: "path_progress"`
  instead; it is unavailable in XY mode. To return to XY, explicitly supply
  XY tracks with `set_position` or use the UI's previewed conversion. UI
  fitting/baking has no dedicated MCP conversion tool.

Example `set_position` arguments for a stationary point at the start of a
two-node line (replace `layer_id` with the target layer's id):

```json
{
  "layer_id": "00000000-0000-7000-8000-000000000001",
  "position": {
    "mode": "Path",
    "path": {
      "nodes": [
        { "id": "start", "point": { "x": 100, "y": 200 }, "in_handle": { "x": 0, "y": 0 }, "out_handle": { "x": 0, "y": 0 }, "segment": "Line", "tangent_mode": "Corner" },
        { "id": "end", "point": { "x": 500, "y": 200 }, "in_handle": { "x": 0, "y": 0 }, "out_handle": { "x": 0, "y": 0 }, "segment": "Line", "tangent_mode": "Corner" }
      ]
    },
    "progress": { "mode": "Static", "value": 0 }
  }
}
```

Then use `set_keyframe` with `param_key: "path_progress"`, values `0` and
`1`, and two **timeline-absolute** `t_us` values to animate along the line.

Effects (per-layer chains; two families that share one `Effect` record and nothing else — VISUAL kinds are realtime Pixi filters: `blur`, `chromakey`, `brightness`, `contrast`, `saturation`, `sharpen`; AUDIO kinds are the `audio.*` namespace and are offline bakes of the clip's audio: `audio.denoise`. See [ADR 0027](adr/0027-per-layer-effects-pixi-filter-chains.md) and [ADR 0063](adr/0063-audio-effects-are-baked-conform-siblings.md)):

- In v1, visual effects render on all five visual layer kinds: VideoClip, ImageOverlay, Color, Text, and Motif; audio effects apply to Audio layers.
- `add_effect { layer_id, kind }` → `{ effect_id, layer_id, kind, enabled, index, params }`. Append an effect to the end of the chain (applied last). `kind` is an enum of the two catalogs — the visual registry's kinds (`src/shared/effects/params.ts`, pinned to `effectRegistry.ts` by test) and the `audio.*` catalog's — and an unknown kind is refused naming them; the stored model stays permissive for a project written by a newer build (ADR 0027), the agent surface does not. Creates the effect with no params set; use `update_effect` to set a static value or `set_keyframe` to keyframe a param.
- **The kind must match the layer kind.** An `audio.*` kind goes on an Audio layer and only on an Audio layer, and a visual kind never goes on one: `EffectKindNotApplicable`, whose message names both the kind and the layer kind (`project://tracks` reports each layer's kind). An unknown NON-audio kind is still accepted and stored — the visual catalog lives in the renderer — and renders as nothing.
- `audio.denoise` removes steady background noise (ffmpeg `afftdn` with a sampled noise profile). Params: `strength` (noise reduction in dB, `[1, 40]`, default 12), `margin` (dB above the measured noise floor, `[0, 20]`, default 8), and the sample region `profile_in_us` / `profile_out_us` — **source-time** bounds of a span containing only noise, at least `250000` µs long and inside the media's duration. It does nothing at all until both bounds are set, and nothing silently falls back to an unsampled profile. The chain is rendered once into a cached sibling of the media's conform audio, so the effect takes a moment to land after a param change; both the preview and the export read that same file, and an export waits for it rather than exporting the unprocessed audio.
- `brightness`, `contrast` and `saturation` each carry exactly one param, `amount`: a percentage offset from neutral in `[-100, 100]`, `0` = no change (`amount: 20` is "+20 %"). Brightness is a gain, so `0` preserves black; saturation desaturates on Rec.709 luma weights.
- `sharpen` carries the same `amount` param on the same percentage scale, but in `[0, 100]` — `0` = no change and there is no negative side, since a negative unsharp amount is a box blur and that is what `blur` is for (a negative value renders as no change, not as a blur). It is a fixed 3×3 cross unsharp (no radius param).
- `update_effect { layer_id, effect_id, patch }` — patch is `{ enabled?, params? }`; v1 params are scalar `{ "mode": "Static", "value": <number> }`. `params` merges key-by-key, and a **`null` value removes its key**, returning that param to unset/default — the only way to unset an effect param (removing an absent key is a no-op, not a failure). For a catalogued kind, a param key the kind does not have and a value outside its range (static or any keyframe) are refused naming the set or the bound, before any write; an unparseable patch rejects with `invalid_params` and never partially applies.
- **`audio.*` params are static only** (`AudioEffectParamStatic`): an audio effect is a whole-clip offline bake, so there is no per-frame value to animate. Send them here as `{ "mode": "Static", "value": <number> }`; both a `set_keyframe` on `effects[<id>].params[<key>]` and a `Keyframed` `set_param_track` for one are refused, and the inspector shows no stopwatch on those rows.
- `move_effect { layer_id, effect_id, new_index }` — reorder (0 = first applied).
- `delete_effect { layer_id, effect_id }` — delete.
- Keyframe a **visual** effect param via `set_keyframe { layer_id, param_key: "effects[<effect_id>].params[<key>]", t_us, value, interp? }`. **Ordering:** `add_effect` creates an effect with no params; set a static value first with `update_effect` (so the param key exists), then use `set_keyframe` to lift it to keyframed. Calling `set_keyframe` on a param key that has never been set returns `UnknownKeyframeParam`; calling it on an `audio.*` effect's param returns `AudioEffectParamStatic` (see above).

Keyframes (animate a layer param's `Animated<T>` track; times are timeline-absolute µs; the record is [`data-model.md` § Animated values](data-model.md#animated-values), the decision [ADR 0058](adr/0058-tangents-live-on-the-key-the-segment-class-on-the-left-key.md)):
- `get_param_track { layer_id, param_key }` → `{ mode, value }` (Static) or `{ mode, extrapolate: { before, after }, keyframes: [{ id, t_us, t_local_us, value, in, out, continuity, segment, preset_id? }] }` (Keyframed) — the keyframe record itself. Read this to discover keyframe ids before editing. Per key, `in` / `out` are the arriving / leaving **tangents** `{ x, y, mode }`: a control point in the owning segment's unit square (`x` the fraction of its time span, `y` of its value span), with `mode` `Auto` (solved on every write — clamped monotone, never overshooting) or `Free` (authored); `in` is stored un-mirrored, as the arriving cubic's own second control point. `continuity` is `Smooth | Broken` — whether the two sides are kept at one slope. `segment` is the class of the segment leaving the key, `Spline | Hold | Linear | Elastic | Bounce`; only Spline reads the tangents, and a Spline segment `a → b` is the cubic `(a.out, b.in)`. `preset_id` names the canonical easing preset that leaving segment (this key's `segment` + `out`, the next key's `in`) exactly matches (presets bake to tangents; the name is recovered by exact-float reverse lookup); a hand-tuned curve and the last key omit the field. `extrapolate` is what the track does outside its keys (`set_extrapolation`, below).
- **Values are typed by `param_key`.** `value` on `set_keyframe` / `clear_keyframes`, and every value in a `set_param_track` record, is a number for the scalar params and an `{ r, g, b, a }` colour (integers 0–255) for `color` — the Text and Color layers' colour, the one colour that animates (shadow and outline colours are static). `get_param_track` returns the same types. A mismatch is refused with the param's value type in the message.
- `set_keyframe { layer_id, param_key, t_us, value, interp? }` — insert-or-update. Lifts a Static track; updates in place at the same frame. `interp` (a raw kind from the list below — not the preset form, which is an `update_keyframe { easing }` payload) is the easing of the segment leaving the key and writes this key's `segment` + `out` and the next key's `in`, both Free; omitted, the new key inherits the preceding segment's easing (Linear on a fresh track).
- `delete_keyframe { layer_id, param_key, keyframe_id }` — last key collapses to Static holding its value.
- `update_keyframe { layer_id, param_key, keyframe_id, t_us?, easing?, in?, out?, continuity? }` — one key, several aspects, one commit, applied in this order. `t_us` moves the key (the track re-sorts). `easing` is the segment leaving the key as one easing: writes the leaving key's `out` tangent and the next key's `in` tangent, both Free, plus the leaving key's `segment` (Spline for a Bezier and the bezier-family presets; Hold / Linear / Elastic / Bounce as themselves, with identity sides). The next key's own `out` is left alone, so smoothness downstream survives. `easing` is one of:
  - `{ "preset": "<id>" }` — a named preset from the canonical easing table (`src/shared/easing.ts::EASING_PRESETS`, the single source of the id list: `linear`, `hold`, the CSS curves `ease`/`ease_in`/`ease_out`/`ease_in_out`, and the `ease_{in,out,in_out}_{sine,quad,cubic,quart,quint,expo,circ,back,elastic,bounce}` families). Bezier-family presets bake to their canonical params at write time; the name comes back as `preset_id` on `get_param_track`. An unknown id rejects with the full live list in the error message.
  - `{ "kind": "Hold" }` | `{ "kind": "Linear" }`
  - `{ "kind": "Bezier", "p1": [x, y], "p2": [x, y] }` — control-point x within `[0, 1]` (x is segment time and the solver is single-valued only there; y may overshoot).
  - `{ "kind": "Elastic", "dir": "In" | "Out" | "InOut", "amplitude"?, "period"? }` — `amplitude` ≥ 1 (default 1), `period` > 0 (default 0.3); omitted params take the defaults.
  - `{ "kind": "Bounce", "dir": "In" | "Out" | "InOut" }`
  `in` / `out` / `continuity` write one key's shape directly. A provided side `{ x, y }` is stored Free with exactly those numbers — `x` within `[0, 1]`, refused outside and never clamped; `y` may overshoot — and the segment it shapes becomes Spline if it was not, so the tangent is read. Writing either side of an Auto key frees the whole key (the other side keeps its solved numbers); on a key already Smooth the opposite side rotates to the same slope. `continuity: "Smooth"` re-derives `in` from `out` in the same write ("out wins", the rule every write applies); `"Broken"` changes no number.
- `smooth_keyframes { layer_id, param_key, keyframe_id? }` — set Auto tangents (clamped monotone, solved on write and kept smooth as neighbours move) with Smooth continuity on one key, or on every key when `keyframe_id` is omitted; the adjacent segments become Spline.
- `set_extrapolation { layer_id, param_key, before?, after? }` — what the track does outside its keys, per side (at least one; the other keeps its value): `Hold` (the end value — the default), `Loop` (repeat the cycle from the first key; a visible jump when first ≠ last, nothing bridges it), `PingPong` (alternate cycles run backwards), `Offset` (each cycle adds the last-minus-first delta), `Continue` (carry the last segment's end velocity on as a line; zero after a Hold or procedural segment). The period is `last.t − first.t`; a single-key track never extrapolates. Refused on a Static track — add keys first.
- `clear_keyframes { layer_id, param_key, value? }` — collapse to Static (defaults to the first keyframe's value).
- `set_param_track { layer_id, param_key, track }` — low-level: replace the whole track in the `get_param_track` record shape (keyframe `t_us` timeline-absolute; each tangent's `x` within `[0, 1]`; `extrapolate` defaults to Hold / Hold when omitted). Auto sides and the `in` side of a Smooth key are re-solved on write, so the coordinates sent for those are overwritten with the solved ones. Retiming many keys, or pasting a whole track, is one commit here.

Valid `param_key`: VideoClip/ImageOverlay/Text/Motif/CompositionRef →
`scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity`, plus `x, y` in
**XY mode only**, or `path_progress` in **Path mode only**. In Path mode,
`x`/`y` writes are rejected; `path_progress` values are fractions (0–1), not
percentages, and its extrapolation is limited to Hold / Loop / PingPong.
Text/Color → `color`; Audio → `gain_db, pan`. Each write routes through the
actor's `update_layer_param_track` (snap-to-frame, sort, dedupe, lock check,
then the Auto / Smooth tangent solve). Unlike `update_layer_params`, these
preserve/produce keyframes rather than wiping them. Keying only one scale
axis of a scale-linked layer diverges the twin pair and auto-clears the link
in the same commit (see `set_scale_linked`); write both axes identically to
animate a linked layer's scale.

Transitions (one per cut, between two adjacent layers on the same track; see [ADR 0048](adr/0048-transition-overlap-by-placement-not-extension.md)):
- `add_transition { from_layer_id, to_layer_id, duration_us, kind?, direction?, placement? }` → the new transition id. The pair must be genuinely adjacent — the outgoing layer's `t_end_us` equal to the incoming layer's `t_start_us`. `placement` decides where the overlap COMES FROM, which is the whole design: the default `"overlap"` moves the INCOMING layer left by the frame-rounded duration, so both layers still play exactly their trimmed ranges (`extended_us = 0`) and the span it vacated stays a gap — nothing ripples; `"extend"` instead borrows outgoing tail media past its source out-point, leaving positions untouched (`extended_us = duration`) and pre-checked against the tail that remains (`TransitionInsufficientHandle` carries `available_us`). A pair already overlapped by EXACTLY the duration attaches as-is under either. `kind` ∈ `Crossfade` (default) | `Wipe` | `Slide`; `direction` is the MOTION direction (`"left"` = the boundary moves leftward), required for Wipe/Slide and rejected for Crossfade. The incoming layer's link siblings follow its move, bouncing to a free lane when theirs is occupied. Visual layers only — an Audio participant is `TransitionUnsupportedLayerKind`. Refuses when the two share a link (moving one would drag the other, so the overlap never opens), when a moved member would cross `t = 0`, or when the duration exceeds either participant. One recorded edit.
- `update_transition { transition_id, duration_us?, kind?, direction?, extended_us? }` — patch geometry in ONE commit; only the fields you set apply. `(duration_us, extended_us)` is a two-target model that fully determines both window edges: `extended_us` is the borrowed share (0 = pure placement, `duration_us` = pure borrow), the outgoing layer ends at its sacred exit frame + `extended_us`, and the incoming layer starts `duration_us` before that end. OMIT `extended_us` and the routing preserves trimmed ranges — growing moves the incoming layer further left and never borrows tail, shrinking returns borrowed tail first and then moves right by the remainder. Only an explicit `extended_us` can GROW the borrow, and a NEGATIVE one is a deliberate tail trim: all borrowed tail returns and real content is trimmed by the remainder, moving the exit frame itself. `direction` rides inside `kind` — changing to Wipe/Slide needs both in the same call, and `direction` alone or beside Crossfade is rejected. `TransitionNotFound` for an unknown id.
- `delete_transition { transition_id }` — restore the hard cut, routed by provenance: the outgoing layer's end shrinks back by `extended_us` (only borrowed tail is returned — real content of a pre-positioned overlap is never trimmed) and the incoming layer moves RIGHT by `duration_us − extended_us`, siblings following. `TransitionRestoreCollision` when the vacated gap has since been filled — the system never makes room; move the blocker first.

Audio roles (a project-level mix fold, not a track property; see [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md)):
- `set_role_gain { role, gain_db }` — `role` ∈ `dialogue` | `music` | `sfx` | `voiceover`. Folds onto every layer of that role at mix time rather than summing through a per-role bus, so it reaches the export the same way it reaches the preview. Recorded (undoable).
- `set_role_flags { role, muted?, solo? }` — mute/solo a role. **Unrecorded**, unlike every other mutation here: a monitoring state is not an edit, so it burns no undo step. Mute wins over solo, and any solo silences the non-soloed roles.

Links (see [features.md §Links](features.md#links)):
- `create_link { layer_ids, reassign? }` → `{ link_id, composition_id, members }`
- `delete_link { link_id }`
- `update_link { link_id, add_layer_ids?, remove_layer_ids?, reassign? }` — one recorded edit, applied add → remove; `reassign` lets an added layer leave another link first, and a link left below two members dissolves
- Reads: there is no `links_list`/`links_get` tool — link membership is carried on the `project://current` resource as `links: [{ id, layer_ids }]`.

Groups (see [features.md §Groups](features.md#groups)):
- `create_group { layer_ids, label? }` → `{ composition_id, layer_id, layer }` — pre-compose: the layers (one or more, all in one composition) move into a new composition, placed back as one Group layer at their earliest start on the top-most lane they occupied. Never partial: a locked member refuses the whole set (`GroupLockedMember`), so does a locked track (`TrackLocked`); a set spanning two compositions is `CrossCompositionSet`. Links fully inside move with the set, a straddling link loses its inside members; transitions between two members move, a straddling one is dropped and logged; markers stay.
- `add_group_layer { source_composition_id, track_id, t_start_us, composition_id? }` → the layer record + `adjusted` — place an existing composition as one more Group layer: a second instance of a Group already in the project. Created windowed over the whole composition (`src_in_us: 0`, `src_out_us: duration_us`) with an identity transform, so it renders what the composition renders; trim it afterwards for a slice. Instances are independent of each other and all show the same content, so an edit inside the composition appears in every one. Refuses before anything is created: the root (`RootComposition`), a composition that already reaches this track's composition — itself included (`ValidationFailed` / `CompositionCycle`, whose `path` is the loop), and a composition with nothing inside it (`InvalidArgument`). `create_group` is the one that makes a NEW Group.
- `add_group_members { layer_ids, group_layer_id }` — move layers already on a timeline INTO the composition a Group layer shows, keeping the screen position they had: one of the four ops that cross compositions. Reach for `move_layers_to_composition` instead when you know the destination composition and the time you want. The members (at least one, all in one composition) and the Group clip must be siblings; the clip's `params.composition` is the destination. Each member lands at `t_start_us − group.t_start_us + group.src_in_us`, re-snapped on its own lattice, so it keeps the screen position it had — a member outside the Group clip's window arrives outside it and shows as overhang. Source tracks map bottom-up onto the destination's existing lanes and spawn one past the end; a whole source track's members travel together onto one lane (so a transition between two of them survives) and bounce as a block off a locked or occupied lane. Links and transitions follow `create_group`'s rules; markers stay behind. Both compositions autofit and NO Group layer is retrimmed. Refuses whole, before any write: `CrossCompositionSet`, `WrongLayerKind`, `GroupLockedMember` / `TrackLocked`, `ValidationFailed` / `CompositionCycle` (a member whose composition already reaches the destination, itself included), and `InvalidArgument` on `layer_ids` for a member that would land before composition time 0.
- `ungroup_layer { layer_id }` — expand a Group layer in place. Refuses unless the layer is plain — identity transform, static opacity 1, no effects, Normal blend — with `GroupNotPlain { reason: "transform" | "opacity" | "effects" | "blend_mode" }`, because expanding would discard those silently. Members outside the layer's `[src_in_us, src_out_us)` window are dropped, straddling ones trimmed with their source window following. The composition is removed when nothing else references it.
- `rename_composition { composition_id, label? }` — `null` / blank clears the name; the root refuses (`RootComposition`).
- `delete_composition { composition_id }` — an orphan only: `CompositionInUse { ref_count }` while any Group layer references it, `RootComposition` for the root.
- Reads: `project://compositions` lists every composition with its `ref_count`; a Group layer's `params.composition` names its composition.

Markers + composition:
- `add_marker { t_us, label, color, end_t_us?, anchor_layer_id?, composition_id? }` → `{ marker_id, composition_id, t_us, end_t_us, label, note, color, anchor, adjusted }` — markers are per composition; `update_marker` / `delete_marker` find theirs by id. Free unless `anchor_layer_id` names a clip for the mark to follow
- `update_marker { marker_id, patch }` / `delete_marker { marker_id }`
- `set_marker_anchor { marker_id, layer_id }` — tie an existing marker to a clip of its own composition, or cut it loose with `layer_id: null`

**Markers follow clips.** A marker may be *anchored* to a clip of its own
composition — it then carries `{ layer, src_us }`, a time in that layer's SOURCE
domain, and its `t_us` is re-derived from the clip on every commit. So an
anchored marker travels with its clip through moves, trims, splits and a
crossing into another composition, and a deleted clip takes its markers with it.
`t_us` is still the field to read: it is a cache, but a stored one, so nothing
about reading a marker changes.

Two consequences worth knowing before you patch one:

- **`t_us` on an anchored marker moves the ANCHOR.** It names the time the mark
  should read; the actor derives `src_us` to make it read that, and the mark
  goes on following from the new offset. A time outside the clip's half-open
  span is refused, as is `t_us` together with `end_t_us` (the reconcile carries
  an anchored region's end by the same delta — patch one or the other).
- **A marker can be `hibernating`**: its `src_us` has fallen outside the clip's
  `[src_in_us, src_out_us)` window, usually because a trim moved the edge past
  it. It is retained, painted on no surface, and revived on the exact frame it
  always named the moment the window covers it again. Its `t_us` is frozen and
  names a moment nothing holds any more, so seek by `anchor_src_us` instead, or
  ignore it — which is what the lane, the search index and the Group badge do.

An anchor is named by the LAYER alone — on `add_marker` and `set_marker_anchor`
alike, never as the stored `{ layer, src_us }` pair. `src_us` is derived from
the time the mark lands on, so no call can produce a `t_us` and a `src_us` that
disagree; a caller free to name both could, and the next commit's reconcile
would settle it by moving the mark somewhere nobody asked for. Both tools refuse
the same three ways, before writing anything: a layer in another composition, a
kind with no source window (Color, Text), and a time the clip does not cover.

`add_marker` ties in the same commit that creates the mark, so one undo takes
both and a refused tie leaves no marker behind to clean up. `set_marker_anchor
{ layer_id: null }` is
the way back out, and the one exit from `hibernating`. The app sets anchors too
— marking with a clip selected, *Attach to clip*, and shot detection — so read
`anchor_layer` to see whether a marker follows one rather than assuming an
agent-created marker is free.
- `update_composition { patch, composition_id? }` — `patch.duration_us` pins the duration; `duration_us: null`, alone in the patch, unpins it and refits to `max(layer.t_end_us)` (the same fan-out as the pin: every history snapshot refits to its own high-water mark). Nothing in this tool records onto the undo stack;
  the patch is applied to every history snapshot, so undo walks past it. `fps` is
  locked once the timeline holds a layer **or any history snapshot / checkpoint
  does** (`FpsLockedByContent`, carrying the current rate, the requested rate, the
  live layer count and `locked_by: "current" | "history"`). With `locked_by:
  "history"` the layer count is 0 and the timeline looks empty — the rate is still
  refused because undo could bring old-grid layers back. Set the rate on a project
  that has never held a layer; to clear a history-scoped lock, empty the timeline
  and reopen the project (opening resets history). Markers, a pinned duration and
  unplaced media never lock it. `sample_rate` is an export target, not a grid, and
  is never locked.
- `set_project_settings { patch }` — the editor's preferences, beside the canvas
  `update_composition` owns, and unrecorded for the same reason: preferences are
  setup, so the patch reaches every history snapshot and undo walks past it. Only
  the fields you send are applied, an unknown key is **refused** rather than
  dropped (the stored settings hold fields this tool does not write, and a silent
  pass would report success for a preference that never changed), and an empty
  patch is refused too. Fields: `auto_pair_audio_on_import` (whether
  `add_video_layer` also places and links the source's audio — turn it off to
  place a video silent, or to resolve a paired-audio overlap by hand),
  `prefer_proxies` and `proxy_override { media_id, value }` (playback only; export
  always reads the original, and `value: null` removes the exception),
  `shot_review { sensitivity, min_shot_us }` and `pause_review { threshold_amp,
  min_pause_us, pad_us }` (each validated and refused as a **whole**, against the
  bounds the detectors enforce, so a stored tuning is always one a later
  `analyze_clip` / `remove_pauses` accepts; `null` clears it back to the
  detector's defaults), and `correction_script` (the reference text
  `correct_caption_text` corrects against). Read the current values from
  `project://current`.

Catalog:
- `list_motifs()` → `[{ id, name, version, size: [w, h], default_duration_s, props_schema, status, content_hash, has_params_ui, target_id? }, ...]`. `status` is `builtin | installed | draft`; drafts may carry `target_id` (the Motif they update); `has_params_ui` reports whether the Motif ships its own parameter page (see [motifs.md](motifs.md) "Parameter UI") — a draft without one gets the generated fallback form, which is the normal agent path. Inspect `props_schema` before calling `add_motif_layer`. Drafts are placeable immediately for preview.

Motif authoring (see [motifs.md](motifs.md) "Agent surface"):
- `get_motif_source { id }` → `{ manifest, html }` — any built-in, installed, or draft.
- `write_motif_draft { manifest, html, from? }` → draft id. `from` records an existing Motif as the update target.
- `preview_motif_draft { id, t_sec, width?, height?, props? }` → base64 PNG of one frame. `props` are canonicalised against the manifest exactly as `add_motif_layer`'s are: omitted keys take the schema defaults, an unknown key is refused naming it, an unknown `id` is refused naming `list_motifs`.
- `install_motif { draft_id, mode: new | update, target_id? }` — publish; `update` republishes over `target_id`, or over the target the draft recorded at `write_motif_draft { from }` when `target_id` is omitted, and is refused when it has neither (naming both ways to supply one); it bumps the version and rebinds placed layers.
- `delete_motif { id }` — remove a user Motif. Built-ins are refused, and so is an id that names neither an installed Motif nor a draft — a typo must not read as a removal.

### Workflow / safety

- `ping()` → `"pong"` — liveness. The one tool that reads no project state and needs no open workspace, so it separates "the host is not running" from "the host refused my call" before anything else is diagnosed.
- `create_checkpoint { label }` → `{ checkpoint_id, label }`
- `list_checkpoints()` / `restore_checkpoint { checkpoint_id }` — restore clears redo and replaces the current snapshot.
- `delete_checkpoint { checkpoint_id }` — drop a restore point. Only the marker goes; the edits it marked stay, nothing about the timeline or the undo stack changes, and there is nothing to undo afterwards. `CheckpointNotFound` for an id `list_checkpoints` does not report. Deliberately **not** blocked by `set_history_lock` — the lock rejects revert paths, and forgetting a restore point reverts nothing.
- `undo()` / `redo()`
- `jump_to { index }` — move the history cursor to an absolute stack index: the history panel's click-a-row, and the way back to a state that is neither one undo away nor a checkpoint. `index` is `project://history`'s numbering (`ops[i]` sits at `window_start + i`, and `cursor` is where you are), so jumping is reading that resource and naming a row; out of range is refused naming the live bounds. A revert path, so `set_history_lock` blocks it with the lock's reason. It records nothing, and a later edit truncates whatever sat ahead of it exactly as after an undo. `evicted > 0` means the stack no longer reaches the start of the project — index 0 is then the oldest surviving state, not the beginning.
- `set_history_lock { locked, reason? }` — freeze undo while a tool batch runs, and release it again; the UI shows the reason. Locking needs a `reason` (it is what the user is shown in place of undo); unlocking refuses one.
- `begin_agent_session { reason }` → work session with stable `id`, `connection_id` and `checkpoint_id`. Creates one Pre-agent checkpoint and enters the lightweight agent view. One active work session per project: repeating on the same connection returns it without another checkpoint or view switch; another connection receives `AgentSessionBusy`.
- `end_agent_session { force? }` — ends the calling connection’s work session and releases its owned undo lock. Another connection cannot end it (`AgentSessionOwnerMismatch`, naming the holder) — unless it passes `force: true`, the takeover for a holder that is gone: the session ends with `end_reason: 'forced'` and its lock releases whoever's connection took it. Repeating after end is safe. The user can also end work or unlock locally in the agent panel. Ending work keeps the current view and activity; it does not cancel running operations, disconnect MCP or prohibit later calls.
- `dry_run { operations }` — applies the batch against a clone, validates after each op (matching `commit()`), halts at the first error. Does not commit. Op variants: `add_color_layer`, `add_video_layer`, `add_audio_layer`, `add_text_layer`, `add_transition`, `update_layer`, `update_layer_params`, `move_layer`, `split_layer`, `delete_layers` (the lift only — `ripple: true` is refused). A rehearsed op runs under the same rule as the real call: an envelope time lands on the grid, and a start below 0 or a trim past the window is refused. Returns `{ results: [{ index, status, output? | error? }, ...], halted_at: number | null }`. Other tools (motifs, caption import, media import, undo/redo) are not dry-runnable.

### Agent panel and lifecycle

Manual entry and exit (View menu / command palette / Exit to editor) only switch
layout. They create no work session, checkpoint or start message, and do not
release undo locks. A close of the owning MCP transport ends its work session
and releases that session’s lock — a DELETE from the client, or the host judging
the client gone (its SSE stream closed for 90 s; 30 min without a request for a
client that never opened one). Already-running operations retain their
attribution and actual outcome.

Both layouts show the same current-project activity: running tasks, readable
operations and objects, errors, folded quick reads (a call is a read when the
catalog's `annotations.readOnlyHint` says so — the same fact the client sees in
`tools/list`), work-session groups and checkpoint recovery. Only the editor offers object navigation. Restore remains
undoable and retains reads and errors; reverted markers use actual history
provenance, never a timestamp range. The panel retains 1000 completed activities
and all running calls, independently of diagnostic log clearing. Reopening a
project starts a fresh activity stream.

The connection header distinguishes a listening MCP service, registered clients
(name/version and last request), and running calls. Registration is not a live
process heartbeat. Connection settings reuse Settings → Agent.

### Render

Export is UI-driven through backend commands + the `export:*` event stream
— there are intentionally no `render_export` / `cancel_render` MCP
tools. Agents that need a render either ask the user, or read
`project://compiled` to inspect what the audio export would produce.

### Prompts (MCP "prompts")

User-invoked workflows discoverable in agent UIs (Claude Desktop slash menu, Cursor command palette):

- `/auto-caption { layer_id, language? }` — walks the agent through `transcribe_clip` → inspect the `srt` field → `apply_subtitles`.
- `/cut-pauses { layer_id, threshold_amp?, min_pause_us?, pad_us? }` — one `remove_pauses` call at the given parameters: every pause is cut out with `pad_us` left standing at each end and the gaps close, tightening the clip in a single undoable edit. The prompt also carries the review-first alternative — `detect_pauses` → one anchored region `add_marker` per pause — for when they should be seen before any of them goes, names the defaults (including the pad) and spells out what each ripple refusal means and which layer it names.
- `/voiceover { script, voice, speed?, target_track_id? }` — `synthesize_speech` for an agent-supplied script. Prompts the agent to split long scripts at paragraph boundaries (tts-1 caps at 4096 chars).

Each prompt closes with the missing-key recovery hint (Settings → API
keys) so the agent has somewhere to send the user when no cloud
provider is configured.

## Tool description quality

Agents pick tools from descriptions, so a description is written like API
docs, not a function signature — but the catalog is also read WHOLE into the
model's context by every client on every session, so each sentence is a
standing cost paid by every agent that connects. Unguarded, descriptions
restate this document and one another and the catalog grows by tens of
kilobytes. The two pressures meet at a budget:

- **What a description carries.** The first sentence says what the tool does
  and, where it has a sibling, when to pick it (`add_audio_layer` vs
  `add_video_layer`, `apply_transcripts` vs `apply_subtitles`). Then the
  non-obvious argument semantics with their defaults, the return shape, and
  the refusals an agent has to *plan around* — by error name, one clause each.
  A write undo walks past ends with the one word "Unrecorded."; a recorded
  edit says nothing, since recording is the default.
- **What the schema carries.** Every property has a one-line meaning with its
  unit (`µs`, composition px, 0..1); a field with a closed vocabulary is an
  enum (`trim_layer.edge`, `add_effect.kind`, every role and mode); `param_key`
  is the enum of animatable params plus the `effects[<id>].params[<key>]`
  pattern; `update_layer_params.patch` is one `oneOf` variant per layer kind,
  generated from the same key table the parser refuses against, so a client
  that reads `oneOf` sees each kind's exact field set. A `null` arm is
  advertised only where null means something omission does not — clear a
  label, unpin `duration_us`, cut a marker loose, return a text-box axis to
  auto, drop a proxy override, fall back to a detector's defaults; an optional
  field is simply not required, and an explicit `null` sent to one is read as
  omitted. `mcp.description-budget` pins the count of undescribed properties
  to zero and `mcp.schema-semantics` pins the enums and variants to the parsers.
- **What it does not.** Types belong to the schema, not the prose. Mechanics,
  rationale, history and every refusal's full story belong here in this
  document; the moment-of-failure explanation belongs in the error message
  itself (see *Error model*), which is where the agent reads it when it
  matters. A rule two tools share is stated once, on the tool that owns it,
  and named from the other.
- **The budget is a gate.** `mcp.description-budget.test.ts` caps each
  description at 700 characters (an explicit, size-limited allowlist of
  complex tools at 1100), each nested schema `description` at 260, and the
  whole compact catalog at 126 KB, annotations included. A raise is a review
  decision that names what the bytes bought — an enum, a return shape, a
  meaning on a property an agent acts on as it types the argument — and the
  way down is merging over-granular families and cutting prose that restates
  the schema, not trimming meaning. It also refuses schema envelope no agent
  reads: `$schema`, `title`, `format`, `default: null`. Rust schemas come out
  of `tool_schema()` in `native/src/mcp/catalog.rs`, which strips those at
  generation; TS schemas simply do not write them. The snapshot the gates read
  is pinned to the binary you run: `npm run mcp:catalog:check` regenerates it
  from the built addon and fails on any diff — CI runs it, and `npm run build`
  and `npm run build:e2e` run it first, so a stale addon on the box fails the
  build instead of serving an old catalog.

Bad:
```
set_clip_speed(clip_id, factor) — Sets clip speed.
```

Good:
```
set_clip_speed(clip_id, factor) — Speeds up or slows down a clip.
factor < 1 slows down (e.g. 0.5 = half speed); > 1 speeds up.
Affects audio pitch unless preserve_pitch=true. Audio length matches
new video length. Maximum factor is 8x; below 0.1 use a different
approach. Does not affect other clips on the timeline.
```

Also bad — the same tool at 2,000 characters, with the derivation of the
8x ceiling, the three release notes that moved it, and the whole story of
what a rejected factor's error says. That is this document's job.

## Error model

A refusal is the tool's ANSWER, not a protocol fault. Every failure inside a
tool — a malformed argument, a stale id, a blocked edit, a compute or OS
failure — comes back as a `CallToolResult` with `isError: true`, which is the
channel a model reads:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "layer overlap on track 7f3a…: the requested range [5000000, 10000000) µs collides with layer 9c1d… at [4200000, 8000000) µs. … Options: create_new_track and retry there; move_layer 9c1d… elsewhere; trim_layer 9c1d… edge 'out' to 5000000; split_layer 9c1d… at 5000000 and delete the right half." }],
  "structuredContent": {
    "code": "invalid_params",
    "message": "…the same text…",
    "error": "LayerOverlap",
    "track": "7f3a…",
    "blocking_layer": "9c1d…",
    "blocking_range_us": [4200000, 8000000],
    "requested_range_us": [5000000, 10000000],
    "options": [
      { "action": "create_new_track", "kind": "Video" },
      { "action": "move_layer", "layer_id": "9c1d…" },
      { "action": "trim_existing", "layer_id": "9c1d…", "edge": "out", "new_t_us": 5000000 },
      { "action": "split_at_t", "layer_id": "9c1d…", "at_t_us": 5000000 }
    ]
  }
}
```

Give the agent something to act on, not a brick wall.

No refusal is a bare variant name. Every `CommandError` has its own arm in
`mapCommandError` (`main/state/mcp-commands.ts`): the message names the id or
field it could not honour, the read that lists valid ones (`project://tracks`,
`list_checkpoints`, …) and the next call, and says "nothing was changed" where
that is the point. The mapper takes the TOOL that raised the error, because a
remedy can depend on it — the ripple refusals offer "add it to `layer_ids`" to
`delete_layers` only; `ripple_delete_gap` and `remove_pauses` have no such
parameter and are told to move or delete the blocker first. `LayerOverlap`'s
options are validated against the geometry, and the pair is oriented first — the
validator reports the earlier-starting layer first, so a request placed before an
existing clip would otherwise name the caller's own layer — and every option it
emits would succeed as written. `mcp.error-vocabulary.test.ts` enumerates the
vocabulary: a new variant cannot fall through to its name.

The text must itself name the cause and the options: it is the one part every
client shows the model. `structuredContent` mirrors the same facts
machine-readably for clients that forward it — `code` is the envelope code
(`invalid_params` for anything the caller can fix, `internal` for a failure
that is not the caller's), then `message`, then whatever the mapper attached:
the `error` variant, the ids, `options[]`. Nothing may live only there.

Two things stay JSON-RPC errors, because they are faults of the REQUEST rather
than answers of a tool: an unknown tool name (`-32602`, `Unknown tool: <name>`),
and a `resources/read` or `prompts/get` that fails (those result types have no
`isError` slot). A client's health or retry logic may treat a JSON-RPC error as
a server fault; it must never see one for a refusal.

Arguments are checked before dispatch on every route. A TS tool's own parser
refuses first; a motif tool and a Rust-parsed tool (`import_media`,
`synthesize_speech`, the clip-compute reads) are checked against their advertised
schema, so a `mode` outside its enum is refused by name and a call missing two
fields is refused once, naming both in the tool's own vocabulary — never serde's
one-field-at-a-time text with the column of a buffer the caller never sent.

## Change feed

Connected agents receive change notifications **in-protocol**, over the same
streamable-HTTP connection — there is no separate event endpoint. Every commit
the state actor makes is relayed to every live session as a
`notifications/weftcut/change` MCP notification whose params are the compact
change summary — the same payload the renderer's `project:changed` event carries:

```json
{
  "op_id": "...",
  "actor_kind": "user",
  "client": null,
  "summary": "Moved 'intro' to 4.20s",
  "affected": [{ "kind": "Layer", "id": "7f3a..." }],
  "timestamp": "..."
}
```

`affected` lists the Track / Layer / Marker refs the op touched, so an agent can
tell whether an edit reached its own work without a read. `actor_kind` and
`client` name who committed the op as the history records it: edits made over
MCP are recorded as `"user"`; only an agent's checkpoints carry `"agent"` and
the client id.

Agents can fetch the full new state by reading `project://current` after a
change notification arrives — the notification is a hint, not a sync protocol.

## Speech (optional, user-supplied)

For things agents can't do well themselves. Speech-to-text runs over
**pluggable backends** — OpenAI Whisper (cloud) plus local one-shot CLI
sidecars (whisper.cpp, FunASR via sherpa-onnx) — behind one entry point.
The API key (secret) lives in `safeStorage`; local engine paths live in a
TS-owned config store; Electron main merges both into the snapshot the
stateless Rust resolver reads. The resolver picks a transcriber by **user
preference then availability** (cloud = has key; local = binary + model
present), falls through a default order, and errors with an actionable
message naming every remedy when nothing is available.

An agent that already has a speech model of its own needs none of that:
`extract_clip_audio` hands it the samples and stays out of the way.

**Capability surfaces:**

- **Transcription** (`Transcriber` trait) — `transcribe_clip { layer_id, t_start_us?, t_end_us?, language?, backend?, word_timestamps? }` returns a normalized transcript envelope `{ backend, segments: [{ t_start_us, t_end_us, text, words: [{ t_start_us, t_end_us, text }] }], language, word_timing, srt }`, all times timeline-absolute; `backend` names the engine that actually served the request. Slices the layer's source audio at the requested window (defaults: the whole layer), transcribes with the picked provider, normalizes the raw output to timestamped word segments, shifts every timestamp forward by the timeline offset, and includes a rendered `srt` field so the agent can inspect / edit and pass it to `apply_subtitles` (word-level data stays in `segments`). `word_timing` records the per-word timing provenance — `exact` from an engine's token offsets, `interpolated_from_cue` when derived by splitting an SRT cue span across its words (space-less CJK cues split per character, matching FunASR's granularity). `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` off a speed-1 segment first. Backends: OpenAI Whisper (cloud, SRT → interpolated words); whisper.cpp + FunASR (local sidecars, exact word timing from JSON token offsets). The `backend` arg is a **strict** override: that engine serves the call or it errors naming the missing piece — it never substitutes another engine, so an explicit local choice can never fall back to a cloud upload. The user's Settings preference stays a soft hint (injected by the host, honored by availability). `word_timestamps` defaults to **true** — the chosen engine's best precision at no extra cost; pass `false` to force SRT-style interpolated output.
- **Raw audio egress** (no trait, no backend) — `extract_clip_audio { layer_id, t_start_us?, t_end_us? }` returns TWO content blocks: a JSON text block `{ layer_id, media_id, t_start_us, t_end_us, source_in_us, source_out_us, duration_us, sample_rate_hz, channels, bits_per_sample, byte_length, mime_type }` and an MCP `audio` block carrying base64 `audio/wav` — mono 16 kHz 16-bit PCM, the very shape every bundled engine is fed. For the agent that brings its OWN speech model: it takes the samples and recognizes them wherever it likes. The returned WAV starts at zero, so the alignment contract is one addition — a cue at `w` in the WAV belongs at `t_start_us + w`, which is the timeline-absolute form `apply_subtitles` wants. The window arguments are `transcribe_clip`'s, unchanged: timeline-absolute, defaulting to the layer's endpoints, so the same pair serves both tools; the pair REPORTED is the window as resolved, so a caller that passed neither still learns which span it got. **60000000 us (60 s) maximum per call** — base64 inflates the payload by 4/3, so a whole take is fetched as consecutive windows rather than as one multi-megabyte message, and an over-long window is refused naming both the cap and the requested duration. What it extracts is the ORIGINAL source audio: before gain, pan, mute, fades, effects and mixing, and a VideoClip's audio is its own source stream, never its link's. Shares `transcribe_clip`'s window resolution and its content-addressed WAV cache, so an extract already made for a transcription costs no second ffmpeg. Refuses a layer with no audio, a window outside the layer, and `speed != 1.0`, with `transcribe_clip`'s refusals by name. No backend is resolved, nothing is uploaded, and no filesystem path leaves the tool — the agent gets bytes.
- **Text-to-speech** (`Synthesizer` trait) — `synthesize_speech { text, voice, speed?, target_track_id?, t_start_us? }` returns `{ layer_id, media_id, t_start_us, t_end_us, cached }`. Synthesizes audio for the supplied script, writes a content-addressed file under `<workspace>/Cache/voiceover/<hash>.mp3`, imports it as a `MediaItem`, and adds an `Audio` layer on the target Audio track (auto-creates one labeled "Voiceover" when absent). `t_start_us` defaults to the composition's current `duration_us` so voiceover appends at the end. `cached=true` means the request hit the cache and no API call billed. Provider today: OpenAI tts-1 (same key as Whisper).

**Config UI:** an OpenAI key activates BOTH `transcribe_clip` and
`synthesize_speech` (TTS is cloud-only today). Settings → **Transcription /
Speech** has an engine selector plus per-backend rows: cloud = API key,
local = binary / model (/ tokens) path pickers, each with a "Test" button
that reports `Available` or the exact missing piece. Engines that report
engine-exact per-word timestamps (whisper.cpp, FunASR) carry an
"exact word timing" badge on their row.

**Human entries ride the same tools.** The renderer's *Transcribe selected
clip* command and *Voiceover…* dialog do not have a second implementation: the main
process serves `transcribe_clip`, `detect_pauses` and `describe_clip` to
the renderer through `callClipComputeTool` (`main/mcp/server.ts`) — the very
function `handleCallTool` uses for the MCP call of the same name, slice
resolution and engine injection included — so a person and an agent asking
the same clip the same question get the same engine and the same slice by
construction. `apply_subtitles` and `synthesize_speech` are renderer hybrid
channels (`main/state/router.ts` `HYBRID_CHANNELS`) reaching the same
`runHybrid` arms; either caller lands one commit, and the only difference is
that the MCP path reads the committed record back from the snapshots around the
call (`main/mcp/hybridResult.ts`) instead of the renderer's bare string.
Three hybrids are renderer-only and have no MCP tool at all —
`drop_shot_markers`, `apply_shot_cuts` (the Shots Panel's reviewed-list
verbs) and `mark_pauses` (the Attribute panel's Pauses section, *Mark pauses*) — because
an agent already composes each from tools it has: `analyze_clip` or the
`media://{id}/analysis` view plus `split_layer` / `add_markers`, and
`detect_pauses` plus `add_markers`; a second tool over one detection would
only be a way for the two surfaces to drift. `remove_pauses` — the same
section's *Remove pauses* — is the hybrid that goes the other way and carries a tool
of its own, because no sequence of advertised tools reproduces it: the
splits, the deletes and the closing of the gaps are one recorded edit, and
composing it would cost an undo step per piece. `analyze_clip` stays agent-only —
the renderer's shot surfaces read the whole-source report instead, and the
shot rows read a source's cached description through the same
`media://{id}/description` handler an agent reads, never computing one
([features.md](features.md)).

**Tool gating:** the `tool_table!` macro registers tools at compile
time, and the catalog has no per-session filter today, so unconfigured
speech tools are always listed and fail with a structured "no backend
available" error that names the Settings panel. Hiding unsupported speech
tools from the catalog entirely is a possible refinement.
`extract_clip_audio` is the one tool under this feature that needs nothing
configured: it resolves no backend at all, so it answers whether or not an
engine is set up.

These are MCP tools like any other; the agent doesn't see "cloud vs local" — just "this tool exists or doesn't."

## Video understanding (optional, user-supplied)

The architectural twin of Speech, for *what is in a shot* rather than *what was
said*. Scene description runs over the same **pluggable-backend** rails: a
`SceneDescriber` trait, a resolver by **preference then availability**, a
normalized `SceneDescription` output, and a per-backend parser — mirroring
ADR 0036. Backends: **Qwen3-VL** and **MiniCPM-V** (local one-shot
`llama-mtmd-cli` sidecars — a GGUF model + mmproj on disk) and an
**OpenAI-compatible endpoint**. All three ingest the SAME input (frames we sample
from the source + injected `<t s>` text-timestamp markers) and diverge only in
the output parser + availability probe. There is no hosted-provider backend
beside the endpoint one, unlike Speech: a hosted VLM speaks the same
`/v1/chat/completions` as a self-hosted one, so it is the same describer with a
different URL, and a second backend would have been a preset masquerading as a
capability.

**Capability surface:**

- **Scene description** (`SceneDescriber` trait) — `describe_clip { layer_id, t_start_us?, t_end_us?, fps?, focus?, language?, backend? }` returns `{ backend, model, segments: [{ t_start_us, t_end_us, text, tags: [ ... ] }] }`, all times **source-absolute** microseconds; `backend`/`model` name the engine that served the request. Samples frames from the layer's source across the window (defaults: the whole layer) at `fps`, runs the model ONCE over all the frames, and normalizes the model's JSON array into timestamped segments — `text` is a free-text span description, `tags` are filterable visual keywords (subjects, setting, camera motion, shot type). `focus` (`"general"` | `"shot-type"`) selects the prompt template that populates `tags`. `language` is a BCP-47 tag (`"en-US"`, `"zh-CN"`, `"ja"`, …) the `text` and the `tags` are written in; the prompt's own instructions stay English, and one trailing rule names the output language. `fps`, `focus` and `language` all default to the app's own settings — Electron main fills each omitted one from a single provider (`vlm_config.json`'s two describe params and `app_settings.language`) and injects the same three, plus the user's preferred engine, into the `media://{id}/description` read, so the view a run writes is the view the shot rows read back. Each stays a real override: an agent that names a sampling rate, a focus or a language gets it whatever the app's panels are set to. Results are **cached per source range**: a later call over an already-described window returns instantly with no model spawn (the cache is a `{ covered_ranges, segments }` value keyed by source hash + `{ backend, model, fps, focus, language, prompt-template version }` — `backend` and `model` are in it too, which is why the resource read has to be told which engine the app prefers rather than walking the plain availability order — `language` is in the key because `covers()` short-circuits a described window with no engine spawn, so a shared key would hand English prose back to a Chinese request forever, a SEPARATE namespace from the shot layer so the cheap deterministic layer and this opt-in layer never block each other). `VideoClip` layers with `speed != 1.0` reject with a hint to `split_layer` first. The `backend` arg (`"qwen3_vl"` | `"minicpm_v"` | `"byo_endpoint"`) is a **strict** override: that engine serves the call or it errors naming the missing piece (binary / model / endpoint) — it never substitutes another engine. This is **privacy-strict**: frames are heavier and more sensitive than audio, so the default order is local-first with the networked engine last, and an explicit local choice can never fall back to an upload. The cached view is also readable as `media://{id}/description`.

**Config UI:** Settings → **Video understanding**, beside Transcription. Same
secrecy split as Speech — the endpoint's optional API key lives in `safeStorage`
under its own `vlm_endpoint` tag; the local engines' binary/model/mmproj paths
and the endpoint URL/model live in the TS-owned `vlm_config` store; Electron main
merges both into the config snapshot the stateless resolver reads. The panel
lists every backend with its live availability and marks the one the resolver
would pick, reusing that resolver's own `select_backend` so the two cannot
disagree. The section shares no configuration with Transcription, key included —
one secret, one editor. Qwen3-VL and
its `llama-mtmd-cli` runtime are also an app-managed download there
([ADR 0055](adr/0055-third-content-slice-is-windows-qwen3-vl-4b-on-llama-mtmd.md)),
which fills the local engine's three paths on install.

## Observability

Tool calls flow through the `LogBus` and surface in the status-bar
console at the bottom of the editor — see [status-log.md](status-log.md).
Each MCP call records a `Started` + `Ok/Err` pair sharing one `op_id`,
with the truncated args / return / error in `details`. The console
filters by category (`Mcp`) and source (`Agent { client }`).

## Concurrency policy

- The express `/mcp` handler accepts concurrent requests across sessions; tool calls funnel into the project actor's single-writer inbox.
- `set_history_lock { locked, reason? }` lets a long batch hold the history pen: while it is held, every revert path (`undo`, `redo`, `jump_to`, `restore_checkpoint`) rejects with `HistoryLocked`, so nobody unwinds the batch from under it. It does NOT collapse or suppress entries — each op in the batch still records its own (`docs/features.md#undo-stack-scope`).
- `dry_run` does not commit; it clones state and walks ops, halting at the first validation error.

## Security

- Localhost-only binding, bearer-enforced on every request, with DNS-rebinding protection on. The bind is loopback-hardcoded — no setting exposes the port to another machine.
- Shim configs carry no token — the shim reads it from `mcp_auth.json` at connect time, so the bearer never spreads into client config files.
- Token surfaced in the connect panel's advanced section; the HTTP connect snippet (which embeds the token) is printed to stdout only in unpackaged dev / e2e runs, never in a packaged build.
- Cloud-API keys live in the OS keyring, not in project files.
