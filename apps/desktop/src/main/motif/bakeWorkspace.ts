import path from 'node:path';
import { MotifBakeCoordinator } from './baking';
import { MotifFrameStore, type FrameCodec } from './frameStore';
import type { MotifCaptureService } from './captureService';
import { hashCacheKey } from '../../shared/motifs/cacheKey';
import type { MotifBakePlan, MotifBakePause, MotifBakeSnapshot } from '../../shared/motifs/baking';

export interface BakeWorkspaceDeps {
  session(): { generation: number; root: string } | null;
  codec: FrameCodec;
  capture: MotifCaptureService;
  pause(): MotifBakePause | undefined;
  diskBytes(): number;
  retain(paths: string[]): void;
  publish(snapshot: MotifBakeSnapshot): void;
}

/** Binds queue, storage and disk retention to a Workspace session. No renderer
 * lifetime owns these jobs. Retention is registered before inventory/admission. */
export class MotifBakeWorkspace {
  private current: { generation: number; root: string; store: MotifFrameStore } | null = null;
  private sizes = new Map<string, Map<number, number>>();
  private inventoryChanges = new Map<string, Map<number, number | null>>();
  private live = new Set<string>();
  private writing = new Map<string, number>();
  private bootstrap = true;
  private revision = 0;
  readonly jobs: MotifBakeCoordinator;

  constructor(private readonly deps: BakeWorkspaceDeps) {
    this.jobs = new MotifBakeCoordinator({
      inventory: async content => {
        const session = this.requireSession();
        const changes = new Map<number, number | null>();
        this.inventoryChanges.set(content.hash, changes);
        try {
          const rows = await session.store.inventory(content.hash);
          if (this.current !== session) throw new Error('Motif workspace superseded');
          const sizes = new Map(rows.map(row => [row.frame, row.bytes]));
          // Foreground requests may persist or reject a cache read while disk
          // discovery awaits I/O. Its later events supersede the enumeration.
          for (const [frame, bytes] of changes) {
            if (bytes === null) sizes.delete(frame); else sizes.set(frame, bytes);
          }
          this.sizes.set(content.hash, sizes);
          return [...sizes.keys()];
        } finally {
          if (this.inventoryChanges.get(content.hash) === changes) this.inventoryChanges.delete(content.hash);
        }
      },
      persist: async (content, frame, wanted) => {
        const session = this.requireSession();
        const isCurrent = () => this.current === session && wanted() && this.deps.session()?.generation === session.generation;
        // Raw LZ4 worst case bounds the next write; existing compressed sizes
        // determine retained usage. No speculative pixel allocation occurs here.
        const raw = content.capture.width * content.capture.height * 4;
        const next = raw + Math.ceil(raw / 255) + 84;
        if (this.bytes() + next > this.deps.diskBytes()) {
          throw new Error('motif-disk-capacity: temporary cache space cannot retain the next frame');
        }
        this.writing.set(content.hash, (this.writing.get(content.hash) ?? 0) + 1);
        this.retain();
        try {
          await this.deps.capture.persist({ ...content.capture, tSec: frame * content.capture.fpsDen / content.capture.fpsNum,
            coalesceKey: `background:${session.generation}:${content.hash}:${frame}`, high: false,
            bake: { hash: content.hash, frame },
          }, isCurrent, session.store);
        } finally {
          if (this.current === session) {
            const remaining = (this.writing.get(content.hash) ?? 1) - 1;
            if (remaining) this.writing.set(content.hash, remaining); else this.writing.delete(content.hash);
            this.retain();
          }
        }
      },
      // Capacity belongs to each content: one large frame cannot prevent a
      // smaller one from using the remaining space. The coordinator backs off
      // individual disk waits without exhausting its finite failure budget.
      pause: () => this.deps.pause(),
      publish: snapshot => this.deps.publish(snapshot),
      collect: async live => {
        const session = this.requireSession();
        const revision = this.revision;
        const current = () => this.current === session && this.revision === revision
          && this.deps.session()?.generation === session.generation;
        await session.store.collect(live, current);
        if (current()) for (const hash of this.sizes.keys()) if (!live.has(hash)) this.sizes.delete(hash);
      },
      isContentFailure: error => /__motif(?:Setup|Render)|never became ready|invalid motif/i.test(String(error)),
    });
  }

  private bytes(): number {
    let sum = 0;
    for (const frames of this.sizes.values()) {
      for (const bytes of frames.values()) sum += bytes;
    }
    return sum;
  }
  private retain(): void {
    this.deps.retain(this.current ? this.bootstrap
      ? [path.join(this.current.root, 'Cache', 'raster')]
      : [...new Set([...this.live, ...this.writing.keys()])]
        .map(hash => path.join(this.current!.root, 'Cache', 'raster', hash)) : []);
  }
  private requireSession() {
    this.sync();
    if (!this.current) throw new Error('No workspace open for Motif preparation');
    return this.current;
  }
  sync(): void {
    const next = this.deps.session();
    if (!this.current && !next) return;
    if (this.current && next?.generation === this.current.generation && next.root === this.current.root) return;
    if (!next) { this.reset(); return; }
    this.revision++;
    this.bootstrap = true;
    this.live.clear(); this.writing.clear(); this.sizes.clear(); this.inventoryChanges.clear();
    const session = { ...next, store: null as unknown as MotifFrameStore };
    session.store = new MotifFrameStore(async () => next.root, this.deps.codec, (hash, frame, present, bytes) => {
      if (this.current !== session) return;
      let sizes = this.sizes.get(hash);
      if (!sizes) this.sizes.set(hash, sizes = new Map());
      if (present && bytes !== undefined) sizes.set(frame, bytes);
      if (!present) sizes.delete(frame);
      if (!present || bytes !== undefined) this.inventoryChanges.get(hash)?.set(frame, present ? bytes! : null);
      this.jobs.frameChanged(hash, frame, present);
    }, (hash, frame, bytes) => {
      if (this.current !== session || this.deps.session()?.generation !== session.generation) throw new Error('Motif workspace superseded');
      const previous = this.sizes.get(hash)?.get(frame) ?? 0;
      if (bytes <= previous) return; // Replacing an existing frame cannot worsen an over-target cache.
      // Before first discovery this accounts only observed writes; thereafter
      // inventory supplies existing sizes. The policy remains cooperative,
      // while every concurrent writer shares this exact admitted-byte check.
      if (this.bytes() - previous + bytes > this.deps.diskBytes()) {
        throw new Error('motif-disk-capacity: temporary cache space cannot retain the encoded frame');
      }
    });
    this.current = session;
    this.retain();
    this.jobs.reset(next.generation);
  }
  reset(): void {
    this.revision++;
    this.bootstrap = true;
    this.current = null;
    this.live.clear(); this.writing.clear(); this.sizes.clear(); this.inventoryChanges.clear();
    this.jobs.reset(-1);
    this.retain();
  }
  store(): MotifFrameStore { return this.requireSession().store; }
  async reconcile(plan: MotifBakePlan): Promise<MotifBakeSnapshot> {
    const session = this.requireSession();
    validateBakePlan(plan);
    if (plan.generation !== session.generation) throw new Error('Motif workspace superseded');
    const revision = ++this.revision;
    if (!plan.collect) this.bootstrap = true;
    this.live = new Set([...plan.live.map(item => item.hash), ...plan.contents.map(item => item.hash)]);
    this.retain();
    const snapshot = await this.jobs.reconcile(plan);
    if (this.current === session && this.revision === revision && plan.collect
      && [...plan.live, ...plan.contents].every(item => snapshot.coverage[item.cacheKey] !== undefined)) {
      this.bootstrap = false;
      this.retain();
    }
    return snapshot;
  }
  snapshot(): MotifBakeSnapshot { this.sync(); return this.jobs.snapshot(); }
  wake(): void { this.jobs.wake(); }
  dispose(): void { this.reset(); this.jobs.dispose(); }
}

export function validateBakePlan(plan: MotifBakePlan): void {
  const invalid = () => { throw new Error('Invalid Motif bake plan'); };
  if (!plan || !Number.isSafeInteger(plan.generation) || !Array.isArray(plan.contents) || !Array.isArray(plan.live)
    || plan.contents.length > 10000 || plan.live.length > 10000 || typeof plan.collect !== 'boolean') invalid();
  for (const keys of [plan.retryKeys, plan.promoteKeys]) if (keys !== undefined && (!Array.isArray(keys) || keys.length > 10000
    || keys.some(key => typeof key !== 'string' || key.length > 1_000_000))) invalid();
  for (const item of [...plan.live, ...plan.contents]) {
    if (!item || typeof item.cacheKey !== 'string' || item.cacheKey.length > 1_000_000 || item.hash !== hashCacheKey(item.cacheKey)) invalid();
  }
  for (const content of plan.contents) {
    const c = content.capture;
    if (!c || typeof c.motifId !== 'string' || typeof c.contentHash !== 'string' || typeof c.propsJson !== 'string'
      || !Number.isSafeInteger(content.contentFrames) || content.contentFrames < 1
      || (content.explicit !== undefined && typeof content.explicit !== 'boolean')
      || !Number.isSafeInteger(c.width) || c.width < 1 || c.width > 8192
      || !Number.isSafeInteger(c.height) || c.height < 1 || c.height > 8192
      || c.width * c.height * 4 > 256 * 1048576
      || !Number.isSafeInteger(c.fpsNum) || c.fpsNum <= 0 || !Number.isSafeInteger(c.fpsDen) || c.fpsDen <= 0
      || (c.settleRafs !== null && (!Number.isSafeInteger(c.settleRafs) || c.settleRafs < 0 || c.settleRafs > 120))
      || !Array.isArray(content.ranges) || content.ranges.length > 10000) invalid();
    let props: unknown;
    try { props = JSON.parse(c.propsJson); } catch { invalid(); }
    if (!props || typeof props !== 'object' || Array.isArray(props)) invalid();
    for (const range of content.ranges) if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 0 || range.end <= range.start || range.end > content.contentFrames) invalid();
  }
  if (plan.sequence !== undefined) {
    if (!Array.isArray(plan.sequence) || plan.sequence.length > 10000) invalid();
    const contents = new Map(plan.contents.map(c => [c.cacheKey, c]));
    for (const entry of plan.sequence) {
      const content = contents.get(entry?.cacheKey);
      if (!content || !Array.isArray(entry.ranges) || entry.ranges.length > 10000) invalid();
      for (const r of entry.ranges) if (!r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end)
        || !content!.ranges.some(allowed => r.start >= allowed.start && r.end <= allowed.end && r.end > r.start)) invalid();
    }
  }
}
