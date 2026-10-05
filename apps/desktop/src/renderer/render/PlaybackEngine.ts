// Visual attachment to the session transport. Destroying this attachment only
// releases Pixi callbacks: the audio clock and schedule outlive the panel.
import { UPDATE_PRIORITY, type Ticker } from "pixi.js";
import type { Compositor } from "./Compositor";
import type { PreviewAudioEngine } from "./audio/PreviewAudioEngine";
import { ScrubCoalescer } from "./decoder/scrub";
import { STAGE, stageAdd, stageFrameBegin, stageFrameEnd, stageNow } from "./perf/stageTimers";

export interface PlaybackEngineInit {
  compositor: Compositor;
  ticker: Ticker;
  audio: PreviewAudioEngine;
}
export type WarmupReason = "audio-ready";
export interface WarmupStats {
  lastMs: number | null;
  maxMs: number;
  lastReason: WarmupReason | null;
  stopCommandMs: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
}

export class PlaybackEngine {
  private readonly compositor: Compositor;
  private readonly ticker: Ticker;
  private readonly audio: PreviewAudioEngine;
  private readonly scrubCoalescer: ScrubCoalescer;
  private readonly cleanups: Array<() => void> = [];
  constructor(init: PlaybackEngineInit) {
    this.compositor = init.compositor;
    this.ticker = init.ticker;
    this.audio = init.audio;
    this.compositor.setOutputClock(() => this.audio.outputClockSnapshot());
    this.scrubCoalescer = new ScrubCoalescer({ debounceMs: 50, maxWaitMs: 180,
      onStableSeek: async (tUs) => {
        this.compositor.setScrubbing(false);
        this.compositor.setAnchorTime(tUs);
        this.compositor.compositeFrame(tUs);
      },
    });
    this.cleanups.push(this.audio.onStateChange((state) => {
      this.compositor.setMasterPlayState(state.phase === "playing");
      if (state.requestedPlaying) {
        this.scrubCoalescer.cancel();
        this.compositor.setScrubbing(false);
      }
    }));
    this.cleanups.push(this.audio.onSeek((tUs) => {
      if (this.audio.isPlayRequested()) this.compositor.noteSeekWhilePlaying();
      this.compositor.setScrubbing(true);
      this.compositor.compositeFrame(tUs);
      this.scrubCoalescer.requestSeek(tUs);
    }));
    this.compositor.setMasterPlayState(this.audio.isPlaying());
    this.ticker.add(this.tick, this, UPDATE_PRIORITY.HIGH);
  }
  isPlaying(): boolean { return this.audio.isPlaying(); }
  isPlayRequested(): boolean { return this.audio.isPlayRequested(); }
  positionUs(): number { return this.audio.positionUs(); }
  play(): void { this.audio.play(); }
  pause(): void { this.audio.pause(); }
  seek(tUs: number, mode: "playhead" | "preview" = "playhead"): void { this.audio.seek(tUs, mode); }
  onPlayStateChange(cb: (playing: boolean) => void): () => void {
    let playing = this.audio.isPlaying();
    const unsubscribe = this.audio.onStateChange((state) => {
      const next = state.phase === "playing";
      if (playing !== next) { playing = next; cb(next); }
    });
    this.cleanups.push(unsubscribe);
    return unsubscribe;
  }
  getWarmupStats(): WarmupStats {
    const s = this.audio.stats();
    return { lastMs: s.preparationMs, maxMs: s.maxPreparationMs,
      lastReason: s.preparationMs === null ? null : "audio-ready",
      stopCommandMs: s.stopCommandMs, baseLatencyMs: s.baseLatencyMs, outputLatencyMs: s.outputLatencyMs };
  }
  getAudioMeter() { return this.audio.graph.meterSnapshot(); }
  resetWarmupStats(): void { this.audio.resetStats(); }
  dispose(): void {
    this.compositor.setOutputClock(null);
    this.ticker.remove(this.tick, this);
    this.scrubCoalescer.cancel();
    for (const cleanup of this.cleanups) cleanup();
  }
  private tick = (): void => {
    const t0 = stageFrameBegin(this.ticker.lastTime + this.ticker.elapsedMS);
    try {
      const start = stageNow();
      const tUs = this.audio.positionUs();
      stageAdd(STAGE.ClockTick, start);
      const anchor = stageNow();
      this.compositor.setAnchorTime(tUs);
      stageAdd(STAGE.Anchor, anchor);
      this.compositor.compositeFrame(tUs);
    } catch (error) {
      console.error("[weftcut/pixi] presentation tick failed:", error);
    } finally { stageAdd(STAGE.TickTotal, t0); stageFrameEnd(); }
  };
}
