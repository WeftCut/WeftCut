// Session transport registry and observable actual state. Commands work with
// no Preview panel mounted. UI toggles use requestedPlaying so a second Play
// gesture cancels preparation; playing is true only after audio is running.

import { create } from "zustand";
import type { PlaybackPhase, PlaybackSnapshot } from "../render/audio/PreviewAudioEngine";

/// Commands exposed by the editor session. Preview edits may borrow the
/// monitor with mode="preview" without changing the session Moment.
export interface TransportHandle {
  /// `untilUs`: pause on the last frame before it (exclusive, this clock). A
  /// later play, pause or playhead seek drops the bound.
  play(untilUs?: number): void;
  pause(): void;
  seek(tUs: number, mode?: "playhead" | "preview"): void;
  isPlaying(): boolean;
}

interface State {
  /// Live session transport, or null outside the editor.
  transport: TransportHandle | null;
  /// Actual running state; preparing is represented separately.
  playing: boolean;
  requestedPlaying: boolean;
  phase: PlaybackPhase;
  error: string | null;
}

export const usePlaybackStore = create<State>(() => ({
  transport: null,
  playing: false,
  requestedPlaying: false,
  phase: "paused",
  error: null,
}));

/// Registered by the editor session, replaced on project/session changes.
export function registerTransport(handle: TransportHandle): void {
  usePlaybackStore.setState({ transport: handle });
  setTransportPlaying(handle.isPlaying());
}

/// Identity-guarded session cleanup cannot release a newer registration.
export function releaseTransport(handle: TransportHandle): void {
  if (usePlaybackStore.getState().transport !== handle) return;
  usePlaybackStore.setState({ transport: null });
  setTransportPlaying(false);
}

/// Seed a simple stopped/running registration. Subsequent updates carry the
/// full snapshot, including preparation and errors.
export function setTransportPlaying(playing: boolean): void {
  setTransportSnapshot({ phase: playing ? "playing" : "paused", requestedPlaying: playing, error: null });
}

export function setTransportSnapshot(snapshot: PlaybackSnapshot): void {
  usePlaybackStore.setState({ ...snapshot, playing: snapshot.phase === "playing" });
}

/// Safe no-ops when there is no editor session.
export function transportPlay(untilUs?: number): void {
  usePlaybackStore.getState().transport?.play(untilUs);
}

export function transportPause(): void {
  usePlaybackStore.getState().transport?.pause();
}

export function transportSeek(tUs: number): void {
  usePlaybackStore.getState().transport?.seek(tUs);
}

/// Atomic hook for React subscribers (primitive → no useSyncExternalStore
/// loop, re-renders only on actual play/pause flips).
export const usePlaybackPlaying = (): boolean =>
  usePlaybackStore((s) => s.playing);
