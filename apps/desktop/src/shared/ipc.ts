// Single source of truth for the preload IPC contract — the shape of
// `window.api`. Shared between the two DOM-context sides that must agree on it:
//   - src/preload/index.ts   implements it: `const api: WeftcutApi = {…}`
//                            (so the implementation is compile-checked here)
//   - src/renderer/bridge/   consumes it: augments `Window` + wraps each method
// Because both type-check against THIS definition, the two sides cannot drift.
// The main process does not consume this contract, so it does not reference
// this project.
//
// Types only — no runtime. `File` etc. resolve from DOM (both consumers are DOM
// contexts); this file is never imported by the non-DOM main process.

import type { UpdateDownloadResult, UpdateRestartResult, UpdateResume, UpdateStatus } from './updates'
import type { ExportDecodeOpenInfo, PreviewDecodeOpenInfo, PreviewDecodeOptions } from './frameCarrier/wire'

export type DialogOpenOpts = {
  title?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}

export type DialogSaveOpts = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type DirEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }

// `decorations` is the Tauri-era name kept at the IPC boundary: true (the
// default in createSecondary) gives the window a native OS frame with a title
// bar (move/close). Secondary windows draw no custom titlebar, so omit it (or
// pass true) for everything except a window that paints its own caption.
export type WinCreateOpts = {
  url?: string
  width?: number
  height?: number
  title?: string
  decorations?: boolean
  resizable?: boolean
  minWidth?: number
  minHeight?: number
}

export type WinAction = 'show' | 'hide' | 'close' | 'center' | 'focus'

export type NotificationOpts = { title?: string; body?: string }

/// Process-tree resource snapshot derived from Electron's app.getAppMetrics().
/// Covers the whole app process tree (main + renderers + GPU + utility), not
/// the host machine. See src/main/metrics.ts for the CPU-normalization landmine.
export type SystemStats = {
  /// Summed CPU across the process tree, as a % of the whole machine (0–100).
  cpu_percent: number
  /// Summed resident memory (working set) of the process tree, in bytes.
  rss_bytes: number
  /// Number of processes in the Electron tree.
  process_count: number
  /// Logical core count — context for cpu_percent.
  logical_cores: number
}

/// An app-level capability notice, listed in the bell's notification center.
/// `code` keys the i18n strings; main collects these at startup
/// (e.g. keyring-unavailable → plaintext cloud keys) and the renderer PULLS them
/// on mount via `app.notices()` — a pull model so a notice can't be lost to the
/// fire-once-before-subscribe race a pushed event had. `args` fill the
/// strings' placeholders.
export type AppNotice = { level: 'info' | 'warn' | 'error'; code: AppNoticeCode; args?: Record<string, string | number> }
/// Every notice main can raise. A new one also needs its catalog entry
/// (`renderer/notifications/appNotices.ts`) and its `app_notice.<code>` strings.
export type AppNoticeCode =
  | 'native_decode_unavailable'
  | 'keyring_unavailable'
  | 'agent_skill_unavailable'
  | 'agent_skill_stale'
  | 'motif_drafts_left'

/// Version identity for the About dialog, pulled by the renderer (the bundle
/// has no package.json access). `app` is app.getVersion(); the rest are
/// process.versions / process platform tags used by bug reports.
export type AppVersions = {
  app: string
  electron: string
  chrome: string
  platform: string
  arch: string
}

/// The source's resolved colour as `previewGpu.open` carries it, in the shape
/// of Electron's `ColorSpace`. Native picks its NV12→RGBA conversion from
/// `matrix` and `range`; the slot textures themselves are imported as sRGB
/// passthrough (main/frameCarrier/sharedTextureImport.ts).
export type PreviewGpuColorSpace = {
  primaries: string
  transfer: string
  matrix: string
  range: 'limited' | 'full' | 'derived' | 'invalid'
}

/// Reply of `previewGpu.open`: decoded stream dimensions + the realized pool
/// size (native may hand back fewer slots than requested).
export type PreviewGpuOpenReply = {
  width: number
  height: number
  poolSize: number
}

/// Reason `previewGpu:open` rejects with when either HW admission currency
/// (sessions, coded pixel area) or the shared GPU buffer budget is full. A CAPACITY
/// condition, not a capability one: the same media on the same machine opens on
/// hardware again as soon as enough reservation frees. Callers must treat it as
/// "software for THIS open" and must NOT record it as a per-media hardware verdict
/// (see `judgeFailure` in ffmpegSourceLifecycle.ts — doing so pinned a source to software
/// for the rest of the app session the first time concurrent load exceeded
/// admission, and kept it there after the extra clips were deleted). Shared so main
/// and the renderer can't drift on the string.
export const HW_BUDGET_EXCEEDED = 'hw-budget-exceeded'

/// The native session opened at dimensions different from the coded size main
/// reserved. Treat this as a transient admission mismatch for THIS open: main
/// closes the native session and releases its lease, and the renderer falls to
/// software without poisoning the per-media hardware capability cache.
export const HW_BUDGET_RESERVATION_MISMATCH = 'hw-budget-reservation-mismatch'

/// Live preview-GPU admission snapshot. Main reserves a decoder session,
/// coded width×height and shared buffer bytes before native open.
///
/// `codedPixelArea` uses the shipping 30 fps reference or accepted 60 fps test. It is
/// deliberately NOT called pixel-rate: fps is not yet carried into admission,
/// and multiplying this number by an assumed rate would overstate the model.
/// `calibratedFps` makes that empirical boundary visible to diagnostics.
export type PreviewGpuBudgetSnapshot = {
  currency: 'coded-pixel-area'
  sessions: { used: number; max: number }
  codedPixelArea: { used: number; max: number; calibratedFps: 30 | 60 }
  /// Live shared-pool VRAM across every OPEN session: Σ width×height×4 (RGBA8)
  /// × that session's slot count, from main's session records. Closed imports
  /// still held by Chromium remain in performanceResources.info's aggregate
  /// byte accounting until their final references are released.
  slotVram: { usedBytes: number; bytesPerPixel: 4 }
}

/// Per-metric ms summary from the native preview timing accumulator. Field
/// names are the napi camelCase of the Rust `TimingSummary`.
export type PreviewGpuTimingSummary = {
  count: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}
/// Native timing metrics: the coord round-trip (emit->ack), decode+copy, and the
/// throughput-bottleneck probe — `ackToEmit` (a slot's ConsumeAck -> its next
/// FrameReady, the one per-slot-cycle segment coordRtt does NOT cover) plus
/// `lookaheadGatedSkips` (how often the pump idled on the lookahead gate rather
/// than pool-full). See docs/decode-bench.md § Strategies.
export type PreviewGpuTimingReport = {
  coordRtt: PreviewGpuTimingSummary
  decodeCopy: PreviewGpuTimingSummary
  /// GPU-side cost of the native NV12→RGBA conversion pass (timestamp queries
  /// on the decode device). A subsample: one query bracket in flight at a
  /// time, polled non-blocking, so `count` legitimately trails the delivered
  /// frame count.
  convertGpu: PreviewGpuTimingSummary
  ackToEmit: PreviewGpuTimingSummary
  lookaheadGatedSkips: number
  /// Frames the pump discarded as already-late (past the playhead by more than the
  /// A/V tolerance) instead of paying the GPU copy + IPC + ImageBitmap to deliver
  /// one nothing would display. 0 = the pipeline kept up; sustained non-zero = a
  /// decode shortfall the drop policy is absorbing.
  lateFrameDrops: number
  /// Thread time-budget probe: production/ack cadence (interEmit/interAck),
  /// the session thread's recv_timeout block distribution (recvBlock — its sum ~=
  /// total thread idle), and wake-reason tallies (idle ticks / acks / anchor nudges).
  interEmit: PreviewGpuTimingSummary
  interAck: PreviewGpuTimingSummary
  recvBlock: PreviewGpuTimingSummary
  recvTimeoutTicks: number
  recvAckMsgs: number
  recvReqMsgs: number
  /// Stall attribution: which pump early-return dominated (eofReturns /
  /// poolFullReturns / acquireFailed / lookaheadGatedSkips), plus the terminal
  /// free-slot count + eof flag when the pump last gave up.
  eofReturns: number
  poolFullReturns: number
  acquireFailed: number
  finalFreeSlots: number
  finalEof: boolean
  /// Fencing-token protocol counters: delivered slots the owner reclaimed
  /// after the lease timeout with no ack (each = one possibly-torn frame
  /// traded against a wedged pool; routine non-zero means the consumer
  /// stalls), and acks dropped on a generation mismatch (usually the late
  /// ack of a reclaimed lease — harmless BECAUSE it was dropped).
  leaseTimeouts: number
  staleGenAcks: number
  /// This session's shared-pool VRAM in bytes (width×height×4×slots) — the
  /// native side of the pool-VRAM instrument (main's budget snapshot carries
  /// the cross-session sum).
  poolSlotBytes: number
}

/// Main-measured renderer round-trip (decode-bench signal attribution): the time
/// from main dispatching `frameReady` to receiving the matching `consumeAck` —
/// main<->renderer transit + renderer work, measured in main's own clock.
export type PreviewGpuMainTiming = { rendererRoundTripMs: PreviewGpuTimingSummary }

/// Availability of the optional @weftcut/native-decode component (level-0
/// gate, ADR 0030). `reason` is the require error when unavailable.
export interface DecodeComponentStatus {
  available: boolean
  reason: string | null
  version: string | null
}

/// Verdict of `decodeCap:probeSw` (D3 machine capability cache): main runs the
/// SW one-frame decode probe, derives the format-class key from what it
/// learned, and consults/updates the per-machine cache. `classKey` is null
/// when the probe couldn't even identify a codec (e.g. unopenable file).
export interface DecodeCapabilityProbeResult {
  ok: boolean
  classKey: string | null
  reason: string | null
}

/// Verdict of `decodeCap:probeHw` (D4 GPU-keyed HW capability cache): main
/// resolves the best HW decode lane for a caller-supplied `classKey` (the
/// renderer derives it from `MediaSummary` — the HW probe itself does not,
/// unlike the SW probe, since probing is comparatively expensive). `lane` is the
/// HW lane that passed (`d3d11va` | `nvdec` | `vaapi` | `videotoolbox`), or null
/// on software fallback; `device` names the DRM render node for a `vaapi`
/// verdict (null for NVDEC/d3d11va/videotoolbox, which decode on the sole
/// GPU/OS handle).
export interface DecodeHwProbeResult {
  ok: boolean
  reason: string | null
  lane: string | null
  device: string | null
  diagnostic?: import('./decode-hardware-diagnostic').DecodeHardwareDiagnostic
}

// Data-root migration IPC surface. Types single-sourced in
// src/shared/data-root.ts (imported by main's handlers + renderer wrappers too).
import type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
} from './data-root'
import type { MenuProjection } from './menu'

/// What a Motif cold start deleted from the project's frame cache.
export interface MotifColdStartResult { files: number; bytes: number }

export interface WeftcutApi {
  diagnostics: import('./diagnostics').DiagnosticsApi
  resources: {
    planExport(request: import('./export-resources').ExportPlanRequest): Promise<number>;
    estimateDecoder(path: string): Promise<number>;
    onExportWaiting(cb: (event: import('./export-resources').ExportResourceBlock & { id: string }) => void): () => void;
    acquire(request: { id: string; memoryMiB: number; threads: number; finalizationToken?: string }): Promise<void>;
    release(id: string): void;
    playing(value: boolean): void;
    status(): Promise<import('./resource-policy').ResourceStatus>;
  }
  performanceResources: {
    info(refresh?: boolean): Promise<import('./performance-budgets').PerformanceResourceInfo>;
    probe(): Promise<import('./hardware-diagnostics').HardwareAccelerationDiagnostics>;
  }
  performanceCalibration: {
    status(): Promise<import('./playback-calibration').CalibrationSnapshot>
    start(): Promise<import('./playback-calibration').CalibrationSnapshot>
    cancel(): Promise<import('./playback-calibration').CalibrationSnapshot>
  }
  colorPick: import('./screenPick').ScreenPickApi
  /** The napi/Rust command dispatcher — one controlled channel for the whole
   *  Rust command catalog. */
  backend: {
    invoke(channel: string, args?: unknown): Promise<unknown>
    /** Existing result plus a renderer publication barrier; never a save receipt. */
    invokePublished(channel: string, args?: unknown): Promise<import('./projectPublication').PublishedResult<unknown>>
  }
  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void>
    writeTextFile(path: string, data: string): Promise<void>
    mkdir(path: string, recursive?: boolean): Promise<void>
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    readDir(path: string): Promise<DirEntry[]>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    isFocused(): Promise<boolean>
    /** Taskbar progress: `status` is a `ProgressBarStatus`, `progress` 0–100. */
    setProgressBar(bar: { status: string; progress?: number }): Promise<void>
    setTitle(title: string): Promise<void>
    captureSnapshot(): Promise<Uint8Array<ArrayBuffer>>
    focus(): Promise<void>
  }
  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null>
    save(opts: DialogSaveOpts): Promise<string | null>
  }
  path: {
    documentDir(): Promise<string>
    join(parts: string[]): Promise<string>
    tempDir(): Promise<string>
  }
  /// `reinstallSkills` re-runs the startup skill refresh and returns what it
  /// found, so the Agent panel can recover a failed install without an app
  /// restart. It also re-broadcasts `app:notices`, since the notice it clears
  /// (or raises) was pulled once on mount.
  mcp: {
    getInfo(): Promise<unknown>
    resetToken(): Promise<unknown>
    reinstallSkills(): Promise<unknown>
  }
  win: {
    create(label: string, options?: WinCreateOpts): Promise<void>
    act(label: string, action: WinAction): Promise<void>
    exists(label: string): Promise<boolean>
  }
  media: { dropped(paths: string[]): Promise<void> }
  /// Startup notices the renderer pulls on mount (see AppNotice), plus the
  /// version identity behind the Help → About dialog (see AppVersions).
  app: {
    notices(): Promise<AppNotice[]>
    versions(): Promise<AppVersions>
    /** The saved layout preset when main created this window (see
     *  shared/layout-theme.ts); null when main did not pass one. */
    launchLayoutTheme: import('./layout-theme').LayoutTheme | null
    /** The Motif tuning main resolved for this run (see
     *  shared/motifs/tuning.ts); null when main did not pass it. */
    motifTuning: import('./motifs/tuning').ResolvedMotifTuning | null
  }
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateDownloadResult>
    restart(): Promise<UpdateRestartResult>
    resume(): Promise<UpdateResume>
  }
  /// Developer menu actions. Main registers their handlers in dev builds only;
  /// a release build rejects every call.
  dev: {
    /// Drops a CLOSED project's Motif frame cache and retires every capture
    /// host (main/motif/coldStart.ts).
    motifColdStart(dir: string): Promise<MotifColdStartResult>
  }
  /// macOS native application menu. The renderer pushes what the CURRENT
  /// surface can run — labels resolved through i18next, accelerators from the
  /// effective keybindings — and main rebuilds the menu from it (src/shared/
  /// menu.ts). A no-op off macOS, where no application menu exists at all.
  /// Chosen items come back as the `menu:action` event.
  menu: { sync(projection: MenuProjection): Promise<void> }
  /// Open a path or URL in the OS default handler (file manager / browser), or
  /// reveal a file in the file manager (selected on Windows / macOS; Linux
  /// opens the containing folder — see main/openPath.ts).
  shell: { open(target: string): Promise<void>; reveal(target: string): Promise<void> }
  /// Post a desktop notification (best-effort; no-op where unsupported).
  notification: { send(opts: NotificationOpts): Promise<void> }
  /// Process-tree resource snapshot (app.getAppMetrics(), main-side).
  metrics: { get(): Promise<SystemStats> }
  /// Best-effort OS font-file lookup by family name (main-side scan); null when
  /// not found, so the renderer falls back to the bundled font chain.
  font: {
    resolve(family: string): Promise<Uint8Array | null>
    /** Session snapshot; family names only, never filesystem paths. */
    listFamilies(): Promise<string[]>
  }
  /// Native GPU-decode preview (Windows d3d11va): a decode session whose
  /// frames stay in shared-texture slots. `open` starts a session and resolves
  /// once its pool's textures reached the preload; the session's port arrives
  /// separately as a window message (`openDecodeSession` in the renderer) and
  /// carries each slot, read into an `ImageBitmap`, the end and errors down and
  /// its `request`/`release` commands up. `close` resolves once main has closed
  /// the session and released its admission; it goes to main ahead of any open
  /// started after it.
  previewGpu: {
    open(args: {
      sessionId: string
      path: string
      poolSize: number
      colorSpace: PreviewGpuColorSpace
      /// Renderer-probed coded dimensions reserved by main before native open.
      codedWidth: number
      codedHeight: number
    }): Promise<PreviewGpuOpenReply>
    close(args: { sessionId: string }): Promise<void>
    /// Live preview-GPU admission budget (see `PreviewGpuBudgetSnapshot`).
    /// Diagnostics —
    /// the open gate in main is still the authority; a caller must not pre-check
    /// this and skip the open.
    budget(): Promise<PreviewGpuBudgetSnapshot>
    /// E2E/bench-only: drain this session's per-frame timing samples. Rejects
    /// for an unknown stream, or with "preview-gpu not built" off the native path.
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport>
    /// E2E/bench-only: drain the MAIN-measured renderer round-trip samples.
    takeMainTimings(): Promise<PreviewGpuMainTiming>
  }
  /// Native preview decode: the Standard engine's software lane and its
  /// copy-back hardware lanes (Linux NVDEC/VAAPI, macOS VideoToolbox), which
  /// ship the same frame bytes. `open` starts a session and resolves with its
  /// shipped frame size; the session's port arrives separately as a window
  /// message (`openDecodeSession` in the renderer) and carries its frames, end
  /// and errors down and its `request`/`release` commands up. `close` ends the
  /// session; it goes to main ahead of any open started after it.
  previewDecode: {
    open(args: { sessionId: string; path: string; options: PreviewDecodeOptions }): Promise<PreviewDecodeOpenInfo>
    close(args: { sessionId: string }): void
  }
  /// Native software export-decode (blind-spot originals: ProRes/DNxHD/MPEG-2/
  /// VC-1). `open` starts a session and resolves with its open info; the
  /// session's port arrives separately as a window message
  /// (`openDecodeSession` in the renderer). `close` ends the session; it goes
  /// to main ahead of any open started after it.
  exportDecode: {
    open(args: {
      sessionId: string
      path: string
      /// CPU transport format for the session's frames: NV12 (8-bit) or
      /// I420P10 (the 10-bit lane; layout on `tenBitFrameFromBytes`).
      outFormat: 'NV12' | 'I420P10'
      /// Frames in flight before the session waits for a release.
      window: number
      finalizationToken?: string | undefined
    }): Promise<ExportDecodeOpenInfo>
    close(args: { sessionId: string }): void
  }
  /// Availability of the optional @weftcut/native-decode component (level-0
  /// gate). The renderer pulls this once on mount (availability is fixed for a
  /// process lifetime — the require is memoized in main).
  decodeComponent: { status(): Promise<DecodeComponentStatus> }
  /// Machine capability probe: runs the SW decode probe on `path` and
  /// returns the cache-informed verdict for that file's format class.
  /// `probeHw` is the GPU-keyed HW-lane counterpart: caller supplies
  /// `classKey` (probing is expensive, so the cache must be consulted before
  /// deciding to probe, not after).
  decodeCap: {
    probeSw(path: string): Promise<DecodeCapabilityProbeResult>
    probeHw(path: string, classKey: string): Promise<DecodeHwProbeResult>
  }
  /// User-managed data location. Main-process actions (not backend commands):
  /// report the effective root, pick+migrate to a new root
  /// (copy/verify/rollback or adopt, progress on `evt:dataRoot:progress`),
  /// relaunch onto it, open it in the file manager, and the post-relaunch
  /// delete-the-old-copy flow. `relaunch` is separate from `pickAndMigrate` so
  /// the UI controls timing (show success, then relaunch).
  dataRoot: {
    current(): Promise<DataRootCurrent>
    pickAndMigrate(): Promise<DataRootMigrateResult>
    relaunch(): Promise<void>
    openFolder(): Promise<void>
    pendingCleanup(): Promise<DataRootPendingCleanup | null>
    deleteOld(): Promise<void>
    dismissCleanup(): Promise<void>
  }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  /// Broadcast an event to every app window (delivered to `on()` subscribers as
  /// `evt:<event>`). Backs the renderer's cross-window `emit()` (bridge/events.ts).
  emit(event: string, payload?: unknown): Promise<void>
  /// Asks main for the native sink's frame port; it arrives as a window
  /// message (`openVideoSinkPort` in the renderer).
  videoSinkPort(): Promise<void>
}
