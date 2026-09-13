import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { hardenWindow, markInternalWindow, userFacingWindows } from './windows';
import type { ScreenPickReply, ScreenPickRequest, ScreenPickSnapshot } from '../shared/screenPick';

interface Overlay {
  win: BrowserWindow;
  snapshot: ScreenPickSnapshot;
  ready(): void;
}
interface Session {
  id: string;
  owner: BrowserWindow;
  overlays: Overlay[];
  shown: boolean;
  finish(reply: ScreenPickReply, focus?: boolean): void;
  cleanups: Array<() => void>;
}

/** One process-wide session. Sender identity is checked on every IPC operation. */
export function registerScreenPick(): void {
  let current: Session | null = null;
  const alive = (s: Session): boolean => current === s && !s.owner.isDestroyed();
  const ownedOverlay = (sender: WebContents): Overlay | undefined =>
    current?.overlays.find(o => !o.win.isDestroyed() && o.win.webContents === sender);
  const mainFrame = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.senderFrame === e.sender.mainFrame;
  const validHex = (hex: unknown): hex is string => typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex);

  async function prepare(s: Session, hint: string): Promise<void> {
    // Wayland does not offer the global positioning/stacking this UI needs.
    // Keep in-app sampling available and report the capability honestly.
    const ozone = app.commandLine.getSwitchValue('ozone-platform');
    if (process.platform === 'linux' && (ozone === 'wayland' ||
      (ozone !== 'x11' && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')))) {
      s.finish({ kind: 'error', reason: 'unsupported' }); return;
    }
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      s.finish({ kind: 'error', reason: 'permission' }); return;
    }
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error('No displays');
    const frames: Array<{ display: Electron.Display; snapshot: ScreenPickSnapshot }> = [];
    for (const display of displays) {
      // Each display needs its own request. Using the largest display's size
      // for all sources UPSCALES smaller screenshots; even +2 extra pixels
      // resamples a single screen. This is a capture request, not a minimum.
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      } });
      if (!alive(s)) return;
      const source = sources.find(source => source.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('Missing display capture');
      const size = source.thumbnail.getSize();
      const tolerance = Math.ceil(display.scaleFactor) + 1;
      if (Math.abs(size.width - display.bounds.width * display.scaleFactor) > tolerance ||
        Math.abs(size.height - display.bounds.height * display.scaleFactor) > tolerance) {
        throw new Error('Display capture is not native resolution');
      }
      frames.push({ display, snapshot: { png: new Uint8Array(source.thumbnail.toPNG()), width: size.width,
        height: size.height, scaleFactor: display.scaleFactor, hint } });
    }
    // ALL captures precede ANY overlay display: neither the magnifier nor an
    // earlier display's overlay can contaminate another frozen sample buffer.
    const loaded: Promise<void>[] = [];
    for (const { display, snapshot } of frames) {
      if (!alive(s)) return;
      const win = new BrowserWindow({ ...display.bounds, show: false, frame: false,
        transparent: true, thickFrame: false, resizable: false, movable: false,
        skipTaskbar: true, hasShadow: false, roundedCorners: false,
        backgroundColor: '#00000000', fullscreenable: false,
        webPreferences: { preload: path.join(import.meta.dirname, '../preload/screenPick.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
          backgroundThrottling: false },
      });
      markInternalWindow(win); // must happen before the first await
      hardenWindow(win, { allowExternalOpen: false });
      win.setMenu(null);
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, 'screen-saver');
      let ready!: () => void;
      const initialized = new Promise<void>(resolve => { ready = resolve; });
      s.overlays.push({ win, snapshot, ready });
      s.cleanups.push(ready); // release pending ready promises on cancellation
      win.once('closed', () => { if (alive(s)) s.finish({ kind: 'cancelled' }); });
      win.webContents.once('render-process-gone', () => s.finish({ kind: 'error', reason: 'capture' }));
      win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') { event.preventDefault(); s.finish({ kind: 'cancelled' }); }
      });
      // Crossing to another overlay is normal. Losing the entire session's
      // focus (e.g. Alt+Tab) cancels without stealing focus back from that app.
      win.on('blur', () => {
        const timer = setTimeout(() => {
          if (alive(s) && s.shown && !s.overlays.some(o => !o.win.isDestroyed() && o.win.isFocused()))
            s.finish({ kind: 'cancelled' }, false);
        }, 150);
        s.cleanups.push(() => clearTimeout(timer));
      });
      const dev = process.env.ELECTRON_RENDERER_URL;
      const load = dev ? win.loadURL(new URL('/screen-pick.html', dev).href)
        : win.loadFile(path.join(import.meta.dirname, '../renderer/screen-pick.html'));
      loaded.push(Promise.all([load, initialized]).then(() => {}));
    }
    await Promise.all(loaded);
    if (!alive(s)) return;
    s.shown = true;
    for (const o of s.overlays) o.win.showInactive();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const index = displays.findIndex(d => d.id === display.id);
    s.overlays[Math.max(0, index)]?.win.focus();
  }

  ipcMain.handle('colorpick:start', (e, request: ScreenPickRequest): Promise<ScreenPickReply> | ScreenPickReply => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    if (!mainFrame(e) || !owner || !userFacingWindows().includes(owner) ||
      !request || typeof request.id !== 'string' || !request.id || request.id.length > 100 ||
      typeof request.hint !== 'string' || request.hint.length > 500) {
      return { kind: 'error', reason: 'capture' };
    }
    current?.finish({ kind: 'cancelled' }, false);
    return new Promise(resolve => {
      const s: Session = {
        id: request.id, owner, overlays: [], shown: false, cleanups: [],
        finish(reply, focus = true) {
          if (current !== s) return;
          current = null; // clear BEFORE destroy, whose events can re-enter
          for (const cleanup of s.cleanups) cleanup();
          for (const { win } of s.overlays) if (!win.isDestroyed()) win.destroy();
          s.overlays.length = 0;
          if (focus && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()) owner.focus();
          resolve(reply);
        },
      };
      current = s;
      const cancel = (): void => s.finish({ kind: 'cancelled' }, false);
      const ownerBlur = (): void => { if (!s.shown) cancel(); };
      const displayChanged = (): void => s.finish({ kind: 'cancelled' });
      owner.once('closed', cancel);
      owner.on('blur', ownerBlur);
      e.sender.once('render-process-gone', cancel);
      e.sender.once('did-start-navigation', cancel);
      screen.on('display-added', displayChanged);
      screen.on('display-removed', displayChanged);
      screen.on('display-metrics-changed', displayChanged);
      s.cleanups.push(() => {
        screen.removeListener('display-added', displayChanged);
        screen.removeListener('display-removed', displayChanged);
        screen.removeListener('display-metrics-changed', displayChanged);
      });
      s.cleanups.push(() => {
        owner.removeListener('closed', cancel);
        owner.removeListener('blur', ownerBlur);
        e.sender.removeListener('render-process-gone', cancel);
        e.sender.removeListener('did-start-navigation', cancel);
      });
      const timer = setTimeout(() => s.finish({ kind: 'error', reason: 'timeout' }), 120_000);
      s.cleanups.push(() => clearTimeout(timer));
      void prepare(s, request.hint).catch(error => {
        if (alive(s)) {
          console.warn('[colorpick] desktop capture failed:', error);
          s.finish({ kind: 'error', reason: 'capture' });
        }
      });
    });
  });
  ipcMain.handle('colorpick:cancel', (e, id: string) => {
    if (mainFrame(e) && current && current.id === id && current.owner.webContents === e.sender)
      current.finish({ kind: 'cancelled' });
  });
  ipcMain.handle('colorpick:snapshot', e => {
    const overlay = mainFrame(e) && ownedOverlay(e.sender);
    if (!overlay) throw new Error('No desktop pick session for sender');
    return overlay.snapshot;
  });
  ipcMain.on('colorpick:ready', e => { if (mainFrame(e)) ownedOverlay(e.sender)?.ready(); });
  ipcMain.on('colorpick:hover', (e, hex: unknown) => {
    if (mainFrame(e) && ownedOverlay(e.sender) && current && validHex(hex))
      current.owner.webContents.send('colorpick:hover', { id: current.id, hex: hex.toLowerCase() });
  });
  ipcMain.on('colorpick:finish', (e, hex: unknown) => {
    if (mainFrame(e) && ownedOverlay(e.sender) && (hex === null || validHex(hex)))
      current?.finish(hex === null ? { kind: 'cancelled' } : { kind: 'picked', hex: hex.toLowerCase() });
  });
  ipcMain.on('colorpick:failed', e => {
    if (mainFrame(e) && ownedOverlay(e.sender)) current?.finish({ kind: 'error', reason: 'capture' });
  });
  app.on('before-quit', () => current?.finish({ kind: 'cancelled' }, false));
}
