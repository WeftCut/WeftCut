// Select the isolated benchmark before loading editor state, jobs or single-instance logic.
import { protocol } from 'electron'
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
