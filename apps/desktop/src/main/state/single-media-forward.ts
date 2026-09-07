import type { MediaItem } from './model'

/** Channels whose Rust fn takes one MediaItem as a call argument; the TS actor
 *  (the sole state owner) resolves it by `mediaId` and forwards it. */
export const SINGLE_MEDIA_CHANNELS: ReadonlySet<string> = new Set([
  'get_media_thumbnail', 'get_waveform_peaks',
  'get_waveform_levels', 'get_waveform_tile', 'get_filmstrip_tile', 'ensure_full_proxy', 'ensure_conform', 'generate_quick_proxy',
])

/** The two channels that read a peaks file, and therefore the two that carry a
 *  `waveformKey`. */
export const WAVEFORM_KEY_CHANNELS: ReadonlySet<string> = new Set([
  'get_waveform_levels', 'get_waveform_tile',
])

/** A waveform key naming a baked effect-chain sibling rather than a media id
 *  (`shared/audioEffects/status.ts` `fxWaveformKey`). */
const FX_KEY_PREFIX = 'fx:'

/** Map renderer `{ mediaId, ...rest }` args to `{ item, ...rest }` the Rust fn
 *  now expects — `rest` carries channel-specific args (e.g. a tile request's
 *  level/channel/range) straight through untouched. Throws
 *  `media {id} not found` when the pool has no such item. */
export function resolveSingleMediaArgs(
  args: { mediaId?: string } & Record<string, unknown>,
  pool: Record<string, MediaItem>,
): { item: MediaItem } & Record<string, unknown> {
  const { mediaId, ...rest } = args
  const id = mediaId ?? ''
  const item = pool[id]
  if (!item) throw new Error(`media ${id} not found`)
  return { item, ...rest }
}

/** Resolve the renderer's `waveformKey` into the explicit `waveformPath` Rust
 *  reads instead of the media item's own peaks file.
 *
 *  A media-id key (the default) is simply dropped: Rust then falls back to
 *  `item.waveform_path`, which is the raw-conform waveform. An `fx:` key goes
 *  to the baker, which owns the signature-keyed path — artifact paths are
 *  derivations, never persisted state (spec Decision 8).
 *
 *  An `fx:` key the baker cannot resolve (malformed, or the peaks sibling
 *  evicted) raises the same `not_ready` a media with no waveform yet does. That
 *  is deliberate: the renderer already drops to the media-id key on `not_ready`,
 *  so the processed waveform degrades to the raw one instead of drawing a
 *  DIFFERENT clip's peaks, which is what silently reusing `item.waveform_path`
 *  here would look like. See ADR 0063. */
export function resolveWaveformKeyArg(
  args: Record<string, unknown>,
  resolveFxKey: (key: string) => string | null,
): Record<string, unknown> {
  const { waveformKey, ...rest } = args
  if (typeof waveformKey !== 'string' || !waveformKey.startsWith(FX_KEY_PREFIX)) return rest
  const waveformPath = resolveFxKey(waveformKey)
  if (waveformPath === null) throw new Error('not_ready')
  return { ...rest, waveformPath }
}
