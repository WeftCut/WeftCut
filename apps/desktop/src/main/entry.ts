// Refuse a 0.7.x agent config or select the isolated benchmark before loading
// editor state, jobs or single-instance logic.
import { app, protocol } from 'electron'
import { MOTIF_SCHEME_ENTRY } from './motif/protocol'
import { startDiagnostics } from './diagnostics'
import { legacyConfigRefusal } from './mcp/legacyConfig'
import { openHandoff, openTargetFromArgv } from './fileAssociation/openTarget'
import { receiveOpenRequests } from './fileAssociation/openRequests'

protocol.registerSchemesAsPrivileged([
  { scheme: 'weftcut-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  MOTIF_SCHEME_ENTRY,
])

// A client config written for the JS shim of 0.7.x starts this executable on
// the shim's script (ADR 0165). First, and instead of everything below: its
// client gets one line saying what replaced it, and neither a window, a profile
// lock nor diagnostics. stderr: the client reads stdout as the protocol. The
// exit waits for the line to be written, so the client sees it.
const legacyConfig = legacyConfigRefusal(process.argv, process.platform)
if (legacyConfig !== null) process.stderr.write(`${legacyConfig}\n`, () => app.exit(1))
else if (process.argv.includes('--weftcut-calibration')) await import('./calibration-host')
// One WeftCut per profile (ADR 0163). Electron keys the lock on the userData
// directory, so runs with their own --user-data-dir (e2e, calibration, bench)
// stay independent. A second launch quits before it opens diagnostics, the
// backend or the MCP host, handing the running app the file it was launched
// on (ADR 0181); the first instance raises its window on 'second-instance'
// (index.ts).
else if (!app.requestSingleInstanceLock(openHandoff(openTargetFromArgv(process.argv, process.cwd())))) app.quit()
else {
  receiveOpenRequests(app, { argv: process.argv, cwd: process.cwd(), platform: process.platform })
  startDiagnostics()
  await import('./index')
}
