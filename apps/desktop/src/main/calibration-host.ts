// Developer prototype entry. No normal project backend, imports, jobs, or persisted settings.
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadNativeDecodeWith } from './native-decode';
import { installPreviewGpuIpc } from './previewGpuIpc';
import { previewGpuDevices, hwBudget } from './previewGpu';
import { recordFrameReadySent } from './previewGpuTiming';
import { hydratePerformanceSettings } from '../shared/performance-settings';
import { PLAYBACK_CALIBRATION } from '../shared/playback-calibration';

if (!process.env.WEFTCUT_CALIBRATION_INPUT) throw new Error('Use the calibration runner');
if (process.platform !== 'win32') throw new Error('The first controlled-host prototype requires Windows D3D11VA');
const input = JSON.parse(fs.readFileSync(process.env.WEFTCUT_CALIBRATION_INPUT, 'utf8'));
if (JSON.stringify(input.protocol) !== JSON.stringify(PLAYBACK_CALIBRATION)) {
  throw new Error('Calibration build is stale: rebuild the E2E entries');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
hydratePerformanceSettings(PLAYBACK_CALIBRATION.performance);
let win: BrowserWindow | null = null;
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(async () => {
  const require_ = createRequire(import.meta.url);
  const component = loadNativeDecodeWith(() => require_('@weftcut/native-decode'), (_error, json) => {
    const { event, payload } = JSON.parse(json);
    if (event === 'previewGpu:frameReady') recordFrameReadySent(payload.streamId, payload.slot, performance.now());
    if (win && !win.isDestroyed()) win.webContents.send(`evt:${event}`, payload);
  }, app.isPackaged ? path.join(process.resourcesPath, 'native-decode')
    : path.resolve(import.meta.dirname, '../../resources/ffmpeg-lgpl/win/bin'));
  const backend = () => {
    if (!component.backend) throw new Error(component.reason ?? 'Native decode unavailable');
    return component.backend;
  };
  installPreviewGpuIpc(backend, () => win);
  // Fresh per-process probe, reused only within this run. Never read capability history.
  let probe: ReturnType<ReturnType<typeof backend>['previewGpuProbe']> | undefined;
  ipcMain.handle('decodeCap:probeHw', (_e, args: { path: string }) => {
    if (args.path !== input.fixture.path) throw new Error('Unexpected calibration media');
    probe ??= backend().previewGpuProbe(args.path, 4000);
    return { ...probe, lane: probe.ok ? 'd3d11va' : null, device: null };
  });
  ipcMain.handle('backend:invoke', (_e, { channel, args }: { channel: string; args?: unknown }) => {
    if (channel === 'calibration_publish') {
      const output = process.env.WEFTCUT_CALIBRATION_OUTPUT;
      if (output) {
        fs.writeFileSync(output + '.tmp', JSON.stringify(args));
        fs.renameSync(output + '.tmp', output);
        const state = (args as { state?: string })?.state;
        if (state === 'complete' || state === 'error') setTimeout(() => app.quit(), 100);
      }
      return;
    }
    if (channel === 'calibration_input') return input;
    if (channel === 'calibration_devices') return previewGpuDevices();
    if (channel === 'calibration_state') return { budget: hwBudget(), devices: previewGpuDevices(), nativeVersion: component.version };
    if (channel === 'log_emit') return;
    throw new Error(`Unavailable in calibration: ${channel}`);
  });
  win = new BrowserWindow({ width: 1320, height: 830, show: true,
    webPreferences: { preload: path.join(import.meta.dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/calibration.html`);
  } else await win.loadFile(path.join(import.meta.dirname, '../renderer/calibration.html'));
});
