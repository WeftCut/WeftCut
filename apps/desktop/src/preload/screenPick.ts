import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenPickOverlayApi } from '../shared/screenPick';

const api: ScreenPickOverlayApi = {
  snapshot: () => ipcRenderer.invoke('colorpick:snapshot'),
  ready: () => ipcRenderer.send('colorpick:ready'),
  hover: hex => ipcRenderer.send('colorpick:hover', hex),
  finish: hex => ipcRenderer.send('colorpick:finish', hex),
  failed: () => ipcRenderer.send('colorpick:failed'),
};
contextBridge.exposeInMainWorld('screenPicker', api);
