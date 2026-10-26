// Electron MAIN for the preview-thread-split spike.
// One process = one (arm, streams) measurement. Results go to --out as JSON;
// console output is unreliable for a Windows GUI-subsystem process.
//   electron poc/preview-thread-split -- --arm=main --streams=2 --fixture=<path.mp4> --out=<file.json>
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const argv = Object.fromEntries(process.argv.filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v] }))
const arm = argv.arm || 'main'
const streams = Number(argv.streams || 1)
const warmup = Number(argv.warmup || 3)
const sample = Number(argv.sample || 15)
const hw = argv.hw || 'prefer-hardware'
const preference = argv.gpu || 'webgpu'
const fixture = path.resolve(argv.fixture || path.join(__dirname, '../../apps/desktop/e2e/fixtures/decode-bench/h264-2160.mp4'))
const out = path.resolve(argv.out || path.join(__dirname, `results/${arm}-${streams}.json`))

const result = { arm, streams, warmup, sample, hw, preference, fixture: path.basename(fixture), electron: process.versions.electron, chrome: process.versions.chrome, errors: [] }
function write() { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)) }

const killTimer = setTimeout(() => { result.errors.push(`TIMEOUT after ${warmup + sample + 60}s`); write(); app.exit(2) }, (warmup + sample + 60) * 1000)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1480, height: 960, show: true, backgroundColor: '#202020',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false },
  })
  ipcMain.on('poc-result', (_e, payload) => {
    Object.assign(result, payload)
    result.gpuFeatures = app.getGPUFeatureStatus()
    write(); clearTimeout(killTimer); app.exit(0)
  })
  ipcMain.on('poc-error', (_e, message) => { result.errors.push(String(message)); write() })
  result.console = []
  win.webContents.on('console-message', (_e, level, message, line, source) => { if (level >= 2) { result.console.push(`${source}:${line} ${message}`.slice(0, 400)); write() } })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { result.errors.push(`did-fail-load ${code} ${desc} ${url}`); write() })
  win.webContents.on('render-process-gone', (_e, d) => { result.errors.push(`renderer gone: ${d.reason}`); write(); app.exit(3) })
  const q = new URLSearchParams({ arm, streams: String(streams), warmup: String(warmup), sample: String(sample), hw, preference, fixture: pathToFileURL(fixture).href })
  win.loadFile(path.join(__dirname, 'index.html'), { search: q.toString() })
})
