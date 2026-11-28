// The picture in the side panel: a WebRTC data channel to the editor window,
// set up over the view's tool calls, carrying the framed chunks the companion
// page reads from `/companion/video` (`../ui/pictureChunks.js`). The panel
// cannot reach loopback over HTTP; a peer connection to the app's 127.0.0.1
// candidate it can. The app answers with that candidate only
// (`renderer/companion/picturePeers.ts`).
import { frameSplitter, pictureDecoder } from '../ui/pictureChunks.js'
import { RETRY_FIRST_MS, RETRY_MAX_MS } from '../ui/transportLoopback.js'

/** How long an answered connection may go without a frame drawn before the
 *  view says the picture cannot reach it here. The editor sends its last
 *  keyframe to a channel the moment it opens, so a working link draws well
 *  within this. */
export const PICTURE_CONNECT_MS = 5000

/** The longest the view waits for its own candidates before it sends the
 *  offer as it stands. The app's checks reach the view whatever it lists, so
 *  a short wait loses nothing. */
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
 *   `blocked` is called when a connection draws nothing within
 *   `PICTURE_CONNECT_MS`, or fails before it drew: the picture cannot reach
 *   this view. The view keeps trying, and the next frame drawn calls `shown`.
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
    channel.onclose = () => finish()
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    let wait = RETRY_FIRST_MS
    for (;;) {
      if (closed) return
      const reply = await signal(pc.localDescription.sdp).catch(() => ({ outcome: 'offline' }))
      if (closed) return
      if (reply.outcome === 'ok' && typeof reply.answer === 'string') {
        // A connection that draws nothing in time is given up and tried
        // anew: one stuck checking would otherwise never end.
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
