// Select the isolated benchmark before loading editor state, jobs or single-instance logic.
import { app, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { nativeWaylandSwitches } from './linuxDisplay'
const waylandSocket = process.env.WAYLAND_DISPLAY && process.env.XDG_RUNTIME_DIR
  ? path.resolve(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY) : null
const displaySwitches = nativeWaylandSwitches(process.platform,
  app.commandLine.getSwitchValue('ozone-platform'), !!waylandSocket && fs.existsSync(waylandSocket),
  app.commandLine.getSwitchValue('use-angle'))
for (const [name, value] of displaySwitches) app.commandLine.appendSwitch(name, value)
if (displaySwitches.some(([name, value]) => name === 'use-angle' && value === 'gl')) {
  const features = app.commandLine.getSwitchValue('enable-features').split(',')
    .filter(value => value && !['Vulkan', 'VulkanFromANGLE', 'DefaultANGLEVulkan'].includes(value))
  app.commandLine.removeSwitch('enable-features')
  if (features.length) app.commandLine.appendSwitch('enable-features', features.join(','))
}
if (process.env.WEFTCUT_SERVER) {
  const userData = path.join(process.env.WEFTCUT_DATA || '/data', 'settings', 'WeftCut')
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
import { MOTIF_SCHEME_ENTRY } from './motif/protocol'
import { startDiagnostics } from './diagnostics'

protocol.registerSchemesAsPrivileged([
  { scheme: 'weftcut-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  MOTIF_SCHEME_ENTRY,
])

if (process.argv.includes('--weftcut-calibration')) await import('./calibration-host')
else {
  startDiagnostics()
  await import('./index')
}
