import { layerRateNumber } from '../../layerTiming';
import type { AudioRole } from '../../ipc';
// Session-owned transport and preview audio. No Pixi, React, DOM, or visual
// readiness dependency. The independent timer replenishes Web Audio's sample-
// accurate schedule; presentation only reads the clock and observes commands.
import type { AudioView, ProjectSummary } from "../../ipc";
import { compositionOrRoot } from "../../ipc/compositions";
import { lastFrameAnchorUs } from "../../frames";
import { forEachLayer, instanceKey } from "../compositionWalk";
import { SyntheticClock } from "../clock";
import { AudioMixer } from "./AudioMixer";
import type { AudioGraph } from "./AudioGraph";
import { LOOKAHEAD_S } from "./chunkSchedule";
import { anyRoleSolo, auditionedRoleGainLinear, roleAudible } from "./roleGate";

export type PlaybackPhase = "paused" | "preparing" | "playing" | "error";
export interface PlaybackSnapshot {
  phase: PlaybackPhase;
  requestedPlaying: boolean;
  error: string | null;
}
export interface AudioTransportStats {
  preparationMs: number | null;
  maxPreparationMs: number;
  stopCommandMs: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
}
interface Entry {
  key: string;
  layerId: string;
  view: AudioView;
  startUs: number;
  endUs: number;
  gain: number;
  signature: string;
  url: string | null;
  mixer: AudioMixer | null;
}
export interface PreparedAudioStem { role: AudioRole; url: string; duration_us: number }
const PREPARE_US = 100_000;
const START_LEAD_S = 0.01;
const PREPARATION_TIMEOUT_MS = 10_000;
const SCHEDULE_MS = 16;

export class PreviewAudioEngine {
  private clock = new SyntheticClock();
  private state: PlaybackSnapshot = { phase: "paused", requestedPlaying: false, error: null };
  private summary: ProjectSummary | null = null;
  private targetId: string | null = null;
  private playableEndUs = 0;
  private entries = new Map<string, Entry>();
  private generation = 0;
  private stemSignature = '';
  private stems: PreparedAudioStem[] | null = null;
  private stemAbort = new AbortController();
  private stemPending: Promise<void> | null = null;
  private stemError: unknown = null;
  private requestAbort = new AbortController();
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private previewUs: number | null = null;
  private lastEmittedUs = -1;
  private stateListeners = new Set<(state: PlaybackSnapshot) => void>();
  private timeListeners = new Set<(tUs: number) => void>();
  private seekListeners = new Set<(tUs: number) => void>();
  private preparationMs: number | null = null;
  private maxPreparationMs = 0;
  private stopCommandMs: number | null = null;

  constructor(readonly graph: AudioGraph,
    private readonly resolveSource: (layerId: string, mediaId: string) => string | null,
    private readonly prepareStems?: (compositionId: string, signal: AbortSignal) => Promise<PreparedAudioStem[]>) {
    this.clock.bindAudio(graph.ctx);
  }

  snapshot(): PlaybackSnapshot { return this.state; }
  outputClockSnapshot(): import("../clock").ClockSyncSnapshot {
    if (this.state.phase === "playing") this.clock.tick();
    return this.clock.syncSnapshot();
  }
  isPlaying(): boolean { return this.state.phase === "playing"; }
  isPlayRequested(): boolean { return this.state.requestedPlaying; }
  positionUs(): number {
    if (this.previewUs !== null) return this.previewUs;
    if (this.graph.ctx.state === "running") this.clock.tick();
    return this.transportPositionUs();
  }
  private transportPositionUs(): number {
    const tUs = this.clock.positionUs();
    const comp = compositionOrRoot(this.summary, this.targetId);
    // Presentation can round onto the exclusive end before the raw clock
    // reaches it, or tick before the independent end timer. Hold the last
    // visible frame in both cases; leave the raw audio clock running so the
    // timer still stops at the actual end. Explicit paused seeks stay free.
    return this.isPlaying() && this.playableEndUs > 0 && comp
      ? Math.min(tUs, lastFrameAnchorUs(this.playableEndUs, comp.fps_num, comp.fps_den))
      : tUs;
  }
  onStateChange(cb: (state: PlaybackSnapshot) => void): () => void {
    this.stateListeners.add(cb); return () => this.stateListeners.delete(cb);
  }
  onTimeUpdate(cb: (tUs: number) => void): () => void {
    this.timeListeners.add(cb); return () => this.timeListeners.delete(cb);
  }
  onSeek(cb: (tUs: number) => void): () => void {
    this.seekListeners.add(cb); return () => this.seekListeners.delete(cb);
  }

  setProject(summary: ProjectSummary | null, targetId: string | null): void {
    if (this.disposed) return;
    const target = compositionOrRoot(summary, targetId)?.id ?? null;
    const replaced = summary?.project_id !== this.summary?.project_id;
    const retargeted = target !== this.targetId;
    if (replaced) {
      this.pause();
      this.clearEntries();
      this.clock.setPosition(0);
    } else if (retargeted) {
      const requested = this.state.requestedPlaying;
      this.invalidate();
      this.clearEntries();
      this.setState(requested ? "preparing" : "paused");
    }
    this.summary = summary;
    this.targetId = target;
    const composition = compositionOrRoot(summary, target);
    let endUs = 0;
    for (const track of composition?.tracks ?? []) if (track.enabled) {
      for (const layer of track.layers) if (layer.enabled) endUs = Math.max(endUs, layer.t_end_us);
    }
    this.playableEndUs = endUs || composition?.duration_us || 0;
    this.clock.bindFps(composition?.fps_num ?? 30, composition?.fps_den ?? 1);
    this.refresh();
  }

  /// Project edits, a baked artifact landing, and live Role faders all enter
  /// here. An unrelated visual edit keeps the existing audio schedule intact.
  refresh(): void {
    if (this.disposed) return;
    const next = new Map<string, Entry>();
    let changed = false;
    const roles = this.summary?.audio_roles ?? [];
    const solo = anyRoleSolo(roles);
    const retimed = !!this.prepareStems && !!this.summary && Object.values(this.summary.compositions).some(c =>
      c.tracks.some(t => t.layers.some(l => (l.params.kind === 'Audio' || l.params.kind === 'CompositionRef') &&
        (layerRateNumber(l.params) !== 1 || l.params.source_phase !== undefined))));
    if (retimed && this.summary && this.targetId) {
      const audioSources: unknown[] = [];
      forEachLayer(this.summary, this.targetId, ({ layer }) => { if (layer.params.kind === 'Audio') audioSources.push(this.resolveSource(layer.id, layer.params.media_id)); });
      const sig = JSON.stringify([this.summary.compositions, this.summary.audio_roles, audioSources, this.targetId]);
      if (sig !== this.stemSignature) {
        this.stemSignature = sig; this.stemAbort.abort(); this.stemAbort = new AbortController();
        this.stems = null; this.stemError = null;
        const signal = this.stemAbort.signal;
        this.stemPending = this.prepareStems!(this.targetId, signal).then(stems => {
          if (signal.aborted || this.disposed) return;
          this.stems = stems; this.refresh();
        }).catch(error => {
          if (signal.aborted || this.disposed) return;
          this.stemError = error;
          if (this.state.requestedPlaying) this.fail(this.generation, error);
        });
        if (this.state.requestedPlaying) { this.invalidate(); this.setState('preparing'); }
      }
      for (const stem of this.stems ?? []) {
        if (!roleAudible(stem.role, roles, solo)) continue;
        const key = 'retime:' + stem.role;
        const gain = auditionedRoleGainLinear(stem.role, roles);
        const view: AudioView = { media_id: key, media_label: key, src_in_us: 0, src_out_us: stem.duration_us,
          gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: stem.role };
        const signature = JSON.stringify([stem, gain]);
        const previous = this.entries.get(key);
        if (previous?.signature === signature) { next.set(key, previous); continue; }
        previous?.mixer?.dispose(); changed = true;
        next.set(key, { key, layerId: key, view, startUs: 0, endUs: stem.duration_us, gain, signature, url: stem.url, mixer: null });
      }
    } else {
      if (this.stemSignature) { this.stemAbort.abort(); this.stemSignature = ''; this.stems = null; this.stemPending = null; this.stemError = null; }
    }
    if (!retimed && this.summary && this.targetId) forEachLayer(this.summary, this.targetId, (placed) => {
      const { layer } = placed;
      if (layer.params.kind !== "Audio" || layer.params.mute || !roleAudible(layer.params.role, roles, solo)) return;
      const key = instanceKey(placed.path, layer.id);
      const view = placed.headUs === 0 && placed.tailUs === 0 ? layer.params : {
        ...layer.params, src_in_us: layer.params.src_in_us + placed.headUs,
        src_out_us: layer.params.src_out_us - placed.tailUs,
      };
      const gain = auditionedRoleGainLinear(view.role, roles);
      const signature = JSON.stringify([view, placed.tStartUs, placed.tEndUs, gain]);
      const previous = this.entries.get(key);
      const resolved = this.resolveSource(layer.id, view.media_id);
      // A temporary missing resolution retains the current artifact only when
      // it is still the SAME media. Never keep audio from a replaced source.
      const url = resolved ?? (previous?.view.media_id === view.media_id ? previous.url : null);
      if (previous && previous.url === url && previous.signature === signature) {
        next.set(key, previous);
        return;
      }
      changed = true;
      let mixer = previous?.mixer ?? null;
      if (previous && previous.url !== url) { mixer?.dispose(); mixer = null; }
      if (mixer && previous?.signature !== signature) mixer.updateView(view, placed.tStartUs, placed.tEndUs, gain);
      next.set(key, { key, layerId: layer.id, view, startUs: placed.tStartUs,
        endUs: placed.tEndUs, gain, signature, url, mixer });
    });
    for (const [key, entry] of this.entries) if (!next.has(key)) {
      changed = true;
      entry.mixer?.dispose();
    }
    this.entries = next;
    if (this.state.phase === "preparing") {
      if (changed || this.deadline === null) this.beginPlay();
    } else if (this.state.phase === "playing") {
      this.pump();
    } else {
      this.preload();
    }
  }

  play(): void {
    if (this.disposed || this.state.requestedPlaying || !this.summary) return;
    this.previewUs = null;
    const end = this.endUs();
    const comp = compositionOrRoot(this.summary, this.targetId)!;
    if (end > 0 && this.clock.positionUs() >= lastFrameAnchorUs(end, comp.fps_num, comp.fps_den)) {
      this.clock.setPosition(0);
      this.emitTime();
      this.emitSeek();
    }
    this.beginPlay();
  }

  pause(): void {
    if (this.disposed) return;
    const started = performance.now();
    if (this.graph.ctx.state === "running") this.clock.tick();
    const tUs = this.transportPositionUs();
    this.invalidate();
    // A manual pause can win the same race as a presentation tick.
    if (this.clock.positionUs() > tUs) this.clock.setPosition(tUs);
    this.stopCommandMs = performance.now() - started;
    this.setState("paused");
    this.emitTime();
  }

  seek(tUs: number, mode: "playhead" | "preview" = "playhead"): void {
    if (this.disposed || !Number.isFinite(tUs)) return;
    if (mode === "preview") {
      // An edit preview borrows the monitor; it does not move the transport
      // clock, cancel audio or publish a different editor Moment.
      this.previewUs = Math.max(0, tUs);
      this.emitSeek();
      return;
    }
    const resume = this.state.requestedPlaying;
    this.invalidate();
    this.previewUs = null;
    this.clock.setPosition(tUs);
    this.emitTime();
    this.emitSeek();
    if (resume) this.beginPlay();
    else { this.setState("paused"); this.preload(); }
  }

  private beginPlay(): void {
    this.invalidate();
    const generation = this.generation;
    this.setState("preparing");
    if (!this.current(generation)) return;
    const started = performance.now();
    this.deadline = setTimeout(() => this.fail(generation, new Error("Audio preparation timed out")), this.stemSignature ? 300_000 : PREPARATION_TIMEOUT_MS);
    void this.prepareStart(generation).then(() => {
      if (!this.current(generation)) return;
      this.clearDeadline();
      this.preparationMs = performance.now() - started;
      this.maxPreparationMs = Math.max(this.maxPreparationMs, this.preparationMs);
      this.clock.play(START_LEAD_S);
      this.schedule();
      this.setState("playing");
      if (!this.current(generation)) return;
      this.timer = setInterval(() => this.pump(), SCHEDULE_MS);
    }).catch((error: unknown) => this.fail(generation, error));
  }

  private async prepareStart(generation: number): Promise<void> {
    // Called directly from the gesture, before the first await (autoplay).
    const resumed = this.graph.resume();
    const ready = this.preparePcm(this.requestAbort.signal);
    await Promise.all([resumed, ready]);
    if (!this.current(generation)) return;
    if (this.graph.ctx.state !== "running") throw new Error("Audio output is not running");
  }

  private async preparePcm(signal: AbortSignal): Promise<void> {
    if (this.stemError) throw this.stemError;
    if (this.stemPending && !this.stems) await this.stemPending;
    signal.throwIfAborted();
    if (this.stemError) throw this.stemError;
    const tUs = this.clock.rawPositionUs();
    // Conform generation may still be in progress. Stay explicitly preparing
    // until the store supplies its URL, the deadline expires, or the request
    // is cancelled. A store update restarts preparation with the new snapshot.
    while (this.window(tUs, PREPARE_US).some((e) => !e.url)) {
      await new Promise<void>((resolve, reject) => {
        const cancel = (): void => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, SCHEDULE_MS);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
    signal.throwIfAborted();
    await Promise.all(this.window(tUs, PREPARE_US).map((e) => this.ensureMixer(e)!.prepare(tUs, PREPARE_US)));
  }

  private preload(): void {
    const tUs = this.clock.rawPositionUs();
    const active = new Set(this.window(tUs, LOOKAHEAD_S * 1_000_000));
    for (const entry of this.entries.values()) {
      if (!active.has(entry)) { entry.mixer?.dispose(); entry.mixer = null; continue; }
      const mixer = this.ensureMixer(entry);
      if (mixer) void mixer.prepare(tUs).catch(() => {}); // play observes/retries errors
    }
  }

  private ensureMixer(entry: Entry): AudioMixer | null {
    if (!entry.mixer && entry.url) {
      entry.mixer = new AudioMixer({ layerId: entry.key, conformUrl: entry.url,
        view: entry.view, layerTStartUs: entry.startUs, layerTEndUs: entry.endUs }, this.graph);
      entry.mixer.updateView(entry.view, entry.startUs, entry.endUs, entry.gain);
    }
    return entry.mixer;
  }

  private window(tUs: number, aheadUs: number): Entry[] {
    return [...this.entries.values()].filter((e) => e.endUs > tUs && e.startUs < tUs + aheadUs);
  }

  private pump(): void {
    if (this.disposed || this.state.phase !== "playing") return;
    try {
      if (this.graph.ctx.state !== "running") throw new Error("Audio output was interrupted");
      this.clock.tick();
      const end = this.endUs();
      if (end > 0 && this.clock.rawPositionUs() >= end) {
        const comp = compositionOrRoot(this.summary, this.targetId)!;
        this.invalidate();
        this.previewUs = null;
        this.clock.setPosition(lastFrameAnchorUs(end, comp.fps_num, comp.fps_den));
        this.setState("paused");
        this.emitTime();
        this.emitSeek();
        this.preload();
        return;
      }
      this.schedule();
      this.emitTime();
    } catch (error) { this.fail(this.generation, error); }
  }

  private schedule(): void {
    const tUs = this.clock.rawPositionUs();
    const active = new Set(this.window(tUs, LOOKAHEAD_S * 1_000_000));
    for (const entry of this.entries.values()) {
      if (active.has(entry)) {
        const mixer = this.ensureMixer(entry);
        mixer?.tick(tUs, true, entry.endUs, this.clock.getAnchor());
        // Sources ahead of the playhead must be opened/prepared independently
        // of video frames. A first open completes on a later microtask.
        if (mixer) {
          const generation = this.generation;
          void mixer.prepare(tUs).then(() => {
            if (this.current(generation) && this.state.phase === "playing" && this.entries.get(entry.key) === entry) {
              mixer.tick(this.clock.rawPositionUs(), true, entry.endUs, this.clock.getAnchor());
            }
          }).catch((error: unknown) => {
            if (this.entries.get(entry.key) === entry) this.fail(generation, error);
          });
        } else if (entry.startUs <= tUs) {
          throw new Error("Audio source is not ready");
        }
      } else if (entry.mixer) {
        entry.mixer.dispose(); entry.mixer = null;
      }
    }
  }

  private endUs(): number {
    return this.playableEndUs;
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private invalidate(): void {
    this.generation++;
    this.requestAbort.abort();
    this.requestAbort = new AbortController();
    this.clearDeadline();
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.clock.pause();
    for (const entry of this.entries.values()) entry.mixer?.stop();
  }
  private clearDeadline(): void {
    if (this.deadline !== null) { clearTimeout(this.deadline); this.deadline = null; }
  }
  private fail(generation: number, error: unknown): void {
    if (!this.current(generation)) return;
    if (this.graph.ctx.state === "running") this.clock.tick();
    this.invalidate();
    // A failed header/read must be retriable, not a permanently rejected
    // source promise retained behind a Play button that can never recover.
    for (const entry of this.entries.values()) { entry.mixer?.dispose(); entry.mixer = null; }
    this.setState("error", error instanceof Error ? error.message : String(error));
  }
  private setState(phase: PlaybackPhase, error: string | null = null): void {
    this.state = { phase, requestedPlaying: phase === "preparing" || phase === "playing", error };
    for (const cb of this.stateListeners) cb(this.state);
  }
  private emitTime(): void {
    const tUs = this.transportPositionUs();
    if (tUs === this.lastEmittedUs) return;
    this.lastEmittedUs = tUs;
    for (const cb of this.timeListeners) cb(tUs);
  }
  private emitSeek(): void { for (const cb of this.seekListeners) cb(this.positionUs()); }
  private clearEntries(): void {
    for (const entry of this.entries.values()) entry.mixer?.dispose();
    this.entries.clear();
  }
  stats(): AudioTransportStats {
    const ctx = this.graph.ctx;
    return { preparationMs: this.preparationMs, maxPreparationMs: this.maxPreparationMs,
      stopCommandMs: this.stopCommandMs,
      baseLatencyMs: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency * 1000 : null,
      outputLatencyMs: Number.isFinite(ctx.outputLatency) ? ctx.outputLatency * 1000 : null };
  }
  resetStats(): void { this.preparationMs = null; this.maxPreparationMs = 0; this.stopCommandMs = null; }
  dispose(): void {
    if (this.disposed) return;
    this.pause(); this.disposed = true; this.clearEntries(); this.graph.dispose();
    this.stateListeners.clear(); this.timeListeners.clear(); this.seekListeners.clear();
  }
}
