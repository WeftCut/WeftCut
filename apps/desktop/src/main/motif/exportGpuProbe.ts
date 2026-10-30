import { BrowserWindow, type WebContents } from 'electron';
import { OffscreenFrames } from './offscreenFrames';
import { probeDirectMotifTexture, probeMotifPngDelivery } from './directGpuTransport';
import { reserveResources } from '../resources';
import type { ProbeSamples } from './gpuSelector';
import { hardenWindow, markInternalWindow } from '../windows';

/** Independent synthetic document: no user Motif, media, timeline or disk cache
 * is mutated. Full-resolution verification is paid once per selector session. */
export async function runExportGpuProbe(owner: WebContents, parent?: number): Promise<ProbeSamples> {
  const width = 1920, height = 1080;
  const release = reserveResources(0, 256, parent);
  let source: BrowserWindow | undefined, frames: OffscreenFrames | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    source = new BrowserWindow({ show: false, width, height, useContentSize: true, transparent: true,
      webPreferences: { offscreen: { useSharedTexture: true }, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const win = source;
    markInternalWindow(win); hardenWindow(win, { allowExternalOpen: false });
    frames = new OffscreenFrames(win.webContents);
    const surfaces = frames;
    const work = async (): Promise<ProbeSamples> => {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><style>body{margin:0;background:transparent}#label{position:absolute;left:50px;top:40px;color:#fff;font:48px sans-serif;text-shadow:2px 3px 9px #0009}#card{position:absolute;left:60px;top:140px;width:800px;height:340px;border-radius:45px;background:linear-gradient(25deg,#0cf8,#fa08);filter:drop-shadow(10px 10px 12px #0008)}</style><canvas width="1920" height="1080"></canvas><div id="label">GPU 123 · Aa</div><div id="card"></div><script>const gl=document.querySelector('canvas').getContext('webgl2',{alpha:true,preserveDrawingBuffer:true});window.draw=n=>{if(!gl)throw Error('WebGL2 unavailable');gl.clearColor(.08+n*.005,.18,.3,.6);gl.clear(gl.COLOR_BUFFER_BIT);document.getElementById('card').style.left=(60+n*3)+'px';return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}</script></html>`));
      win.webContents.debugger.attach('1.3');
      const renderer = await win.webContents.executeJavaScript(`(()=>{const e=gl?.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):''})()`);
      if (!renderer || /swiftshader|llvmpipe|software/i.test(renderer)) throw new Error('Hardware WebGL renderer unavailable');
      const send = (method: string, params?: Record<string, unknown>) => win.webContents.debugger.sendCommand(method, params);
      win.setContentSize(width, height);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const screenshot = async (): Promise<string> => (await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data;
      const draw = async (index: number) => { surfaces.prepare(); await win.webContents.executeJavaScript(`window.draw(${index % 6})`); };
      const gpu = async (reference?: string) => {
        const texture = await surfaces.capture(width, height, screenshot);
        try { return await probeDirectMotifTexture(owner, texture, parent, reference); }
        finally { texture.release(); }
      };
      // Multiple exact frames include changing pixels, alpha and text edges.
      for (let i = 0; i < 3; i++) {
        await draw(i);
        const reference = await screenshot();
        if (!await gpu(reference)) return { quality: false, gpu: [], png: [] };
      }
      const samples: ProbeSamples = { quality: true, gpu: [], png: [] };
      for (let i = 0; i < 9; i++) {
        await draw(i);
        for (const mode of i % 2 ? ['png', 'gpu'] as const : ['gpu', 'png'] as const) {
          const start = performance.now();
          if (mode === 'gpu') await gpu();
          else await probeMotifPngDelivery(owner, await screenshot());
          if (i >= 2) samples[mode].push(performance.now() - start);
        }
      }
      return samples;
    };
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GPU transport probe timed out')), 12000);
    })]);
  } catch (error) {
    // The probe contains only our synthetic document. Keep a bounded reason in
    // local diagnostics so a timeout is not mistaken for unsupported hardware.
    console.warn('[motif GPU probe]', String(error).slice(0, 300));
    throw error;
  } finally {
    clearTimeout(timer); frames?.dispose(); if (source && !source.isDestroyed()) source.destroy(); release();
  }
}
