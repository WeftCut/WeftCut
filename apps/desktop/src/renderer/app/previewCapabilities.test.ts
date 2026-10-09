import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaSummary } from '../ipc';
import type { ProbeState } from '../render/exportReadiness';
import type { WebcodecsDecodeVerdict } from '../render/decoder/probeSourceDecodable';
import { PreviewCapabilities } from './previewCapabilities';

const media = (id = 'a', changes: Partial<MediaSummary> = {}) => ({
  id, kind: 'Video', path: `/${id}.mov`, size_bytes: 10, available: true,
  content_hash: 'hash-a', ...changes,
}) as MediaSummary;
function setup() {
  const memo = new Map<string, ProbeState>();
  const jobs: { media: MediaSummary; signal: AbortSignal; resolve: (v: WebcodecsDecodeVerdict) => void }[] = [];
  const verdict = vi.fn(), forget = vi.fn(), changed = vi.fn();
  const probe = vi.fn((media: MediaSummary, signal: AbortSignal) => new Promise<WebcodecsDecodeVerdict>(resolve => {
    jobs.push({ media, signal, resolve });
    signal.addEventListener('abort', () => resolve('unknown'), { once: true });
  }));
  const capabilities = new PreviewCapabilities({ memo, probe, verdict, forget, changed, available: () => true });
  const update = (...items: MediaSummary[]) => capabilities.update(new Map(items.map(m => [m.id, m])));
  return { capabilities, update, jobs, memo, probe, verdict, forget };
}
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('content-scoped preview capabilities', () => {
  it('carries evidence through coalesced hash-and-copy summaries only with a verified handoff', async () => {
    const t = setup(); t.update(media('a', { content_hash: null }));
    t.jobs[0]!.resolve('ok'); await flush();
    const destination = media('a', { path: '/workspace/a.mov' });
    expect(t.capabilities.decoded(destination)).toBe(false);
    t.capabilities.relocate({ media_id: 'a', from: '/a.mov', to: destination.path, content_hash: 'hash-a', size_bytes: 10 });
    expect(t.capabilities.decoded(destination)).toBe(true);
    t.update(destination);
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(t.capabilities.decoded(media('a', { path: destination.path, content_hash: 'different' }))).toBe(false);
    t.capabilities.clear();
  });
  it('survives hash refinement, relocation and unrelated summary updates while probing', async () => {
    const t = setup();
    t.update(media('a', { content_hash: null }));
    t.update(media());
    for (let i = 0; i < 20; i++) t.update(media('a', { path: '/workspace/Media/a.mov' }));
    expect(t.probe).toHaveBeenCalledTimes(1);
    expect(t.jobs[0]!.signal.aborted).toBe(false);
    t.jobs[0]!.resolve('ok'); await flush();
    expect(t.capabilities.decoded(media('a', { path: '/workspace/Media/a.mov' }))).toBe(true);
    t.capabilities.clear();
  });
  it.each([
    { content_hash: 'replacement' },
    { content_hash: null, path: '/different.mov' },
    { size_bytes: 11 },
  ])('invalidates real content changes: %j', async changes => {
    const t = setup(); t.update(media()); t.jobs[0]!.resolve('ok'); await flush();
    const next = media('a', changes);
    expect(t.capabilities.decoded(next)).toBe(false);
    t.update(next);
    expect(t.memo.get('a')).toBe('pending');
    expect(t.forget).toHaveBeenCalledWith('a');
    t.capabilities.clear();
  });
  it('does not publish stale results after replacement or project retirement', async () => {
    const t = setup(); t.update(media());
    t.update(media('a', { content_hash: 'new' }));
    t.jobs[0]!.resolve('unsupported'); await flush();
    expect(t.verdict).not.toHaveBeenCalled();
    t.capabilities.clear();
    t.jobs[1]!.resolve('ok'); await flush();
    expect(t.memo.size).toBe(0); expect(t.verdict).not.toHaveBeenCalled();
  });
  it('bounds concurrency, advances later files and retries unknown without condemning capability', async () => {
    vi.useFakeTimers(); const t = setup();
    t.update(media('a'), media('b'), media('c'));
    expect(t.jobs).toHaveLength(2);
    t.jobs[0]!.resolve('unknown'); await flush();
    expect(t.jobs).toHaveLength(3); expect(t.jobs[2]!.media.id).toBe('c');
    t.jobs[1]!.resolve('ok'); t.jobs[2]!.resolve('ok'); await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.jobs).toHaveLength(4); expect(t.jobs[3]!.media.id).toBe('a');
    t.jobs[3]!.resolve('ok'); await flush();
    expect([...t.memo.values()]).toEqual(['ok', 'ok', 'ok']);
    t.capabilities.clear();
  });
  it('revokes evidence for a missing source and probes a reappearing source', async () => {
    const t = setup(); t.update(media()); t.jobs[0]!.resolve('ok'); await flush();
    t.update(media('a', { available: false }));
    expect(t.capabilities.decoded(media())).toBe(false);
    t.update(media()); expect(t.jobs).toHaveLength(2); t.capabilities.clear();
  });
});
