import type { Layer, MediaItem, Project } from './model'
import { eachLayer } from './model'
import { playsNoSoundError, resolvePauseSubject } from './pauseSubject'

/** MCP clip compute tools whose Rust handler takes one layer + its MediaItem
 *  (the `resolve_clip_audio_source` / `resolve_clip_video_source` inputs) as an
 *  injected slice; the TS actor (the sole state owner) resolves and forwards it.
 *  `detect_pauses` / `transcribe_clip` / `extract_clip_audio` read the layer's
 *  audio; `describe_clip` and `analyze_clip` read its video frames.
 *
 *  `detect_pauses` takes its slice from `resolvePauseComputeArgs` below rather
 *  than from `resolveClipSliceArgs`: it is the one tool whose slice is not the
 *  named layer (spec Decision 1). */
export const CLIP_SLICE_TOOLS: ReadonlySet<string> = new Set([
  'detect_pauses', 'transcribe_clip', 'describe_clip', 'analyze_clip', 'extract_clip_audio',
])

/** MCP clip compute tools shaped `{ a:{layer_id,t_us}, b:{layer_id,t_us} }` —
 *  TWO nested clip slices, not a top-level `layer_id`, so they can't ride
 *  `CLIP_SLICE_TOOLS`. `compare_frames` compares one frame from each side. */
export const TWO_SLICE_TOOLS: ReadonlySet<string> = new Set(['compare_frames'])

/** Resolve one layer id to its `{ layer, media }` slice from the actor snapshot.
 *  The MediaItem comes from the layer's params (VideoClip / Audio carry a `media`
 *  id). Missing layer/media → `null` — the Rust handler owns the structured
 *  not-found / not-analyzable error (single source of truth). */
function resolveLayerSlice(
  layerId: string,
  snapshot: Pick<Project, 'compositions' | 'media_pool'>,
): { layer: Layer | null; media: MediaItem | null } {
  let layer: Layer | null = null
  for (const e of eachLayer(snapshot)) if (e.layer.id === layerId) { layer = e.layer; break }
  const mediaId =
    layer && (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio')
      ? layer.params.media
      : null
  const media: MediaItem | null = mediaId ? snapshot.media_pool[mediaId] ?? null : null
  return { layer, media }
}

/** Resolve the `{ layer, media }` slice for a single-slice clip MCP tool from a
 *  top-level `layer_id` and merge it into the tool args. */
export function resolveClipSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'compositions' | 'media_pool'>,
): Record<string, unknown> {
  const { layer, media } = resolveLayerSlice((args as { layer_id?: string }).layer_id ?? '', snapshot)
  return { ...args, layer, media }
}

/** Resolve `detect_pauses`' slice: the SUBJECT Audio layer, its media, and the
 *  peaks file the detection must read.
 *
 *  Not `resolveClipSliceArgs`, because the named layer is not necessarily the
 *  one that plays — a VideoClip delegates to its linked audio (spec Decision 1)
 *  — and the detector's answer has to describe the samples the mixer will send.
 *  `peaks_path` follows the same principle one level down (Decision 11): when
 *  the subject's effect chain has a baked peaks sibling on disk, the bands the
 *  detection produces are read off the very file the timeline waveform draws,
 *  so the two can never disagree. `null` falls back to the media's own peaks
 *  rather than refusing, mirroring the tile fetch; export keeps its own strict
 *  gate.
 *
 *  A missing layer injects `layer: null` and lets Rust own the not-found
 *  refusal, exactly as the general resolver does. A layer with no subject is
 *  refused HERE instead: Rust accepts `Audio` only, so passing the VideoClip
 *  through would surface the host's own unresolved delegation as a wire-shape
 *  complaint about a layer kind the agent was invited to pass. */
export function resolvePauseComputeArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'compositions' | 'media_pool'>,
  peaksPathFor: (subjectLayerId: string) => string | null,
): Record<string, unknown> {
  const layerId = (args as { layer_id?: string }).layer_id ?? ''
  const resolved = resolvePauseSubject(layerId, snapshot)
  if (!resolved.ok) {
    if (resolved.reason === 'plays_no_sound') throw playsNoSoundError('detect_pauses', layerId, snapshot)
    return { ...args, layer: null, media: null, peaks_path: null }
  }
  const { subject } = resolved
  const mediaId = subject.params.kind === 'Audio' ? subject.params.media : null
  return {
    ...args,
    layer: subject,
    media: mediaId ? snapshot.media_pool[mediaId] ?? null : null,
    peaks_path: peaksPathFor(subject.id),
  }
}

/** Resolve BOTH nested clip slices for a two-slice tool: each of `a` / `b` gets
 *  its `{ layer, media }` injected from its own `layer_id`, same
 *  single-source-of-truth contract as `resolveClipSliceArgs` (missing → null,
 *  Rust produces the not-found / not-video error per side). */
export function resolveTwoSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'compositions' | 'media_pool'>,
): Record<string, unknown> {
  const resolveSide = (raw: unknown): Record<string, unknown> => {
    const side = (raw ?? {}) as Record<string, unknown>
    const { layer, media } = resolveLayerSlice((side as { layer_id?: string }).layer_id ?? '', snapshot)
    return { ...side, layer, media }
  }
  return {
    ...args,
    a: resolveSide((args as { a?: unknown }).a),
    b: resolveSide((args as { b?: unknown }).b),
  }
}
