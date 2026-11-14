// The companion page in a browser: the loopback transport, and the key from the
// link's fragment. The fragment stays in the address, so a reload keeps working
// in a sandboxed frame, where there is no storage to move the key to.
import { mountCompanion } from './app.js'
import { loopbackTransport } from './transportLoopback.js'

const key = /(?:^#|&)k=([0-9a-f]{64})(?:&|$)/.exec(location.hash)?.[1] ?? null
const clock = { sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }) }

mountCompanion(
  document.getElementById('companion'),
  loopbackTransport({ fetch: (...args) => fetch(...args), key, clock }),
  { locale: navigator.language },
)
