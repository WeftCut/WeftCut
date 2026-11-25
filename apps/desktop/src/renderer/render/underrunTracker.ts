// Playback underrun detection — the signal behind the transport-bar
// indicator (and, later, res-throttle / stop-on-drop).
//
// The playback clock free-runs off the audio hardware clock and never
// waits for decode (industry-standard NLE transport; docs/render.md).
// When the decoder falls behind, the painter deliberately holds its
// previous frame (`ActiveClip.boundFramePtsUs`), so without this module
// the only trace of an underrun is a console log.
//
// Two independent causes of "playback isn't keeping up" — a stale ring
// (**dropped**) and a stalled composite loop (**late**) — counted
// separately because they point at different fixes. `UnderrunSnapshot`'s
// two count fields define what each one scores.
//
// Both drive one edge-triggered "active" flag safe to write straight
// into React state. This module owns neither the loop nor the ring:
// `Compositor` hands it the frame-selection verdict once per composite
// sweep, and the playback engine hands it each display frame's interval.

/// Slack added to the selected frame's presentation window before it
/// counts as stale. Absorbs ±1 µs rational-rounding jitter between the
/// comp-frame grid and source PTS grids without masking a real one-frame
/// lag.
const DURATION_JITTER_US = 1_000;

/// Freshness window when the source reported no per-frame duration
/// (WebCodecs may emit `duration: null`). Same scale as the ring's
/// `CLAMP_TO_FIRST_GAP_US`: generous enough for any real media frame
/// interval (24 fps ≈ 42 ms), small enough that a visible freeze
/// still trips it.
const FALLBACK_FRESH_GAP_US = 100_000;

/// Source times within this of the media's end are exempt from lateness:
/// a clip trimmed to (or past) the last media frame legitimately holds
/// that frame forever — EOS, not underrun. Sized around one low-fps
/// media frame so the exemption never hides more than the tail frame.
const EOS_GUARD_US = 50_000;

export type FrameVerdict = "fresh" | "late";

export interface FrameSelectionJudgeInput {
  /// PTS of the frame the painter bound, or null when the ring had
  /// nothing paintable (starved — the painter held its previous image).
  selectedPtsUs: number | null;
  /// Duration of the bound frame; `<= 0` means the source didn't report
  /// one and the fallback gap applies.
  selectedDurationUs: number;
  /// Requested source time (`src_in_us` + layer-local offset).
  srcTUs: number;
  /// Media duration for the EOS exemption; null disables it.
  mediaDurationUs: number | null;
}

/// Classify one painted VideoClip frame. "late" means a newer frame
/// should exist at `srcTUs` but the decoder hasn't produced it.
export function judgeFrameSelection(input: FrameSelectionJudgeInput): FrameVerdict {
  const { selectedPtsUs, selectedDurationUs, srcTUs, mediaDurationUs } = input;
  // EOS exemption first: past the end of real media there is no newer
  // frame to be late FOR. Checked before the starved branch so a clip
  // trimmed past EOS whose ring drained doesn't flag either.
  if (mediaDurationUs !== null && srcTUs + EOS_GUARD_US >= mediaDurationUs) {
    return "fresh";
  }
  if (selectedPtsUs === null) return "late";
  const gapUs = srcTUs - selectedPtsUs;
  // Negative gap = the ring clamped forward to its first entry (CTS /
  // edit-list offset) — the decoder is ahead, not behind.
  if (gapUs <= 0) return "fresh";
  if (selectedDurationUs > 0) {
    return srcTUs < selectedPtsUs + selectedDurationUs + DURATION_JITTER_US
      ? "fresh"
      : "late";
  }
  return gapUs <= FALLBACK_FRESH_GAP_US ? "fresh" : "late";
}

export interface UnderrunSnapshot {
  /// True while an underrun of EITHER cause was observed within the last
  /// `holdMs` — drives the indicator's "lit" state. Held on briefly after
  /// recovery so a flickering ring doesn't strobe the UI.
  active: boolean;
  /// Comp frames painted from a stale ring. `snapshot()` reports session
  /// totals; `onChange` reports the current indicator episode, cleared after
  /// three seconds without an observed problem (including while paused).
  droppedFrames: number;
  /// Comp frames composited after a display-frame gap long enough to show a
  /// comp frame late or skip it (`lateFrameThresholdMs`). Same lifecycle as
  /// `droppedFrames`; a stalled loop scores here and not there.
  lateFrames: number;
}

/// Both per-session counts, for the status-log row on pause.
export interface UnderrunSessionSummary {
  droppedFrames: number;
  lateFrames: number;
}

export interface UnderrunTrackerInit {
  /// Current indicator episode, separate from cumulative diagnostic totals.
  /// Edge-triggered + throttled observer. Fires immediately on
  /// inactive→active and active→inactive flips; count-only growth while
  /// active is coalesced to one emission per `minEmitIntervalMs`. Never
  /// fires when nothing changed — safe to feed straight into React state.
  /// (`| undefined` for exactOptionalPropertyTypes pass-through.)
  onChange?: ((snapshot: UnderrunSnapshot) => void) | undefined;
  /// How long `active` stays true after the last underrun of either cause.
  holdMs?: number;
  /// Cap on the post-seek grace window (see `noteSeekWhilePlaying`).
  graceMaxMs?: number;
  /// Minimum interval between count-growth emissions while active.
  minEmitIntervalMs?: number;
  /// Injectable clock for tests; defaults to `performance.now`.
  now?: () => number;
}

const DEFAULT_HOLD_MS = 1_500;
const INDICATOR_QUIET_MS = 3_000;
const DEFAULT_GRACE_MAX_MS = 1_000;
const DEFAULT_MIN_EMIT_INTERVAL_MS = 250;

/// Budget assumed until `bindFrameBudgetMs` learns the composition's fps
/// — matches `Compositor`'s own 30 fps default.
const DEFAULT_FRAME_BUDGET_MS = 1_000 / 30;

/// Display interval assumed until the cadence estimate has samples.
const FALLBACK_DISPLAY_INTERVAL_MS = 1_000 / 60;
/// Frame intervals the display-interval estimate is the median of (~2 s at
/// 60 Hz). A median, so the late frames being judged can't drag it.
const CADENCE_WINDOW = 120;
const CADENCE_MIN_SAMPLES = 8;
/// The display rate does not change frame to frame; re-sorting the window
/// on every frame would be pure cost on the composite path.
const CADENCE_REFRESH_EVERY = 30;
/// Margin when counting the refreshes that fit in one comp frame. Absorbs
/// the estimate's error where the comp frame is a whole number of
/// refreshes: 30 fps on a 59.94 Hz panel is 1.998 refreshes, which is two.
const REFRESH_COUNT_MARGIN = 0.1;

/// Frame interval past which a display frame counts as late. Only a gap
/// longer than one comp frame can show a comp frame late or skip it, and
/// gaps are whole display refreshes, so the threshold sits half a refresh
/// above the most refreshes that fit in one comp frame. Never below one
/// refresh: a composition faster than the display is late only when the
/// display misses a refresh.
export function lateFrameThresholdMs(budgetMs: number, displayIntervalMs: number): number {
  const refreshes = Math.max(1, Math.floor(budgetMs / displayIntervalMs + REFRESH_COUNT_MARGIN));
  return (refreshes + 0.5) * displayIntervalMs;
}

export class UnderrunTracker {
  private readonly onChange: ((s: UnderrunSnapshot) => void) | undefined;
  private readonly holdMs: number;
  private readonly graceMaxMs: number;
  private readonly minEmitIntervalMs: number;
  private readonly now: () => number;

  private active = false;
  private droppedFrames = 0;
  private lateFrames = 0;
  private clearedDroppedFrames = 0;
  private clearedLateFrames = 0;
  private quietUntilMs = 0;
  private pendingClear: UnderrunSessionSummary | null = null;
  private activeUntilMs = 0;
  private frameBudgetMs = DEFAULT_FRAME_BUDGET_MS;
  /// Comp time of the last frame counted as dropped, so a frame judged
  /// late on several rAF ticks (rAF runs faster than the comp grid)
  /// counts once.
  private lastDropFrameUs: number | null = null;
  /// The `lastDropFrameUs` twin for late ticks — same per-comp-frame
  /// dedupe, kept separate so one cause can't swallow the other's count.
  private lastLateFrameUs: number | null = null;
  /// Interval of the display frame being composited (`noteFrame`). Taken by
  /// the sweep that judges it and dropped by `tickDecay`, so a composite
  /// outside the frame loop (repaint, seek) never judges a stale one.
  private pendingFrameMs: number | null = null;
  private readonly cadence: number[] = [];
  private cadenceWriteIdx = 0;
  private cadenceSamples = 0;
  private displayIntervalMs = FALLBACK_DISPLAY_INTERVAL_MS;
  /// In-play seek grace: true while underruns of either cause are
  /// suppressed. Cleared by the first sweep that is both all-fresh and
  /// on time (pipeline re-primed) or by `graceDeadlineMs` (so genuinely
  /// wedged playback can't hide behind an eternal grace).
  private graceArmed = false;
  private graceDeadlineMs = 0;
  private lastEmitMs = -Infinity;
  private lastEmittedActive = false;
  private lastEmittedDropped = 0;
  private lastEmittedLate = 0;
  /// One-shot latch for `takeSessionSummary` — pause() fires
  /// unconditionally (including pause-during-warmup, where no new play
  /// session ever began), so without the latch a stale session's count
  /// would be re-reported.
  private sessionConsumed = false;

  constructor(init: UnderrunTrackerInit = {}) {
    this.onChange = init.onChange;
    this.holdMs = init.holdMs ?? DEFAULT_HOLD_MS;
    this.graceMaxMs = init.graceMaxMs ?? DEFAULT_GRACE_MAX_MS;
    this.minEmitIntervalMs = init.minEmitIntervalMs ?? DEFAULT_MIN_EMIT_INTERVAL_MS;
    this.now = init.now ?? (() => performance.now());
  }

  /// Teach the tracker the composition's frame budget. Called by
  /// `Compositor` wherever it recomputes `fpsNum`/`fpsDen`.
  bindFrameBudgetMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.frameBudgetMs = ms;
  }

  /// One display frame of the composite loop, before its composite runs.
  /// `intervalMs` is the gap between this frame's and the previous frame's
  /// begin times (rAF timestamps), not between the composites themselves:
  /// work that delays a callback but still meets the refresh is not late.
  noteFrame(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.pendingFrameMs = null;
      return;
    }
    this.pendingFrameMs = intervalMs;
    this.cadence[this.cadenceWriteIdx] = intervalMs;
    this.cadenceWriteIdx = (this.cadenceWriteIdx + 1) % CADENCE_WINDOW;
    this.cadenceSamples += 1;
    if (this.cadenceSamples === CADENCE_MIN_SAMPLES ||
      (this.cadenceSamples > CADENCE_MIN_SAMPLES && this.cadenceSamples % CADENCE_REFRESH_EVERY === 0)) {
      const sorted = [...this.cadence].sort((a, b) => a - b);
      this.displayIntervalMs = sorted[Math.floor(sorted.length / 2)]!;
    }
  }

  /// New play session (master clock released): reset counters so the
  /// indicator reflects THIS run, not history.
  beginPlay(): void {
    this.droppedFrames = 0;
    this.lateFrames = 0;
    this.clearedDroppedFrames = 0;
    this.clearedLateFrames = 0;
    this.quietUntilMs = 0;
    this.pendingClear = null;
    this.lastDropFrameUs = null;
    this.lastLateFrameUs = null;
    // An UNEXPIRED grace survives session start. play() arms the warm-up
    // gate up to 250 ms before the clock is released, and a seek inside
    // that window arms grace for exactly the ring rebuild the session will
    // open with — clearing it here (the old behavior) let that rebuild
    // score dropped+late frames the grace was armed against.
    const keepGrace = this.graceArmed && this.now() < this.graceDeadlineMs;
    this.active = false;
    this.activeUntilMs = 0;
    this.graceArmed = keepGrace;
    this.sessionConsumed = false;
    this.emit(true);
  }

  /// Arm the post-seek grace window. An in-play seek flushes the rings,
  /// so the following ~ring-rebuild interval — stale selections and the
  /// stalled ticks that rebuild causes alike — would otherwise score on
  /// every timeline click during playback.
  noteSeekWhilePlaying(): void {
    this.graceArmed = true;
    this.graceDeadlineMs = this.now() + this.graceMaxMs;
  }

  /// One verdict per composite sweep while the master clock is running.
  /// `anyLate` = at least one visible VideoClip painted from a stale ring;
  /// `frameUs` is the snapped comp time that was judged. The late half
  /// judges the interval `noteFrame` left for this composite, if any.
  judgeSweep(anyLate: boolean, frameUs: number): void {
    const nowMs = this.now();
    const frameMs = this.pendingFrameMs;
    this.pendingFrameMs = null;
    const tickLate =
      frameMs !== null &&
      frameMs > lateFrameThresholdMs(this.frameBudgetMs, this.displayIntervalMs);
    if (this.graceArmed) {
      if (!anyLate && !tickLate) {
        this.graceArmed = false; // pipeline re-primed; judge normally again
      } else if (nowMs < this.graceDeadlineMs) {
        return;
      } else {
        this.graceArmed = false; // grace expired with playback still behind
      }
    }
    if (!anyLate && !tickLate) return;
    // Cancel even if deduplication leaves both counters unchanged. The
    // confirmation must observe a quiet interval, not merely stable totals.
    this.pendingClear = null;
    if (anyLate && frameUs !== this.lastDropFrameUs) {
      this.lastDropFrameUs = frameUs;
      this.droppedFrames += 1;
    }
    if (tickLate && frameUs !== this.lastLateFrameUs) {
      this.lastLateFrameUs = frameUs;
      this.lateFrames += 1;
    }
    this.activeUntilMs = nowMs + this.holdMs;
    // Refresh even when frame deduplication did not increase a count: a
    // repeatedly stale image is still an ongoing problem.
    this.quietUntilMs = nowMs + Math.max(INDICATOR_QUIET_MS, this.holdMs);
    if (!this.active) {
      this.active = true;
      this.emit(true);
    } else {
      this.emit(false);
    }
  }

  /// Hold-off decay; called every composite (playing or not) so the
  /// indicator dims after the last underrun even once judging stops. Also
  /// drops a frame interval no sweep judged (paused, scrubbing, hidden).
  tickDecay(): void {
    const nowMs = this.now();
    this.pendingFrameMs = null;
    let changed = false;
    if (this.active && nowMs >= this.activeUntilMs) {
      this.active = false;
      changed = true;
    }
    if (!this.active && nowMs >= this.quietUntilMs &&
      (this.clearedDroppedFrames !== this.droppedFrames || this.clearedLateFrames !== this.lateFrames)) {
      const candidate = this.pendingClear;
      if (candidate && candidate.droppedFrames === this.droppedFrames && candidate.lateFrames === this.lateFrames) {
        // A later composite confirmed the same readings. Check and commit
        // synchronously, after that composite's judgeSweep; no timer/await can
        // clear a newly reported problem between these operations.
        this.clearedDroppedFrames = candidate.droppedFrames;
        this.clearedLateFrames = candidate.lateFrames;
        this.pendingClear = null;
        changed = true;
      } else {
        this.pendingClear = { droppedFrames: this.droppedFrames, lateFrames: this.lateFrames };
      }
    } else {
      this.pendingClear = null;
    }
    if (changed) this.emit(true);
  }

  snapshot(): UnderrunSnapshot {
    return {
      active: this.active,
      droppedFrames: this.droppedFrames,
      lateFrames: this.lateFrames,
    };
  }

  /// Session-end summary for the LogBus row, at most once per play
  /// session (zeroes on repeat calls until the next `beginPlay()`).
  takeSessionSummary(): UnderrunSessionSummary {
    if (this.sessionConsumed) return { droppedFrames: 0, lateFrames: 0 };
    this.sessionConsumed = true;
    return { droppedFrames: this.droppedFrames, lateFrames: this.lateFrames };
  }

  private emit(force: boolean): void {
    if (!this.onChange) return;
    const droppedFrames = this.droppedFrames - this.clearedDroppedFrames;
    const lateFrames = this.lateFrames - this.clearedLateFrames;
    const changed =
      this.active !== this.lastEmittedActive ||
      droppedFrames !== this.lastEmittedDropped ||
      lateFrames !== this.lastEmittedLate;
    if (!changed) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastEmitMs < this.minEmitIntervalMs) return;
    this.lastEmitMs = nowMs;
    this.lastEmittedActive = this.active;
    this.lastEmittedDropped = droppedFrames;
    this.lastEmittedLate = lateFrames;
    this.onChange({ active: this.active, droppedFrames, lateFrames });
  }
}
