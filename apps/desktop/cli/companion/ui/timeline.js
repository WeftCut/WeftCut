// The companion page's timeline, as data: which rows it draws, where each clip
// sits along them, and the time under a pointer. `app.js` turns these into DOM.

/** One row per track in the editor's order, the last track on top (it draws
 *  over the ones below it). A track with nothing on it draws no row. A row of
 *  audio alone is labelled A, any other V, with the track's number. */
export function timelineRows(tracks) {
  const rows = []
  tracks.forEach((track, i) => {
    if (track.clips.length === 0) return
    const audio = track.clips.every((c) => c.kind === 'Audio')
    rows.push({ key: track.track_id, label: `${audio ? 'A' : 'V'}${i + 1}`, clips: track.clips })
  })
  return rows.reverse()
}

/** A clip's place on its row, in percent of the composition's duration. A clip
 *  too short to see keeps a sliver. */
export function clipBox(clip, durationUs) {
  const d = Math.max(1, durationUs)
  return {
    left: (clip.t_start_us / d) * 100,
    width: Math.max(MIN_CLIP_PERCENT, ((clip.t_end_us - clip.t_start_us) / d) * 100),
  }
}
const MIN_CLIP_PERCENT = 0.3

/** The time under `clientX` on a lane spanning `left`..`left + width`, clamped
 *  to the composition, in whole microseconds. */
export function timeAt(clientX, left, width, durationUs) {
  if (width <= 0) return 0
  const f = Math.min(1, Math.max(0, (clientX - left) / width))
  return Math.round(f * durationUs)
}

/** Ruler ticks: about six, at a round step. */
export function rulerTicks(durationUs) {
  const step = TICK_STEPS_US.find((s) => s >= durationUs / 6) ?? TICK_STEPS_US[TICK_STEPS_US.length - 1]
  const ticks = []
  for (let t = 0; t <= durationUs; t += step) ticks.push(t)
  return ticks
}
const TICK_STEPS_US = [1e6, 2e6, 5e6, 10e6, 15e6, 30e6, 60e6, 120e6, 300e6, 600e6, 1800e6, 3600e6]

/** A ruler label, `mm:ss`, minutes past 59 included. Ticks fall on whole
 *  seconds, so nothing finer is needed. */
export function rulerLabel(us) {
  const s = Math.floor(Math.max(0, us) / 1e6)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** The composition frame nearest `us`, at `fps` `{ num, den }`.
 *  LANDMINE: twin of `frameIndexRound` behind the editor's `formatTimecode`
 *  (renderer/frames.ts). The page cannot load the editor's wasm; doubles are
 *  exact here as long as `us * num` stays under 2^53 (a day at 60000/1001). */
export function frameAt(us, fps) {
  return Math.max(0, Math.round((us * fps.num) / (fps.den * 1e6)))
}

/** Where frame `index` starts, in whole microseconds. */
export function frameStartUs(index, fps) {
  return Math.round((index * fps.den * 1e6) / fps.num)
}

/** `HH:MM:SS:FF` as the editor's timecode reads it: non-drop-frame, the frame
 *  field counting to the rate rounded to a whole number. */
export function timecode(us, fps) {
  const frames = frameAt(us, fps)
  const perSecond = Math.max(1, Math.round(fps.num / fps.den))
  const secs = Math.floor(frames / perSecond)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(frames % perSecond)}`
}
