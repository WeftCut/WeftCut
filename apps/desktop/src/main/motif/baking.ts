import type { MotifBakeContent, MotifBakePause, MotifBakePlan, MotifBakeSnapshot, MotifBakeStatus, MotifFrameRange } from '../../shared/motifs/baking';
import { isResourceCapacityError } from '../../shared/resource-policy';

export interface MotifBakeCoordinatorDeps {
  inventory(content: { cacheKey: string; hash: string }): Promise<number[]>;
  persist(content: MotifBakeContent, frame: number, isCurrent: () => boolean): Promise<void>;
  pause(): MotifBakePause | undefined;
  publish(snapshot: MotifBakeSnapshot): void;
  collect?(liveHashes: ReadonlySet<string>): Promise<void>;
  isContentFailure?(error: unknown): boolean;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): () => void;
}

interface ContentState {
  cacheKey: string;
  hash: string;
  content?: MotifBakeContent;
  frames: Set<number>;
  hydrated: boolean;
  status: MotifBakeStatus;
  cursor: number;
  failures: number;
  retryAt: number;
}

function ranges(content: MotifBakeContent): MotifFrameRange[] {
  const sorted = content.ranges.map(r => ({ start: Math.max(0, Math.ceil(r.start)), end: Math.min(content.contentFrames, Math.floor(r.end)) }))
    .filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: MotifFrameRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/** One workspace's persistent Motif demand. Capture remains serialized by the
 * capture host; this module owns clip order, discovery, recovery and coverage. */
export class MotifBakeCoordinator {
  private generation = 0;
  private epoch = 0;
  private revision = 0;
  private states = new Map<string, ContentState>();
  private disposed = false;
  private discovering = false;
  private discovery: Promise<void> = Promise.resolve();
  private running = false;
  private cancelTimer?: () => void;
  private sequence: NonNullable<MotifBakePlan['sequence']> = [];
  private sequenceIndex = 0;
  private priority: string[] = [];
  private lastPublish = -Infinity;
  private inFlight = new Set<string>();
  private collecting?: Set<string>;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(private readonly deps: MotifBakeCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
  }

  reset(generation: number): void {
    this.epoch++;
    this.revision++;
    this.generation = generation;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.states.clear();
    this.sequence = []; this.sequenceIndex = 0; this.priority = [];
    this.discovering = false;
    this.emit(true);
  }

  async reconcile(plan: MotifBakePlan): Promise<MotifBakeSnapshot> {
    if (this.disposed || plan.generation !== this.generation) return this.snapshot();
    const epoch = this.epoch;
    const revision = ++this.revision;
    const demands = new Map(plan.contents.map(c => [c.cacheKey, { ...c, ranges: ranges(c) }]));
    const live = new Map([...plan.live, ...plan.contents].map(c => [c.cacheKey, c]));
    // Explicit full preparation belongs to the workspace opening, so a
    // replacement renderer's automatic-only plan cannot silently cancel it.
    for (const [key, state] of this.states) {
      if (state.content?.explicit && live.has(key)) {
        const content = demands.get(key) ?? state.content;
        demands.set(key, { ...content, explicit: true, ranges: [{ start: 0, end: content.contentFrames }] });
      }
    }
    const retry = new Set(plan.retryKeys ?? []);
    this.sequence = plan.sequence ?? [];
    this.sequenceIndex = 0;
    // Explicit full demand may extend beyond the automatic clip sequence.
    this.sequence = [...this.sequence, ...[...demands.values()].map(c => ({ cacheKey: c.cacheKey, ranges: c.ranges }))];
    const promoted = [...new Set(plan.promoteKeys ?? [])].filter(key => demands.has(key));
    this.priority = [...promoted, ...this.priority.filter(key => live.has(key) && !promoted.includes(key))];
    for (const key of this.states.keys()) if (!live.has(key)) this.states.delete(key);
    for (const [key, ref] of live) {
      let state = this.states.get(key);
      if (!state || state.hash !== ref.hash) {
        state = { cacheKey: key, hash: ref.hash, frames: new Set(), hydrated: false,
          status: { phase: 'queued', done: 0, total: 0 }, cursor: 0,
          failures: 0, retryAt: 0 };
        this.states.set(key, state);
      }
      state.content = demands.get(key);
      if (retry.has(key)) {
        state.failures = 0; state.retryAt = 0;
        state.status = { ...state.status, phase: 'queued', reason: undefined, error: undefined };
      }
      this.refresh(state);
      this.collecting?.add(ref.hash);
    }
    this.discovering = true;
    this.emit(true);
    const current = () => !this.disposed && this.epoch === epoch && this.revision === revision;
    // A later reconciliation supersedes discovery, but never races an older GC.
    this.discovery = this.discovery.catch(() => {}).then(async () => {
      if (!current()) return;
      for (const state of this.states.values()) {
        if (!current()) return;
        if (!state.hydrated && !state.retryAt) await this.hydrate(state, epoch);
      }
      if (!current()) return;
      if (plan.collect && this.deps.collect) {
        const keep = new Set([...this.states.values()].map(s => s.hash));
        for (const hash of this.inFlight) keep.add(hash);
        this.collecting = keep;
        try { await this.deps.collect(keep); }
        catch { /* Cache collection is best effort; discovery and writes remain authoritative. */ }
        finally { if (this.collecting === keep) this.collecting = undefined; }
      }
      if (!current()) return;
      this.discovering = false;
      this.emit(true);
      this.wake();
    });
    await this.discovery;
    return this.snapshot();
  }

  snapshot(): MotifBakeSnapshot {
    const statuses: MotifBakeSnapshot['statuses'] = {};
    const coverage: MotifBakeSnapshot['coverage'] = {};
    for (const [key, state] of this.states) {
      if (state.content) statuses[key] = { ...state.status };
      if (state.hydrated) coverage[key] = [...state.frames].sort((a, b) => a - b);
    }
    return { generation: this.generation, statuses, coverage };
  }

  wake(): void {
    if (this.disposed) return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (!this.running && !this.discovering) this.arm(0);
  }

  /** Storage is shared with foreground captures and cache reads. Their writes
   * and discovered misses must update the same coverage authority. */
  frameChanged(hash: string, frame: number, present: boolean): void {
    if (this.disposed || !Number.isSafeInteger(frame) || frame < 0) return;
    for (const state of this.states.values()) {
      if (state.hash !== hash) continue;
      const before = state.frames.has(frame);
      if (before === present) continue;
      if (present) state.frames.add(frame);
      else { state.frames.delete(frame); this.sequenceIndex = 0; }
      if (state.content?.ranges.some(r => frame >= r.start && frame < r.end)) {
        state.status.done += present ? 1 : -1;
        if (state.status.phase !== 'error' && state.hydrated && state.status.done === state.status.total) {
          state.status = { ...state.status, phase: 'ready', reason: undefined, error: undefined };
        } else if (state.status.phase === 'ready') state.status.phase = 'queued';
      }
      if (state.status.phase === 'ready') this.priority = this.priority.filter(key => key !== state.cacheKey);
    }
    this.emit();
    this.wake();
  }

  retry(cacheKey?: string): void {
    for (const state of this.states.values()) {
      if (cacheKey !== undefined && state.cacheKey !== cacheKey) continue;
      state.failures = 0; state.retryAt = 0;
      state.status = { ...state.status, phase: 'queued', reason: undefined, error: undefined };
      this.refresh(state);
    }
    this.emit(true);
    this.wake();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.states.clear();
  }

  private refresh(state: ContentState): void {
    const content = state.content;
    if (!content) return;
    const total = content.ranges.reduce((n, r) => n + r.end - r.start, 0);
    let done = 0;
    for (const frame of state.frames) if (content.ranges.some(r => frame >= r.start && frame < r.end)) done++;
    state.status = { ...state.status, done, total };
    if (state.hydrated && done === total && state.status.phase !== 'error') state.status = { ...state.status, phase: 'ready', reason: undefined, error: undefined };
    else if (state.status.phase === 'ready') state.status.phase = 'queued';
  }

  private async hydrate(state: ContentState, epoch: number): Promise<void> {
    try {
      const frames = await this.deps.inventory(state);
      if (!this.current(state, epoch)) return;
      for (const frame of frames) if (Number.isSafeInteger(frame) && frame >= 0) state.frames.add(frame);
      state.hydrated = true;
      state.retryAt = 0; state.failures = 0;
      state.status = { ...state.status, phase: 'queued', reason: undefined, error: undefined };
      this.refresh(state);
    } catch (error) { if (this.current(state, epoch)) this.fail(state, error); }
  }

  private current(state: ContentState, epoch: number): boolean {
    return !this.disposed && this.epoch === epoch && this.states.get(state.cacheKey) === state;
  }

  private nextFrame(state: ContentState, ranges = state.content!.ranges): number | undefined {
    for (const [from, to] of [[state.cursor, Infinity], [0, state.cursor]]) {
      for (const range of ranges) {
        for (let frame = Math.max(range.start, from!); frame < Math.min(range.end, to!); frame++) {
          if (!state.frames.has(frame)) return frame;
        }
      }
    }
    return undefined;
  }

  private fail(state: ContentState, error: unknown): void {
    const message = String(error);
    if (isResourceCapacityError(error) || /ENOSPC|disk.*full|motif-disk-capacity/i.test(message)) {
      state.retryAt = this.now() + 1000;
      state.status = { ...state.status, phase: 'paused', reason: isResourceCapacityError(error) ? 'capacity' : 'disk', error: message };
    } else {
      state.failures++;
      const terminal = this.deps.isContentFailure?.(error) || state.failures >= 3;
      state.retryAt = terminal ? Infinity : this.now() + 250 * 2 ** (state.failures - 1);
      state.status = { ...state.status, phase: terminal ? 'error' : 'retrying', reason: undefined, error: message };
    }
    this.emit(true);
  }

  private arm(delay: number): void {
    if (this.cancelTimer || this.disposed) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      void this.step();
    }, delay);
  }

  private async step(): Promise<void> {
    if (this.running || this.disposed || this.discovering) return;
    const candidates = [...this.states.values()].filter(s => (!s.hydrated || s.content) && s.status.phase !== 'ready' && s.status.phase !== 'error');
    if (!candidates.length) { this.emit(true); return; }
    const pause = this.deps.pause();
    if (pause) {
      for (const state of candidates) state.status = { ...state.status, phase: 'paused', reason: pause };
      this.emit(true);
      this.arm(1000);
      return;
    }
    const now = this.now();
    const eligible = candidates.filter(s => s.retryAt <= now);
    if (!eligible.length) {
      this.arm(Math.max(1, Math.min(...candidates.map(s => s.retryAt)) - now));
      return;
    }
    this.priority = this.priority.filter(key => {
      const state = this.states.get(key);
      return state?.content && state.status.phase !== 'ready';
    });
    const available = new Map(eligible.map(s => [s.cacheKey, s]));
    let chosen = this.priority.map(key => available.get(key)).find(s => !!s);
    let targetRanges = chosen?.content?.ranges;
    if (!chosen) for (let i = this.sequenceIndex; i < this.sequence.length; i++) {
      const entry = this.sequence[i]!;
      const state = this.states.get(entry.cacheKey);
      if (!state?.content || state.status.phase === 'ready'
        || (state.hydrated && this.nextFrame(state, entry.ranges) === undefined)) {
        // Retire completed prefixes once, rather than scanning their saved
        // frames for every frame of a later occurrence. Read misses reopen it.
        if (i === this.sequenceIndex) this.sequenceIndex++;
        continue;
      }
      if (available.has(entry.cacheKey)) {
        chosen = state; targetRanges = entry.ranges; break;
      }
    }
    // Unknown inventory without capture demand still gets its bounded retry.
    chosen ??= eligible[0]!;
    const epoch = this.epoch;
    this.running = true;
    try {
      if (!chosen.hydrated) { await this.hydrate(chosen, epoch); return; }
      const frame = this.nextFrame(chosen, targetRanges);
      if (frame === undefined) { this.refresh(chosen); return; }
      const content = chosen.content!;
      chosen.status = { ...chosen.status, phase: 'baking', reason: undefined, error: undefined };
      this.emit();
      this.inFlight.add(chosen.hash);
      await this.deps.persist(content, frame, () => this.current(chosen, epoch) && !!chosen.content);
      if (!this.current(chosen, epoch)) return;
      const newlyCovered = !chosen.frames.has(frame);
      chosen.frames.add(frame);
      chosen.cursor = frame + 1;
      chosen.failures = 0; chosen.retryAt = 0;
      chosen.status.lastProgressAt = this.now();
      // Re-evaluate order after every frame: user promotion and foreground
      // captures remain responsive without rotating incomplete clips.
      if (newlyCovered && chosen.content?.ranges.some(r => frame >= r.start && frame < r.end)) chosen.status.done++;
      chosen.status.phase = chosen.status.done === chosen.status.total ? 'ready' : 'queued';
      if (chosen.status.phase === 'ready') this.priority = this.priority.filter(key => key !== chosen.cacheKey);
      this.emit(chosen.status.phase === 'ready');
    } catch (error) {
      if (this.current(chosen, epoch) && chosen.content) this.fail(chosen, error);
    } finally {
      if (this.current(chosen, epoch) && chosen.status.phase === 'baking') chosen.status.phase = 'queued';
      this.inFlight.delete(chosen.hash);
      this.running = false;
      if (!this.disposed && !this.discovering) this.arm(0);
    }
  }

  private emit(force = false): void {
    if (this.disposed || (!force && this.now() - this.lastPublish < 100)) return;
    this.lastPublish = this.now();
    try { this.deps.publish(this.snapshot()); } catch { /* Observers cannot strand work. */ }
  }
}
