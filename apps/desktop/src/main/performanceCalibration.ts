import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { CalibrationService } from './calibrationService'
import { reserveResources } from './resources'
import { PLAYBACK_CALIBRATION } from '../shared/playback-calibration'
import { MIB } from '../shared/performance-settings'

export function installPerformanceCalibration(): void {
  const service = new CalibrationService({
    supported: process.platform === 'win32',
    fixtureDirectory: app.isPackaged ? path.join(process.resourcesPath, 'performance-calibration')
      : path.resolve(import.meta.dirname, '../../e2e/fixtures/decode-bench/calibration-60'),
    runsDirectory: path.join(os.tmpdir(), 'weftcut-performance-calibration'),
    // The isolated process keeps a fixed measurement protocol, but it must
    // reserve its peak workload in the parent authority before it launches.
    reserve: () => reserveResources(0, 256 + PLAYBACK_CALIBRATION.performance.frame_ring_mib
      + PLAYBACK_CALIBRATION.performance.gpu_buffer_mib
      + Math.max(...PLAYBACK_CALIBRATION.counts) * (64 + PLAYBACK_CALIBRATION.width * PLAYBACK_CALIBRATION.height * 24 / MIB)),
    launch(input, directory) {
      const env: NodeJS.ProcessEnv = { ...process.env, WEFTCUT_CALIBRATION_INPUT: input,
        WEFTCUT_CALIBRATION_OUTPUT: path.join(directory, 'report.json') }
      for (const key of Object.keys(env)) {
        if (key.startsWith('WEFTCUT_HW_') || key.startsWith('WEFTCUT_FORCE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
      }
      return spawn(process.execPath, [...(app.isPackaged ? [] : [path.join(import.meta.dirname, 'index.js')]),
        '--weftcut-calibration', `--user-data-dir=${path.join(directory, 'profile')}`],
      { env, stdio: 'ignore', windowsHide: true })
    },
  })
  ipcMain.handle('performanceCalibration:status', () => service.status())
  ipcMain.handle('performanceCalibration:start', () => service.start())
  ipcMain.handle('performanceCalibration:cancel', () => service.cancel())
  app.on('before-quit', () => { service.cancel() })
}
