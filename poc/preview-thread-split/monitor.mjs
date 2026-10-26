// Main-thread responsiveness: rAF interval (what a DOM playhead feels), long
// tasks, and a timer-cadence probe. Always runs on the main thread.
import { percentiles } from './pipeline.mjs'

export function startMonitor(win, playhead) {
  const raf = [], timer = []
  let longTasks = 0, longTaskMs = 0, longTaskMax = 0, last = 0, lastTimer = 0, stopped = false, frames = 0
  const po = new PerformanceObserver(list => { for (const e of list.getEntries()) if (win.sampling()) { longTasks++; longTaskMs += e.duration; longTaskMax = Math.max(longTaskMax, e.duration) } })
  try { po.observe({ type: 'longtask', buffered: false }) } catch { /* unsupported */ }
  function frame(now) {
    if (stopped) return
    frames++
    if (last && win.sampling()) raf.push(now - last)
    last = now
    if (playhead) playhead.style.transform = `translateX(${(win.sec() * 60) % 1264}px)`
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const iv = setInterval(() => { const now = performance.now(); if (lastTimer && win.sampling()) timer.push(now - lastTimer); lastTimer = now }, 16)
  return {
    stop() { stopped = true; clearInterval(iv); po.disconnect() },
    summary() {
      const r = percentiles(raf)
      return { rafIntervalMs: r, rafFramesOver50ms: raf.filter(v => v > 50).length, rafFramesOver100ms: raf.filter(v => v > 100).length, timerIntervalMs: percentiles(timer), longTasks, longTaskMs: +longTaskMs.toFixed(0), longTaskMaxMs: +longTaskMax.toFixed(0) }
    },
  }
}
