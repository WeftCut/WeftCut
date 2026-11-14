// The companion page's one UI: the project's name and the latest agent call,
// the preview's picture once the user asks for it, play / pause and the time,
// a small timeline to seek on, and export progress. It reads the project and
// drives the player; it never edits. Everything it
// knows arrives through `transport` (`transportLoopback.js` in a browser), and
// the DOM is built node by node: the page's CSP admits no inline style or
// markup from data.
import { exportRunning, pageState, pictureState } from './viewState.js'
import { clipBox, formatTime, rulerTicks, timeAt, timelineRows } from './timeline.js'
import { fill, stringsFor } from './strings.js'

/**
 * @param {HTMLElement} root
 * @param {{ start(h: { state(s: object): void, event(name: string, data: unknown): void, link(status: string): void }): () => void,
 *           control(action: object): Promise<string>,
 *           openPicture(view: { mount: HTMLElement, shown(): void }): { close(): void } | null }} transport
 * @param {{ now?: () => number, frame?: (cb: () => void) => void, locale?: string }} [env]
 *   `now` in milliseconds and `frame` (a requestAnimationFrame) move the
 *   playhead between transport updates; `locale` is the browser's, used until
 *   the app names its own.
 */
export function mountCompanion(root, transport, env = {}) {
  const now = env.now ?? (() => performance.now())
  const frame = env.frame ?? ((cb) => requestAnimationFrame(cb))
  const doc = root.ownerDocument

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const name = el('span', 'cw-name')
  const activity = el('span', 'cw-activity')
  const focus = el('button', 'cw-focus')
  focus.type = 'button'
  const header = el('header', 'cw-header')
  header.append(name, activity, focus)

  const notice = el('p', 'cw-notice')
  notice.setAttribute('role', 'status')

  const pictureMount = el('div', 'cw-picture')
  const stageMessage = el('p', 'cw-stage-message')
  const showPicture = el('button', 'cw-show-picture')
  showPicture.type = 'button'
  const stageFocus = el('button', 'cw-stage-focus')
  stageFocus.type = 'button'
  const stageOverlay = el('div', 'cw-stage-overlay')
  stageOverlay.append(stageMessage, showPicture, stageFocus)
  const stage = el('section', 'cw-stage')
  stage.append(pictureMount, stageOverlay)

  const play = el('button', 'cw-play')
  play.type = 'button'
  const time = el('span', 'cw-time')
  const hidePicture = el('button', 'cw-hide-picture')
  hidePicture.type = 'button'
  const controls = el('div', 'cw-controls')
  controls.append(play, time, hidePicture)

  const labels = el('div', 'cw-labels')
  const ruler = el('div', 'cw-ruler')
  const rows = el('div', 'cw-rows')
  const playhead = el('div', 'cw-playhead')
  const lanes = el('div', 'cw-lanes')
  lanes.append(ruler, rows, playhead)
  const timeline = el('section', 'cw-timeline')
  timeline.append(labels, lanes)

  const exportLabel = el('span', 'cw-export-label')
  const exportFill = el('div', 'cw-export-fill')
  const exportTrack = el('div', 'cw-export-track')
  exportTrack.append(exportFill)
  const exportBox = el('div', 'cw-export')
  exportBox.append(exportLabel, exportTrack)

  root.replaceChildren(header, notice, stage, controls, timeline, exportBox)

  let link = 'connecting'
  let state = null
  let editorRefused = false
  let strings = stringsFor(env.locale)
  /** When `state.transport` arrived, for moving the playhead while playing. */
  let transportAt = now()
  let ticking = false
  /** The user's word on the picture; not kept across a reload. */
  let pictureWanted = false
  let picture = null
  let pictureSupported = true
  let pictureShown = false

  const duration = () => state?.composition?.duration_us ?? 0
  const ready = () => view().state === 'ready'
  const view = () => pageState({ link, editorRefused, state }, strings)

  function playheadUs() {
    const t = state?.transport
    if (!t) return 0
    if (!t.playing) return t.t_us
    return Math.min(duration(), t.t_us + (now() - transportAt) * 1000)
  }

  function paintView() {
    const v = view()
    root.dataset.state = v.state
    notice.textContent = v.message ?? ''
    notice.hidden = v.message === null
    play.disabled = v.state !== 'ready'
    focus.disabled = link !== 'online'
    paintStage()
  }

  function paintStage() {
    const ready = view().state === 'ready'
    const exporting = exportRunning(state?.export ?? null)
    // A frame from before counts for nothing once the picture had to stop.
    if (!ready || exporting) pictureShown = false
    const p = pictureState({
      exporting,
      wanted: pictureWanted,
      supported: pictureSupported,
      minimized: state?.window === 'minimized',
      shown: pictureShown,
    }, strings)
    stage.hidden = !ready
    stage.dataset.picture = p.picture
    if (state?.composition) stage.style.aspectRatio = `${state.composition.width} / ${state.composition.height}`
    stageMessage.textContent = p.message ?? ''
    stageOverlay.hidden = p.message === null
    showPicture.hidden = p.picture !== 'off'
    stageFocus.hidden = p.picture !== 'minimized'
    hidePicture.hidden = !pictureWanted
    hidePicture.disabled = !ready
  }

  function setPicture(on) {
    pictureWanted = on
    if (on && picture === null) {
      pictureShown = false
      picture = transport.openPicture({
        mount: pictureMount,
        shown() {
          if (pictureShown) return
          pictureShown = true
          paintStage()
        },
      })
      pictureSupported = picture !== null
    } else if (!on && picture !== null) {
      picture.close()
      picture = null
    }
    paintStage()
  }

  function paintText() {
    doc.documentElement.lang = strings.lang
    const project = state?.project?.name ?? null
    doc.title = project === null ? strings.title : `${project} · ${strings.title}`
    name.textContent = project ?? strings.title
    focus.textContent = strings.show_editor
    stageFocus.textContent = strings.show_editor
    showPicture.textContent = strings.show_picture
    hidePicture.textContent = strings.hide_picture
    timeline.setAttribute('aria-label', strings.timeline)
  }

  function paintTransport() {
    const playing = state?.transport?.playing === true
    play.textContent = playing ? '❚❚' : '▶'
    play.setAttribute('aria-label', playing ? strings.pause : strings.play)
    paintPlayhead()
    if (playing && !ticking) { ticking = true; frame(tick) }
  }

  function tick() {
    paintPlayhead()
    if (state?.transport?.playing === true) frame(tick)
    else ticking = false
  }

  function paintPlayhead() {
    const t = playheadUs()
    time.textContent = `${formatTime(t)} / ${formatTime(duration())}`
    playhead.style.left = `${duration() > 0 ? (t / duration()) * 100 : 0}%`
  }

  function paintTimeline() {
    const d = duration()
    ruler.replaceChildren(...(d > 0 ? rulerTicks(d) : []).map((t) => {
      const tick = el('span', 'cw-tick', formatTime(t))
      tick.style.left = `${(t / d) * 100}%`
      return tick
    }))
    const drawn = timelineRows(state?.tracks ?? [])
    labels.replaceChildren(el('div', 'cw-label-spacer'), ...drawn.map((row) => el('div', 'cw-label', row.label)))
    timeline.hidden = state?.composition == null
    if (drawn.length === 0) { rows.replaceChildren(el('p', 'cw-empty', strings.timeline_empty)); return }
    rows.replaceChildren(...drawn.map((row) => {
      const lane = el('div', 'cw-lane')
      lane.append(...row.clips.map((c) => {
        const node = el('div', 'cw-clip', c.label)
        node.dataset.layerId = c.layer_id
        node.dataset.kind = c.kind
        node.title = c.label
        const box = clipBox(c, d)
        node.style.left = `${box.left}%`
        node.style.width = `${box.width}%`
        return node
      }))
      return lane
    }))
  }

  function paintExport() {
    const job = state?.export ?? null
    exportBox.hidden = !exportRunning(job)
    paintStage()
    if (exportBox.hidden) return
    const percent = Math.round(job.progress * 100)
    exportLabel.textContent = fill(strings.exporting, { percent, file: job.filename })
    exportFill.style.width = `${percent}%`
  }

  function paintActivity() {
    const a = state?.activity ?? null
    if (a === null) { activity.textContent = ''; return }
    const text = a.state === 'running' ? strings.activity_running : a.state === 'error' ? strings.activity_error : strings.activity_done
    activity.textContent = fill(text, { client: a.client, tool: a.tool.replaceAll('_', ' ') })
  }

  function paintAll() {
    paintText()
    paintView()
    paintTimeline()
    paintTransport()
    paintExport()
    paintActivity()
  }

  /** What a control's answer means for the page. The transport tells `link`
   *  itself about a lost app or a refused key. */
  function answered(outcome) {
    if (outcome !== 'not_ready' || editorRefused) return
    editorRefused = true
    paintView()
  }

  play.addEventListener('click', () => {
    if (!ready()) return
    void transport.control({ action: state.transport.playing ? 'pause' : 'play' }).then(answered)
  })
  const focusEditor = () => { void transport.control({ action: 'focus' }).then(answered) }
  focus.addEventListener('click', focusEditor)
  stageFocus.addEventListener('click', focusEditor)
  showPicture.addEventListener('click', () => setPicture(true))
  hidePicture.addEventListener('click', () => setPicture(false))

  // Seeking while dragging: the playhead follows the pointer at once, and the
  // app hears the latest position, one request at a time.
  let seekSending = false
  let seekNext = null
  async function sendSeeks() {
    seekSending = true
    while (seekNext !== null) {
      const t = seekNext
      seekNext = null
      answered(await transport.control({ action: 'seek', t_us: t }))
    }
    seekSending = false
  }
  function seekTo(clientX) {
    const box = lanes.getBoundingClientRect()
    const t = timeAt(clientX, box.left, box.width, duration())
    state.transport = { ...state.transport, t_us: t }
    transportAt = now()
    paintPlayhead()
    seekNext = t
    if (!seekSending) void sendSeeks()
  }
  let dragging = false
  lanes.addEventListener('pointerdown', (e) => {
    if (!ready() || duration() <= 0) return
    dragging = true
    lanes.setPointerCapture?.(e.pointerId)
    seekTo(e.clientX)
  })
  lanes.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX) })
  const endDrag = () => { dragging = false }
  lanes.addEventListener('pointerup', endDrag)
  lanes.addEventListener('pointercancel', endDrag)

  paintAll()
  const stopTransport = transport.start({
    state(s) {
      state = s
      editorRefused = false
      transportAt = now()
      strings = stringsFor(s.language ?? env.locale)
      paintAll()
    },
    event(eventName, data) {
      if (state === null) return
      if (eventName === 'transport') {
        state.transport = data
        transportAt = now()
        paintTransport()
      } else if (eventName === 'export') {
        state.export = data
        paintExport()
      } else if (eventName === 'activity') {
        state.activity = data
        paintActivity()
      } else if (eventName === 'window') {
        state.window = data
        paintStage()
      }
    },
    link(status) {
      link = status
      paintView()
    },
  })
  return {
    stop() {
      setPicture(false)
      stopTransport()
    },
  }
}
