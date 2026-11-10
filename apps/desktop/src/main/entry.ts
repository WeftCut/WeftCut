// Select the isolated benchmark before loading editor state, jobs or single-instance logic.
import { app, protocol } from 'electron'
import { MOTIF_SCHEME_ENTRY } from './motif/protocol'
import { startDiagnostics } from './diagnostics'

protocol.registerSchemesAsPrivileged([
  { scheme: 'weftcut-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  MOTIF_SCHEME_ENTRY,
])

if (process.argv.includes('--weftcut-calibration')) await import('./calibration-host')
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
