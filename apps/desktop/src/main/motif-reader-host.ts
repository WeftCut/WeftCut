import { createRequire } from 'node:module'
import { createMotifReaderHost } from './motif/readerHost'

// The app-wide Motif reader utility process (ADR 0154). It answers renderer
// workers on the ports main hands it. Do not import Electron main bootstrap
// or anything that needs `app` here.
const native = createRequire(import.meta.url)('@weftcut/core') as Pick<typeof import('@weftcut/core'), 'motifReadFrameScaled'>
const host = createMotifReaderHost({
  read: (file, div) => native.motifReadFrameScaled(file, div),
  report: miss => process.parentPort.postMessage(miss),
})
process.parentPort.on('message', event => host.control(event.data, event.ports))
