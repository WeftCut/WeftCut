import { cacheBudget } from "../render/cacheBudget";

type Entry = { state: "pending" | "not_ready" | "error" } | { state: "ready"; dataUrl: string };

/** Shares reads between poster consumers; ready strings participate in the
 * renderer's image budget. Mounted posters are a soft retention floor, while
 * hidden posters are evicted in access order. */
export class MediaPosterCache {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  private identities = new Map<string, string>();
  private bytes = 0;
  constructor(
    private fetch: (mediaId: string) => Promise<string>,
    private budget = cacheBudget,
  ) {}

  get(id: string): string | null {
    const entry = this.entries.get(id);
    if (entry?.state !== "ready") return null;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.dataUrl;
  }

  subscribe(id: string, notify: () => void): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) this.listeners.set(id, listeners = new Set());
    listeners.add(notify);
    void this.ensure(id);
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0) {
        this.listeners.delete(id);
        // No late read may recreate a removed consumer's pending entry.
        if (this.entries.get(id)?.state !== "ready") this.remove(id);
        this.trim();
      }
    };
  }

  reconcile(identities: ReadonlyMap<string, string>): void {
    for (const [id, identity] of this.identities) {
      if (identities.get(id) !== identity) this.remove(id);
    }
    this.identities = new Map(identities);
    this.report();
  }

  completed(id: string): void {
    this.remove(id);
    if (this.listeners.has(id) && this.identities.has(id)) void this.ensure(id);
  }

  private async ensure(id: string): Promise<void> {
    if (!this.identities.has(id)) return;
    const cached = this.entries.get(id);
    if (cached && cached.state !== "not_ready") return;
    const pending: Entry = { state: "pending" };
    this.entries.set(id, pending);
    let entry: Entry;
    try { entry = { state: "ready", dataUrl: await this.fetch(id) }; }
    catch (error) { entry = { state: String(error).includes("not_ready") ? "not_ready" : "error" }; }
    if (this.entries.get(id) !== pending) return;
    this.entries.set(id, entry);
    if (entry.state === "ready") this.bytes += entry.dataUrl.length * 2;
    this.report();
    this.trim();
    this.listeners.get(id)?.forEach((notify) => notify());
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.state === "ready") this.bytes -= entry.dataUrl.length * 2;
    this.entries.delete(id);
    this.report();
  }

  private report(): void {
    this.budget.update(this, "filmstrip_cache_mib", this.bytes, () => this.trim());
  }

  private trim(): void {
    const limit = this.budget.ownerAllowance("filmstrip_cache_mib", this);
    for (const [id, entry] of this.entries) {
      if (this.bytes <= limit) break;
      if (entry.state === "ready" && !this.listeners.has(id)) this.remove(id);
    }
  }
}
