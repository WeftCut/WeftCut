// The main-process download queue for app-managed content: the one owner of
// "which items are on their way", so the Settings row can unmount, remount, or
// reload without touching a transfer. Items run ONE AT A TIME in enqueue
// order (bandwidth-friendly, and what the Settings UX always showed); each run
// is a `downloadItem` call (contentDownload.ts), which already resumes.
//
// Pure + DI like the downloader: the catalog, the install check, the download
// function, and every sink (renderer broadcast, autofill, LogBus, persistence)
// are injected, so the sequencing rules are unit-testable with a scripted
// download. The Electron binding lives in src/main/index.ts.

import type {
  ContentDownloadProgress,
  ContentDownloadResult,
  ContentItem,
  ContentQueueEntry,
  ContentQueueSnapshot,
} from "../shared/content-download";

/** Per-item lifecycle notifications — the LogBus op's raw material. `progress`
 *  is un-throttled (download phase only); the sink throttles for the log. */
export type ContentQueueItemEvent =
  | { kind: "started" }
  | { kind: "progress"; ratio: number }
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface ContentQueueDeps {
  catalog: readonly ContentItem[];
  isInstalled(item: ContentItem): boolean;
  /** Pinned payload size for this platform — the progress denominator a
   *  `queued` entry shows before its first tick. 0 when unknown. */
  totalBytesOf(item: ContentItem): number;
  download(
    item: ContentItem,
    onProgress: (p: ContentDownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<ContentDownloadResult>;
  /** Every snapshot change; download ticks are throttled to `tickMs`. */
  onChange(snapshot: ContentQueueSnapshot): void;
  /** A successful install — the autofill consumers hang here. Runs BEFORE the
   *  snapshot broadcast so a renderer re-fetch already sees the filled config. */
  onInstalled(item: ContentItem): void;
  onItemEvent(item: ContentItem, event: ContentQueueItemEvent): void;
  /** Ordered ids of everything pending (queued or in flight) whenever that set
   *  changes — the persistence hook. Error entries are not pending. */
  onPendingChanged(ids: readonly string[]): void;
  now(): number;
  /** Minimum ms between broadcast download ticks (default 250 — ~4 Hz). */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 250;

export class ContentQueue {
  private listeners = new Set<() => void>();
  /** Run order. Terminal `error` entries linger (the row shows why) until the
   *  item is enqueued again or cancelled; `ok`/`cancelled` entries are dropped. */
  private entries: ContentQueueEntry[] = [];
  private running: { id: string; controller: AbortController } | null = null;
  private lastTickAt = 0;
  /** Set by shutdown(): the in-flight abort must NOT mutate or persist — the
   *  saved queue keeps the id so the next boot resumes it. */
  private shuttingDown = false;

  constructor(private readonly deps: ContentQueueDeps) {}

  snapshot(): ContentQueueSnapshot {
    return { entries: this.entries.map((e) => ({ ...e })) };
  }

  entryOf(id: string): ContentQueueEntry | undefined {
    return this.entries.find((e) => e.itemId === id);
  }

  /** Observe completion of a dependency set without owning or duplicating transfers. */
  ensure(ids: readonly string[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        this.listeners.delete(check);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error("Preparation cancelled"));
      const check = () => {
        if (signal.aborted) return abort();
        for (const id of ids) {
          const item = this.deps.catalog.find(i => i.id === id);
          if (!item) return finish(new Error(`unknown content id: ${id}`));
          const entry = this.entryOf(id);
          if (entry?.state === "error") return finish(new Error(entry.error ?? "Download failed"));
          if (!this.deps.isInstalled(item)) {
            if (!entry) return finish(new Error("Download cancelled"));
            return;
          }
        }
        finish();
      };
      if (signal.aborted) return abort();
      // Enqueue before subscribing: enqueue broadcasts before starting the first transfer.
      try { this.enqueue([...ids]); } catch (e) { reject(e); return; }
      this.listeners.add(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  /** Queued or in flight — the states `content:remove` must refuse over. */
  isPending(id: string): boolean {
    const e = this.entryOf(id);
    return e !== undefined && e.state !== "error";
  }

  /**
   * Add items in the given order. Installed items are skipped (the main-side
   * guard the renderer's `missing` filter used to be the only copy of),
   * pending ones are left alone, and an `error` entry is superseded by a
   * fresh queued one. Unknown ids throw — that is a caller bug, not content.
   */
  enqueue(ids: readonly string[]): ContentQueueSnapshot {
    let changed = false;
    for (const id of ids) {
      const item = this.deps.catalog.find((i) => i.id === id);
      if (!item) throw new Error(`unknown content id: ${id}`);
      if (this.deps.isInstalled(item)) continue;
      const existing = this.entryOf(id);
      if (existing && existing.state !== "error") continue;
      if (existing) this.entries = this.entries.filter((e) => e !== existing);
      this.entries.push({
        itemId: id,
        state: "queued",
        receivedBytes: 0,
        totalBytes: this.deps.totalBytesOf(item),
      });
      changed = true;
    }
    if (changed) {
      this.pendingChanged();
      this.broadcast(true);
      this.pump();
    }
    return this.snapshot();
  }

  /**
   * Stop one item. In flight → abort (its partial stays: cancel is pause);
   * queued → drop; error → dismiss. Anything else is a no-op.
   */
  cancel(id: string): void {
    if (this.running?.id === id) {
      // finish() drops the entry once the download reports `cancelled`.
      this.running.controller.abort();
      return;
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.itemId !== id);
    if (this.entries.length !== before) {
      this.pendingChanged();
      this.broadcast(true);
    }
  }

  /**
   * App quit: abort the in-flight fetch so its file handle closes at a chunk
   * boundary, and freeze the bookkeeping — the persisted pending list still
   * names the item, which is exactly what lets the next boot pick it up.
   */
  shutdown(): void {
    this.shuttingDown = true;
    this.running?.controller.abort();
  }

  private pump(): void {
    if (this.running || this.shuttingDown) return;
    const next = this.entries.find((e) => e.state === "queued");
    if (!next) return;
    const item = this.deps.catalog.find((i) => i.id === next.itemId);
    if (!item) {
      // Cannot happen (enqueue validated the id); drop rather than wedge.
      this.entries = this.entries.filter((e) => e !== next);
      this.pump();
      return;
    }
    const controller = new AbortController();
    this.running = { id: next.itemId, controller };
    next.state = "downloading";
    this.broadcast(true);
    this.deps.onItemEvent(item, { kind: "started" });
    void this.deps
      .download(item, (p) => this.onTick(item, p), controller.signal)
      .then(
        (result) => this.finish(item, result),
        (e: unknown) =>
          this.finish(item, {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
      );
  }

  private onTick(item: ContentItem, p: ContentDownloadProgress): void {
    if (this.shuttingDown) return;
    const entry = this.entryOf(item.id);
    if (!entry) return;
    entry.receivedBytes = p.receivedBytes;
    entry.totalBytes = p.totalBytes;
    switch (p.phase) {
      case "resume":
        entry.state = "resuming";
        break;
      case "download":
        entry.state = "downloading";
        break;
      case "verify":
        entry.state = "verifying";
        break;
      case "extract":
        entry.state = "extracting";
        break;
      case "done":
      case "error":
        // finish() owns the terminal transition (it has the result).
        return;
    }
    if (p.phase === "download") {
      if (p.totalBytes > 0) {
        this.deps.onItemEvent(item, {
          kind: "progress",
          ratio: p.receivedBytes / p.totalBytes,
        });
      }
      this.broadcast(false);
    } else {
      this.broadcast(true);
    }
  }

  private finish(item: ContentItem, result: ContentDownloadResult): void {
    if (this.shuttingDown) return;
    this.running = null;
    const entry = this.entryOf(item.id);
    if (result.ok) {
      this.entries = this.entries.filter((e) => e !== entry);
      this.deps.onItemEvent(item, { kind: "ok" });
      this.deps.onInstalled(item);
    } else if ("cancelled" in result) {
      this.entries = this.entries.filter((e) => e !== entry);
      this.deps.onItemEvent(item, { kind: "cancelled" });
    } else if (entry) {
      entry.state = "error";
      entry.error = result.error;
      entry.receivedBytes = 0;
      this.deps.onItemEvent(item, { kind: "error", message: result.error });
    }
    this.pendingChanged();
    this.broadcast(true);
    this.pump();
  }

  private broadcast(force: boolean): void {
    const t = this.deps.now();
    if (!force && t - this.lastTickAt < (this.deps.tickMs ?? DEFAULT_TICK_MS)) return;
    this.lastTickAt = t;
    this.deps.onChange(this.snapshot());
    for (const listener of this.listeners) listener();
  }

  private pendingChanged(): void {
    this.deps.onPendingChanged(
      this.entries.filter((e) => e.state !== "error").map((e) => e.itemId),
    );
  }
}
