// The companion page's one UI: the project and the link's health, the
// preview's picture once the user asks for it, the player's controls and
// time, a small timeline to seek on, export progress and the agent calls seen
// since the page opened. It reads the project and drives the player; it never
// edits. Everything it knows arrives through `transport`
// (`transportLoopback.js` in a browser, `../panel/transportToolcall.js` in a
// host's side panel), and the DOM is built node by node: the page's CSP admits
// no inline style or markup from data.
import { exportRunning, exportShown, pageState, pictureState, recordCall } from './viewState.js'
import { clipBox, frameAt, frameStartUs, rulerLabel, rulerTicks, timeAt, timecode, timelineRows } from './timeline.js'
import { fill, stringsFor } from './strings.js'

const SVG = 'http://www.w3.org/2000/svg'

/** 16-unit stroke icons. Frame steps are bare chevrons so they never read as
 *  the bar-and-triangle of go-to-start / go-to-end. */
const ICONS = {
  start: 'M3.5 3v10M13 3.5 6 8l7 4.5z',
  end: 'M12.5 3v10M3 3.5 10 8l-7 4.5z',
  prev: 'M10 3.5 5.5 8l4.5 4.5',
  next: 'M6 3.5 10.5 8 6 12.5',
  play: 'M5 3.2v9.6L13 8z',
  pause: 'M5 3.5v9M11 3.5v9',
  open: 'M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-9V4H6',
  hide: 'M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.7C2.6 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 1.9',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  pip: 'M2 3.5h12v9H2zM8.5 8h4v3h-4z',
}

/** The W of the app icon, and the line the startup screen's pulse runs along
 *  inside it (renderer/startup/StartupScreen.tsx, LogoPulsePaths.tsx). */
const W_CLIP = 'M200.117 167.417L151.477 239.378C149.409 242.438 144.851 242.276 143.004 239.078L95.331 156.5C92.6515 151.859 87.6995 149 82.3404 149H10.0005C4.47764 149 0.000488281 153.477 0.000488281 159V183C0.000488281 188.523 4.47764 193 10.0005 193H57.3059C62.6835 193 67.6496 195.879 70.3222 200.545L124.679 295.455C127.352 300.121 132.318 303 137.696 303H154.024C159.011 303 163.672 300.522 166.461 296.387L220.001 217L273.541 296.387C276.329 300.522 280.99 303 285.977 303H302.306C307.683 303 312.649 300.121 315.322 295.455L369.679 200.545C372.352 195.879 377.318 193 382.696 193H430C435.523 193 440 188.523 440 183V159C440 153.477 435.523 149 430 149L357.661 149C352.302 149 347.35 151.859 344.671 156.5L296.997 239.078C295.151 242.276 290.593 242.438 288.525 239.378L239.885 167.417C230.368 153.337 209.634 153.337 200.117 167.417Z'
const W_PULSE = 'M8 171H76L148 271L220 192L292 271L364 171H432'

/** A ruler tick this close to the right edge keeps its mark and drops its
 *  label, which would run past the lane. */
const TICK_LABEL_MAX = 0.88

/** What the empty page says in each state that is not `ready`. */
const EMPTY_COPY = {
  revoked: ['revoked_title', 'revoked_body'],
  offline: ['offline_title', 'offline_body'],
  opening: ['opening_title', null],
  no_project: ['no_project_title', 'no_project_body'],
  connecting: [null, null],
}

/**
 * @param {HTMLElement} root
 * @param {{ start(h: { state(s: object): void, event(name: string, data: unknown): void, link(status: string): void }): () => void,
 *           control(action: object): Promise<string>,
 *           openPicture(view: { mount: HTMLElement, shown(): void, failed(): void, blocked(): void }): { close(): void } | null,
 *           launch?(): Promise<'ok' | 'failed'>,
 *           recentProject?(): Promise<{ name: string, path: string } | null>,
 *           openProject?(path: string): Promise<'ok' | 'failed'> }} transport
 *   `launch`, `recentProject` and `openProject` are offered by a transport that
 *   can start the app and open a project; the page shows their buttons only then.
 * @param {{ now?: () => number, wallNow?: () => number, frame?: (cb: () => void) => void, locale?: string, icon?: string }} [env]
 *   `now` in milliseconds and `frame` (a requestAnimationFrame) move the
 *   playhead between transport updates; `wallNow` (ms since the epoch) dates
 *   the agent calls; `locale` is the browser's, used until the app names its own;
 *   `icon` is the app icon's address, which differs between the page and a view.
 */
export function mountCompanion(root, transport, env = {}) {
  const now = env.now ?? (() => performance.now())
  const wallNow = env.wallNow ?? (() => Date.now())
  const frame = env.frame ?? ((cb) => requestAnimationFrame(cb))
  const doc = root.ownerDocument
  const win = doc.defaultView

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const svg = (tag, attrs = {}) => {
    const node = doc.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    return node
  }
  const icon = (name) => {
    const node = svg('svg', { viewBox: '0 0 16 16', class: 'cw-icon', 'aria-hidden': 'true' })
    node.append(svg('path', { d: ICONS[name] }))
    return node
  }
  const iconButton = (name, className) => {
    const b = el('button', `cw-iconbtn ${className}`)
    b.type = 'button'
    b.append(icon(name))
    return b
  }
  const textButton = (className) => {
    const b = el('button', `cw-button ${className}`)
    b.type = 'button'
    return b
  }

  /** The app icon with the pulse laid over its W; CSS decides when it runs. */
  function mark(className, clipId) {
    const wrap = el('span', `cw-mark ${className}`)
    wrap.setAttribute('aria-hidden', 'true')
    const img = el('img', 'cw-mark-img')
    if (env.icon) img.src = env.icon
    img.alt = ''
    const pulse = svg('svg', { viewBox: '0 0 440 440', class: 'cw-mark-pulse', fill: 'none' })
    const clip = svg('clipPath', { id: clipId })
    clip.append(svg('path', { d: W_CLIP }))
    const defs = svg('defs')
    defs.append(clip)
    const g = svg('g', { 'clip-path': `url(#${clipId})` })
    for (const cls of ['cw-pulse-glow', 'cw-pulse-core']) g.append(svg('path', { d: W_PULSE, pathLength: '100', class: cls }))
    pulse.append(defs, g)
    wrap.append(img, pulse)
    return wrap
  }

  const name = el('span', 'cw-name')
  const meta = el('span', 'cw-meta')
  const titles = el('div', 'cw-titles')
  titles.append(name, meta)
  const linkDot = el('span', 'cw-link-dot')
  const focus = iconButton('open', 'cw-focus')
  const header = el('header', 'cw-header')
  header.append(mark('cw-header-mark', 'cw-header-w'), titles, linkDot, focus)

  const emptyTitle = el('h1', 'cw-empty-title')
  const emptyBody = el('p', 'cw-empty-body')
  const emptyWait = el('p', 'cw-empty-wait')
  const emptyFocus = textButton('cw-empty-focus')
  const emptyStart = textButton('cw-button-primary cw-empty-start')
  const emptyRecent = textButton('cw-button-primary cw-empty-recent')
  const empty = el('section', 'cw-empty')
  empty.setAttribute('role', 'status')
  empty.append(mark('cw-empty-mark', 'cw-empty-w'), emptyTitle, emptyBody, emptyWait, emptyStart, emptyRecent, emptyFocus)

  const pictureMount = el('div', 'cw-picture')
  const posterTitle = el('p', 'cw-poster-title')
  const posterBody = el('p', 'cw-poster-body')
  const showPicture = textButton('cw-button-primary cw-show-picture')
  const poster = el('div', 'cw-poster')
  poster.append(posterTitle, posterBody, showPicture)
  const stageMessage = el('p', 'cw-stage-message')
  const stageFocus = textButton('cw-stage-focus')
  const stageRetry = textButton('cw-stage-retry')
  const stageNote = el('div', 'cw-stage-note')
  stageNote.append(stageMessage, stageFocus, stageRetry)
  const hud = el('span', 'cw-hud')
  const copyPicture = iconButton('copy', 'cw-copy-picture')
  const pip = iconButton('pip', 'cw-pip')
  const hidePicture = iconButton('hide', 'cw-hide-picture')
  const stageTools = el('div', 'cw-stage-tools')
  stageTools.append(copyPicture, pip, hidePicture)
  const stage = el('section', 'cw-stage')
  stage.append(pictureMount, poster, stageNote, hud, stageTools)

  const toStart = iconButton('start', 'cw-to-start')
  const prev = iconButton('prev', 'cw-prev')
  const play = iconButton('play', 'cw-play')
  const next = iconButton('next', 'cw-next')
  const toEnd = iconButton('end', 'cw-to-end')
  const buttons = el('div', 'cw-buttons')
  buttons.append(toStart, prev, play, next, toEnd)
  const timeNow = el('span', 'cw-time-now')
  const timeEnd = el('span', 'cw-time-end')
  const time = el('span', 'cw-time')
  time.append(timeNow, timeEnd)
  const controls = el('div', 'cw-controls')
  controls.append(buttons, time)

  const labels = el('div', 'cw-labels')
  const ruler = el('div', 'cw-ruler')
  const rows = el('div', 'cw-rows')
  const hoverLabel = el('span', 'cw-hover-label')
  const hover = el('div', 'cw-hover')
  hover.append(hoverLabel)
  const playhead = el('div', 'cw-playhead')
  const lanes = el('div', 'cw-lanes')
  lanes.append(ruler, rows, hover, playhead)
  const timeline = el('section', 'cw-timeline')
  timeline.append(labels, lanes)

  const ringFill = svg('circle', { cx: '10', cy: '10', r: '8', pathLength: '100', class: 'cw-ring-fill' })
  const ring = svg('svg', { viewBox: '0 0 20 20', class: 'cw-ring', 'aria-hidden': 'true' })
  ring.append(svg('circle', { cx: '10', cy: '10', r: '8', pathLength: '100', class: 'cw-ring-track' }), ringFill)
  const exportLabel = el('span', 'cw-export-label')
  const exportFile = el('span', 'cw-export-file')
  const exportBox = el('div', 'cw-export')
  exportBox.append(ring, exportLabel, exportFile)

  const calls = el('ol', 'cw-calls')
  const keys = el('p', 'cw-keys')
  const toast = el('div', 'cw-toast')
  toast.setAttribute('role', 'status')

  const body = el('div', 'cw-body')
  body.append(stage, controls, timeline, exportBox, calls, keys)
  root.replaceChildren(header, empty, body, toast)

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
  /** The app said it cannot encode the picture, since the page last asked. */
  let pictureFailed = false
  /** The picture's connection drew nothing here since it last drew. */
  let pictureBlocked = false
  /** A start of the app this page asked for is running. */
  let launching = false
  /** The app's most recent project while none is open, once asked for;
   *  `asked` is reset whenever the page leaves `no_project`. */
  let recent = { asked: false, project: null }
  /** Agent calls this page saw, newest first (`recordCall`). */
  let seenCalls = []

  const duration = () => state?.composition?.duration_us ?? 0
  const fps = () => state?.composition?.fps ?? { num: 30, den: 1 }
  const view = () => pageState({ link, editorRefused, state })
  const ready = () => view() === 'ready'

  function playheadUs() {
    const t = state?.transport
    if (!t) return 0
    if (!t.playing) return Math.min(duration(), t.t_us)
    return Math.min(duration(), t.t_us + (now() - transportAt) * 1000)
  }

  function paintView() {
    const v = view()
    root.dataset.state = v
    header.dataset.link = link
    body.hidden = v !== 'ready'
    empty.hidden = v === 'ready'
    empty.dataset.state = v
    const [title, text] = EMPTY_COPY[v] ?? [null, null]
    emptyTitle.textContent = title === null ? '' : strings[title]
    emptyTitle.hidden = title === null
    emptyBody.textContent = text === null ? '' : strings[text]
    emptyBody.hidden = text === null
    emptyWait.hidden = !['offline', 'connecting', 'opening'].includes(v)
    emptyFocus.hidden = v !== 'no_project'
    emptyStart.hidden = v !== 'offline' || typeof transport.launch !== 'function'
    emptyStart.disabled = launching
    emptyStart.textContent = launching ? strings.starting_app : strings.start_app
    if (v !== 'no_project') recent = { asked: false, project: null }
    else if (!recent.asked && typeof transport.recentProject === 'function') askRecent()
    emptyRecent.hidden = v !== 'no_project' || recent.project === null
    if (recent.project !== null) emptyRecent.textContent = fill(strings.open_recent, { name: recent.project.name })
    focus.disabled = link !== 'online'
    for (const b of [toStart, prev, play, next, toEnd]) b.disabled = v !== 'ready'
    paintStage()
  }

  function paintStage() {
    const exporting = exportRunning(state?.export ?? null)
    // A frame from before counts for nothing once the picture had to stop.
    if (!ready() || exporting) pictureShown = false
    const p = pictureState({
      exporting,
      wanted: pictureWanted,
      supported: pictureSupported,
      failed: pictureFailed,
      blocked: pictureBlocked,
      minimized: state?.window === 'minimized',
      shown: pictureShown,
    })
    stage.dataset.picture = p
    if (state?.composition) stage.style.aspectRatio = `${state.composition.width} / ${state.composition.height}`
    poster.hidden = p !== 'off'
    const message = {
      export: strings.picture_export, unsupported: strings.picture_unsupported, failed: strings.picture_failed,
      blocked: strings.picture_blocked, minimized: strings.picture_minimized, starting: strings.picture_starting,
    }[p]
    stageMessage.textContent = message ?? ''
    stageNote.hidden = message === undefined
    stageFocus.hidden = p !== 'minimized'
    stageRetry.hidden = p !== 'failed'
    stageTools.hidden = !pictureWanted
    copyPicture.hidden = !(p === 'live' || p === 'minimized')
    pip.hidden = !doc.pictureInPictureEnabled || !(p === 'live' || p === 'minimized')
  }

  function setPicture(on) {
    pictureWanted = on
    syncPicture()
  }

  /** Pulls the picture while the user wants it and can see it: in the tab,
   *  or popped out. An open picture keeps the app encoding, so a hidden tab
   *  lets go of it and asks again once shown. A failed picture is let go of
   *  too, and asked for again only by Try again. */
  function syncPicture() {
    const seen = !doc.hidden || doc.pictureInPictureElement != null
    const pull = pictureWanted && seen && !pictureFailed
    if (pull && picture === null) {
      pictureShown = false
      pictureFailed = false
      pictureBlocked = false
      picture = transport.openPicture({
        mount: pictureMount,
        shown() {
          if (pictureShown && !pictureBlocked) return
          pictureShown = true
          pictureFailed = false
          pictureBlocked = false
          paintStage()
        },
        blocked() {
          if (pictureBlocked) return
          pictureBlocked = true
          pictureShown = false
          paintStage()
        },
        failed() {
          pictureFailed = true
          pictureShown = false
          // Called from inside the decoder: let go of the stream once it returns.
          queueMicrotask(syncPicture)
          paintStage()
        },
      })
      pictureSupported = picture !== null
    } else if (!pull && picture !== null) {
      picture.close()
      picture = null
    }
    paintStage()
  }

  function paintText() {
    doc.documentElement.lang = strings.lang
    const project = state?.project?.name ?? null
    doc.title = project === null ? strings.title : `${project} – ${strings.title}`
    name.textContent = project ?? strings.title
    const c = state?.composition
    meta.textContent = project !== null && c ? `${c.width} × ${c.height}   ${Math.round((c.fps.num / c.fps.den) * 100) / 100} fps` : ''
    const titled = [
      [focus, strings.show_editor], [toStart, strings.to_start], [prev, strings.prev_frame],
      [next, strings.next_frame], [toEnd, strings.to_end], [copyPicture, strings.copy_picture],
      [pip, strings.pip], [hidePicture, strings.hide_picture],
    ]
    for (const [button, label] of titled) { button.title = label; button.setAttribute('aria-label', label) }
    emptyFocus.textContent = strings.show_editor
    stageFocus.textContent = strings.show_editor
    stageRetry.textContent = strings.picture_retry
    emptyWait.textContent = strings.waiting
    posterTitle.textContent = strings.picture_off_title
    posterBody.textContent = strings.picture_off_body
    showPicture.textContent = strings.show_picture
    keys.textContent = strings.keys
    timeline.setAttribute('aria-label', strings.timeline)
  }

  function paintTransport() {
    const playing = state?.transport?.playing === true
    play.replaceChildren(icon(playing ? 'pause' : 'play'))
    play.dataset.playing = String(playing)
    play.title = playing ? strings.pause : strings.play
    play.setAttribute('aria-label', play.title)
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
    const d = duration()
    timeNow.textContent = timecode(t, fps())
    timeEnd.textContent = timecode(d, fps())
    hud.textContent = timeNow.textContent
    playhead.hidden = d <= 0
    playhead.style.left = `${d > 0 ? (t / d) * 100 : 0}%`
  }

  function paintTimeline() {
    const d = duration()
    ruler.replaceChildren(...(d > 0 ? rulerTicks(d) : []).map((t) => {
      const mark = el('span', 'cw-tick', rulerLabel(t))
      mark.style.left = `${(t / d) * 100}%`
      if (t > 0 && t / d > TICK_LABEL_MAX) mark.dataset.unlabelled = 'true'
      return mark
    }))
    const drawn = timelineRows(state?.tracks ?? [])
    labels.replaceChildren(el('div', 'cw-label-spacer'), ...drawn.map((row) => el('div', 'cw-label', row.label)))
    if (drawn.length === 0) { rows.replaceChildren(el('p', 'cw-timeline-empty', strings.timeline_empty)); return }
    rows.replaceChildren(...drawn.map((row) => {
      const lane = el('div', 'cw-lane')
      lane.append(...row.clips.map((c) => {
        const node = el('div', 'cw-clip')
        node.append(el('span', 'cw-clip-label', c.label))
        node.dataset.layerId = c.layer_id
        node.dataset.kind = c.kind
        node.dataset.start = String(c.t_start_us)
        node.title = `${c.label}\n${timecode(c.t_start_us, fps())} – ${timecode(c.t_end_us, fps())}`
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
    exportBox.hidden = !exportShown(job)
    paintStage()
    if (exportBox.hidden) return
    const running = exportRunning(job)
    const percent = Math.round(job.progress * 100)
    exportBox.dataset.state = running ? 'running' : job.state
    ringFill.style.strokeDasharray = `${running ? percent : 100} 100`
    exportLabel.textContent = running ? fill(strings.exporting, { percent }) : job.state === 'completed' ? strings.export_done : strings.export_failed
    exportFile.textContent = job.filename
  }

  function ago(at) {
    const s = Math.max(0, Math.round((wallNow() - at) / 1000))
    if (s < 10) return strings.ago_now
    if (s < 60) return fill(strings.ago_seconds, { n: s })
    return fill(strings.ago_minutes, { n: Math.round(s / 60) })
  }

  function paintCalls() {
    calls.hidden = seenCalls.length === 0
    calls.replaceChildren(...seenCalls.map((c, i) => {
      const row = el('li', 'cw-call')
      row.dataset.state = c.state
      if (i > 0) row.dataset.older = 'true'
      const tool = c.tool.replaceAll('_', ' ')
      const text = c.state === 'running' ? strings.activity_running : c.state === 'error' ? strings.activity_error : strings.activity_done
      row.append(el('span', 'cw-call-mark'), el('span', 'cw-call-client', c.client), el('span', 'cw-call-text', fill(text, { tool })), el('span', 'cw-call-at', ago(c.at)))
      return row
    }))
  }

  function paintAll() {
    paintText()
    paintView()
    paintTimeline()
    paintTransport()
    paintExport()
    paintCalls()
  }

  /** What a control's answer means for the page. The transport tells `link`
   *  itself about a lost app or a refused key. */
  function answered(outcome) {
    if (outcome !== 'not_ready' || editorRefused) return
    editorRefused = true
    paintView()
  }

  let toastTimer = 0
  function say(text) {
    toast.textContent = text
    toast.dataset.shown = 'true'
    win?.clearTimeout(toastTimer)
    toastTimer = win?.setTimeout(() => { toast.dataset.shown = 'false' }, 2400) ?? 0
  }

  // Seeking, from the timeline or the buttons: the playhead moves at once,
  // and the app hears the latest position, one request at a time.
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
  function seek(t) {
    if (!ready() || duration() <= 0) return
    const at = Math.max(0, Math.min(duration(), Math.round(t)))
    state.transport = { ...state.transport, t_us: at }
    transportAt = now()
    paintPlayhead()
    seekNext = at
    if (!seekSending) void sendSeeks()
  }
  const stepFrames = (n) => seek(frameStartUs(frameAt(playheadUs(), fps()) + n, fps()))
  function togglePlay() {
    if (!ready()) return
    void transport.control({ action: state.transport.playing ? 'pause' : 'play' }).then(answered)
  }

  play.addEventListener('click', togglePlay)
  toStart.addEventListener('click', () => seek(0))
  toEnd.addEventListener('click', () => seek(duration()))
  prev.addEventListener('click', () => stepFrames(-1))
  next.addEventListener('click', () => stepFrames(1))
  const focusEditor = () => { void transport.control({ action: 'focus' }).then(answered) }

  emptyStart.addEventListener('click', async () => {
    if (launching) return
    launching = true
    paintView()
    const outcome = await transport.launch()
    launching = false
    paintView()
    if (outcome !== 'ok') say(strings.start_failed)
  })

  /** Asks once per stay on the start screen which project to offer. */
  function askRecent() {
    recent = { asked: true, project: null }
    const asked = recent
    void transport.recentProject().then((project) => {
      if (recent !== asked) return
      recent = { asked: true, project }
      paintView()
    })
  }
  emptyRecent.addEventListener('click', async () => {
    const project = recent.project
    if (project === null) return
    emptyRecent.disabled = true
    const outcome = await transport.openProject(project.path)
    emptyRecent.disabled = false
    if (outcome !== 'ok') say(fill(strings.open_recent_failed, { name: project.name }))
  })
  for (const b of [focus, emptyFocus, stageFocus]) b.addEventListener('click', focusEditor)
  showPicture.addEventListener('click', () => setPicture(true))
  hidePicture.addEventListener('click', () => setPicture(false))
  // Only a new request has the app start an encoder again after one failed.
  stageRetry.addEventListener('click', () => { pictureFailed = false; setPicture(false); setPicture(true) })
  doc.addEventListener('visibilitychange', syncPicture)

  copyPicture.addEventListener('click', () => {
    const canvas = pictureMount.querySelector('canvas')
    if (!canvas) return
    canvas.toBlob(async (blob) => {
      try {
        if (!blob) throw new Error('no picture')
        await win.navigator.clipboard.write([new win.ClipboardItem({ 'image/png': blob })])
        say(strings.picture_copied)
      } catch {
        // A frame sandboxed without clipboard permission refuses the write.
        say(strings.picture_copy_refused)
      }
    }, 'image/png')
  })

  pip.addEventListener('click', async () => {
    const canvas = pictureMount.querySelector('canvas')
    if (!canvas) return
    const video = el('video')
    video.muted = true
    video.srcObject = canvas.captureStream()
    // Closing the pop-out while the tab is hidden leaves nobody watching.
    video.addEventListener('leavepictureinpicture', syncPicture)
    await video.play()
    await video.requestPictureInPicture()
  })

  let dragging = false
  const timeUnder = (clientX) => {
    const box = lanes.getBoundingClientRect()
    return timeAt(clientX, box.left, box.width, duration())
  }
  lanes.addEventListener('pointerdown', (e) => {
    if (!ready() || duration() <= 0) return
    dragging = true
    lanes.setPointerCapture?.(e.pointerId)
    seek(timeUnder(e.clientX))
  })
  lanes.addEventListener('pointermove', (e) => {
    if (duration() <= 0) return
    const t = timeUnder(e.clientX)
    hover.style.left = `${(t / duration()) * 100}%`
    hoverLabel.textContent = timecode(t, fps())
    hover.dataset.shown = 'true'
    if (dragging) seek(t)
  })
  lanes.addEventListener('pointerleave', () => { hover.dataset.shown = 'false' })
  lanes.addEventListener('dblclick', (e) => {
    const clip = e.target.closest?.('.cw-clip')
    if (clip) seek(Number(clip.dataset.start))
  })
  const endDrag = () => { dragging = false }
  lanes.addEventListener('pointerup', endDrag)
  lanes.addEventListener('pointercancel', endDrag)

  function onKey(e) {
    if (!ready() || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.target?.closest?.('input, textarea, [contenteditable]')) return
    if (e.key === ' ' && !e.target?.closest?.('button')) { e.preventDefault(); togglePlay() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) seek(playheadUs() - 1e6); else stepFrames(-1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) seek(playheadUs() + 1e6); else stepFrames(1) }
    else if (e.key === 'Home') { e.preventDefault(); seek(0) }
    else if (e.key === 'End') { e.preventDefault(); seek(duration()) }
  }
  doc.addEventListener('keydown', onKey)
  /** Keeps each call's "n s ago" true while nothing new arrives. */
  const agoTimer = win?.setInterval(() => { if (seenCalls.length > 0) paintCalls() }, 10_000)

  function takeCall(activity) {
    seenCalls = recordCall(seenCalls, activity, wallNow())
    paintCalls()
  }

  paintAll()
  const stopTransport = transport.start({
    state(s) {
      const firstState = state === null
      state = s
      editorRefused = false
      transportAt = now()
      strings = stringsFor(s.language ?? env.locale)
      if (firstState && s.activity !== null) seenCalls = recordCall(seenCalls, s.activity, wallNow())
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
        takeCall(data)
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
      doc.removeEventListener('keydown', onKey)
      doc.removeEventListener('visibilitychange', syncPicture)
      win?.clearInterval(agoTimer)
      win?.clearTimeout(toastTimer)
    },
  }
}
