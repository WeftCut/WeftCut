// Pure main-side per-frame coordination timing for decode-bench signal
// attribution. The MAIN process sees both ends of the renderer round-trip — it
// passes on a session's `slot` message and receives its `release` — so it times
// that round-trip in its OWN clock, with no cross-process clock sync. No
// `electron` import, so this is unit-testable (see vitest.config.ts note); the
// session wiring lives in previewGpu.ts. One accumulator for every session.
import { msSummary } from '../shared/msStats'
import type { PreviewGpuTimingSummary } from '../shared/ipc'

/// Cap on retained samples; a 30s window at native frame rates stays far under it
/// (matches the Rust-side cap). Stop-appending once full.
const CAP = 20_000

const pendingSendMs = new Map<string, number>()
let rtSamplesMs: number[] = []

const key = (streamId: string, slot: number): string => `${streamId}:${slot}`

/// Stamp the moment main passed a `slot` message on to the renderer.
export function recordFrameReadySent(streamId: string, slot: number, nowMs: number): void {
  pendingSendMs.set(key(streamId, slot), nowMs)
}

/// On the matching `release`, record the renderer round-trip (main->renderer->main)
/// and clear the pending stamp. 1:1 by (streamId, slot); a release with no prior
/// send records nothing.
export function recordConsumeAck(streamId: string, slot: number, nowMs: number): void {
  const k = key(streamId, slot)
  const sent = pendingSendMs.get(k)
  if (sent === undefined) return
  pendingSendMs.delete(k)
  if (rtSamplesMs.length < CAP) rtSamplesMs.push(nowMs - sent)
}

/// Drain the accumulated round-trip samples into a summary and clear them.
export function takeMainTimings(): { rendererRoundTripMs: PreviewGpuTimingSummary } {
  const summary = msSummary(rtSamplesMs)
  rtSamplesMs = []
  return { rendererRoundTripMs: summary }
}

/// Drop any un-acked pending stamps for a stream (called on session close so a
/// frame in flight at teardown can't leak a Map entry).
export function clearMainPendingFor(streamId: string): void {
  const prefix = `${streamId}:`
  for (const k of pendingSendMs.keys()) {
    if (k.startsWith(prefix)) pendingSendMs.delete(k)
  }
}
