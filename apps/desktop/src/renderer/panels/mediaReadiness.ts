import type { MediaSummary } from '../ipc';
import type { DecodeResolution } from '../render/decoder/decodeEngine';

// Job vocabulary for export/optimization, never a playback gate.
export type ProxyState = 'pending' | 'ready' | 'failed';
export type MediaReadiness = { ready: true } | {
  ready: false;
  reason: 'missing' | 'proxy_pending' | 'unsupported';
};
export const PREPARING_MEDIA: MediaReadiness = { ready: false, reason: 'proxy_pending' };

/** Pool, context menu and timeline consume this same verdict. Resolution comes
 * from the player's resolver; queue events cannot grant or revoke access. */
export function mediaReadiness(media: MediaSummary, resolution?: DecodeResolution): MediaReadiness {
  if (!media.available) return { ready: false, reason: 'missing' };
  if (media.kind !== 'Video') return { ready: true };
  if (resolution?.status === 'ok' && resolution.target) return { ready: true };
  if (resolution?.status === 'unsupported') return { ready: false, reason: 'unsupported' };
  return PREPARING_MEDIA;
}
