// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSummary } from "../ipc";
import { mediaReadiness } from "./mediaReadiness";

const baseVideo = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  id: "m1",
  label: "clip.mp4",
  path: "C:/m/clip.mp4",
  kind: "Video",
  duration_us: 5_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 10_000_000,
  available: true,
  decode_route: { route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 },
  codec: "h264",
  pix_fmt: "yuv420p",
  ...over,
});


vi.mock('../bridge/ipc', () => ({ convertFileSrc: (path: string) => path }));
import { resolvePreviewSource } from '../render/decoder/resolvePreviewSource';
import { useAppSettingsStore } from '../settings/appSettingsStore';
import { useDecodeComponentStore } from '../settings/decodeComponentStore';
import { useProxyPrefStore } from '../state/proxyPreferenceStore';
import { markFfmpegUnusable, resetFfmpegCapabilitySession } from '../render/decoder/ffmpegCapability';
import { markWebcodecsUnusable, resetWebcodecsCapabilitySession } from '../render/decoder/webcodecsCapability';

beforeEach(() => {
  useAppSettingsStore.setState(s => ({ settings: { ...s.settings, decode_engine: 'auto' } }));
  useDecodeComponentStore.setState({ available: true });
  useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  resetFfmpegCapabilitySession(); resetWebcodecsCapabilitySession();
});
const ready = (m = baseVideo(), decoded = false) => mediaReadiness(m, resolvePreviewSource(m, decoded));
describe('actionability shares the actual playback resolution', () => {
  it('allows Standard on the original before hashing, copying or proxy generation', () => {
    expect(ready()).toEqual({ ready: true });
  });
  it('Lite waits for actual original evidence, even when a proxy job claims success', () => {
    useDecodeComponentStore.setState({ available: false });
    expect(ready()).toEqual({ ready: false, reason: 'proxy_pending' });
    expect(ready(baseVideo(), true)).toEqual({ ready: true });
  });
  it('does not confuse persisted proxy paths with user-selected playback sources', () => {
    useDecodeComponentStore.setState({ available: false });
    const m = baseVideo({ decode_route: { route: 'direct-export', quick_proxy: '/proxy.mp4' } });
    expect(ready(m).ready).toBe(false);
    useProxyPrefStore.setState({ preferProxies: true });
    expect(ready(m)).toEqual({ ready: true });
  });
  it('keeps using a playable original while a requested proxy is not yet available', () => {
    useProxyPrefStore.setState({ preferProxies: true });
    expect(ready()).toEqual({ ready: true });
  });
  it('blocks missing originals even if capability was previously successful', () => {
    expect(ready(baseVideo({ available: false }), true)).toEqual({ ready: false, reason: 'missing' });
  });
  it('responds to terminal engine failure and falls back to verified Lite', () => {
    markFfmpegUnusable('m1', 'failed');
    expect(ready().ready).toBe(false);
    expect(ready(baseVideo(), true).ready).toBe(true);
    markWebcodecsUnusable('m1', 'unsupported');
    expect(ready(baseVideo(), true)).toEqual({ ready: false, reason: 'unsupported' });
  });
  it('respects a pinned engine instead of trusting another engine capability', () => {
    useAppSettingsStore.setState(s => ({ settings: { ...s.settings, decode_engine: 'webcodecs' } }));
    expect(ready().ready).toBe(false);
    useAppSettingsStore.setState(s => ({ settings: { ...s.settings, decode_engine: 'ffmpeg' } }));
    useDecodeComponentStore.setState({ available: false });
    expect(ready(baseVideo(), true)).toEqual({ ready: false, reason: 'unsupported' });
  });
  it.each(['Audio', 'Image', 'Subtitle'])('permits available %s without waiting for background files', kind => {
    expect(mediaReadiness(baseVideo({ kind }))).toEqual({ ready: true });
  });
});
