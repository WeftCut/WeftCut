# Architecture

WeftCut is an Electron desktop video editor with a Rust core loaded as a napi
addon. The Electron **main** process (TypeScript) owns the authoritative
project, persistence, config stores and the MCP host. The Rust core owns native
runtime services (derivative jobs, caches, ffmpeg, the export audio mixer and
video sink, speech/VLM backends, logs, resource admission) and receives the
project slice it needs as a call argument. The **renderer** hosts the React UI
and the PixiJS compositor that draws both preview and export. External agents
connect over MCP. The project folder *is* the project, and auto-save means
closing the app loses nothing ([data-model.md](data-model.md#on-disk-format-workspace-folder)).
Runtime choice and the stateless-Rust split:
[ADR 0024](adr/0024-desktop-runtime-electron-napi.md).

## Processes

Paths are under `apps/desktop/`.

| Process | Entry | Role |
|---|---|---|
| Main | `src/main/entry.ts` → `index.ts` | Registers the `weftcut-media:` and `motif:` schemes, loads `@weftcut/core`, runs the project actor, IPC routing, MCP host, export jobs, audio-effect baker and Motif capture. |
| Rust core (in main) | `native/` → `@weftcut/core` | `Backend.invoke(cmd, argsJson)` dispatch (`native/src/napi_backend.rs`); events return through a thread-safe function (`events.rs`). Never links libav. |
| Native decode (in main, optional) | `native/decode/` → `@weftcut/native-decode` | The only libav (ffmpeg-next) consumer: Standard-engine decode for preview and export. Loaded once in a try/catch (`src/main/native-decode.ts`); a failure only disables that engine ([ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)). |
| Renderer | `src/renderer/index.html`, preload `src/preload/index.ts` | React UI, PixiJS compositor, decoded-frame intake, Web Audio preview mixer. |
| Renderer workers | `render/worker/exportWorker.ts`, `render/motifs/motifReaderWorker.ts`, `render/positionConversion.worker.ts` | Export render and encode on an `OffscreenCanvas`; Motif frame reads; offline position conversion. |
| Utility processes | `src/main/motif-reader-host.ts`, `decode-probe-host.ts` (macOS), `hardware-probe-host.ts` (Linux) | Motif frame decode off main ([ADR 0154](adr/0154-motif-frames-are-read-at-preview-scale-through-one-reader.md)); crash-isolated hardware probes. |
| Hidden windows | `src/main/motif/capture.ts`, `svgRaster.ts`, `screenPick.ts` | Offscreen Motif capture over CDP ([ADR 0017](adr/0017-motifs-cdp-webcap-clock-takeover.md), [motifs.md](motifs.md#capture-host)); SVG rasterizing on import; screen color pick. |
| Child processes | `native/src/ffmpeg/`, `speech/`, `vlm/` | ffmpeg/ffprobe via `ffmpeg-sidecar`; local speech (whisper.cpp, FunASR) and VLM engines as sidecars. |
| `weftcut-mcp` shim | `src/cli/` | Stdio MCP server that bridges agent clients to the app's HTTP endpoint ([mcp.md](mcp.md#transport--deployment)). |

`src/main/calibration-host.ts` is a Windows-only developer prototype, selected
by `--weftcut-calibration` and built only into E2E builds.

## Principles

### 1. Single writer

Every mutation, from a UI edit or an MCP tool call, goes through one TypeScript
actor in main (`src/main/state/`). It validates, commits a frozen snapshot to
history and broadcasts a `ChangeEvent`. Serialization, not locking, handles
concurrency. Rust never mutates the project: compute calls take the slice they
need, and derivative jobs emit write-back events the actor folds in
([data-model.md](data-model.md#concurrency-single-writer-actor)).

### 2. Preview = export pipeline

The export Worker constructs the same `Compositor` the preview uses, against an
`OffscreenCanvas`, so preview pixels equal export pixels by construction. The
pipeline is recursive: a Group is a composition drawn to a texture and staged
as one layer of its parent ([ADR 0052](adr/0052-link-propagates-group-composes.md)).
Preview draws its render target (the composition it is locked to, or the one
holding focus) on that composition's own clock
([ADR 0053](adr/0053-a-timeline-panel-is-one-composition.md)); export always
draws the root. Details: [render.md](render.md#compositions-the-recursive-composite).

Deterministic "what you see/hear" math (frame snap, keyframe evaluation, the
audio envelope, the role gate) lives once in the `weftcut-eval` crate
(`native/eval/`). Rust links it natively; the renderer and the main-process
actor load it as wasm from `src/renderer/eval/`
([ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)).

### 3. ffmpeg never composites

ffmpeg runs as a subprocess for:

- **Import derivatives**: the quick proxy (preview), the full proxy (an H.264
  export master for sources WebCodecs can't decode), thumbnails, filmstrip
  tiles, waveforms, and the 48 kHz f32 audio conform both mixers read
  ([audio.md](audio.md#the-conform-cache), [preview.md](preview.md#proxies)).
- **Audio export**: Rust mixes (`native/src/audio/mix.rs`); ffmpeg applies the
  limiter and encodes.
- **Video export**: the native engine (default) streams GPU-packed rawvideo to
  an ffmpeg sink that owns the encode; the WebCodecs engine (explicit pin)
  encodes in the renderer instead ([render.md](render.md#encode-exits)).
- **Final mux**: stream copy into the user's container, never a re-encode
  ([export.md](export.md#pipeline)).

The binary main puts on `PATH` wins over an exe-adjacent one, and
`ffmpeg-sidecar`'s download is the clean-machine fallback on Windows and macOS
(`native/src/ffmpeg/mod.rs`; [setup.md](setup.md#ffmpeg-at-runtime),
[licensing.md](licensing.md)).

## Data flow: one edit

1. A UI command (`backend:invoke`) or an MCP tool call reaches the actor.
2. The actor validates. A failure returns a structured `CommandError`
   (`src/shared/commandErrors.ts`).
3. The actor commits a snapshot to history and broadcasts a `ChangeEvent`.
4. Subscribers react:
   - **Renderer**: main sends `evt:project:changed`. The renderer's publication
     client (`src/renderer/state/projectPublication.ts`) reads the newest
     version, keeps unchanged branches by reference, and the compositor
     updates its sprite tree in place. Command promises resolve after their
     receipt is applied ([ADR 0114](adr/0114-project-view-publication.md)).
   - **Autosave**: a debounced write of `project.json` plus periodic
     `Backups/` copies (`src/main/state/autosave.ts`).
   - **MCP change feed**: notifications to subscribed agents
     ([mcp.md](mcp.md#change-feed)).

## Process boundaries

| From → To | Mechanism |
|---|---|
| Renderer → main | contextBridge capabilities (`src/preload/index.ts`), mostly `api.backend.invoke(channel, args)` → `ipcMain.handle('backend:invoke')` in `src/main/index.ts`. Main first intercepts channels that need main-held state (clip compute, audio effects, and the single-media and export channels, which get the project slice injected). `routeChannel` (`src/main/state/router.ts`) sends the rest to the TS host, or to `Backend.invoke` when pure-native. |
| Clip compute | `transcribe_clip`, `detect_pauses` and `describe_clip` from the UI call the MCP host's `callClipComputeTool` (`src/main/mcp/server.ts`), so the human and agent paths are one function. |
| Main → renderer | `webContents.send('evt:<event>', payload)`, received via `api.on(event, …)`. Carries actor events and Rust events relayed from the thread-safe function. |
| Renderer → files | `weftcut-media://localhost/<encoded-abs-path>` (privileged, fetch + stream, HTTP `Range`) for media reads; `motif:` for Motif documents; `fs:*` IPC confined by `fsGuard.ts` to temp, userData, the data root and the open workspace. |
| Native decode → renderer | Windows hardware preview hands over persistent D3D11 shared textures (`src/main/previewGpu.ts`); other lanes copy frame bytes ([preview.md](preview.md#decode-engine)). |
| Agent → main | MCP streamable HTTP on `127.0.0.1` (`src/main/mcp/`, `@modelcontextprotocol/sdk` + express), bearer token in `<userData>/mcp_auth.json`. The catalog merges TS tool defs with Rust compute/hybrid tools (`mcpCatalog.ts`). |
| Rust → ffmpeg | `ffmpeg-sidecar` subprocesses resolved through `native/src/ffmpeg/mod.rs`. |

## Where things live

| Area | Code (under `apps/desktop/`) | Doc |
|---|---|---|
| Project model, actor, history, persistence, migration | `src/main/state/`; Rust serde model `native/src/state/` | [data-model.md](data-model.md) |
| Types shared by main and renderer | `src/shared/` | |
| Compositor, sprites, effects, transitions, export Worker | `src/renderer/render/` | [render.md](render.md) |
| Preview surface, decode engines, proxies | `src/renderer/preview/`, `render/decoder/`, `src/main/previewGpu.ts`, `native/decode/` | [preview.md](preview.md), [platform-codecs.md](platform-codecs.md) |
| Export jobs, settings, finalization | `src/main/exportJobs.ts`, `src/renderer/app/exportRunner.ts`, `native/src/export/` | [export.md](export.md) |
| Audio: conform, mixers, baked effects | `native/src/audio/`, `src/renderer/render/audio/`, `src/main/audioFx/` | [audio.md](audio.md) |
| Derivative jobs and caches | `native/src/jobs/`, `native/src/cache/` (project `Cache/`; app-level cache under the data root) | [data-model.md](data-model.md#app-level-storage-the-data-root) |
| Motifs | `src/main/motif/`, `src/renderer/render/motifs/`, `native/src/motif_*.rs` | [motifs.md](motifs.md), [motif-authoring.md](motif-authoring.md) |
| MCP host, agent activity, tacks, audits, styles | `src/main/mcp/`, `src/main/agent/`, `src/main/lint/`, `src/main/taste/`, `native/src/mcp/` | [mcp.md](mcp.md) |
| Speech, captions, video understanding | `native/src/speech/`, `subtitles/`, `vlm/`, `inference/`; clip-compute jobs `src/main/compute/` | [captions.md](captions.md), [mcp.md](mcp.md#video-understanding-optional-user-supplied) |
| Resource admission and performance | `native/src/resources.rs`, `src/main/resources.ts` | [performance-settings.md](performance-settings.md) |
| Logs and status | `native/src/logs/`, `src/renderer/logs/` | [status-log.md](status-log.md) |
| Security: CSP, protocols, Motif sandbox | `electron.vite.config.ts`, `src/main/windows.ts`, `src/main/motif/protocol.ts` | [security.md](security.md) |
| UI shell: Dock, panels, focus, widgets | `src/renderer/workspace/`, `focus/`, `components/` | [ui-tokens.md](ui-tokens.md) (incl. [icons](ui-tokens.md#icons)), [ADR 0018](adr/0018-ui-widgets-on-base-ui-with-tailwind-tokens.md) |
| Build, packaging, releases | `electron.vite.config.ts`, `electron-builder.yml`, `scripts/` | [setup.md](setup.md), [releases.md](releases.md), [licensing.md](licensing.md) |

The Rust workspace (`native/Cargo.toml`) has three members besides the core:
`eval/` (shared math, native + wasm), `conversion/` (offline position
conversion, native + wasm) and `decode/`.

## Panels and the Dock

Editor surfaces are Dockview panels catalogued by **kind** in
`src/renderer/workspace/panelRegistry.ts`. A kind is not an identity: the
`timeline` kind has one instance per composition, addressed
`timeline:<compositionId>` ([ADR 0053](adr/0053-a-timeline-panel-is-one-composition.md)),
and `panelIdOf` / `parsePanelId` are the only functions that know that
spelling. A panel is also the unit of keyboard focus. An action's `scope` names
kinds, so `scope: "timeline"` resolves to the timeline panel that last held the
keyboard ([ADR 0041](adr/0041-focus-regions-are-panels-and-scope-the-keyboard.md)).
Dock geometry is app-wide in `<userData>/workspaces.json`, with every
`timeline:*` folded to the bare `timeline` slot. Which compositions are open is
the project's `view.json` ([data-model.md](data-model.md#viewjson-how-this-project-was-last-looked-at)).

## Internationalization

The UI ships `en-US` (default) and `zh-CN` through i18next
(`src/renderer/i18n/locales/*.ts`, registered in `i18n/index.ts`). Rust logs and
MCP tool errors stay English. Actor refusals cross IPC as a `CommandError`
tagged by its `error` field, which the renderer parses
(`src/renderer/errors/parseCommandError.ts`) and localizes. Log lines may carry
`i18n_key` / `i18n_args` ([status-log.md](status-log.md#i18n)).

## See also

- [Features](features.md): the concrete behavior of each capability.
- [Conformance](conformance.md): media fixtures and E2E gates.
- Release scope and open work live in the GitHub issue tracker; docs describe
  what exists today.
