// The editor and the isolated calibration host install the same GPU preview
// IPC. A session's commands and close travel the decode-session channels
// (frameCarrier/ipcCarrierPort.ts, installed beside this); what is here opens
// sessions and reads the diagnostics that belong to no one session.
import { ipcMain } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import { openPreviewGpu, takeTimingsPreviewGpu, hwBudget, type PreviewGpuRequest } from './previewGpu'
import { takeMainTimings } from './previewGpuTiming'
import { ipcCarrierPort } from './frameCarrier/ipcCarrierPort'

export function installPreviewGpuIpc(backend: () => NativeDecode): void {
  ipcMain.handle('previewGpu:open', (event, a: PreviewGpuRequest) =>
    openPreviewGpu(backend(), event.sender, ipcCarrierPort, a))
  ipcMain.handle('previewGpu:budget', () => hwBudget())
  ipcMain.handle('previewGpu:takeTimings', (_e, a: { streamId: string }) => takeTimingsPreviewGpu(backend(), a.streamId))
  ipcMain.handle('previewGpu:takeMainTimings', () => takeMainTimings())
}
