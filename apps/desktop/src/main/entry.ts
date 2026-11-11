// Select the legacy shim hand-over or the isolated benchmark before loading
// editor state, jobs or single-instance logic.
import fs from 'node:fs'
import { app, protocol } from 'electron'
import { MOTIF_SCHEME_ENTRY } from './motif/protocol'
import { startDiagnostics } from './diagnostics'
import { shippedCliDir } from './mcp/cliInstall'
import { legacyShimHandover } from './mcp/legacyShim'
import { serveLegacyShim } from './mcp/legacyShimHost'

protocol.registerSchemesAsPrivileged([
  { scheme: 'weftcut-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  MOTIF_SCHEME_ENTRY,
])

// A client config from a release that ran a JS shim on this executable (ADR
// 0165). First, and instead of everything below: that client is speaking MCP
// on this process's stdio, and must get neither a window nor a second-instance
// quit.
const legacyShim = legacyShimHandover({
  argv: process.argv,
  platform: process.platform,
  shippedDir: shippedCliDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: import.meta.dirname }),
  isFile: (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false,
})
if (legacyShim) serveLegacyShim(legacyShim)
else if (process.argv.includes('--weftcut-calibration')) await import('./calibration-host')
// One WeftCut per profile (ADR 0163). Electron keys the lock on the userData
// directory, so runs with their own --user-data-dir (e2e, calibration, bench)
// stay independent. A second launch quits before it opens diagnostics, the
// backend or the MCP host; the first instance raises its window on
// 'second-instance' (index.ts).
else if (!app.requestSingleInstanceLock()) app.quit()
else {
  startDiagnostics()
  await import('./index')
}
