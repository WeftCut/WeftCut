// Synthetic clock with an audio-master derivation mode.
//
// Behavior (docs/audio.md §Clock):
//   - When an `AudioContext` is bound and RUNNING, the playing position is
//     DERIVED from the audio timeline against a `ClockAnchor` taken at
//     play/seek (or at the suspended→running flip): pure mapping, no
//     accumulation. Output timestamps interpolate between device quanta;
//     estimated output latency, then currentTime, are labelled fallbacks.
//     Scheduling uses currentTime; presentation uses estimated output time.
//   - Otherwise (no context, or suspended — e.g. before the first user
//     gesture under autoplay policy), the clock advances by
//     `performance.now()` deltas. The flip back to audio-derived
//     re-anchors from the CURRENT raw position, so switching sources
//     never jumps the playhead.
//
// The anchor type + mapping live in `audio/chunkSchedule.ts` — the same
// pair the session's AudioMixers schedule chunks against. The render and output
// projections share this mapping; neither feeds back into the scheduling anchor.
//
// Internal state `_rawTUs` is the unsnapped position. Externally
// observable `positionUs()` returns the value snapped to a
// composition-frame boundary — the storage invariant ("every observable
// TimeUs is on a comp-frame grid") extends through the playback engine.
//
// The export Worker has no clock at all — it iterates the exact-rational
// frame grid (`frameGrid.ts`); nothing here runs during export.

import { snapFrameRound } from "../frames";
import {
  type ClockAnchor,
  compUsAtCtxTime,
} from "./audio/chunkSchedule";

export interface ClockTickInfo {
  /// Current composition time in microseconds (snapped to comp frame).
  tUs: number;
  /// Delta in microseconds since the previous tick.
  dtUs: number;
}

export interface ClockSyncSnapshot {
  source: "output-timestamp" | "latency-estimate" | "render-clock" | "wall" | "paused";
  timestampAgeMs: number | null;
  renderCompUs: number | null;
  outputCompUs: number | null;
  /// Unsnapped, monotonic presentation position. May hold during an output
  /// latency increase; outputCompUs keeps exposing the actual estimate.
  presentationUs: number;
}

export class SyntheticClock {
  private _rawTUs = 0;
  private _playing = false;
  private _lastWallMs: number | null = null;
  private _audioCtx: AudioContext | null = null;
  private _anchor: ClockAnchor | null = null;
  private _sync: ClockSyncSnapshot = { source: "paused", timestampAgeMs: null,
    renderCompUs: null, outputCompUs: null, presentationUs: 0 };
  private _fpsNum = 30;
  private _fpsDen = 1;

  bindAudio(ctx: AudioContext | null): void {
    this._audioCtx = ctx;
    this._anchor = null;
    this.resetSync();
  }

  /// Bind the composition fps so `positionUs()` and `setPosition` can
  /// snap to frame. Called by the Compositor / PlaybackEngine on
  /// project load and on fps changes; before the first call, snap
  /// defaults to 30fps.
  bindFps(num: number, den: number): void {
    this._fpsNum = num > 0 ? num : 30;
    this._fpsDen = den > 0 ? den : 1;
  }

  play(startDelayS = 0): void {
    if (this._playing) return;
    this._playing = true;
    this._lastWallMs = performance.now();
    this.reanchor();
    if (this._anchor) this._anchor.ctxTime += startDelayS;
  }

  pause(): void {
    this._playing = false;
    this._lastWallMs = null;
    this._anchor = null;
    this.resetSync();
  }

  isPlaying(): boolean {
    return this._playing;
  }

  /// Hard-set the composition position. Called by `seek()`. Snaps on
  /// entry so external callers can't inject off-grid values. Re-anchors
  /// when playing so the audio-derived position continues from here.
  setPosition(tUs: number): void {
    this._rawTUs = Math.max(0, snapFrameRound(tUs, this._fpsNum, this._fpsDen));
    this._lastWallMs = this._playing ? performance.now() : null;
    this.resetSync();
    if (this._playing) this.reanchor();
  }

  positionUs(): number {
    return snapFrameRound(this._rawTUs, this._fpsNum, this._fpsDen);
  }

  /// Audio scheduling keeps sample precision; only the displayed moment is
  /// snapped to video frames.
  rawPositionUs(): number {
    return this._rawTUs;
  }

  syncSnapshot(): ClockSyncSnapshot {
    return { ...this._sync, presentationUs: this._rawTUs };
  }

  private resetSync(): void {
    this._sync = { source: this._playing ? "wall" : "paused", timestampAgeMs: null,
      renderCompUs: null, outputCompUs: null, presentationUs: this._rawTUs };
  }

  /// The live clock anchor, or null while paused / while the context
  /// isn't driving (suspended or unbound). PlaybackEngine forwards this
  /// to the Compositor; the AudioMixers schedule against the SAME pair.
  getAnchor(): ClockAnchor | null {
    return this._playing ? this._anchor : null;
  }

  /// Advance the clock to "now". Returns the new position + delta
  /// since the previous tick. Caller is expected to invoke once per rAF.
  tick(): ClockTickInfo {
    if (!this._playing) {
      return { tUs: this.positionUs(), dtUs: 0 };
    }
    const prevRaw = this._rawTUs;

    if (this.audioRunning()) {
      // Source flip (suspended→running, or first running tick after
      // play) re-anchors from the CURRENT raw position — the derivation
      // source changes, the position doesn't.
      if (this._anchor === null) this.reanchor();
      const outputTime = this.audioTime();
      this._sync.renderCompUs = compUsAtCtxTime(this._anchor!, this._audioCtx!.currentTime);
      this._sync.outputCompUs = compUsAtCtxTime(this._anchor!, outputTime);
      this._rawTUs = Math.max(
        prevRaw,
        this._sync.outputCompUs,
      );
      // Keep the wall timestamp fresh so a running→suspended flip
      // doesn't integrate a stale delta on its first wall tick.
      this._lastWallMs = performance.now();
    } else {
      this._anchor = null;
      this.resetSync();
      const nowMs = performance.now();
      const lastMs = this._lastWallMs ?? nowMs;
      this._lastWallMs = nowMs;
      this._rawTUs += Math.round((nowMs - lastMs) * 1000);
    }

    return { tUs: this.positionUs(), dtUs: this._rawTUs - prevRaw };
  }

  private audioRunning(): boolean {
    return this._audioCtx !== null && this._audioCtx.state === "running";
  }

  private reanchor(): void {
    // PCM is scheduled on the rendering timeline. Anchoring on outputTime
    // would schedule in the past and cancel the very latency we compensate.
    this._anchor = this.audioRunning()
      ? { compUs: this._rawTUs, ctxTime: this._audioCtx!.currentTime }
      : null;
  }

  private audioTime(): number {
    const ctx = this._audioCtx!;
    const renderTime = ctx.currentTime;
    let stamp: AudioTimestamp | undefined;
    try { stamp = ctx.getOutputTimestamp?.(); } catch { /* unavailable device */ }
    const contextTime = stamp?.contextTime ?? NaN;
    const ageMs = performance.now() - (stamp?.performanceTime ?? NaN);
    this._sync.timestampAgeMs = Number.isFinite(ageMs) ? ageMs : null;
    // A stale device stamp must not be extrapolated indefinitely. Latency
    // properties are explicitly estimates; never label that fallback measured.
    if (!Number.isFinite(contextTime) || contextTime <= 0
      || !Number.isFinite(ageMs) || ageMs < -10 || ageMs > 250) {
      const base = ctx.baseLatency;
      const output = ctx.outputLatency;
      if (Number.isFinite(base) && base >= 0 && Number.isFinite(output) && output >= 0) {
        this._sync.source = "latency-estimate";
        return Math.max(0, renderTime - base - output);
      }
      this._sync.source = "render-clock";
      return renderTime;
    }
    this._sync.source = "output-timestamp";
    return Math.min(renderTime, contextTime + ageMs / 1000);
  }
}
