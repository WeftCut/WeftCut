import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron'
import { installMotifFrames } from './motifFrames'
import { MotifReadBarrier } from './motifReadBarrier'
import { createDecodeSessionPorts } from './decodeSessionPorts'
import { createSlotReader } from './slotReader'
import { createReadCompletionProof } from '../shared/readCompletion'
import { readLayoutThemeArgument } from '../shared/layout-theme'
import { readMotifTuningArgument } from '../shared/motifs/tuning'
import type {
  WeftcutApi,
  AppNotice,
  AppVersions,
  DecodeCapabilityProbeResult,
  DecodeComponentStatus,
  DecodeHwProbeResult,
  DialogOpenOpts,
  DialogSaveOpts,
  DirEntry,
  MotifColdStartResult,
  NotificationOpts,
  PreviewGpuBudgetSnapshot,
  PreviewGpuMainTiming,
  PreviewGpuOpenReply,
  PreviewGpuTimingReport,
  SystemStats,
  WinCreateOpts,
  WinAction,
} from '../shared/ipc'
import type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
} from '../shared/data-root'
import type { MenuProjection } from '../shared/menu'
import type { UpdateDownloadResult, UpdateRestartResult, UpdateResume, UpdateStatus } from '../shared/updates'
import type { DecodeWireMsg, ExportDecodeOpenInfo, PreviewDecodeOpenInfo } from '../shared/frameCarrier/wire'

type Listener = (payload: unknown) => void

// Every shared texture main sends lands here, in the isolated world, the only
// one that can receive them. GPU preview sessions and Motif pools both read
// their slots through this one reader (slotReader.ts).
const slotReader = createSlotReader()
sharedTexture.setSharedTextureReceiver(async (data, tag: unknown) => {
  slotReader.receive(data.importedSharedTexture, tag)
})
window.addEventListener('pagehide', () => slotReader.close())
ipcRenderer.on('evt:motifGpu:close', (_e, { key }: { key: string }) => slotReader.drop(key))

// Decode sessions served on a port this preload holds (decodeSessionPorts.ts).
// A port cannot cross contextBridge, so the consumer's end reaches the page as
// a window message tagged with its session id (renderer/ipc/decodeSession.ts).
const decodeSessionPorts = createDecodeSessionPorts(
  (sessionId, cmd) => ipcRenderer.send('decodeSession:cmd', sessionId, cmd),
  sessionId => ipcRenderer.invoke('decodeSession:close', sessionId) as Promise<void>,
  (sessionId, port) => window.postMessage({ weftcutDecodeSessionPort: sessionId }, '*', [port]),
  slotReader,
)
ipcRenderer.on('decodeSession:msg', (_e, sessionId: string, msg: DecodeWireMsg) => decodeSessionPorts.deliver(sessionId, msg))
ipcRenderer.on('decodeSession:end', (_e, sessionId: string) => decodeSessionPorts.end(sessionId))
const closeDecodeSession = (sessionId: string): void => {
  void decodeSessionPorts.close(sessionId).catch((error: unknown) => console.warn('[preload] decode session close failed', error))
}

// Motif's GPU reads: the slot reader takes the texture's bitmap, and the read
// barrier proves the GPU ran the copy before main may reuse the slot. The
// one-pixel proof stands in when the barrier's worker cannot start.
const proveReadComplete = createReadCompletionProof()
const motifReadBarrier = new MotifReadBarrier(bitmap => proveReadComplete(bitmap) !== null)
installMotifFrames(
  key => slotReader.read(key, 0).then(read => read.bitmap),
  bitmap => motifReadBarrier.complete(bitmap),
)

// The contextBridge surface — the COMPLETE set of things the (untrusted)
// renderer can ask the main process to do. Grouped, named methods rather than a
// generic `invoke(channel)` passthrough: a compromised renderer can only reach
// these specific operations, and the IPC surface is auditable at a glance
// (Electron security guidance: expose APIs, not channels). The one generic
// channel is `backend.invoke`, which fronts the napi/Rust command dispatcher —
// a single controlled capability that validates its own commands.
const api: WeftcutApi = {
  diagnostics: {
    summary: () => ipcRenderer.invoke('diagnostics:summary'),
    exportBundle: () => ipcRenderer.invoke('diagnostics:export'),
    dismissPrevious: () => ipcRenderer.invoke('diagnostics:dismiss'),
    recordError: message => ipcRenderer.send('diagnostics:error', message),
  },
  resources: {
    planExport: request => ipcRenderer.invoke('resources:plan-export', request),
    estimateDecoder: path => ipcRenderer.invoke('resources:estimate-decoder', path),
    onExportWaiting: cb => {
      const listener = (_event: Electron.IpcRendererEvent, value: import('../shared/export-resources').ExportResourceBlock & { id: string }) => cb(value);
      ipcRenderer.on('resources:export-waiting', listener);
      return () => { ipcRenderer.removeListener('resources:export-waiting', listener); };
    },
    acquire: request => ipcRenderer.invoke('resources:acquire', request),
    release: id => ipcRenderer.send('resources:release', id),
    playing: value => ipcRenderer.send('resources:playing', value),
    status: () => ipcRenderer.invoke('resources:status'),
  },
  performanceResources: {
    info: refresh => ipcRenderer.invoke('performanceResources:info', refresh),
    probe: () => ipcRenderer.invoke('performanceResources:probe'),
  },
  performanceCalibration: {
    status: () => ipcRenderer.invoke('performanceCalibration:status'),
    start: () => ipcRenderer.invoke('performanceCalibration:start'),
    cancel: () => ipcRenderer.invoke('performanceCalibration:cancel'),
  },
  colorPick: {
    start: request => ipcRenderer.invoke('colorpick:start', request),
    cancel: id => ipcRenderer.invoke('colorpick:cancel', id),
    onHover: callback => {
      const listener = (_e: Electron.IpcRendererEvent, event: import('../shared/screenPick').ScreenPickHover): void => callback(event)
      ipcRenderer.on('colorpick:hover', listener)
      return () => ipcRenderer.removeListener('colorpick:hover', listener)
    },
  },
  backend: {
    invoke(channel: string, args?: unknown): Promise<unknown> {
      return ipcRenderer.invoke('backend:invoke', { channel, args })
    },
    invokePublished(channel: string, args?: unknown) {
      return ipcRenderer.invoke('backend:invokePublished', { channel, args })
    },
  },

  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:writeFile', { path, data, append }) as Promise<void>
    },
    writeTextFile(path: string, data: string): Promise<void> {
      return ipcRenderer.invoke('fs:writeTextFile', { path, data }) as Promise<void>
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:mkdir', { path, recursive }) as Promise<void>
    },
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
      return ipcRenderer.invoke('fs:readFile', { path }) as Promise<Uint8Array<ArrayBuffer>>
    },
    remove(path: string): Promise<void> {
      return ipcRenderer.invoke('fs:remove', { path }) as Promise<void>
    },
    exists(path: string): Promise<boolean> {
      return ipcRenderer.invoke('fs:exists', { path }) as Promise<boolean>
    },
    readDir(path: string): Promise<DirEntry[]> {
      return ipcRenderer.invoke('fs:readDir', { path }) as Promise<DirEntry[]>
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize') as Promise<void>,
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize') as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke('window:close') as Promise<void>,
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    isFocused: (): Promise<boolean> => ipcRenderer.invoke('window:isFocused') as Promise<boolean>,
    setProgressBar: (bar: { status: string; progress?: number }): Promise<void> => ipcRenderer.invoke('window:setProgressBar', bar) as Promise<void>,
    setTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:setTitle', title) as Promise<void>,
    captureSnapshot: (): Promise<Uint8Array<ArrayBuffer>> =>
      ipcRenderer.invoke('window:captureSnapshot') as Promise<Uint8Array<ArrayBuffer>>,
    focus: (): Promise<void> => ipcRenderer.invoke('window:focus') as Promise<void>,
  },

  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null> {
      return ipcRenderer.invoke('dialog:open', opts) as Promise<string | string[] | null>
    },
    save(opts: DialogSaveOpts): Promise<string | null> {
      return ipcRenderer.invoke('dialog:save', opts) as Promise<string | null>
    },
  },

  path: {
    documentDir: (): Promise<string> => ipcRenderer.invoke('path:documentDir') as Promise<string>,
    join: (parts: string[]): Promise<string> => ipcRenderer.invoke('path:join', { parts }) as Promise<string>,
    tempDir: (): Promise<string> => ipcRenderer.invoke('path:tempDir') as Promise<string>,
  },

  mcp: {
    getInfo: (): Promise<unknown> => ipcRenderer.invoke('get_mcp_info'),
    resetToken: (): Promise<unknown> => ipcRenderer.invoke('reset_mcp_token'),
    reinstallSkills: (): Promise<unknown> => ipcRenderer.invoke('reinstall_skills'),
  },

  win: {
    create: (label: string, options?: WinCreateOpts): Promise<void> =>
      ipcRenderer.invoke('win:create', { label, options }) as Promise<void>,
    act: (label: string, action: WinAction): Promise<void> =>
      ipcRenderer.invoke('win:act', { label, action }) as Promise<void>,
    exists: (label: string): Promise<boolean> => ipcRenderer.invoke('win:exists', { label }) as Promise<boolean>,
  },

  media: {
    dropped: (paths: string[]): Promise<void> => ipcRenderer.invoke('media:dropped', paths) as Promise<void>,
  },

  app: {
    notices: (): Promise<AppNotice[]> => ipcRenderer.invoke('app:notices') as Promise<AppNotice[]>,
    versions: (): Promise<AppVersions> => ipcRenderer.invoke('app:versions') as Promise<AppVersions>,
    launchLayoutTheme: readLayoutThemeArgument(process.argv),
    motifTuning: readMotifTuningArgument(process.argv),
  },

  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
    download: (): Promise<UpdateDownloadResult> => ipcRenderer.invoke('updates:download'),
    restart: (): Promise<UpdateRestartResult> => ipcRenderer.invoke('updates:restart'),
    resume: (): Promise<UpdateResume> => ipcRenderer.invoke('updates:resume'),
  },

  dev: {
    motifColdStart: (dir: string): Promise<MotifColdStartResult> => ipcRenderer.invoke('dev:motifColdStart', dir),
  },

  menu: {
    // Push what this renderer surface can currently run into the macOS
    // application menu; main rebuilds from it. Off macOS main ignores the call
    // (there is no application menu there — see src/main/appMenu.ts).
    sync: (projection: MenuProjection): Promise<void> =>
      ipcRenderer.invoke('menu:sync', projection) as Promise<void>,
  },

  // OS shell + desktop notification — native main-process concerns, handled by
  // Electron directly (no Rust round-trip; the Rust dispatcher owns project
  // state, not the OS shell).
  shell: {
    open: (target: string): Promise<void> => ipcRenderer.invoke('shell:open', { target }) as Promise<void>,
    reveal: (target: string): Promise<void> => ipcRenderer.invoke('shell:reveal', { target }) as Promise<void>,
  },
  notification: {
    send: (opts: NotificationOpts): Promise<void> => ipcRenderer.invoke('notification:send', opts) as Promise<void>,
  },
  metrics: {
    get: (): Promise<SystemStats> => ipcRenderer.invoke('app:metrics') as Promise<SystemStats>,
  },
  font: {
    index: () => ipcRenderer.invoke('font:index'),
    onIndex: cb => {
      const listener = (_e: Electron.IpcRendererEvent, index: import('../shared/fonts/types').FontIndex): void => cb(index)
      ipcRenderer.on('evt:fonts:index', listener)
      return () => { ipcRenderer.removeListener('evt:fonts:index', listener) }
    },
    bytes: (sha256: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke('font:bytes', { sha256 }) as Promise<Uint8Array | null>,
    listFamilies: (): Promise<string[]> => ipcRenderer.invoke('font:listFamilies') as Promise<string[]>,
  },
  projectFonts: {
    view: () => ipcRenderer.invoke('project-fonts:view'),
    exclude: (family: string) => ipcRenderer.invoke('project-fonts:exclude', { family }),
    allow: (family: string) => ipcRenderer.invoke('project-fonts:allow', { family }),
    onChanged: cb => {
      const listener = (): void => cb()
      ipcRenderer.on('evt:project-fonts:changed', listener)
      return () => { ipcRenderer.removeListener('evt:project-fonts:changed', listener) }
    },
    onProgress: cb => {
      const listener = (_e: Electron.IpcRendererEvent, progress: import('../shared/fonts/types').FontCopyProgress | null): void => cb(progress)
      ipcRenderer.on('evt:project-fonts:progress', listener)
      return () => { ipcRenderer.removeListener('evt:project-fonts:progress', listener) }
    },
  },

  // Event subscription: main relays core events via webContents.send →
  // `evt:<event>` → here.
  on(event: string, cb: Listener): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(`evt:${event}`, handler)
    return () => ipcRenderer.removeListener(`evt:${event}`, handler)
  },
  off(event: string): void {
    ipcRenderer.removeAllListeners(`evt:${event}`)
  },

  // Cross-window broadcast: forward an event to main, which re-sends it as
  // `evt:<event>` to every window (delivered above via `on()`).
  emit(event: string, payload?: unknown): Promise<void> {
    return ipcRenderer.invoke('app:emit', { event, payload }) as Promise<void>
  },

  // The native video sink's frame port. A port cannot cross contextBridge, so
  // it reaches the page as a window message (`openVideoSinkPort`).
  videoSinkPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onPort = (event: Electron.IpcRendererEvent) => {
        window.postMessage({ weftcutVideoSinkPort: true }, '*', event.ports)
        resolve()
      }
      ipcRenderer.once('export:videosink_port', onPort)
      ipcRenderer.invoke('export:videosink_port').catch((error: unknown) => {
        ipcRenderer.removeListener('export:videosink_port', onPort)
        reject(error)
      })
    })
  },

  // Native GPU-decode preview (Windows): a decode session like the two below,
  // whose `slot` messages this preload reads into bitmaps before posting them
  // on (decodeSessionPorts.ts).
  previewGpu: {
    open(args: Parameters<WeftcutApi['previewGpu']['open']>[0]): Promise<PreviewGpuOpenReply> {
      return decodeSessionPorts.openSession(args.sessionId, () => ipcRenderer.invoke('previewGpu:open', args) as Promise<PreviewGpuOpenReply>)
    },
    close(args: { sessionId: string }): Promise<void> {
      return decodeSessionPorts.close(args.sessionId)
    },
    budget(): Promise<PreviewGpuBudgetSnapshot> {
      return ipcRenderer.invoke('previewGpu:budget') as Promise<PreviewGpuBudgetSnapshot>
    },
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport> {
      return ipcRenderer.invoke('previewGpu:takeTimings', { streamId }) as Promise<PreviewGpuTimingReport>
    },
    takeMainTimings(): Promise<PreviewGpuMainTiming> {
      return ipcRenderer.invoke('previewGpu:takeMainTimings') as Promise<PreviewGpuMainTiming>
    },
  },

  // Native decode sessions (preview and export); each one's port reaches the
  // page as a window message (`openDecodeSession` in the renderer).
  previewDecode: {
    open(args: Parameters<WeftcutApi['previewDecode']['open']>[0]): Promise<PreviewDecodeOpenInfo> {
      return decodeSessionPorts.openSession(args.sessionId, () => ipcRenderer.invoke('previewDecode:open', args) as Promise<PreviewDecodeOpenInfo>)
    },
    close(args: { sessionId: string }): void {
      closeDecodeSession(args.sessionId)
    },
  },
  exportDecode: {
    open(args: Parameters<WeftcutApi['exportDecode']['open']>[0]): Promise<ExportDecodeOpenInfo> {
      return decodeSessionPorts.openSession(args.sessionId, () => ipcRenderer.invoke('exportDecode:open', args) as Promise<ExportDecodeOpenInfo>)
    },
    close(args: { sessionId: string }): void {
      closeDecodeSession(args.sessionId)
    },
  },

  // Availability of the optional native-decode component (level-0 gate). Pulled
  // once on mount by the renderer's decodeComponentStore.
  decodeComponent: {
    status: () => ipcRenderer.invoke('decodeComponent:status') as Promise<DecodeComponentStatus>,
  },

  // Machine capability probe: runs the SW decode probe + consults the
  // per-machine capability cache for the probed file's format class.
  // probeHw is the GPU-keyed HW-lane counterpart — caller supplies the
  // classKey (the renderer derives it from MediaSummary).
  decodeCap: {
    probeSw: (path: string) =>
      ipcRenderer.invoke('decodeCap:probeSw', { path }) as Promise<DecodeCapabilityProbeResult>,
    probeHw: (path: string, classKey: string) =>
      ipcRenderer.invoke('decodeCap:probeHw', { path, classKey }) as Promise<DecodeHwProbeResult>,
  },

  // User-managed data location. Plain main-process actions; the copy
  // migration's progress arrives out-of-band on `evt:dataRoot:progress` (subscribe
  // via the generic `on()` above), not as a return value.
  dataRoot: {
    current: (): Promise<DataRootCurrent> => ipcRenderer.invoke('dataRoot:current') as Promise<DataRootCurrent>,
    pickAndMigrate: (): Promise<DataRootMigrateResult> =>
      ipcRenderer.invoke('dataRoot:pickAndMigrate') as Promise<DataRootMigrateResult>,
    relaunch: (): Promise<void> => ipcRenderer.invoke('dataRoot:relaunch') as Promise<void>,
    openFolder: (): Promise<void> => ipcRenderer.invoke('dataRoot:openFolder') as Promise<void>,
    pendingCleanup: (): Promise<DataRootPendingCleanup | null> =>
      ipcRenderer.invoke('dataRoot:pendingCleanup') as Promise<DataRootPendingCleanup | null>,
    deleteOld: (): Promise<void> => ipcRenderer.invoke('dataRoot:deleteOld') as Promise<void>,
    dismissCleanup: (): Promise<void> => ipcRenderer.invoke('dataRoot:dismissCleanup') as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('api', api)

// Resolve drag-drop file paths in the preload's own drop listener.
// Background: in Electron 30+, a File passed across the contextBridge loses its
// disk-backing, so webUtils.getPathForFile() returns '' when called from the
// renderer side (electron/electron#44600). The fix is to intercept drop events
// here in the preload where the File objects are still native-backed.
function wireFileDrop(): void {
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    if (!(e.target instanceof Element && e.target.closest('.media-pool'))) return
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .flatMap((f) => {
        try {
          const path = webUtils.getPathForFile(f)
          return path.length > 0 ? [path] : []
        } catch {
          return []
        }
      })
    if (paths.length > 0) void ipcRenderer.invoke('media:dropped', paths)
  })
}
wireFileDrop()

// Frameless-window drag regions. The renderer marks its titlebars with the
// `data-drag-region` attribute; Electron doesn't treat it as draggable on its
// own — it uses the CSS `-webkit-app-region` property. Bridge the two by
// injecting a stylesheet
// (interactive descendants get `no-drag` so window controls / buttons stay
// clickable).
//
// LANDMINE for the third rule: a drag region is a list of rects the browser
// process hands to the OS, which claims mousedown BEFORE the renderer sees it.
// Only `no-drag` subtracts from that list — painting on top does NOT, however
// high the z-index. Portaled popups are not descendants of any titlebar, so the
// rule above never reaches them, and a popup tall enough to overlap a caption
// bar (a clamped `.settings-panel` starts 10px into it) would go dead along its
// top edge: the ✕ unclickable, the drag stealing the click. Hence the explicit
// opt-out, covering every popup Base UI portals — Dialog and Popover render
// role="dialog", Menu role="menu", Select role="listbox". The backdrop is
// deliberately NOT listed: it spans the viewport, so exempting it would kill
// window dragging outright whenever a modal is open.
function injectDragRegionStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    [data-drag-region] { -webkit-app-region: drag; }
    [data-drag-region] :where(button, a, input, select, textarea, [role="button"], [contenteditable]) { -webkit-app-region: no-drag; }
    :where([role="dialog"], [role="menu"], [role="listbox"]) { -webkit-app-region: no-drag; }
  `
  document.head.appendChild(style)
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDragRegionStyles)
} else {
  injectDragRegionStyles()
}
