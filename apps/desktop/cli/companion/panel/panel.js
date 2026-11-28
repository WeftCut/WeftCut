// The companion UI as an MCP Apps view in a host's side panel: the host's
// postMessage bridge, the tool-call transport, and the host's locale. Bundled
// with the UI's modules into one self-contained `panel.html`
// (`scripts/build-side-panel.mjs`): the view's default CSP admits inline
// script and style and no request of any kind.
import { mountCompanion } from '../ui/app.js'
import entry from './entry.json'
import icon from '../ui/icon.svg'
import { mcpAppsBridge } from './mcpAppsBridge.js'
import { toolcallTransport } from './transportToolcall.js'

/** How long the view waits for the host's handshake before it starts on its
 *  own language. */
const HANDSHAKE_WAIT_MS = 3000

const bridge = mcpAppsBridge({
  post: (message) => window.parent.postMessage(message, '*'),
  subscribe: (listener) => {
    const onMessage = (event) => { if (event.source === window.parent) listener(event.data) }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  },
})

const handshake = bridge.initialize({ name: 'weftcut-side-preview', version: '1' }).catch(() => ({}))
const waited = new Promise((resolve) => { setTimeout(() => resolve({}), HANDSHAKE_WAIT_MS) })

void Promise.race([handshake, waited]).then((context) => {
  const page = mountCompanion(
    document.getElementById('companion'),
    toolcallTransport({
      bridge,
      syncTool: entry.sync.name,
      clock: { sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }) },
      codecs: typeof VideoDecoder === 'undefined' ? null : { VideoDecoder, EncodedVideoChunk },
      Peer: typeof RTCPeerConnection === 'undefined' ? null : RTCPeerConnection,
    }),
    { locale: context?.hostContext?.locale ?? navigator.language, icon },
  )
  bridge.onRequest('ui/resource-teardown', () => {
    page.stop()
    return {}
  })
})

// The host sizes the frame; the view says how much it fills.
let reported = ''
new ResizeObserver(() => {
  const { scrollWidth: width, scrollHeight: height } = document.documentElement
  if (`${width}x${height}` === reported) return
  reported = `${width}x${height}`
  bridge.sizeChanged(width, height)
}).observe(document.documentElement)
