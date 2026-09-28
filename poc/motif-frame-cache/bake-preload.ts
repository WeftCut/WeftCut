import { contextBridge, ipcRenderer, sharedTexture, type SharedTextureImported } from 'electron';
import { installMotifFrames } from '../../apps/desktop/src/preload/motifFrames';

// Use the production MessagePort receiver and the production completion barrier.
const imports = new Map<string, SharedTextureImported>();
const announced: string[] = [];
ipcRenderer.on('evt:previewGpu:slot', (_event, { streamId }) => announced.push(streamId));
ipcRenderer.on('evt:motifGpu:close', (_event, { key }) => {
  imports.get(key)?.release(); imports.delete(key);
});
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  const key = announced.shift();
  if (!key) throw new Error('Unannounced benchmark texture');
  imports.set(key, importedSharedTexture);
});
const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
installMotifFrames(key => imports.get(key), bitmap => {
  ctx.drawImage(bitmap, 0, 0, 1, 1); ctx.getImageData(0, 0, 1, 1); return true;
});
contextBridge.exposeInMainWorld('bench', {
  invoke: (name: string, args: unknown) => ipcRenderer.invoke(`bench:${name}`, args),
});
