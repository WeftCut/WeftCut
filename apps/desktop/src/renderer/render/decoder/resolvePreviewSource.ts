import type { MediaSummary } from '../../ipc';
import { convertFileSrc } from '../../bridge/ipc';
import { useAppSettingsStore } from '../../settings/appSettingsStore';
import { useDecodeComponentStore } from '../../settings/decodeComponentStore';
import { proxyIntent, useProxyPrefStore } from '../../state/proxyPreferenceStore';
import { quickProxyPath } from '../decodeRoute';
import { resolveDecodeEngine } from './decodeEngine';
import { isFfmpegUnusable } from './ffmpegCapability';
import { isWebcodecsUnusable } from './webcodecsCapability';
import { onDecodeCapabilityChange } from './capabilityChanges';

/** The common live gatherer for playback and actionability. A job's lifecycle
 * is deliberately not an input: only a usable source and engine grant access. */
export function resolvePreviewSource(media: MediaSummary, originalDecoded: boolean) {
  const proxy = quickProxyPath(media);
  return resolveDecodeEngine({
    setting: useAppSettingsStore.getState().settings.decode_engine,
    componentAvailable: useDecodeComponentStore.getState().available,
    useProxySource: proxyIntent(media.id) && proxy !== null,
    proxyReady: proxy !== null,
    proxyUrl: proxy === null ? null : convertFileSrc(proxy),
    originalPath: media.path,
    originalUrl: convertFileSrc(media.path),
    webcodecsCanDecodeOriginal: isWebcodecsUnusable(media.id) ? 'fail' : originalDecoded ? 'ok' : 'untested',
    ffmpegUsable: !isFfmpegUnusable(media.id),
  });
}

export function onPreviewResolutionChange(notify: () => void): () => void {
  const stops = [
    useAppSettingsStore.subscribe((s, prev) => { if (s.settings.decode_engine !== prev.settings.decode_engine) notify(); }),
    useDecodeComponentStore.subscribe((s, prev) => { if (s.available !== prev.available) notify(); }),
    useProxyPrefStore.subscribe(notify),
    onDecodeCapabilityChange(notify),
  ];
  return () => stops.forEach(stop => stop());
}
