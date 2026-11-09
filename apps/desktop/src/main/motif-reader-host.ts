import { createMotifReaderHost } from './motif/readerHost'
import { holdMotifReads, motifReadHoldFrame } from './motif/readerE2EHold'
import { readMotifTuningArgument } from '../shared/motifs/tuning'
import { loadMotifNative } from './motif/native'

// The app-wide Motif reader utility process (ADR 0154). It answers renderer
// workers on the ports main hands it. Do not import Electron main bootstrap
// or anything that needs `app` here.

// Main passes its resolved tuning on the fork's argv.
const tuning = readMotifTuningArgument(process.argv)
if (!tuning) throw new Error('The Motif reader utility needs the tuning main resolved')
const native = loadMotifNative(tuning)
// E2E builds only: the reader conformance spec holds reads of one frame number
// so it can kill this process or switch the workspace mid-read. Production
// builds fold this away (electron.vite.config.ts defines the flag).
const holdFrame = process.env.WEFTCUT_E2E_BUILD === '1'
  ? motifReadHoldFrame(process.env.WEFTCUT_E2E_MOTIF_READER_HOLD_FRAME) : null
const hold = holdFrame === null ? null : holdMotifReads(holdFrame)
const host = createMotifReaderHost({
  openReader: () => {
    const reader = native.openFrameFileReader()
    return hold ? hold(reader) : reader
  },
  report: message => process.parentPort.postMessage(message),
})
process.parentPort.on('message', event => host.control(event.data, event.ports))
