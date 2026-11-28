// The picture in the side panel: a WebRTC data channel to the editor window,
// set up over the view's tool calls, carrying the framed chunks the companion
// page reads from `/companion/video` (`../ui/pictureChunks.js`). The panel
// cannot reach loopback over HTTP; a peer connection to the app's 127.0.0.1
// candidate it can. The app answers with that candidate only, ignores the
// candidates this offer names, and sends nothing to a channel whose pair is
// not on its loopback socket (`renderer/companion/picturePeers.ts`).
import { frameSplitter, pictureDecoder } from '../ui/pictureChunks.js'
import { RETRY_FIRST_MS, RETRY_MAX_MS } from '../ui/transportLoopback.js'

/** How long an answered connection may take to open its channel before the
 *  view says the picture cannot reach it here. A channel that opened stays,
 *  frames or none: the editor may have nothing to send (an export holds the
 *  picture, a first frame is still encoding), and the view shows that from the
 *  app's state. */
export const PICTURE_CONNECT_MS = 5000

/** The longest the view waits for its own candidates before it sends the
 *  offer as it stands. The app reads none of them: the view's checks to the
 *  app's candidate form the pair, so a short wait loses nothing. */
export const GATHER_MAX_MS = 1500

/** Connection states after which the channel carries nothing more. */
const ENDED = new Set(['failed', 'disconnected', 'closed'])

/**
 * Opens the picture into `view.mount`.
 * @param {{
 *   signal(offer: string): Promise<{ outcome: string, answer?: string }>,
 *   codecs: { VideoDecoder: typeof VideoDecoder, EncodedVideoChunk: typeof EncodedVideoChunk },
 *   Peer: typeof RTCPeerConnection,
 *   doc: Document,
 *   clock: { sleep(ms: number): Promise<void> },
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} deps `signal` hands the offer to the app (`side_preview_sync { op:
 *   "signal" }`): `ok` with its answer, `not_ready` while no editor can take
 *   it, anything else when it will not come.
 * @param {{ mount: HTMLElement, shown(): void, failed(): void, blocked(): void }} view
 *   `blocked` is called when a connection's channel does not open within
 *   `PICTURE_CONNECT_MS`, or the connection ends before it drew (the app
 *   closes a channel off loopback as it opens): the picture cannot reach this
 *   view. The view keeps trying, and the next frame drawn calls `shown`.
 * @returns {{ close(): void }}
 */
export function openPeerPicture({ signal, codecs, Peer, doc, clock, timers = globalThis }, view) {
  let closed = false
  let peer = null
  let drawn = false
  let deadline = null
  const canvas = doc.createElement('canvas')
  view.mount.replaceChildren(canvas)
  const decoder = pictureDecoder({
    canvas,
    codecs,
    shown() {
      drawn = true
      clearDeadline()
      view.shown()
    },
    failed: view.failed,
  })

  function clearDeadline() {
    if (deadline !== null) timers.clearTimeout(deadline)
    deadline = null
  }

  function blocked() {
    clearDeadline()
    if (!closed) view.blocked()
  }

  /** One peer connection, from its offer until its channel ends. */
  async function connection() {
    drawn = false
    const pc = peer = new Peer({ iceServers: [] })
    // LANDMINE: ordered and reliable. The frames are split into messages a
    // channel can carry, and the splitter reads them back as one byte stream:
    // a lost or reordered message would break every frame after it.
    const channel = pc.createDataChannel('picture', { ordered: true })
    channel.binaryType = 'arraybuffer'
    const split = frameSplitter()
    channel.onmessage = (event) => {
      for (const frame of split(new Uint8Array(event.data))) decoder.take(frame)
    }
    let finish
    const ended = new Promise((resolve) => { finish = resolve })
    pc.onconnectionstatechange = () => {
      if (!ENDED.has(pc.connectionState)) return
      if (!drawn) blocked()
      finish()
    }
    channel.onopen = () => {
      clearDeadline()
      selected(pc)
    }
    channel.onclose = () => {
      if (!drawn) blocked()
      finish()
    }
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    let wait = RETRY_FIRST_MS
    for (;;) {
      if (closed) return
      const reply = await signal(pc.localDescription.sdp).catch(() => ({ outcome: 'offline' }))
      if (closed) return
      if (reply.outcome === 'ok' && typeof reply.answer === 'string') {
        // A connection whose channel does not open in time is given up and
        // tried anew: one stuck checking would otherwise never end.
        deadline = timers.setTimeout(() => { blocked(); finish() }, PICTURE_CONNECT_MS)
        await pc.setRemoteDescription({ type: 'answer', sdp: reply.answer })
        break
      }
      // The editor answers once it is up; anything else will not change by
      // asking at once, and the view says so while it keeps asking.
      if (reply.outcome !== 'not_ready' && reply.outcome !== 'offline') blocked()
      await clock.sleep(wait)
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
    await ended
  }

  void (async () => {
    let wait = RETRY_FIRST_MS
    while (!closed) {
      try {
        await connection()
      } catch {
        if (!drawn) blocked()
      }
      clearDeadline()
      peer?.close()
      peer = null
      if (closed) return
      if (drawn) wait = RETRY_FIRST_MS
      await clock.sleep(wait)
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
  })()

  return {
    close() {
      closed = true
      clearDeadline()
      peer?.close()
      peer = null
      decoder.close()
      canvas.remove()
    },
  }

  /** Marks the canvas with the addresses of the pair `pc` selected, as
   *  `data-pair-local` (this view's end) and `data-pair-remote` (the app's),
   *  for a test to read from outside the frame. */
  function selected(pc) {
    pc.getStats().then((report) => {
      const stats = [...report.values()]
      const id = stats.find((s) => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId
      const pair = id ? report.get(id) : stats.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
      if (!pair) return
      canvas.dataset.pairLocal = report.get(pair.localCandidateId)?.address ?? ''
      canvas.dataset.pairRemote = report.get(pair.remoteCandidateId)?.address ?? ''
    }, () => {})
  }

  /** Resolves once `pc` has gathered its candidates, or at `GATHER_MAX_MS`. */
  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const timer = timers.setTimeout(resolve, GATHER_MAX_MS)
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState !== 'complete') return
        timers.clearTimeout(timer)
        resolve()
      }
    })
  }
}
