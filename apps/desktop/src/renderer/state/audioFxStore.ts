// Renderer mirror of the baker's per-layer audio bake state: one map, keyed by
// layer id, plus the pure reductions of it every consumer needs — the card's
// status line, the preview's audio source, the timeline's waveform key.
//
// Boundary: this module derives nothing the baker already decided, and reaches
// the IPC layer only through the callbacks `bootAudioFxStore` is handed — the
// reductions and the mirror itself stay pure. Bake state is never persisted
// (spec Decision 8) — a stored path outlives the file it names. See ADR 0063
// and docs/audio.md § Clip effects.
//
// React subscribers must use the ATOMIC selector hooks below (per
// `feedback_zustand_composite_selector` — never build an object in a selector).

import { create } from "zustand";
import {
  AUDIO_FX_STATUS_EVENT,
  fxWaveformKey,
  type AudioFxError,
  type AudioFxSnapshot,
  type AudioFxStatusEvent,
  type LayerFxState,
} from "../../shared/audioEffects/status";

/// What a card shows. `none` is the empty chain (the layer plays the raw
/// conform), `ready` the artifact the desired signature names, `failed` a bake
/// that will not land, `pending` everything in between.
export type AudioFxStatus = "none" | "pending" | "ready" | "failed";

interface State {
  layers: Record<string, LayerFxState>;
}

export const useAudioFxStore = create<State>(() => ({ layers: {} }));

/// Replace the whole map — the answer to a boot-time or late snapshot request.
export function hydrate(snapshot: AudioFxSnapshot): void {
  useAudioFxStore.setState({ layers: { ...snapshot } });
}

/// One layer's state, as published. An event carries the layer's FULL state
/// rather than a delta, so a dropped event cannot leave this mirror
/// half-updated — hence a plain overwrite, never a merge.
export function applyStatus(ev: AudioFxStatusEvent): void {
  useAudioFxStore.setState((s) => ({
    layers: { ...s.layers, [ev.layer_id]: ev.state },
  }));
}

/// Project close / switch. The baker rebuilds its map from scratch, so an
/// entry kept across the switch would name another project's artifact.
export function clear(): void {
  useAudioFxStore.setState({ layers: {} });
}

/// The four-way reduction of one layer's state. Order is load-bearing: a
/// SATISFIED desire reads `ready` even when a stale `error` is still attached,
/// because the baker keeps the last failure until the next bake supersedes it.
export function deriveStatus(state: LayerFxState | undefined): AudioFxStatus {
  if (!state || state.desired_sig === null) return "none";
  if (state.ready?.sig === state.desired_sig) return "ready";
  if (state.error !== null) return "failed";
  return "pending";
}

/// The audio a layer should PLAY, or null for the raw conform.
///
/// Stale-while-revalidate (spec Decision 9): the last ready artifact keeps
/// playing while a new bake runs and after one fails, so this deliberately
/// ignores both `pending` and `error`. Only an EMPTY effective chain — a null
/// desire — drops back to the raw conform, because then there is nothing the
/// user asked to hear.
export function readyAudioPath(state: LayerFxState | undefined): string | null {
  if (!state || state.desired_sig === null || !state.ready) return null;
  return state.ready.audio_path;
}

/// The waveform-tile key for the layer's processed audio, or null while the raw
/// conform's own key (the media id) is still the truthful one. Same
/// stale-while-revalidate rule as the audio path — the timeline shows the last
/// baked waveform rather than flicking back to raw mid-bake.
export function readyPeaksKey(state: LayerFxState | undefined): string | null {
  if (!state || state.desired_sig === null || !state.ready) return null;
  if (!state.ready.peaks_path) return null;
  return fxWaveformKey(state.ready.media_hash, state.ready.sig.slice(0, 16));
}

/// Imperative read for the non-React consumers of this map — the preview's
/// audio-source resolution runs inside a scene-graph node, not a component.
export function layerFxState(layerId: string): LayerFxState | undefined {
  return useAudioFxStore.getState().layers[layerId];
}

export const useAudioFxStatus = (layerId: string): AudioFxStatus =>
  useAudioFxStore((s) => deriveStatus(s.layers[layerId]));

/// The last failure, whether or not it is the layer's current status: a card
/// that shows `failed` needs the message, and nothing else reads this.
export const useAudioFxError = (layerId: string): AudioFxError | null =>
  useAudioFxStore((s) => s.layers[layerId]?.error ?? null);

export const useReadyPeaksKey = (layerId: string): string | null =>
  useAudioFxStore((s) => readyPeaksKey(s.layers[layerId]));

export const useReadyAudioPath = (layerId: string): string | null =>
  useAudioFxStore((s) => readyAudioPath(s.layers[layerId]));

// ===== Boot wiring =========================================================

export interface AudioFxBootDeps {
  /// Event subscription resolving to an unlisten fn — `@/bridge/events`'
  /// `listen`, narrowed to the one payload this mirror reads.
  listen: (
    event: string,
    handler: (e: { payload: AudioFxStatusEvent }) => void,
  ) => Promise<() => void>;
  /// The baker's whole map (`audioFxSnapshot`).
  snapshot: () => Promise<AudioFxSnapshot>;
  /// Subscribe to project IDENTITY changes, resolving to an unsubscribe. When
  /// wired, a switch re-seeds: the baker rebuilds its map from scratch on load,
  /// and a layer of the closed project left in this mirror would otherwise
  /// still name its artifact (`proxyPreferenceStore` re-hydrates on the same
  /// signal, for the same reason).
  onProjectSwitch?: (cb: () => void) => () => void;
}

/// Seed the mirror and keep it live. Call once at app boot; returns the
/// unsubscribe.
///
/// The listener is registered BEFORE the seed read and pushes that arrive while
/// the read is in flight are re-applied ON TOP of it: the snapshot is the older
/// value of the two, so letting it win would resurrect a state the baker has
/// already superseded, and skipping the pre-seed window entirely would drop the
/// push for good (nothing re-sends it).
export async function bootAudioFxStore(
  deps: AudioFxBootDeps,
): Promise<() => void> {
  let seeded = false;
  const duringSeed = new Map<string, LayerFxState>();
  const unlisten = await deps.listen(AUDIO_FX_STATUS_EVENT, (e) => {
    if (!seeded) duringSeed.set(e.payload.layer_id, e.payload.state);
    applyStatus(e.payload);
  });
  const seed = async (reseeding: boolean): Promise<void> => {
    let snapshot: AudioFxSnapshot;
    try {
      snapshot = await deps.snapshot();
    } catch {
      // No project open, or the baker isn't started. On a SWITCH that means the
      // previous project's entries have to go: they name artifacts of a project
      // nothing is playing any more. At boot there is nothing to drop, and
      // whatever the live pushes delivered stands.
      if (reseeding) clear();
      seeded = true;
      return;
    }
    seeded = true;
    hydrate({ ...snapshot, ...Object.fromEntries(duringSeed) });
    duringSeed.clear();
  };
  await seed(false);
  const unsubProject = deps.onProjectSwitch?.(() => {
    seeded = false;
    duringSeed.clear();
    void seed(true);
  });
  return () => {
    unlisten();
    unsubProject?.();
  };
}
