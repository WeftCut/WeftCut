# MCP Server & Agent UX

WeftCut is an MCP server. External agents (Claude Code, Claude Desktop, Codex,
Cursor, custom clients) edit the open project through a structured tool
surface, over the **`weftcut-mcp` stdio shim** (recommended) or **HTTP-direct**.
Per-tool arguments, return shapes and refusals live in the advertised catalog
(tool descriptions and schemas) — that is the contract agents read. This doc
holds what the catalog cannot: transport, conventions, cross-tool rules, and
the agent-facing UX. Agent guidance ships as one skill (ADR 0046).

## Transport & deployment

- **Streamable HTTP on `127.0.0.1:<port>/mcp`**, hosted in the Electron main
  process (`express` + the SDK's `StreamableHTTPServerTransport`,
  `main/mcp/index.ts`). Each `initialize` mints a session (`Mcp-Session-Id`);
  in-protocol notifications (the change feed) ride the same connection.
- **The Rust core is transport-free**: it provides its tools, resources,
  prompts and wire types over napi (`mcpCatalog`, `mcpCallTool`,
  `mcpReadResource`, `mcpListPrompts`, `mcpGetPrompt`); main forwards its output
  verbatim. The advertised catalog is the union of the Rust catalog and the TS
  tables (`MCP_TOOL_DEFS`, `MOTIF_TOOL_DEFS`, the export tools), deduplicated by
  name with TS winning (`main/mcp/mcpCatalog.ts`).
- **The stdio shim** (`src/cli/`, built by `scripts/build-cli.mjs`) runs under
  `ELECTRON_RUN_AS_NODE` — the WeftCut binary is its Node runtime. The app
  copies it to `<userData>/cli/weftcut-mcp.cjs` at every startup; client
  configs point at that copy, the only path stable across upgrades on all three
  OSes (an AppImage mounts at a random point). `<userData>` is
  `<appData>/WeftCut`, named from package.json's `productName`, which must stay
  set: electron-builder's `productName` is not written into the packaged
  package.json. The shim re-reads `mcp_auth.json` on every (re)connect, so port
  re-picks and token rotations self-heal and its config carries no URL or token.
- **Shim catalog = synthetic ∪ (app reachable ? real catalog : ∅).** Always
  present: `weftcut_status` (endpoint state, next steps, a `Project:` line) and
  `launch_weftcut` (detached GUI spawn, bounded wait). `tools/list_changed`
  fires on every bridge transition, so one session upgrades when the app comes
  up and degrades when it closes. While bridged the change feed is forwarded
  verbatim. Subcommands: `info` (exit 3 when the app is down), `print-config`,
  `list-tools`, `help`.
- Port and bearer token persist in `<userData>/mcp_auth.json`; an occupied
  saved port falls back to a fresh one and rewrites the file. One server per
  running instance. Localhost only; remote access is out of scope.

## Authentication & security

- 32-byte random hex bearer, written `0600` (POSIX only; Windows maps it to
  read-only). It cannot be encrypted because the shim is a plain Node process.
- Enforced on every `/mcp` request by main's middleware (`401` otherwise),
  constant-time compare. DNS-rebinding protection: `allowedHosts` is the
  loopback bind only; `Origin` is left unrestricted for non-browser clients.
  The bind is loopback-hardcoded.
- The token stays hidden until the user opens **Connect agent**; *Refresh*
  rotates it in place (same port). Shim configs carry no token. The HTTP
  snippet with the token is printed to stdout only in unpackaged dev / e2e
  runs. Cloud API keys live in the OS keyring (`safeStorage`), never in
  project files.

## Connection UX

**Settings → Agent → Connect agent**:
- **Primary: stdio shim config**, one snippet per client (Codex TOML, Claude
  and Cursor JSON) plus a self-configuration prompt; paths are generated from
  `process.execPath` and `app.getPath("userData")`. The `Generic` tab prints
  the connection facts unwrapped, because MCP standardises the protocol, not
  the config file (`mcpServers` is a Claude Desktop convention). An `mcp add`
  one-liner accompanies a snippet where the client's CLI can express the whole
  entry (Codex and Claude Code for stdio; Claude Code alone for HTTP —
  `codex mcp add --url` takes only an env-var name for the bearer). Windows
  paths are double-quoted for Git Bash and PowerShell.
- **Advanced: HTTP-direct** — URL, masked token, the same snippets in URL +
  header form; breaks when the app is closed and goes stale when port or
  token change. Until the shim bundle exists (dev before `build:cli`) HTTP
  renders as primary; "starting…" shows until the port is bound.
- **`initialize` carries `instructions` on both transports**: the session
  etiquette in ten lines (`main/mcp/instructions.ts`). The app's server sends
  it, and so does the shim, which answers `initialize` itself and bundles the
  same file, so a stdio and an HTTP-direct client read identical text. The
  etiquette is pinned equal to the head of the shipped skill; the last line
  names the app version, so an agent whose skill copy carries another
  `metadata.version` knows to replace it. `serverInfo`
  is `weftcut` (`weftcut-mcp` through the shim) at the app version (a bare dev
  `electron out/main/index.js` reports Electron's).
- **The skill**: `skills/weftcut/` staged with its required docs by
  `scripts/build-skills.mjs`, its SKILL.md stamped with the app version as
  `metadata.version`, shipped as an extraResource, and mirrored to
  `<userData>/skills/` at startup (`main/mcp/skillsInstall.ts`): that folder
  is the app's and holds exactly the bundle, so a file a release removed is
  deleted. The panel shows an install prompt pointing at that folder, plus
  the path, an open-folder button and a note that the agent's own copy does
  not update itself. The state describes the app's copy only: `current`,
  `stale` or `unavailable` with its fault; the panel shows the fault with
  *Try again* (no restart), and a packaged build that is not `current` raises
  a startup notice that main retracts by re-broadcasting `app:notices`.

## Multi-agent semantics

- The single-writer actor serializes all mutations regardless of source; each
  tool call commits or rejects whole.
- Every MCP call records as `Agent { client }`, `client` being the name the
  client declared in `initialize` (control chars stripped, ≤ 64 UTF-8 bytes,
  `mcp` when absent; through the shim, the downstream client's name). UI edits
  record as `User`. The tag shows in history, checkpoints, the change feed and
  the status log.
- No edit locks or per-agent state; a conflicting commit fails its invariants
  and the agent re-reads and retries.
- The work session owns the history lock (`begin_agent_session`, `lock: true`
  by default). While it is held, every revert path (`undo`, `redo`, `jump_to`,
  `restore_checkpoint`, Revert all) from any other source fails with
  `HistoryLocked` (`invalid_request`), which names the holder and tells the
  caller to wait or ask the user. The owning connection's own reverts pass, so
  an agent undoes its own mistake without unlocking. The lock gates reverting
  only; edits still commit and record (`features.md#undo-stack-scope`). The
  session's end, its connection closing and the Agent panel's Unlock release it.
- A work session belongs to a connection, and a connection can vanish without
  a `DELETE`. The host closes a session whose client is gone (its standalone
  SSE stream closed for 90 s, or no request for 30 min when it never opened
  one — `REAPER_DEFAULTS` in `main/mcp/index.ts`); the shim terminates its app
  session when stdin closes; `begin_agent_session { force: true }` is the
  takeover (it ends the stale session and begins the caller's). `AgentSessionBusy` / `AgentSessionOwnerMismatch`
  (`invalid_request`) carry the `holder`, also visible in `project://session`.
- `transcribe_clip` and `describe_clip` are clip-compute jobs (ADR 0121,
  `main/compute/jobs.ts`): a call with a `progressToken` gets
  `notifications/progress` on each phase change and at least every 15 s; an
  identical call (same source span and answer-changing args) joins the running
  job; only `notifications/cancelled` from every attached caller, or the app's
  Cancel, cancels it — a disconnect does not; a cancelled call answers
  `isError` with code `cancelled`.

## Tool surface conventions

- One declarative table per side single-sources schema and dispatch:
  `MCP_TOOL_DEFS` (`main/state/mcp-commands.ts`) for TS tools, `tool_table!`
  for Rust tools. Every schema property has an explicit `type` (clients coerce
  untyped fields to strings). Every tool has `annotations` — `readOnlyHint`
  on reads, `destructiveHint` on writes (true for removals and reverts),
  `idempotentHint` on sets — and the agent panel's read/write split reads the
  same flag.
- **Names** follow `<verb>_<resource>`, `delete_*` for every removal, one
  `update_*` per resource with optional fields; a field's set and clear are one
  tool taking `null`. A rename is a break: the old name gets `unknown tool`
  (ADR 0074). `RETIRED_MCP_TOOL_NAMES` (`main/mcp/toolAliases.ts`) resolves
  only `checkpoint`, `set_composition`, `compositions_delete`.
- Before adding a tool, check an existing tool's arguments: two verbs that
  differ by one boolean are one tool with a flag.
- **No silent no-op, no silent degrade.** A write that would ignore, drop or
  not apply an argument refuses: an empty patch, a flag call naming no flag, a
  `null` on a field where null means nothing, a time a few µs off a key. A
  `null` arm is advertised only where it means something (`label: null`
  clears, `end_t_us: null` makes a point). A read or render that delivers less
  than asked refuses, or says so in a typed field. Gate:
  `mcp.no-silent-outcomes.test.ts` sends every optional and nullable field of
  every write tool (TS, Motif, export, Rust) alone on a fixture project and
  fails unless the state changed or the call refused; its exceptions are an
  explicit list, each with a reason.
- **The time base is in the name.** `t_*` is timeline-absolute (the owning
  composition's clock), `src_*` source-absolute (the media file's own time),
  `local_*` layer-local (µs from the layer's `t_start_us`); a few names put a
  role word before the base (`at_t_us`, `from_t_us`, `end_t_us`). A bare
  `_us` / `_s` is a duration (`duration_us`, `pad_us`, `delta_us`). A result
  in source time for a layer carries that layer's `mapping { layer_id,
  t_start_us, src_in_us, rate: {num, den}, source_phase? }`: timeline
  `t = t_start_us + (src − src_in_us − source_phase.in) / rate`.
  `project://tracks` envelopes carry `media_id` and `rate` (when ≠ 1) for the
  same sum. Gate: `mcp.time-base-names.test.ts` walks every input property
  and every result key a description documents; its exceptions are explicit
  lists.
- **Background state is readable.** No agent should need `sleep`, `pgrep` or a
  cache listing to learn what the app is doing:
  - A media card (`media://{id}`, each `project://media` row, the
    `import_media` answer) carries `derivatives`: `waveform` / `conform`
    (audio), `thumbnails` / `proxy` (video; no `proxy` for a Bypass route),
    each `"pending" | "running" | "ready" | { "failed": "<reason>" }`. Main
    keeps the job events no MCP session receives
    (`main/state/derivative-jobs.ts`). Shot detection is not a derivative: the
    call that needs it runs it.
  - A "not ready" refusal (`DerivativeNotReady`) carries `{ media_id,
    derivative, state, retry_after_s }`; a failed job says so with its
    `reason` and `retry_after_s: null`, and `import_media` of the same file
    re-runs it.
  - A busy admission (`ResourceBusy`) names its `holders` (`[{ kind,
    media_id?, mib, threads }]`, from the native ledger) and `retry_after_s`.
    A claim larger than the whole working allowance is `ResourceBudget {
    needed_mib, allowed_mib, setting, memory_target_mib }`, which no wait
    admits.
  - `get_export_status { wait_s ≤ 60 }` blocks until the job's state changes.
  Gates: `derivative-jobs.test.ts`, `faultText.test.ts`, the governor's holder
  tests (`native/src/resources.rs`).

### Projects and the no-project rule

The actor always holds a project (a startup placeholder, or the one just
closed), so "a project is open" is a host fact: set where Open, New Project,
Save As, `open_project` and `create_project` land, cleared on Close Project.

**No project open ⇒ every project tool refuses** with `NoProjectOpen` and
dispatches nothing. Default-deny: only `APP_SCOPE_TOOLS` /
`APP_SCOPE_RESOURCES` in `main/mcp/mutationTools.ts` answer — `ping`, the
Motif library and file-transfer tools, the export preset tools,
`get_export_status`, `cancel_export`, `retry_export`, `open_project`,
`create_project`, `read_project` for views `session` / `effects` / `taste`, and
the resources `project://session`, `project://taste`, `effects://catalog`,
`motifs://current`. One predicate (`servesWithoutProject`) serves both gates;
`mcp.project-scope` sweeps the whole catalog. `install_motif` with no project
open republishes the library entry and rebinds no layers. The renderer is not
gated.

Agents open or create a project **only when the user asked for that one**;
otherwise they ask. `project://session` reports `project` (null when none),
`recent_projects` and `default_parent_folder`. `open_project` takes an
absolute project folder; both tools flush the previous project, drop its
history and checkpoints (as UI Close + Open does) and report `replaced`; the
renderer follows via `project:opened`. `open_project` on the folder already
open (compared by resolved real path) reloads nothing and answers
`{ name, dir, replaced: null, already_open: true }`. `create_project` validates the name with
the New Project dialog's rules (`shared/newProject.ts`), defaults the canvas to
1920×1080 at 60 fps and refuses a missing `parent_folder` when no default
exists.

## Resources

| URI | Returns |
|---|---|
| `project://current` | full Project JSON |
| `project://composition` | one composition's settings only (no tracks); `?composition=<id>` for a Group's |
| `project://compositions` | every composition with `ref_count` (Group layers pointing at it; 0 = root or orphan) |
| `project://media` | media pool, each row with its `derivatives` |
| `project://tracks` | a composition's tracks (`enabled`, `locked`, `role`) with layer **envelopes** (`media_id`, `rate` when ≠ 1) — what an agent plans timeline edits against |
| `project://layers/{id}` | one layer in full, from any composition; stored key times as `local_t_us` |
| `project://markers` | a composition's markers, with `anchor_layer`, `anchor_src_us`, `hibernating` |
| `project://links` | a composition's links `{ id, members }` |
| `project://transitions` | a composition's transitions |
| `project://settings` | editing preferences plus `metadata`; `modified_at` moves on every recorded edit and is restored by undo/redo/restore — compare for change, not order |
| `project://taste` | the merged style (`extends` in `TASTE.md`, else `weftcut-default`) + overrides: roles, tokens, example `motifs` per role, `fonts` resolved against installed families, provenance, diagnostics, revision. Pixel tokens are for a 1080-px frame. Read fresh every call; the app never writes `TASTE.md` |
| `project://session` | active work session (or null), recent sessions, history lock, `project`, `recent_projects`, `default_parent_folder` |
| `project://tacks` | the opening's tacks, oldest first (see *Tacks*) |
| `project://history` | recent ops and checkpoints (no snapshots); see below |
| `project://compiled` | compiled audio IRGraph |
| `composition://meter` | preview master-bus level `{ live, rms_db, peak_db }`, pushed ~2 Hz, `live: false` after 2 s of silence; a tap on what the user hears, never a render. Per-role meters reach no MCP surface ([audio.md](audio.md#meters)) |
| `media://{id}` | one pooled file as a card (`used_by`, `derivatives`, sub-resources). `resources/list` names one per file and `list_changed` fires on pool changes, so clients can @-mention media |
| `media://{id}/thumbnail` | middle thumbnail JPG |
| `media://{id}/frame/{src_us}` | frame at a source time, lazy-cached |
| `media://{id}/waveform` | peaks file |
| `media://{id}/analysis` | deterministic shot report at default params (`analyze_clip`'s `src_*` shape, no `mapping`), computed on a miss, shared with `analyze_clip` |
| `media://{id}/description` | cached clip descriptions for the app's preferred engine and settings; `404` until `describe_clip` (purpose `clip`) ran; never runs inference |
| `media://{id}/shot-description` | the same for purpose `shot` |
| `effects://catalog` | every effect kind with param defaults, ranges and the keyframe path |
| `motifs://current` | Motif catalog without HTML (same as `list_motifs`) |

Templates (`resources/templates/list`, RFC 6570): `project://layers/{id}`,
`project://composition{?composition}`, `project://tracks{?composition}`,
`project://markers{?composition}`, `project://links{?composition}`,
`project://transitions{?composition}`, `project://tacks{?composition}`,
`media://{id}`, `media://{id}/thumbnail`, `media://{id}/frame/{src_us}`,
`media://{id}/waveform`, `media://{id}/analysis`, `media://{id}/description`,
`media://{id}/shot-description`. `?composition=` is the only query a
`project://` read takes; an unknown key or a scope on a project-wide read is
refused, never answered with the root. A `media://*` read before its
derivative exists is resource-not-found with `DerivativeNotReady` data
(`media_id`, `derivative`, `state`, `retry_after_s`); a failed job reads
failed with its reason. The job events themselves reach the renderer only, so
no remedy names them.

`read_project { view }` serves the same views as a tool for clients without
resource support (`READ_PROJECT_VIEWS`, plus `media_thumbnail` / `media_frame`
as image blocks), through the same function, so the two never disagree.

**`project://history` positions.** `ops` is a window (the last 100 of a
200-entry cap) and `cursor` is an absolute stack index. `window_start` is the
absolute index of `ops[0]`; `jump_to` takes an op's `op_id`, which no eviction
shifts. `evicted` counts entries dropped off the front at capacity (the Initial entry included).
Only `window_start === 0 && evicted === 0` means `ops[0]` is the project's
start. Each op carries `summary`, `label_key`/`label_args`, `affected` and
`entity_labels` (resolved against whichever snapshot still holds each ref, so
deleted entities keep a name).

## Tools

### Results, snapping and refusals

- **Every edit answers with the committed record**, read back from the commit's
  snapshot (`structuredContent` + the same JSON as text) — never a bare id.
  Layer answers are the envelope plus `siblings` (link members carried),
  `moved` (what a ripple or transition placement shifted) and `adjusted`
  (`{ field, requested, applied, reason }`). Readers live in
  `main/state/mcp-results.ts`.
- **Snap and echo, clamp and refuse.** A sent time changes in exactly one way:
  it lands on the layer's lattice (composition frame grid, or 48 kHz samples
  for Audio), with `reason: "grid"`. Every adjustment the UI's drag would make
  for a user who sees the ghost (floor at 0, clamp at the other edge or source
  end) is a refusal over MCP before any write (`NegativeLayerStart`,
  `TrimEdgeOutOfRange`). The mutations share one implementation; MCP parsers
  set `strict`. The one other adjustment is a Motif whose new props shorten
  its content (`reason: "content"`).
- **Composition scope.** Layer ids are unique project-wide, so layer-addressed
  tools take no scope and a layer inside a Group is edited like one in the
  root. `composition_id` on a tool that names a `track_id` is a cross-check;
  tools that pick or spawn a lane take it to choose the composition (root when
  omitted). A move never crosses compositions (`CrossCompositionMove`), a set
  never straddles two (`CrossCompositionSet`); only `create_group`,
  `add_group_members`, `ungroup_layer` and `move_layers_to_composition` move a
  layer between compositions.
- **Unrecorded writes** (undo walks past them): `set_track_flags`,
  `set_role_flags`, `update_composition`, `set_project_settings`, checkpoints,
  work sessions, the history lock and the tack verbs. Every other edit is one
  recorded commit.

### Analysis tools

- `analyze_audio { media_id, src_start_us?, src_end_us? }` — the original
  source audio of a media item (before gain, fades, effects, mix): waveform,
  onsets (`src_us`) and energy changes from the finest waveform cache, ≤ 60 s
  windows. Envelope estimates, not
  beats or LUFS. To show candidates, tack them; analysis never edits.
- `detect_pauses` — pauses from the peaks of what plays: the baked effect
  sibling's when ready, else the media's (`peaks_source` `fx`/`raw`). A
  VideoClip resolves to its linked Audio member sharing its media
  ([features.md](features.md#pauses)). `noise_floor_amp` is what to derive a
  threshold from. Defaults `threshold_amp=0.02`, `min_pause_us=500000`,
  `bridge_us=80000`.
- `remove_pauses` — the same detection, then cut each pause's core (keeping
  `pad_us`, default 100 ms, at each end) and close the gaps, as one recorded
  edit. Linked partners are cut on the frame grid together. Refuses whole with
  `delete_layers { ripple: true }`'s refusals by name. For review first, use
  `detect_pauses` + one `create_tacks` batch.
- `analyze_clip` — deterministic shot boundaries (`src_start_us`,
  `src_end_us`, `src_keyframe_us`), `cut_scores` (`src_us`) and per-shot
  brightness / motion / sharpness and `black` / `freeze` / `fade` flags for a
  VideoClip, with `media_id` and the layer's `mapping`. Defaults `sensitivity=0.4`,
  `min_shot_us=500000` (`shot_default_opts`). Stats are advisory (proxy
  decode); flags are deterministic.
- `compare_frames` — pHash Hamming distance + MSSIM of two source frames
  (`{ layer_id, src_us }` each);
  `similar` = `phash_hamming <= 10 && ssim >= 0.5`. Cross-aspect pairs lean on
  the pHash.
- `describe_clip`, `transcribe_clip`, `extract_clip_audio` — see *Speech* and
  *Video understanding*.

### Edit tools

Each maps to an actor command ([data-model.md](data-model.md) "Mutation
surface").

Media and tracks: `import_media` (absolute or project-relative path; a file
the pool already holds — same file or same bytes — answers `existing: true`,
or relinks a missing item and answers `relinked: true`; files outside `Media/`
are copied in, ADR 0151, and the answer's `path` / `path_rel` name the pooled
copy — reserved under `Media/` when the copy is queued, with `copying: true`
until it lands; subtitle documents become `Subtitle` items; `.svg` is
rasterised once to a 2048-px PNG), `delete_media` (`force` cascades like
`delete_layers`), `add_track`, `delete_track` (A/B roll protected),
`rename_track`, `move_track` (refuses the reserved A roll / B roll —
`TrackReserved`, they keep their place as `restack_layer` keeps them — and a
track holding a locked layer, `LayerLocked`), `set_track_flags`
(`enabled`/`locked`; no mute/solo — audio mixes by role, ADR 0023).

Layers: `add_layers` places 1–50 layers in one recorded edit, all or nothing
(spec D5). Shared fields sit flat on each layer (`track_id`, `t_start_us`,
`t_end_us`, `label`, a creation-time `transform`); `content` is a one-level
`oneOf` on `kind`: `video` (a Video item; the source window is `src_in_us`
plus the span at rate 1; `audio` defaults to `auto_pair_audio_on_import` and
`linked` lands and links the dialogue Audio on the same track's audio lane),
`image` (a still), `audio` (the only path for audio-only media; never paired;
sample-lattice endpoints; `role` defaults to `music`), `text` (born in the
style's tokens for its `graphic_role`), `color` (the composition's size),
`motif` (props validated against `props_schema`; omitted props take style
tokens, then manifest defaults; a `media` prop names `"<media_id>"` or
`"<media_id>@<t_us>"`) and `group` (another instance of an existing
composition; refuses root, cycles, empty; `t_end_us` defaults to its length).
A layer without `track_id` opens a fresh track inside the same commit, in
`composition_id` (else the root); with one, `composition_id` cross-checks it.
Keys outside a kind's arm are refused, not dropped. A layer's envelope is two
tools, as a track's is (`rename_track` / `set_track_flags`): `rename_layer`
(`label`; `null` clears it) and `set_layer_flags` (`enabled` and/or `locked` on
exactly the named layers, one edit; nothing is expanded). Both refuse a key they
do not take naming its owner — `t_start_us` → `move_layers`, `t_end_us` →
`trim_layer` (they carry link partners and the source window), a param →
`update_layer_params`.
Other layer edits: `update_layer_params` (one closed `oneOf` variant per kind; a static
write replaces that field's animation, `x`/`y` included; it answers each
patched field as committed under `params`; `scale_linked` links the scale pair
after the scale fields — `true` copies the `scale_x` track onto `scale_y`, keys
included, `false` unlinks — and while linked one axis sent writes both; Text
has no scale fields — a bigger title is a bigger box, ADR 0049, and a Static
`set_param_track` on a Text scale is refused with the same words; Text `intro` (`FadeIn`/`SlideUp`/`SlideDown`/
`Typewriter`) and `outro` (`FadeOut`/`SlideUp`/`SlideDown`) presets stay on the
layer's edges and play in preview and export alike,
[render.md](render.md#text-entrance-and-exit-presets); VideoClip `crop` is a
normalized source rect, `null` resets; `src_in_us` on VideoClip, Audio, Motif
and Group is a **slip** — the window moves at its length, the span stays —
and there is no `src_out_us`: a window's length is changed by `trim_layer`, its
rate by `retime_layers`), `trim_layer`, `restack_layer` (anchored
z-reorder, [features.md](features.md#track-placement)), `split_layer` (an array of cuts, one atomic edit),
`auto_split_by_shot` (the cached shot scan at `analyze_clip`'s defaults) — both
split link partners in lockstep and answer `siblings: [{ layer_id, segments }]`
for them — and `move_layers_to_composition`.

Moving and copying share one vocabulary: `layer_ids[0]` is the seed, its
landing is one of `t_start_us` / `delta_us`, and `track_id` moves only the seed
(every other member keeps its own track).
- `move_layers { layer_ids, t_start_us | delta_us, track_id? | "spawn",
  insert?, escape_link? }` moves a set and its link partners in one edit. A lane
  alone (no time) is legal; `"spawn"` opens a fresh top track for the seed, so
  lifting a dialogue Audio onto its own lane is `{ layer_ids: [audio],
  track_id: "spawn" }` and the link survives. `insert: true` is the ripple
  move: the set's span closes behind it (`planRipple`, the ripple delete's
  refusals by name) and room opens at the landing on every track; the seed's
  `t_start_us` is read on the closed timeline, i.e. where it starts afterwards.
  "Move the part after 1:30 to the start" is `split_layer` + one `move_layers
  { t_start_us: 0, insert: true }`. Answers `{ layers, rippled, track?,
  pruned_tracks }`. Nearest sibling: `shift_layers`, which takes no names.
- `shift_layers { from_t_us, delta_us, track_ids?, composition_id? }` sweeps
  every layer starting at or after a time. Positive opens room (the ripple
  insert); negative closes `[from_t_us + delta_us, from_t_us)` through the
  ripple planner, so a gap closes with one edge and a layer starting inside the
  span is `RippleInsideHole`, not a silent overlap; carried transitions keep
  their frame count. An empty sweep refuses.
- `paste_layers { layer_ids, t_start_us | delta_us, track_id?, unique? }` is the
  one copy tool (whole set, all-or-nothing; nothing is expanded). A Group clone
  is another instance of its composition unless `unique: true`, which
  deep-copies the composition (and the Groups inside it) so the copy edits
  independently; the answer's `groups` names each copy's `composition_id`.

Set tools take exactly the ids they are given — `delete_layers`,
`set_layer_flags`, `paste_layers`, `retime_layers` — and say so ("nothing is
expanded"); geometry tools (`move_layers`, `trim_layer`, `split_layer`) carry
link partners unless `escape_link`.

Deletes: `delete_layers` — `ripple: false` lifts (spans stay empty);
`ripple: true` closes each span on every track of the composition, each layer
on its own lattice. A ripple refuses whole: `RippleInsideHole`,
`RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked`.
A gap closes with `shift_layers` and a negative delta, by the same rules
([features.md](features.md#ripple-delete)). The remedy each refusal names
depends on the tool: only `delete_layers` and `move_layers` have a
`layer_ids` to widen.

Captions: `apply_transcripts` (keeps word timing; builds cues to the style's
caption limits — line breaks, `max_lines`, `max_cue_s`, `min_cue_s`; ≤ 1000
transcripts), `apply_subtitles` (lays a whole `Subtitle` item onto caption
tracks, ADR 0026, [captions.md](captions.md#ingestion)), `correct_caption_text` (against
`correction_script`; may split or merge word-timed cues), `restyle_to_taste`
(Text and Motif layers back to style tokens; groups `look`/`position`/`motion`,
default look + motion), `restyle_captions` (every caption in the project, or
`layer_ids`), `merge_captions`, `export_captions` (SRT/WebVTT body; a read).

**Graphic role.** Text, ImageOverlay and Motif layers carry `graphic_role`:
`null` or a name matching `^[a-z][a-z0-9_]{0,31}$`. Built-ins: `title`,
`lower_third`, `callout`, `credit`, `logo`, `plate`, `illustration`, `none`.
Other names are custom roles, never refused; whether the taste declares them is
an audit finding. Set at creation or via `update_layer_params`; a Video refuses
one. Captions are always untagged (a caption is identified by its track).

Position and motion paths:

VideoClip, ImageOverlay, Text, Motif and CompositionRef layers have one active
`Transform.position` representation: `XY` (independent `x`/`y` animation) or
`Path` (timestamp-free geometry plus a scalar `progress` animation). For every
kind the position is the transform anchor's location (ADR 0112).

- `set_position { layer_id, position }` replaces the complete record in one
  undo entry. Its keys are timed `local_t_us`, **layer-local microseconds**,
  unlike the timeline-absolute `t_us` of `set_keyframe` / `set_param_track`;
  the answer echoes them the same way. Keys need only
  `{local_t_us, value}`; nodes need only `{ point }` (handles default to zero,
  `segment` to `"Line"`, `tangent_mode` to `"Corner"`). WeftCut generates every
  node and key id; sending `id` is refused. It replaces motion (annotated
  destructive); it does not fit or bake. Bounds: 1–128 nodes, coordinates
  within ±10 million px. A static `update_layer_params` `x`/`y` flattens XY
  animation too.
- `progress` is a fraction, **not percentages**: 0 start, 1 end, by distance.
  At most 4096 keys; only `Hold`, `Loop`, `PingPong` extrapolation (`Offset` /
  `Continue` refused).
- `translate_position { layer_id, dx, dy }` offsets the position in either
  mode as one undo step: every XY key (or the static value), or every path node
  with its handles and progress. Nearest sibling: `set_position`, which
  replaces the record.
- In Path mode `x`/`y` writes are rejected; animate `path_progress`. Return to
  XY by sending XY tracks to `set_position`.

Example (a point at the start of a two-node line):

```json
{
  "layer_id": "00000000-0000-7000-8000-000000000001",
  "position": {
    "mode": "Path",
    "path": {
      "nodes": [
        { "point": { "x": 100, "y": 200 } },
        { "point": { "x": 500, "y": 200 } }
      ]
    },
    "progress": { "mode": "Static", "value": 0 }
  }
}
```

Then `set_keyframe` on `path_progress` with values 0 and 1 at two
timeline-absolute times.

Effects (visual kinds are realtime Pixi filters on the five visual kinds;
`audio.*` kinds are offline bakes on Audio layers, ADR 0027 / ADR 0063):
`add_effect { kind, params? }` (unknown kinds refused; the kind must match the
layer kind, `EffectKindNotApplicable`; `params` sets values at creation, so one
call adds a working effect), `update_effect { patch: { enabled?, params? } }`
(params as plain numbers, `{ "strength": 8 }`; `null` unsets a key; a value
written to a keyframed param replaces its keys), `move_effect`,
`delete_effect`. Param values are numbers in the catalog's ranges
(`effects://catalog`), and an unset param IS its catalog default
(`src/shared/effects/params.ts`): the effect record answers it, and a visual
param is keyframed as `effects[<id>].params[<key>]` with no prior write. An id
that names no effect on the layer is `EffectNotFound`. `audio.*` params are
static only (`AudioEffectParamStatic`).

Keyframes (timeline-absolute µs; record: [data-model.md](data-model.md#animated-values),
ADR 0058) are five tools over one track write:
- `get_param_track` answers `track` in exactly `set_param_track`'s write
  shape, so a read-edit-write round trip sends it back unchanged, with
  `keyframe_ids`, `local_t_us` and `preset_ids` parallel to its keys.
- `set_param_track` replaces the whole track in one entry (annotated
  destructive): `{mode: "Static", value}` holds one value,
  `{mode: "Keyframed", value: [keys], extrapolate?}` animates (Hold/Hold when
  omitted; `path_progress` takes Hold, Loop and PingPong only). Keys need only
  `{t_us, value}`; `easing` or `in`/`out`/`segment`/`continuity` shape them.
  Two keys that snap onto one frame are refused naming both
  (`KeyframesShareFrame`). It answers the committed keys `{keyframe_id, t_us,
  value}`.
- `set_keyframe` inserts or updates by time; the time snaps to the layer's
  lattice first, so a write a few µs off a key updates that key and keeps its
  id. On a Static track the first key replaces the static value, which is not
  kept.
- `update_keyframe` changes one key by id, applied in order: time (onto a
  frame another key holds is refused, `KeyframeOccupied` naming it), easing,
  sides with `out` last, continuity, `smooth: true` (Auto tangents on both
  sides).
- `delete_keyframe`; deleting the last key collapses the track to Static.

One easing vocabulary, `easing`, serves `set_keyframe`, `update_keyframe` and
a `set_param_track` key: a preset `{"preset": "<id>"}` from
`src/shared/easing.ts::EASING_PRESETS`, or a raw `{"kind": "Hold" | "Linear" |
"Bezier" | "Elastic" | "Bounce", …}`. It eases the segment leaving the key; on
the last key, which has none, the segment arriving at it, so keys authored in
time order each carry the easing of the move into them. A lone key has no
segment, and refuses one. Bulk authoring (`set_param_track`, `set_position`)
refuses caller ids: WeftCut allocates UUIDs because native export requires
them, and project load rejects a non-UUID keyframe id rather than
regenerating it. Every replacement mints fresh ids, so these tools are not
idempotent. Values are typed by `param_key` (`{r,g,b,a}` for `color`).

Valid `param_key`: VideoClip/ImageOverlay/Text/Motif/CompositionRef →
`scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity`, plus `x, y` in
**XY mode only**, or `path_progress` in **Path mode only** (where `x`/`y`
writes are rejected). Text/Color → `color`; Audio → `gain_db, pan`. On a
scale-linked layer a keyframe tool's write to one scale axis is the linked
Scale: the other axis takes a copy (fresh ids) in the same commit, as the UI
fans it out.

Transitions (ADR 0048): `add_transition` (`placement: "overlap"` moves the
incoming layer left so both play their trimmed ranges; `"extend"` borrows
outgoing tail media), `update_transition` (`(duration_us, extended_us)`
determine both window edges), `delete_transition` (restores the cut by
provenance; `TransitionRestoreCollision` if the gap was filled). Visual layers
only.

Audio roles (a mix fold, not a bus; ADR 0023): `set_role_gain` (recorded),
`set_role_flags` (mute/solo, at least one; mute wins; gates preview and
export; unrecorded and absent from the review diff, so an agent restores the
flags before handing back).

Links ([features.md](features.md#links)): `create_link`, `update_link` (add →
remove, one edit; below two members dissolves), `delete_link`. Membership is
read from `project://links`.

Groups ([features.md](features.md#groups)): `create_group` (pre-compose;
never partial), `add_layers` kind `group` (another instance), `add_group_members` (into a Group's
composition, keeping screen position), `ungroup_layer` (plain Groups only,
`GroupNotPlain`), `rename_composition`, `delete_composition` (orphans only,
`CompositionInUse`).

Markers and composition: `add_marker` (`color` defaults to the timeline's
marker blue; `note` as `update_marker` takes it), `update_marker` (`end_t_us: null`
turns a region back into a point; no other field takes null),
`delete_marker`, `set_marker_anchor`. A marker is the user's content — agents add one only when
asked, and use tacks otherwise. An anchored marker stores `{ layer, src_us }`
and re-derives `t_us` every commit; patching `t_us` moves the anchor; a
marker whose `src_us` leaves the clip's window is `hibernating` (kept, not
painted, revived when covered). An anchor is named by the layer alone.
`update_composition` (unrecorded; `duration_us: null` unpins; `fps` refused
with `FpsLockedByContent` once a layer exists now or in any history snapshot)
and `set_project_settings` (unrecorded; unknown keys and empty patches
refused; answers `{ settings, changed }`).

Time remapping: `retime_layers` (an absolute rate — source µs per timeline µs,
so 2/1 is double speed at half the length — or a target duration; keeps starts
and source windows; `preserve_pitch` sets the policy of the Audio and Group
clips among the targets, with or without a target). Nothing is expanded: the
answer's `unretimed_partners` names the link partners left at their old rate.
Frame sampling is the only interpolation, so there is no tool for it. Video,
Audio, animated ImageOverlay, Motif and CompositionRef retime; static images,
Text and Color do not.

Motifs ([motif-workspaces.md](motif-workspaces.md)): `list_motifs`,
`open_motif_draft`, `read_motif`, `update_motif_files` (revision-checked
batch; exact-match `edits`), `preview_motif` (whole canvas scaled to bounds,
never cropped; `id`, no alias; `local_t_s` is seconds from the Motif's start, not timeline time), `install_motif` (publishes; replacing another
target needs its version), `export_motif` (with `path`: an absolute `.zip` in
an existing folder; an existing file is `PathExists`, never overwritten;
annotated destructive), `delete_motif`, and the transfer tools
`begin_file_upload` (≤ 256 MiB), `write_file_chunk` (≤ 256 KiB decoded),
`read_file_transfer`, `delete_file_transfer`.

### Workflow / safety

- `ping` — liveness; app-scoped, so it separates "host down" from "refused".
- `begin_agent_session { reason, lock?, force? }` — a batch the user agreed to:
  one Pre-agent checkpoint, the review baseline pinned to it, one switch to the
  agent view and, unless `lock: false`, the history lock with `reason` shown in
  place of undo. One active session per project. A repeat from the same
  connection returns it and changes the lock only when `lock` is passed, so a
  repeat never undoes the user's Unlock (idempotent); another connection gets
  `AgentSessionBusy`, or with `force: true` ends that session (`end_reason:
  "forced"`, answered as `taken_over`) and begins its own. Answers the session
  with `locked`.
- `end_agent_session` — ends the caller's session and releases its lock; another
  connection gets `AgentSessionOwnerMismatch`. When the root's audit is not
  fresh the owner's end runs `check_composition` first and is held once on
  `hard` or `warning` findings (`{ ended: false, held: "audit", … }`); ending
  again with no edit between ends it. Reports `ended` (the session, null with
  none), `audit` and `tacks_to_review`. Ending changes no view and cancels
  nothing.
- `undo` / `redo` answer the stepped-over op as a history row. History is
  shared, so `undo` reverts the newest edit by anyone: `undone.actor` says whose.
- `jump_to { op_id }` — to the state right after an op of `project://history`.
  An op id survives the cap's front eviction; an index would shift under it.
- `create_checkpoint` — a named restore point for this project opening only:
  opening another project or quitting drops it. `restore_checkpoint` records the
  restore (clears redo). `project://history` lists checkpoints; deleting one is
  the History panel's.
- Siblings: `create_checkpoint` vs `begin_agent_session` — begin already makes a
  checkpoint, so a separate one is a restore point the user names.
  `restore_checkpoint` vs `jump_to` — a named state that survives eviction vs a
  row of the stack.

### Tacks

A **tack** points the user at a stretch of the film without writing project
content (ADR 0115): runtime review state of the project opening, not in
history, not saved, untouched by undo, restore and the history lock; opening
a project clears them. It comments on **what plays in its range** on every
track and is either current or `outdated`, derived on read; the range moves
with its content (ADR 0117). A read gives the stored record plus
`composition_id`, `t_us`, `end_t_us` (null only when its composition is gone),
`outdated` and `follows` (the layer the range moves with now, or null).

- `create_tacks` — a validated batch (all or none; refusals name the index);
  `label` ≤ 200 chars, `body` ≤ 4000, `kind` `note`/`issue`/`question`; times
  land on the frame grid. Soft `hints` flag labels that name a time, ranges
  over gap only, and duplicates of the client's own open tacks. At most 1000
  per opening (`TackLimit`; nothing is evicted).
- `update_tack` — label, body, kind, `status` (`open`/`resolved`/`dismissed`).
  A tack's place is fixed; delete and re-create to move one.
- `delete_tacks` — by ids or by `session_id`.

After a committing call, the caller's own open tacks it moved or outdated ride
on the result as `affected_tacks: [{ tack_id, label, change }]` (`moved` |
`outdated`); a non-JSON result gets a trailing text block.
`end_agent_session` adds `tacks_to_review` (the client's open outdated tacks).

### Audit

`check_composition` checks a whole composition against the craft table
(`src/shared/craft.ts`, shipped as the skill's `craft/rules.md`) and the
merged taste, from project data alone, and the host remembers the result per
composition for the opening (ADR 0128). `hard` must be fixed before handoff,
`warning` fixed or tacked with the reason, `review` is a style departure to
confirm. Only rules with a right answer: `undeclared-role`, `text-offscreen`
(hard); `title-hold`, `lower-third-hold`, `text-pops`, `title-safe`,
`motif-off-frame`, `captions-covered`, `caption-line-length`, `caption-lines`,
`caption-cue-min`, `caption-cue-max`, `short-clip`, `role-inconsistency`
(warning); `token-drift` (review). `motif-off-frame` is a Motif canvas
reaching past the frame edge at its start or a transform key (a full-frame
canvas is exempt). `captions-covered` is an opaque layer — footage, a colour,
a plate Motif, a drawn scene (a frame-sized illustration Motif with no picture
prop, not on `ground: none`), or a Group holding one — on a track above a
caption track while cues are up. Group contents are checked through the
Group's transform and timing. Text extents are estimated (0.55 em advance,
1.25 em line). `revision` hashes the composition and taste revision; an audit
is fresh while both are unchanged. `start_export` and `end_agent_session`
audit the root when it is not fresh and report `audit` beside their result;
neither blocks the user or an export.

### Render and export

Export jobs are application-session jobs shared with the UI (ADR 0111).

- Presets (app-scoped, the export dialog's library): `list_export_presets`,
  `create_export_preset`, `update_export_preset`, `rename_export_preset`,
  `delete_export_preset`, `set_default_export_preset`. Built-ins
  (`builtin:match`, `builtin:hd`, `builtin:fullhd`, `builtin:uhd`) are
  read-only and adapt to the project; names are unique, ≤ 40 chars; presets
  store no engines, paths or ranges.
- Jobs: `get_export_options`, `start_export`, `get_export_status`,
  `retry_export` (an `awaiting_retry` finalization), `cancel_export`. With
  `preset_id`, its values then per-job `settings`; otherwise saved project
  settings over the default preset. Neither writes the project or a preset.
  `range` is `{ t_start_us, t_end_us }`, timeline µs, half-open.
  Reuse a `request_id` only when unsure a request arrived; different arguments
  under one id fail. Conflict policy `rename` (default) or `fail`; MCP never
  overwrites. Settings, `output_path` (absolute, in an existing folder, the
  extension `get_export_options` reports) and an `on_conflict: fail` collision
  are checked before a job exists and refused as `invalid_params`
  (`PathExists`, `PathNotFound`, `InvalidArgument`). `get_export_status`
  answers `{ job }`: the job named, else the active one, else the most recent;
  `null` only before any job ran. `wait_s` (≤ 60) blocks until that job's
  `state` changes (progress does not wake it) and answers at once when it is
  terminal; there are no progress notifications. A failed job's `error`
  carries its family's variant and data (`ResourceBusy` with `holders`).
  Only a completed status certifies `output_path`. Export locks
  editing and project switching until terminal; closing MCP does not affect
  the job; jobs do not survive an app restart.
- `render_frames` — read-only JPEGs of the root through the export pipeline
  (same decode, Motif frames and compositor), at timeline `t_us` (1–24) or sampled
  over `layer_ids` (settled, middle, exit, after each cut and shot change;
  ≤ 24); a labelled contact sheet by default. Refused while an export runs or
  before the editor has announced the project.
- Renderer capability (`renderer/render/rendererCapability.ts`, one query for
  preview, stills and export). Without WebGPU and WebGL2 Pixi falls back to its
  canvas renderer, which draws no clip effects, crops or transitions. A
  `render_frames` call whose frames hold any of them is refused before drawing:
  `invalid_request`, `RendererCannotDraw { renderer, missing, layer_ids, t_us,
  needs }`; frames without them render as usual. An export whose range holds
  them fails before encoding with the same variant on the job's `error`.
  `encoder_engine` / `decode_engine: auto` pick what the host runs: no WebGL
  means WebCodecs encode (8-bit H.264/HEVC/AV1 at a bitrate) and no native
  decode; anything else fails as `EncoderUnavailable` naming `encoder_engine`.
- `project://compiled` shows the audio composition before rendering.

### Prompts

User-invoked workflows (slash menu / command palette), `native/src/mcp/prompts.rs`:

- `/auto-caption` — `transcribe_clip` → `apply_transcripts` with the clip as
  `source_layer_ids`.
- `/cut-pauses` — one `remove_pauses` call, with the review-first alternative
  (`detect_pauses` → one `create_tacks` batch of region tacks) and what each
  ripple refusal means.
- `/voiceover` — `synthesize_speech`, splitting scripts over 4096 chars at
  paragraphs.

Each closes with the missing-key recovery hint.

## Agent panel and lifecycle

- View selection is the renderer's: manual entry/exit only switches layout —
  no session, checkpoint or lock change. `begin_agent_session` auto-enters the
  agent view once. The main-owned `AgentActivityService`
  (`main/agent/activity.ts`) holds one work session per project opening, keyed
  by the initiating MCP connection.
- A session ends by `end_agent_session`, a local end, a takeover or a definite
  transport close, releasing its undo lock; the user has a separate Unlock.
  There is no idle timeout. Running calls keep their attribution
  (`AsyncLocalStorage` carries call identity) and outcome.
- Activity is a structured stream separate from diagnostic logs: history ids,
  localized labels and object names, outcome, duration; bounded, redacted
  arguments. History keeps runtime provenance on snapshots, so restore,
  undo/redo and branch replacement mark effects applied or reverted; ids past
  the 4000-op provenance horizon read as unknown, never as reverted.
- Retention: the latest 1000 completed activities plus all running ones; not
  persisted; a project replacement starts a fresh stream and late results from
  the old opening are dropped. Deltas are versioned by opening id and revision;
  the renderer repairs gaps with a snapshot.
- Both layouts share one panel and store. Quick successful reads fold; slow
  calls, writes and failures stay individual (`readOnlyHint` decides a read).
  Checkpoint restore is gated by availability, lock and pending restore. Object
  navigation is editor-only; the agent view can jump its preview to a review
  item's time without selecting, entering compositions or starting playback.
- The connection header shows the listening service, registered clients
  (name/version, last request) and running calls. Registration is not a
  heartbeat.

## Review

After agent work the user reviews what differs from the state they last
accepted (ADR 0115). The diff is pure: entities compared by identity, each its
own added/removed/modified change, facts from the entity's own values, no
inferred cause or carried moves (ADR 0116). A change is unreviewed when an
Agent-sourced commit touched the entity since the baseline. The list is settled
as a whole — *Approve all* (moves the baseline, records nothing) or *Revert
all* (a recorded restore to the baseline, under the history lock) — and both
refuse when the view has moved on. Removed entities are drawn at their
baseline place, labelled as such. Tacks paint in their own Review lane under
the marker lane while the Review overlay is on and the opening has had a
session or a tack; overlapping chips collapse into a group chip.

## Tool description quality

Every client reads the whole catalog into context every session, so each
sentence is a standing cost.

- **A description carries**: what the tool does and when to pick it over a
  sibling; non-obvious argument semantics and defaults; the return shape; the
  refusals an agent must plan around, by name. An unrecorded write ends with
  "Unrecorded."
- **The schema carries**: a one-line meaning with unit for every property;
  enums for closed vocabularies; `param_key` as the animatable enum plus the
  effects pattern; `update_layer_params.patch` as one `oneOf` per kind,
  generated from the parser's key table. A `null` arm only where null means
  something omission does not.
- **Neither carries**: types in prose, mechanics, rationale, history (this
  doc), or the moment-of-failure explanation (the error message).
- **Gates**: `mcp.description-budget.test.ts` caps descriptions at 700 chars
  (≤ 17 allowlisted complex tools at 1100), nested property descriptions at
  260, and the compact tools array at 158,000 UTF-8 bytes; it also refuses
  `$schema`, `title`, `format` and `default: null` in schemas.
  `mcp.schema-semantics` pins enums and variants to the parsers.
  `npm run mcp:catalog:check` regenerates the Rust snapshot from the built
  addon and fails on drift (CI, `build`, `build:e2e`).
  `mcp.docs-coverage.test.ts` requires every advertised tool, resource and
  prompt to be named in this doc.

## Error model

A refusal is the tool's **answer**, not a protocol fault: every failure inside
a tool returns `isError: true` with text that names the cause and the options
— the one part every client shows the model. `structuredContent` mirrors it:
`code` (`invalid_params` when the caller can fix it, `invalid_request` when no
argument can, `internal` otherwise; `cancelled` for a cancelled compute job),
`message`, `error` (the variant, always present), ids and `options[]`. Nothing
lives only in `structuredContent`.

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "layer overlap on track 7f3a…: [5000000, 10000000) µs collides with layer 9c1d… at [4200000, 8000000) µs. … Options: …" }],
  "structuredContent": {
    "code": "invalid_params", "message": "…", "error": "LayerOverlap",
    "blocking_layer": "9c1d…", "options": [{ "action": "move_layers", "layer_id": "9c1d…" }]
  }
}
```

- Every `CommandError` has its own arm in `mapCommandError`
  (`main/state/mcp-commands.ts`), which takes the raising tool because a
  remedy can depend on it (only `delete_layers` and `move_layers` are told
  "add it to `layer_ids`"). `LayerOverlap` options are validated against the geometry.
  `mcp.error-vocabulary.test.ts` keeps any variant from falling through to its
  bare name.
- Host-raised families (not `CommandError`): `NoProjectOpen`
  (`invalid_request`, `NO_PROJECT_OPEN_MESSAGE` in `main/mcp/toolResult.ts`);
  the workspace errors of `open_project` / `create_project` — wrong path or
  name (`invalid_params`), or a folder that cannot be opened here
  (`ProjectSchemaTooNew`, `ProjectInvalid`, …; `invalid_request`, so a client
  that retries on `invalid_params` does not loop); the tack store's
  `TackLimit` / `NoCurrentCall` (`invalid_request`) and `TackNotFound` plus
  argument errors (`invalid_params`).
- One mapper at the boundary: every refusal, from any route (TS, Rust,
  export, render, Motif, file IO), leaves through `toolErrorResult`
  (`main/mcp/toolResult.ts`). It rewrites foreign text (`main/mcp/faultText.ts`):
  Electron's `Error invoking remote method '…'` wrapper is dropped, errno text
  becomes a sentence with its own variant (`PathNotFound`, `PathExists`,
  `PermissionDenied`, `DiskFull`, …), and a resource-admission refusal becomes
  `ResourceBusy` (the MiB it needed and found, the `holders`, `retry_after_s`)
  or, for a claim no wait admits, `ResourceBudget` naming Settings ›
  Performance › Memory target and the target that would admit it. A route that names no
  variant gets the code's (`InvalidArgument`, `InvalidRequest`, `Internal`).
  Export refusals map the job service's codes onto variants
  (`exportRefusal`, `main/mcp/exportTools.ts`); an unknown argument names the
  key and the export tool that takes it. A failed job's `error.message` in an
  export record is said in the same words.
- `mcp.error-vocabulary` sweeps every catalog tool (TS, Motif, export and the
  Rust snapshot) and fails on a refusal outside this shape, and on
  `Error invoking remote method`, an errno prefix or `media:job_complete` in
  any result text.
- JSON-RPC errors are reserved for faults of the request: an unknown tool name
  (`-32602`), a failing `resources/read` or `prompts/get` (no `isError`
  slot; a gated resource read is `InvalidRequest` with the no-project message;
  a URI that names nothing is MCP's resource-not-found, `-32002`).
- Arguments are checked before dispatch on every route: TS parsers, or the
  advertised schema for motif and Rust-parsed tools, so all missing fields are
  named at once in the tool's own vocabulary.

## Change feed

Every actor commit is relayed to every live session as
`notifications/weftcut/change` with the compact summary the renderer's
`project:changed` carries (`mapChangeEvent` in `main/state/ts-actor-host.ts`):

```json
{ "op_id": "...", "actor_kind": "agent", "client": "claude-code",
  "summary": "Moved 'intro' to 4.20s", "affected": [{ "kind": "Layer", "id": "7f3a..." }],
  "timestamp": "..." }
```

`actor_kind` / `client` follow the history actor (MCP edits are `agent` with
the client name). `affected` lets an agent tell whether an edit reached its
own work. The notification is a hint; read `project://current` for state.

## Speech (optional, user-supplied)

Speech-to-text runs over pluggable backends — OpenAI Whisper (cloud),
whisper.cpp and FunASR sidecars (local), and `byo_endpoint`, any
OpenAI-compatible transcription server (ADR 0036). Keys live in `safeStorage`;
main injects the selected model's config into every call that resolves an
engine, so the Rust resolver is stateless. Transcription uses the model
selected in Settings → Transcription (a picker that activates a model only
after its downloads install and a minimal inference succeeds) and otherwise
errors naming the remedy; nothing is substituted (ADR 0064). An OpenAI key
also enables `synthesize_speech`; TTS picks by preference, then a default
order. Unconfigured speech tools stay listed and
refuse naming the Settings panel.

- `transcribe_clip` — a timeline-absolute transcript envelope `{ backend,
  segments (with words), language, word_timing }` for a layer window, ready for
  `apply_transcripts`. `word_timing` is `exact` (engine token offsets) or
  `interpolated_from_cue`. Retimed times are projected by the playback rate.
  Network engines get audio over 10 min in pieces cut at the quietest 200 ms
  near each mark. `backend` is a **strict** override (that engine or an error
  naming the missing piece); without it the selected model serves the call or
  it errors. `word_timestamps` defaults to true;
  `normalize_audio` (default false) applies constant gain toward −3 dBFS
  (≤ +24 dB) to a private copy and reports it.
- `extract_clip_audio` — for an agent with its own speech model: a JSON block
  plus a base64 mono 16 kHz 16-bit WAV of the **original source audio** (before
  gain, effects, mix), ≤ 60 s of source per call; the block's window is
  `t_start_us`/`t_end_us` and `src_in_us`/`src_out_us` with `rate {num, den}`,
  so offset `w` maps to `t_start_us + w / rate`. Resolves no backend, uploads nothing, needs
  nothing configured.
- `synthesize_speech` — OpenAI tts-1 to `Cache/voiceover/<hash>.mp3`,
  imported and placed on an Audio track (default start: composition end;
  `cached` means no API call was billed).
- `byo_endpoint` posts multipart WAV to the user's full URL, asks for
  `verbose_json` with word and segment timestamps, retries once as `srt` on
  400/415/422 or a missing `segments` array, and remembers the working format
  per URL for the process. Per-model request timeout 10–3600 s, defaulting to
  the local sidecars' guard (60 s + 10 s per audio second).

Human entries use the same code: main serves `transcribe_clip`,
`detect_pauses` and `describe_clip` to the renderer through
`callClipComputeTool` (`main/mcp/server.ts`), and `apply_subtitles` /
`synthesize_speech` are hybrid channels shared with MCP. `drop_shot_markers`,
`apply_shot_cuts` and `mark_pauses` are renderer-only hybrids because agents
compose them from existing tools; `remove_pauses` has a tool because its
splits, deletes and gap closing must be one recorded edit.

## Video understanding (optional, user-supplied)

The twin of Speech for what is in a shot: a `SceneDescriber` trait with
Qwen3-VL and MiniCPM-V (`llama-mtmd-cli` sidecars) and an OpenAI-compatible
endpoint (a hosted VLM is the same describer with another URL). All get the
same sampled frames with `<t s>` markers.

- `describe_clip` — `{ backend, model, summary?, media_id, mapping,
  segments: [{ src_start_us, src_end_us, text, tags }] }` for a source window
  (`src_start_us`/`src_end_us`, default the source the layer plays), sampled at `fps` everywhere in the window (never sparser
  for longer windows), described in chunks (16 frames locally; 1–64 and up to
  8 concurrent for an endpoint). Over 3600 frames is refused naming the longest
  window that fits. `fps`, `focus` and `language` default to the app's
  settings, injected by main into calls and into both description resources.
  `purpose` `clip` (default) or `shot` keep separate caches: describing a
  clip does not mark its shots described, and legacy mixed-purpose entries are
  ignored.
- Results are cached as runs of finished chunks, resumable after a cancel or
  failure; `refresh` redoes an exact window (ADR 0147). Runs read tidied, and a
  `clip` window longer than one request gets a `summary`
  ([notes](notes/descriptions-vlm-facts.md#long-clips-tidy-and-summary-2026-10-27)).
  The cache key includes backend, model, fps, focus, language and prompt
  version.
- The selected model serves the call; `backend` is a strict override. Neither
  ever substitutes another engine, so a local choice never uploads
  (ADR 0064). Endpoint requests retry 408/429/5xx
  (≤ 3 attempts in 45 s) and are bounded per chunk by the model's request
  timeout (default 300 s + 20 s per frame). Timeout, frames per request and
  concurrency are run tuning, outside the cache key.
- Settings → Video understanding has its own `vlm_endpoint` key; local
  engines are app-managed downloads (ADR 0039).

## Observability

MCP calls flow through the `LogBus` into the status-bar console
([status-log.md](status-log.md)): a `Started` + `Ok/Err` pair per call sharing
one `op_id`, truncated args/result/error in `details`, filterable by category
`Mcp` and source `Agent { client }`.
