// The cross-process vocabulary of bake state: what the baker publishes, what a
// late subscriber gets, what the export gate answers, and how a baked waveform
// is keyed. One definition so main's baker, the renderer's mirror store and the
// export gate cannot drift.
//
// Types plus two pure string helpers — no runtime dependency at all, which is
// what lets both processes import it. Bake state is a DERIVATION, never
// persisted in the project (spec Decision 8): a stored path outlives the file
// it names. See ADR 0063 and docs/audio.md § Clip effects.

/// A bake that exists on disk and is playable. `sig` is the full digest;
/// `media_hash` rides along so a consumer can rebuild either sibling path
/// without re-reading the media item.
export interface AudioFxReady {
  sig: string;
  media_hash: string;
  audio_path: string;
  /** `null` while the waveform sibling has not been built yet (audio is ready, the picture is not). */
  peaks_path: string | null;
}

/// Why a bake failed. `effect_id` / `kind` are null when the failure belongs to
/// the chain as a whole (a missing conform, an ffmpeg refusal of the composed
/// graph) rather than to one effect — the export error says so instead of
/// blaming an arbitrary card.
export interface AudioFxError {
  message: string;
  effect_id: string | null;
  kind: string | null;
}

/// One layer's whole bake state. `ready` SURVIVES a later failure or a pending
/// re-bake on purpose: preview is stale-while-revalidate, so the last good
/// artifact keeps playing until a new one lands (spec Decision 9).
///
/// `desired_sig` null = the layer has no effective chain and plays the raw
/// conform. `pending` is the sig currently baking, null when idle.
export interface LayerFxState {
  desired_sig: string | null;
  ready: AudioFxReady | null;
  pending: string | null;
  error: AudioFxError | null;
}

/// The whole map, keyed by layer id — the answer to a boot-time or late
/// subscriber's snapshot request.
export type AudioFxSnapshot = Record<string, LayerFxState>;

/// One push. Carries the layer's FULL state, not a delta: the renderer store is
/// then a plain mirror, and a dropped event cannot leave it half-updated.
export interface AudioFxStatusEvent {
  layer_id: string;
  state: LayerFxState;
}

export const AUDIO_FX_STATUS_EVENT = "audio_fx:status";

/// The export gate's answer. `waiting` names the layers whose bake must land
/// before the mix is what the user heard; `failed` names the ones that never
/// will. Export gates and waits — it never falls back to the raw conform
/// silently (spec Decision 9), so a non-empty `failed` is an export error.
export interface EnsureExportAudioFxResult {
  waiting: string[];
  failed: Array<{
    layer_id: string;
    effect_id: string | null;
    kind: string | null;
    error: string;
  }>;
}

/// Waveform-tile keys are either a media id (raw conform) or this form (a baked
/// sibling). One key per artifact and artifacts are immutable, so a new bake is
/// simply new tiles — the tile engine needs no invalidation event.
const FX_WAVEFORM_KEY_RE = /^fx:([0-9a-f]+)\.fx-([0-9a-f]{16})$/;

export function fxWaveformKey(mediaHash: string, sig16: string): string {
  return `fx:${mediaHash}.fx-${sig16}`;
}

/// Inverse of `fxWaveformKey`; null for a media-id key (the raw-conform case)
/// or anything malformed, so a caller can branch on the shape alone.
export function parseFxWaveformKey(
  key: string,
): { mediaHash: string; sig16: string } | null {
  const m = FX_WAVEFORM_KEY_RE.exec(key);
  return m ? { mediaHash: m[1], sig16: m[2] } : null;
}
