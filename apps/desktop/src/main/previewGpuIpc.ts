// The editor and isolated calibration host install the same GPU transport IPC.
import { BrowserWindow, ipcMain } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import { openPreviewGpu, requestFrameAtPreviewGpu, consumeAckPreviewGpu, closePreviewGpu, takeTimingsPreviewGpu, hwBudget } from './previewGpu'
import { recordConsumeAck, takeMainTimings } from './previewGpuTiming'

export function installPreviewGpuIpc(backend: () => NativeDecode, fallbackWindow: () => BrowserWindow | null): void {
  ipcMain.handle('previewGpu:open', (e, a: { streamId: string; path: string; poolSize: number; colorSpace: Electron.ColorSpace; codedWidth: number; codedHeight: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? fallbackWindow()
    if (!win) throw new Error('previewGpu:open — no window for sender')
    return openPreviewGpu(backend(), win, a.streamId, a.path, a.poolSize, a.colorSpace, a.codedWidth, a.codedHeight)
  })
  ipcMain.handle('previewGpu:requestFrameAt', (_e, a: { streamId: string; targetUs: number }) => requestFrameAtPreviewGpu(backend(), a.streamId, a.targetUs))
  ipcMain.handle('previewGpu:consumeAck', (_e, a: { streamId: string; slot: number; gen: number }) => {
    recordConsumeAck(a.streamId, a.slot, performance.now())
    return consumeAckPreviewGpu(backend(), a.streamId, a.slot, a.gen)
  })
  ipcMain.handle('previewGpu:close', (_e, a: { streamId: string }) => closePreviewGpu(backend(), a.streamId))
  ipcMain.handle('previewGpu:budget', () => hwBudget())
  ipcMain.handle('previewGpu:takeTimings', (_e, a: { streamId: string }) => takeTimingsPreviewGpu(backend(), a.streamId))
  ipcMain.handle('previewGpu:takeMainTimings', () => takeMainTimings())
}
