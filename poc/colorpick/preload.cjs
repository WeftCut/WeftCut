const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  data: () => ipcRenderer.invoke('data'),
  start: () => ipcRenderer.invoke('start'),
  finish: value => ipcRenderer.send('finish', value),
  fixtureClick: () => ipcRenderer.send('fixture-click'),
  onResult: cb => ipcRenderer.on('result', (_e, value) => cb(value)),
});
