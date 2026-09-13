const { app, BrowserWindow, desktopCapturer, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
let origin, overlays = [], fixtures = [], active = false, settles = 0, fixtureClicks = 0;
let timer, result, captures = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function windowFor(mode, bounds) {
  const w = new BrowserWindow({ ...(bounds || { width: 620, height: 400 }),
    show: false, frame: mode === 'controller', resizable: false,
    skipTaskbar: mode !== 'controller', thickFrame: false,
    transparent: mode !== 'controller', backgroundColor: mode === 'controller' ? '#18202b' : '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  if (bounds) w.setBounds(bounds);
  return w;
}
async function load(w, mode, data) {
  captures.set(w.webContents.id, data || {});
  await w.loadFile(path.join(__dirname, 'page.html'), { query: { mode } });
  await w.webContents.executeJavaScript('window.readyPromise');
  await w.webContents.executeJavaScript(`document.title = ${JSON.stringify('WeftCut colorpick probe ' + mode + ' ' + w.id)}`);
}
function finish(value) {
  if (!active) return;
  active = false; result = value; settles++;
  clearTimeout(timer);
  for (const w of overlays) { captures.delete(w.webContents.id); w.destroy(); }
  overlays = [];
  origin.show(); origin.focus();
  origin.webContents.send('result', value);
}
ipcMain.handle('data', e => captures.get(e.sender.id));
ipcMain.handle('start', e => e.sender === origin.webContents ? begin() : null);
ipcMain.on('finish', (e, value) => {
  if (overlays.some(w => w.webContents === e.sender)) finish(value);
});
ipcMain.on('fixture-click', () => fixtureClicks++);
async function begin() {
  if (active) finish(null);
  active = true;
  timer = setTimeout(() => finish(null), 30000);
  const metrics = [];
  try {
    const displays = screen.getAllDisplays();
    // Capture ALL displays before showing ANY overlay. Each request asks for
    // that display's physical resolution; do not trust the thumbnail default.
    const frozen = [];
    for (const d of displays) {
      const expected = { width: Math.round(d.bounds.width * d.scaleFactor),
        height: Math.round(d.bounds.height * d.scaleFactor) };
      const started = performance.now();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: expected });
      const source = sources.find(s => s.display_id === String(d.id));
      if (!source || source.thumbnail.isEmpty()) throw Error(`Missing display capture: ${d.id}`);
      const png = source.thumbnail.toPNG();
      const size = source.thumbnail.getSize();
      let checkerMismatches = null;
      const fixture = fixtures.find(f => f.display.id === d.id);
      if (fixture) {
        // BGRA bitmap is sampled at the fixture's known 1-physical-pixel
        // black/white checker, away from titlebars, taskbar and color swatches.
        const bytes = source.thumbnail.toBitmap();
        const b = fixture.win.getContentBounds();
        const x0 = Math.round((b.x - d.bounds.x) * d.scaleFactor);
        const y0 = Math.round((b.y - d.bounds.y) * d.scaleFactor);
        checkerMismatches = 0;
        for (let y = 240; y < 304; y++) for (let x = 240; x < 304; x++) {
          const i = ((y0 + y) * size.width + x0 + x) * 4;
          const want = (x + y) % 2 ? 255 : 0;
          if ([bytes[i], bytes[i + 1], bytes[i + 2]].some(v => v !== want)) checkerMismatches++;
        }
      }
      metrics.push({ displayId: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor,
        expected, actual: size, nativeSize: size.width === expected.width && size.height === expected.height,
        checkerMismatches, captureMs: Math.round(performance.now() - started) });
      frozen.push({ display: d, png: png.toString('base64'), size });
    }
    for (const f of frozen) {
      const w = windowFor('overlay', f.display.bounds);
      overlays.push(w);
      await load(w, 'overlay', { png: f.png, displayId: f.display.id, bounds: f.display.bounds });
      w.setAlwaysOnTop(true, 'screen-saver');
    }
    for (const w of overlays) w.show();
    overlays[0]?.focus();
    return metrics;
  } catch (error) { finish(null); throw error; }
}
app.whenReady().then(async () => {
  origin = windowFor('controller');
  await load(origin, 'controller');
  origin.show();
  origin.on('closed', () => app.quit());
  globalThis.probe = {
    environment: () => ({ versions: process.versions, platform: process.platform,
      displays: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds,
        scaleFactor: d.scaleFactor, rotation: d.rotation, colorSpace: d.colorSpace })) }),
    fixtures: async () => {
      for (const display of screen.getAllDisplays()) {
        const win = windowFor('fixture', display.bounds);
        fixtures.push({ win, display });
        await load(win, 'fixture');
        win.setAlwaysOnTop(true, 'pop-up-menu'); win.show();
      }
      await delay(500);
    },
    removeFixtures: () => {
      for (const f of fixtures) { captures.delete(f.win.webContents.id); f.win.destroy(); }
      fixtures = []; origin.show(); origin.focus();
    },
    begin,
    overlayEvidence: async () => {
      const saved = [];
      for (const d of screen.getAllDisplays()) {
        const sources = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{
          width:Math.round(d.bounds.width*d.scaleFactor),height:Math.round(d.bounds.height*d.scaleFactor)}});
        const source=sources.find(s=>s.display_id===String(d.id));
        const file=path.join(out,`desktop-overlay-${d.id}.png`);
        fs.writeFileSync(file,source.thumbnail.toPNG());
        saved.push({displayId:d.id,file,size:source.thumbnail.getSize()});
      }
      return saved;
    },
    state: () => ({ result, settles, overlayCount: overlays.length, fixtureClicks,
      originFocused: origin.isFocused() }),
  };
});
app.on('window-all-closed', () => app.quit());
