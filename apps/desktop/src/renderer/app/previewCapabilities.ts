import type { MediaSummary } from '../ipc';
import type { ProbeState } from '../render/exportReadiness';
import type { WebcodecsDecodeVerdict } from '../render/decoder/probeSourceDecodable';
import type { MediaSourceRelocated } from '../../shared/media-source-relocated';

interface Entry { media: MediaSummary; abort?: AbortController; settled: boolean; retryAt: number; relocation?: MediaSourceRelocated }

/** Evidence belongs to content. A new hash refines the same source; a verified
 * equal hash permits relocation. Replacements retire evidence and work. */
export function samePreviewContent(a: MediaSummary, b: MediaSummary): boolean {
  if (a.size_bytes !== b.size_bytes) return false;
  if (a.content_hash && b.content_hash) return a.content_hash === b.content_hash;
  return a.path === b.path;
}

export class PreviewCapabilities {
  private entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = 0;
  constructor(private deps: {
    memo: Map<string, ProbeState>;
    probe: (media: MediaSummary, signal: AbortSignal) => Promise<WebcodecsDecodeVerdict>;
    verdict: (media: MediaSummary, verdict: WebcodecsDecodeVerdict) => void;
    forget: (id: string) => void;
    changed: () => void;
    available: () => boolean;
  }) {}

  decoded(media: MediaSummary): boolean {
    const entry = this.entries.get(media.id);
    return !!entry && this.matches(entry, media) && this.deps.memo.get(media.id) === 'ok';
  }

  relocate(proof: MediaSourceRelocated): void {
    const entry = this.entries.get(proof.media_id);
    if (entry && entry.media.path === proof.from && entry.media.size_bytes === proof.size_bytes &&
      (!entry.media.content_hash || entry.media.content_hash === proof.content_hash)) entry.relocation = proof;
  }

  private matches(entry: Entry, media: MediaSummary): boolean {
    const proof = entry.relocation;
    return samePreviewContent(entry.media, media) || !!proof && proof.to === media.path &&
      proof.content_hash === media.content_hash && proof.size_bytes === media.size_bytes;
  }

  update(pool: ReadonlyMap<string, MediaSummary>): void {
    for (const [id, entry] of this.entries) {
      const next = pool.get(id);
      if (!next || !next.available || !this.matches(entry, next)) {
        this.entries.delete(id);
        entry.abort?.abort();
        this.deps.memo.delete(id);
        this.deps.forget(id);
      } else entry.media = next;
    }
    for (const media of pool.values()) {
      if (media.kind === 'Video' && media.available && !this.entries.has(media.id)) {
        this.entries.set(media.id, { media, settled: false, retryAt: 0 });
      }
    }
    this.refresh();
  }

  refresh = (): void => {
    clearTimeout(this.timer);
    if (!this.deps.available()) return;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (this.active >= 2) break;
      if (entry.settled || entry.abort || entry.retryAt > now) continue;
      if (this.deps.memo.get(id) === 'ok') { entry.settled = true; continue; }
      const abort = entry.abort = new AbortController();
      this.active++;
      this.deps.memo.set(id, 'pending');
      void this.deps.probe(entry.media, abort.signal).catch(() => 'unknown' as const).then(verdict => {
        if (abort.signal.aborted || this.entries.get(id) !== entry) return;
        entry.settled = verdict !== 'unknown';
        entry.retryAt = verdict === 'unknown' ? Date.now() + 1000 : 0;
        if (verdict === 'ok') this.deps.memo.set(id, 'ok');
        else this.deps.memo.delete(id);
        this.deps.verdict(entry.media, verdict);
        this.deps.changed();
      }).finally(() => {
        this.active--;
        delete entry.abort;
        this.refresh();
      });
    }
    const retry = [...this.entries.values()].filter(e => !e.settled && !e.abort && e.retryAt > now);
    if (retry.length) this.timer = setTimeout(this.refresh, Math.max(1, Math.min(...retry.map(e => e.retryAt)) - now));
  };

  clear(): void {
    clearTimeout(this.timer);
    for (const [id, entry] of this.entries) {
      entry.abort?.abort();
      this.deps.forget(id);
    }
    this.entries.clear();
    this.deps.memo.clear();
  }
}
